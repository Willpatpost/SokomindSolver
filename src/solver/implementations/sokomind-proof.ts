import type {
  SolverExecutionContext,
  SolverProof,
  SolverProofAlgorithm,
  SolverRequest,
  SolverResult,
  SolverSolution,
} from "../contracts.ts";
import type { SokomindRequestOptions } from "./sokomind-options.ts";
import { compileSearchBoard } from "../search/compiled-board.ts";
import { selectProofAlgorithm, type ProofAlgorithm } from "../search/proof-algorithm-selection.ts";
import { runExactMoveAStar, type ExactIncumbent } from "../search/exact-move-astar.ts";
import { runIdaStarSearch, type ExactMoveIdaStarOptions } from "../search/ida-star.ts";
import type { IdaStarCheckpoint } from "../search/ida-star-checkpoint.ts";
import {
  createBoardContentKey,
  createExactStateCodecVersion,
} from "../search/ida-star-checkpoint.ts";
import {
  enumerateFirstPushPartitions,
  buildPartitionRequest,
  isProofResult,
  type ProofCommand,
  type ProofResult,
  type ProofStartPartition,
} from "./sokomind-proof-protocol.ts";

export interface ProofCheckpointOptions {
  readonly checkpoint?: IdaStarCheckpoint;
  readonly onCheckpoint?: (checkpoint: IdaStarCheckpoint) => void;
  readonly solverVersion?: string;
}

export async function runSequentialProof(
  request: SolverRequest,
  context: SolverExecutionContext,
  options: SokomindRequestOptions,
  discoveryResult: SolverResult,
  checkpointOptions?: ProofCheckpointOptions,
): Promise<SolverResult> {
  if (discoveryResult.status !== "solved") {
    return discoveryResult;
  }

  const incumbent: ExactIncumbent = {
    solution: discoveryResult.solution,
    cost: discoveryResult.solution.moves,
  };

  const remaining = request.limits?.maxElapsedMs !== undefined
    ? request.limits.maxElapsedMs - discoveryResult.metrics.elapsedMs
    : undefined;

  if (remaining !== undefined && remaining <= 0) {
    return discoveryResult;
  }

  const proofLimits = options.mode === "optimal"
    ? request.limits
    : remaining !== undefined
      ? { ...request.limits, maxElapsedMs: remaining }
      : request.limits;

  const board = compileSearchBoard(request.board);
  const boxCount = request.snapshot.boxes.length;

  let algorithm: ProofAlgorithm;
  if (options.proofAlgorithm === "auto") {
    algorithm = selectProofAlgorithm(board, boxCount, request.limits?.maxMemoryBytes);
  } else {
    algorithm = options.proofAlgorithm;
  }

  const proofRequest: SolverRequest = {
    ...request,
    limits: proofLimits,
  };

  let proofResult: SolverResult;
  if (algorithm === "astar") {
    proofResult = await runExactMoveAStar(proofRequest, context, { incumbent });
  } else {
    const idaOptions: ExactMoveIdaStarOptions = {
      incumbent,
      reachabilityPolicy: options.idaReachabilitySnapshots,
      snapshotPeriod: options.idaSnapshotPeriod,
      ...(checkpointOptions?.checkpoint
        ? { checkpoint: checkpointOptions.checkpoint }
        : {}),
      ...((checkpointOptions?.onCheckpoint && checkpointOptions.solverVersion)
        ? {
            onCheckpoint: checkpointOptions.onCheckpoint,
            checkpointContext: {
              boardContentKey: createBoardContentKey(request.board),
              solverVersion: checkpointOptions.solverVersion,
              exactStateCodecVersion: createExactStateCodecVersion(
                board.cellCount,
                [...board.goalCellsByLabel.keys()].length,
              ),
              partitionId: null,
            },
          }
        : {}),
    };
    proofResult = await runIdaStarSearch(proofRequest, context, idaOptions);
  }

  if (proofResult.status === "solved") {
    return proofResult;
  }

  return discoveryResult;
}

