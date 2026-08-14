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
import {
  selectProofAlgorithm,
  type ProofAlgorithm,
} from "../search/proof-algorithm-selection.ts";
import {
  isProofCommand,
  type ProofCommand,
  type ProofProgress,
  type ProofSolutionFound,
  type ProofPartitionComplete,
  type ProofError,
  type ProofResult,
  type ProofStartPartition,
} from "./sokomind-proof-protocol.ts";

let abortController: AbortController | null = null;
let pendingUpperBound: number | undefined;
let activePrefixCost = 0;
let activeUpperBound = Number.POSITIVE_INFINITY;
let lastReportedLowerBound = 0;

function postResult(result: ProofResult): void {
  self.postMessage(result);
}

function createUpperBoundChannel(): UpperBoundChannel {
  return {
    poll(): number | undefined {
      const value = pendingUpperBound;
      pendingUpperBound = undefined;
      if (value !== undefined && value < activeUpperBound) {
        activeUpperBound = value;
      }
      return value;
    },
  };
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

async function runPartition(command: ProofStartPartition): Promise<void> {
  const { partitionId, request, initialUpperBound, prefixCost, algorithm } =
    command;

  abortController = new AbortController();
  pendingUpperBound = undefined;
  activePrefixCost = prefixCost;
  activeUpperBound = initialUpperBound;
  lastReportedLowerBound = prefixCost;

  const channel = createUpperBoundChannel();

  let lastProgressMs = 0;
  const PROGRESS_THROTTLE_MS = 200;

  const context: SolverExecutionContext = {
    signal: abortController.signal,
    reportProgress(progress: SolverProgress): void {
      const now = performance.now();
      if (now - lastProgressMs < PROGRESS_THROTTLE_MS) return;
      lastProgressMs = now;
      lastReportedLowerBound = Math.max(
        lastReportedLowerBound,
        (progress.lowerBound ?? 0) + prefixCost,
      );
      postResult({
        type: "proof/progress",
        partitionId,
        lowerBound: lastReportedLowerBound,
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

  let result: SolverResult;
  try {
    if (selectedAlgorithm === "astar") {
      result = await runExactMoveAStar(request, context, {
        upperBound: initialUpperBound,
        upperBoundChannel: channel,
      });
    } else {
      result = await runIdaStarSearch(request, context, {
        upperBound: initialUpperBound,
        upperBoundChannel: channel,
        persistTransposition: false,
      });
    }
  } catch (error: unknown) {
    postResult({
      type: "proof/error",
      partitionId,
      message: error instanceof Error ? error.message : String(error),
    } satisfies ProofError);
    return;
  }

  if (result.status === "solved") {
    const fullSolution = prependSolution(command, result.solution);
    postResult({
      type: "proof/solution",
      partitionId,
      solution: fullSolution,
      totalCost: fullSolution.moves,
    } satisfies ProofSolutionFound);
    postResult({
      type: "proof/partition-complete",
      partitionId,
      lowerBound: Math.max(
        lastReportedLowerBound,
        (result.proof?.lowerBound ?? 0) + prefixCost,
      ),
      exhausted: result.proof?.kind === "optimal",
      metrics: result.metrics,
    } satisfies ProofPartitionComplete);
  } else if (result.status === "unsolved") {
    postResult({
      type: "proof/partition-complete",
      partitionId,
      lowerBound: Math.max(
        lastReportedLowerBound,
        (result.proof?.lowerBound ??
          result.metrics.counters?.lowerBound ??
          (result.reason === "exhausted" ? activeUpperBound : 0)) + prefixCost,
      ),
      exhausted: result.reason === "exhausted",
      metrics: result.metrics,
    } satisfies ProofPartitionComplete);
  } else {
    postResult({
      type: "proof/partition-complete",
      partitionId,
      lowerBound: lastReportedLowerBound,
      exhausted: false,
      metrics: result.metrics,
    } satisfies ProofPartitionComplete);
  }
}

self.onmessage = ({ data }: MessageEvent<unknown>) => {
  if (!isProofCommand(data)) return;

  const command: ProofCommand = data;

  switch (command.type) {
    case "proof/start-partition":
      void runPartition(command);
      break;

    case "solver/update-upper-bound": {
      const localBound = command.moves - activePrefixCost;
      if (localBound > 0 && (pendingUpperBound === undefined || localBound < pendingUpperBound)) {
        pendingUpperBound = localBound;
      }
      break;
    }

    case "proof/cancel":
      abortController?.abort();
      abortController = null;
      break;
  }
};
