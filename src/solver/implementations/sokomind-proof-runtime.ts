import type {
  SolverExecutionContext,
  SolverProgress,
  SolverResult,
  SolverSolution,
} from "../contracts.ts";
import { compileSearchBoard } from "../search/compiled-board.ts";
import {
  runExactMoveAStar,
  type UpperBoundChannel,
} from "../search/exact-move-astar.ts";
import { runIdaStarSearch } from "../search/ida-star.ts";
import { ExactPreprocessingCache } from "../search/preprocessing-cache.ts";
import {
  SHARED_HEURISTIC_MAX_H,
  SharedHeuristicTable,
  type ExactHeuristicShare,
} from "../search/shared-heuristic-table.ts";
import {
  selectProofAlgorithm,
  type ProofAlgorithm,
} from "../search/proof-algorithm-selection.ts";
import {
  isProofCommand,
  PROOF_HEARTBEAT_MS,
  type ProofCommand,
  type ProofProgress,
  type ProofSolutionFound,
  type ProofPartitionComplete,
  type ProofError,
  type ProofHeuristicEntries,
  type ProofIdle,
  type ProofResult,
  type ProofStartPartition,
} from "./sokomind-proof-protocol.ts";

const PROGRESS_THROTTLE_MS = 200;
/** A lane's shared-bound table takes at most this, and at most 1/8 of its memory limit. */
const SHARED_HEURISTIC_MAX_BYTES = 64 * 1024 * 1024;
/** Offered bounds are batched into messages of up to this many entries. */
const SHARED_HEURISTIC_OUTBOX_ENTRIES = 4096;

/** The bounds this worker holds for one coordinator run. */
interface RunHeuristicShare {
  readonly runId: number;
  readonly boxCount: number;
  readonly table: SharedHeuristicTable;
  readonly scratchTokens: Uint32Array;
}

function prependSolution(
  partition: ProofStartPartition,
  innerSolution: SolverSolution,
): SolverSolution {
  return {
    steps: [...partition.prefixSteps, ...innerSolution.steps],
    moves: partition.prefixCost + innerSolution.moves,
    pushes: innerSolution.pushes + 1,
    objective: innerSolution.objective,
    objectiveScore: partition.prefixCost + innerSolution.objectiveScore,
    optimality: innerSolution.optimality,
  };
}

/**
 * One partition's run. Each run keeps its own abort signal and bounds, so a
 * command can only reach the run that was active when it arrived, never a
 * later one.
 */
interface PartitionRun {
  readonly command: ProofStartPartition;
  readonly abortController: AbortController;
  /** Local upper bound received but not yet polled by the kernel. */
  pendingUpperBound: number | undefined;
  /** Exclusive local upper bound the kernel has taken. */
  upperBound: number;
  lastReportedLowerBound: number;
}

