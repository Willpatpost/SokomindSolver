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
  type ProofIdle,
  type ProofResult,
  type ProofStartPartition,
} from "./sokomind-proof-protocol.ts";

const PROGRESS_THROTTLE_MS = 200;

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
    }
  };
}