// ---------------------------------------------------------------------------
// Concurrent proof (§17, §18)
// ---------------------------------------------------------------------------

type ProofMessageListener = (event: { data: unknown }) => void;
type ProofErrorListener = (event: { message?: string; error?: unknown }) => void;

export interface SokomindProofWorker {
  postMessage(message: ProofCommand): void;
  addEventListener(
    type: "message",
    listener: ProofMessageListener,
  ): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: ProofErrorListener,
  ): void;
  removeEventListener(
    type: "message",
    listener: ProofMessageListener,
  ): void;
  removeEventListener(
    type: "error" | "messageerror",
    listener: ProofErrorListener,
  ): void;
  terminate(): void;
}

interface PartitionTracker {
  readonly partitionId: string;
  readonly prefixCost: number;
  readonly worker: SokomindProofWorker;
  lowerBound: number;
  completed: boolean;
  exhausted: boolean;
  failed: boolean;
}

export interface ConcurrentProofOptions {
  readonly createProofWorker: () => SokomindProofWorker;
  readonly proofParallelism: number;
}

export async function runConcurrentProof(
  request: SolverRequest,
  context: SolverExecutionContext,
  options: SokomindRequestOptions,
  discoveryResult: SolverResult,
  concurrentOptions: ConcurrentProofOptions,
): Promise<SolverResult> {
  if (discoveryResult.status !== "solved") {
    return discoveryResult;
  }

  const board = compileSearchBoard(request.board);
  const boxCount = request.snapshot.boxes.length;

  let algorithm: ProofAlgorithm;
  if (options.proofAlgorithm === "auto") {
    algorithm = selectProofAlgorithm(board, boxCount, request.limits?.maxMemoryBytes);
  } else {
    algorithm = options.proofAlgorithm;
  }

  const partitions = enumerateFirstPushPartitions(request, board);

  if (partitions.length === 0) {
    return discoveryResult;
  }

  const globalU = discoveryResult.solution.moves;
  let bestSolution: SolverSolution = discoveryResult.solution;
  let bestCost = globalU;
  const proofAlgorithmLabel: SolverProofAlgorithm =
    concurrentOptions.proofParallelism > 1
      ? (algorithm === "astar" ? "parallel-move-astar" : "parallel-move-ida-star")
      : (algorithm === "astar" ? "move-astar" : "move-ida-star");

  const workerCount = Math.min(
    concurrentOptions.proofParallelism,
    partitions.length,
  );

  const workers: SokomindProofWorker[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(concurrentOptions.createProofWorker());
  }

  const trackers: PartitionTracker[] = partitions.map((p, i) => ({
    partitionId: p.partitionId,
    prefixCost: p.prefixCost,
    worker: workers[i % workerCount],
    lowerBound: 0,
    completed: false,
    exhausted: false,
    failed: false,
  }));

  const trackerById = new Map(trackers.map((t) => [t.partitionId, t]));

  return new Promise<SolverResult>((resolve) => {
    let settled = false;

    function finish(result: SolverResult): void {
      if (settled) return;
      settled = true;
      for (const w of workers) {
        try {
          w.postMessage({ type: "proof/cancel" });
        } catch {
          // worker already terminated
        }
        w.terminate();
      }
      resolve(result);
    }

    function checkTermination(): void {
      if (settled) return;

      const allComplete = trackers.every((t) => t.completed || t.failed);
      const globalLower = Math.min(...trackers.map((t) =>
        t.failed ? 0 : t.lowerBound,
      ));

      if (allComplete) {
        const anyIncomplete = trackers.some((t) => t.failed);
        const allExhausted = trackers.every((t) => t.exhausted || t.failed);

        const proof: SolverProof = {
          objective: { kind: "moves" },
          kind: anyIncomplete ? "bounded" : "optimal",
          lowerBound: globalLower,
          upperBound: bestCost,
          gap: bestCost - globalLower,
          algorithm: proofAlgorithmLabel,
        };

        if (allExhausted && bestCost === globalU && !anyIncomplete) {
          proof satisfies SolverProof;
        }

        finish({
          status: "solved",
          solution: { ...bestSolution, optimality: anyIncomplete ? "unknown" : "proven" },
          metrics: discoveryResult.metrics,
          proof,
        });
        return;
      }

      if (globalLower >= bestCost) {
        finish({
          status: "solved",
          solution: { ...bestSolution, optimality: "proven" },
          metrics: discoveryResult.metrics,
          proof: {
            objective: { kind: "moves" },
            kind: "optimal",
            lowerBound: globalLower,
            upperBound: bestCost,
            gap: 0,
            algorithm: proofAlgorithmLabel,
          },
        });
      }
    }

    function handleMessage(data: unknown): void {
      if (!isProofResult(data)) return;
      const result: ProofResult = data;

      switch (result.type) {
        case "proof/progress": {
          const tracker = trackerById.get(result.partitionId);
          if (tracker && result.lowerBound > tracker.lowerBound) {
            tracker.lowerBound = result.lowerBound;
          }
          break;
        }

        case "proof/solution": {
          const tracker = trackerById.get(result.partitionId);
          if (tracker && result.totalCost < bestCost) {
            bestCost = result.totalCost;
            bestSolution = result.solution as SolverSolution;
            for (const w of workers) {
              try {
                w.postMessage({
                  type: "solver/update-upper-bound",
                  moves: bestCost,
                });
              } catch {
                // worker already terminated
              }
            }
          }
          if (tracker) {
            tracker.completed = true;
            tracker.exhausted = true;
            tracker.lowerBound = result.totalCost;
          }
          checkTermination();
          break;
        }

        case "proof/partition-complete": {
          const tracker = trackerById.get(result.partitionId);
          if (tracker) {
            tracker.completed = true;
            tracker.exhausted = result.exhausted;
            if (result.lowerBound > tracker.lowerBound) {
              tracker.lowerBound = result.lowerBound;
            }
          }
          checkTermination();
          break;
        }

        case "proof/error": {
          const tracker = trackerById.get(result.partitionId);
          if (tracker) {
            tracker.completed = true;
            tracker.failed = true;
          }
          checkTermination();
          break;
        }
      }
    }

    function handleError(partitionId: string): void {
      const tracker = trackerById.get(partitionId);
      if (tracker) {
        tracker.completed = true;
        tracker.failed = true;
      }
      checkTermination();
    }

    const messageListeners = new Map<SokomindProofWorker, ProofMessageListener>();
    const errorListeners = new Map<SokomindProofWorker, ProofErrorListener>();

    for (const worker of workers) {
      const msgListener: ProofMessageListener = (event) => handleMessage(event.data);
      const errListener: ProofErrorListener = () => {
        const assigned = trackers.filter((t) => t.worker === worker && !t.completed);
        for (const t of assigned) handleError(t.partitionId);
      };
      messageListeners.set(worker, msgListener);
      errorListeners.set(worker, errListener);
      worker.addEventListener("message", msgListener);
      worker.addEventListener("error", errListener);
    }

    const onAbort = () => {
      finish({
        status: "cancelled",
        metrics: discoveryResult.metrics,
      });
    };
    if (context.signal.aborted) {
      onAbort();
      return;
    }
    context.signal.addEventListener("abort", onAbort, { once: true });

    for (let i = 0; i < partitions.length; i++) {
      const partition = partitions[i];
      const tracker = trackers[i];
      const partitionRequest = buildPartitionRequest(request, partition);

      const localU = bestCost - partition.prefixCost;
      if (localU <= 0) {
        tracker.completed = true;
        tracker.exhausted = true;
        tracker.lowerBound = partition.prefixCost;
        continue;
      }

      const command: ProofStartPartition = {
        type: "proof/start-partition",
        partitionId: partition.partitionId,
        request: partitionRequest,
        initialUpperBound: localU,
        prefixCost: partition.prefixCost,
        prefixSteps: partition.prefixSteps,
        algorithm,
        deterministic: options.deterministic,
      };
      tracker.worker.postMessage(command);
    }

    checkTermination();
  });
}