// Shared by the browser and Node proof worker entry points, which differ only
// in how they receive commands and post results. Contains no Node imports so
// the browser worker bundle stays free of them.
export function createProofWorkerRuntime(
  postResult: (result: ProofResult) => void,
  { heartbeatMs = PROOF_HEARTBEAT_MS }: { readonly heartbeatMs?: number } = {},
): (data: unknown) => void {
  let activeRun: PartitionRun | null = null;
  // Outlives partitions and runs: the partitions of a proof share a board, so
  // only the first one on this worker builds the tables.
  const preprocessingCache = new ExactPreprocessingCache();
  // Outlives partitions but not runs: every partition of a run has the same
  // board and labels, so box tokens name the same state in each of them.
  let runShare: RunHeuristicShare | null = null;

  /**
   * The kernel's view of the run's shared bounds. Offers go into the local
   * table and an outbox that `flush` posts for the coordinator to relay.
   */
  function createKernelShare(
    share: RunHeuristicShare,
    partitionId: string,
  ): { readonly kernelShare: ExactHeuristicShare; readonly flush: () => void } {
    const { runId, boxCount, table } = share;
    const stride = boxCount + 2;
    const outbox = new Uint32Array(SHARED_HEURISTIC_OUTBOX_ENTRIES * stride);
    let pending = 0;
    const flush = (): void => {
      if (pending === 0) return;
      postResult({
        type: "proof/heuristic-entries",
        runId,
        partitionId,
        entries: outbox.slice(0, pending * stride),
      } satisfies ProofHeuristicEntries);
      pending = 0;
    };
    const kernelShare: ExactHeuristicShare = {
      lookup: (robotCell, tokens) => table.lookup(robotCell, tokens),
      offer(robotCell, tokens, h) {
        table.insert(robotCell, tokens, h);
        const base = pending * stride;
        outbox[base] = robotCell;
        for (let i = 0; i < boxCount; i++) outbox[base + 1 + i] = tokens[i];
        outbox[base + 1 + boxCount] = Math.min(h, SHARED_HEURISTIC_MAX_H);
        pending += 1;
        if (pending === SHARED_HEURISTIC_OUTBOX_ENTRIES) flush();
      },
      get retainedBytes() {
        return table.retainedBytes + outbox.byteLength;
      },
    };
    return { kernelShare, flush };
  }

  function createUpperBoundChannel(run: PartitionRun): UpperBoundChannel {
    return {
      poll(): number | undefined {
        const value = run.pendingUpperBound;
        run.pendingUpperBound = undefined;
        if (value !== undefined && value < run.upperBound) {
          run.upperBound = value;
        }
        return value;
      },
    };
  }

  async function runPartition(run: PartitionRun): Promise<void> {
    const { command } = run;
    const { runId, partitionId, request, initialUpperBound, prefixCost, algorithm } =
      command;

    const channel = createUpperBoundChannel(run);
    if (runShare !== null && runShare.runId !== runId) runShare = null;
    let shareFlush: (() => void) | undefined;

    let lastProgressMs = 0;
    let lastProgress: ProofProgress = {
      type: "proof/progress",
      runId,
      partitionId,
      lowerBound: prefixCost,
      expandedStates: 0,
    };
    const postProgress = (progress: ProofProgress): void => {
      lastProgressMs = performance.now();
      lastProgress = progress;
      postResult(progress);
    };

    const context: SolverExecutionContext = {
      signal: run.abortController.signal,
      reportProgress(progress: SolverProgress): void {
        shareFlush?.();
        const now = performance.now();
        if (now - lastProgressMs < PROGRESS_THROTTLE_MS) return;
        run.lastReportedLowerBound = Math.max(
          run.lastReportedLowerBound,
          (progress.lowerBound ?? 0) + prefixCost,
        );
        postProgress({
          type: "proof/progress",
          runId,
          partitionId,
          lowerBound: run.lastReportedLowerBound,
          expandedStates: progress.expandedStates ?? 0,
          generatedStates: progress.generatedStates,
          counters: progress.counters,
        } satisfies ProofProgress);
      },
      now: performance.now.bind(performance),
    };

    const board = compileSearchBoard(request.board);
    const boxCount = request.snapshot.boxes.length;

    let selectedAlgorithm: ProofAlgorithm;
    if (algorithm === "astar" || algorithm === "ida-star") {
      selectedAlgorithm = algorithm;
    } else {
      selectedAlgorithm = selectProofAlgorithm(
        board,
        boxCount,
        request.limits?.maxMemoryBytes,
      );
    }

    let heuristicShare: ExactHeuristicShare | undefined;
    if (command.shareHeuristic && selectedAlgorithm === "astar") {
      if (runShare === null) {
        const maxMemoryBytes = request.limits?.maxMemoryBytes ?? Infinity;
        runShare = {
          runId,
          boxCount,
          table: new SharedHeuristicTable(
            boxCount,
            Math.min(SHARED_HEURISTIC_MAX_BYTES, Math.floor(maxMemoryBytes / 8)),
          ),
          scratchTokens: new Uint32Array(boxCount),
        };
      }
      const created = createKernelShare(runShare, partitionId);
      heuristicShare = created.kernelShare;
      shareFlush = created.flush;
    }

    // The table builds before the search report no progress, so the last
    // progress is resent from their yields. A lane that stops yielding still
    // falls silent and trips the coordinator's watchdog.
    const heartbeat = setInterval(() => {
      if (performance.now() - lastProgressMs >= heartbeatMs) postProgress(lastProgress);
    }, heartbeatMs);
    let result: SolverResult;
    try {
      if (selectedAlgorithm === "astar") {
        result = await runExactMoveAStar(request, context, {
          upperBound: initialUpperBound,
          upperBoundChannel: channel,
          preprocessingCache,
          heuristicShare,
        });
      } else {
        result = await runIdaStarSearch(request, context, {
          upperBound: initialUpperBound,
          upperBoundChannel: channel,
          preprocessingCache,
        });
      }
    } catch (error: unknown) {
      postResult({
        type: "proof/error",
        runId,
        partitionId,
        message: error instanceof Error ? error.message : String(error),
      } satisfies ProofError);
      return;
    } finally {
      clearInterval(heartbeat);
      shareFlush?.();
    }

    if (result.status === "solved") {
      const fullSolution = prependSolution(command, result.solution);
      postResult({
        type: "proof/solution",
        runId,
        partitionId,
        solution: fullSolution,
        totalCost: fullSolution.moves,
      } satisfies ProofSolutionFound);
      postResult({
        type: "proof/partition-complete",
        runId,
        partitionId,
        lowerBound: Math.max(
          run.lastReportedLowerBound,
          (result.proof?.lowerBound ?? 0) + prefixCost,
        ),
        exhausted: result.proof?.kind === "optimal",
        metrics: result.metrics,
      } satisfies ProofPartitionComplete);
    } else if (result.status === "unsolved") {
      postResult({
        type: "proof/partition-complete",
        runId,
        partitionId,
        lowerBound: Math.max(
          run.lastReportedLowerBound,
          (result.proof?.lowerBound ??
            result.metrics.counters?.lowerBound ??
            (result.reason === "exhausted" ? run.upperBound : 0)) + prefixCost,
        ),
        exhausted: result.reason === "exhausted",
        metrics: result.metrics,
      } satisfies ProofPartitionComplete);
    } else {
      postResult({
        type: "proof/partition-complete",
        runId,
        partitionId,
        lowerBound: run.lastReportedLowerBound,
        exhausted: false,
        metrics: result.metrics,
      } satisfies ProofPartitionComplete);
    }
  }

  return (data: unknown): void => {
    if (!isProofCommand(data)) return;

    const command: ProofCommand = data;

    switch (command.type) {
      case "proof/start-partition": {
        const { runId, partitionId } = command;
        if (activeRun !== null) {
          postResult({
            type: "proof/error",
            runId,
            partitionId,
            message: `Partition ${activeRun.command.partitionId} is still running.`,
          } satisfies ProofError);
          break;
        }
        const run: PartitionRun = {
          command,
          abortController: new AbortController(),
          pendingUpperBound: undefined,
          upperBound: command.initialUpperBound,
          lastReportedLowerBound: command.prefixCost,
        };
        activeRun = run;
        void runPartition(run)
          .catch((error: unknown) => {
            postResult({
              type: "proof/error",
              runId,
              partitionId,
              message: error instanceof Error ? error.message : String(error),
            } satisfies ProofError);
          })
          .finally(() => {
            if (activeRun === run) activeRun = null;
            postResult({ type: "proof/idle", runId, partitionId } satisfies ProofIdle);
          });
        break;
      }

      case "solver/update-upper-bound": {
        // Each start carries the current bound, so one arriving between
        // partitions has nothing to update.
        const run = activeRun;
        if (run === null) break;
        const localBound = command.moves - run.command.prefixCost;
        if (localBound > 0 && (run.pendingUpperBound === undefined || localBound < run.pendingUpperBound)) {
          run.pendingUpperBound = localBound;
        }
        break;
      }

      case "proof/cancel":
        activeRun?.abortController.abort();
        break;

      case "proof/heuristic-entries": {
        // Entries from another lane of this worker's current run; an older
        // run's entries, or a malformed batch, are ignored.
        const share = runShare;
        if (share === null || share.runId !== command.runId) break;
        const { entries } = command;
        const { boxCount, table, scratchTokens } = share;
        const stride = boxCount + 2;
        if (entries.length % stride !== 0) break;
        for (let base = 0; base < entries.length; base += stride) {
          for (let i = 0; i < boxCount; i++) scratchTokens[i] = entries[base + 1 + i];
          table.insert(entries[base], scratchTokens, entries[base + 1 + boxCount]);
        }
        break;
      }
    }
  };
}
