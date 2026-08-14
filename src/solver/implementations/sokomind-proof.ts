import type {
  SolverExecutionContext,
  SolverProofAlgorithm,
  SolverRequest,
  SolverResult,
  SolverRunMetrics,
  SolverSolution,
} from "../contracts.ts";
import { verifySolverSolution } from "../verification.ts";
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

export function remainingProofLimits(
  request: SolverRequest,
  consumed: SolverRunMetrics,
): SolverRequest["limits"] | null {
  const limits = request.limits;
  if (!limits) return undefined;
  // Solver limits are integer protocol values. Rounding down also makes the
  // hand-off deadline-safe when the discovery clock reports fractional ms.
  const maxElapsedMs = limits.maxElapsedMs === undefined
    ? undefined
    : Math.max(0, Math.floor(limits.maxElapsedMs - consumed.elapsedMs));
  const maxExpandedStates = limits.maxExpandedStates === undefined
    ? undefined
    : Math.max(0, Math.floor(
        limits.maxExpandedStates - (consumed.expandedStates ?? 0),
      ));
  const maxGeneratedStates = limits.maxGeneratedStates === undefined
    ? undefined
    : Math.max(0, Math.floor(
        limits.maxGeneratedStates - (consumed.generatedStates ?? 0),
      ));
  if (maxElapsedMs === 0 || maxExpandedStates === 0 || maxGeneratedStates === 0) {
    return null;
  }
  return {
    ...limits,
    ...(maxElapsedMs === undefined ? {} : { maxElapsedMs }),
    ...(maxExpandedStates === undefined ? {} : { maxExpandedStates }),
    ...(maxGeneratedStates === undefined ? {} : { maxGeneratedStates }),
  };
}

function mergeProofMetrics(
  discovery: SolverRunMetrics,
  proof: SolverRunMetrics,
): SolverRunMetrics {
  const discoveryCounters = discovery.counters ?? {};
  const proofCountersSource = proof.counters ?? {};
  const proofCounters = Object.fromEntries(
    Object.entries(proofCountersSource).map(([name, value]) => [
      `proof.${name}`,
      value,
    ]),
  );
  const proofCurrentMemory = proofCountersSource.currentEstimatedMemoryBytes ??
    proofCountersSource.estimatedMemoryBytes;
  const discoveryCurrentMemory = discoveryCounters.currentEstimatedMemoryBytes ??
    discoveryCounters.estimatedMemoryBytes;
  const peakEstimatedMemoryBytes = Math.max(
    discoveryCounters.peakEstimatedMemoryBytes ?? 0,
    proofCountersSource.peakEstimatedMemoryBytes ?? 0,
  );
  return Object.freeze({
    elapsedMs: discovery.elapsedMs + proof.elapsedMs,
    expandedStates:
      (discovery.expandedStates ?? 0) + (proof.expandedStates ?? 0),
    generatedStates:
      (discovery.generatedStates ?? 0) + (proof.generatedStates ?? 0),
    peakFrontierSize: Math.max(
      discovery.peakFrontierSize ?? 0,
      proof.peakFrontierSize ?? 0,
    ),
    counters: Object.freeze({
      ...discoveryCounters,
      ...proofCounters,
      proofExpandedStates: proof.expandedStates ?? 0,
      proofGeneratedStates: proof.generatedStates ?? 0,
      ...(proofCurrentMemory === undefined && discoveryCurrentMemory === undefined
        ? {}
        : {
            estimatedMemoryBytes:
              proofCurrentMemory ?? discoveryCurrentMemory ?? 0,
            currentEstimatedMemoryBytes:
              proofCurrentMemory ?? discoveryCurrentMemory ?? 0,
          }),
      ...(peakEstimatedMemoryBytes === 0
        ? {}
        : { peakEstimatedMemoryBytes }),
    }),
  });
}

function withMetrics(result: SolverResult, metrics: SolverRunMetrics): SolverResult {
  return Object.freeze({ ...result, metrics }) as SolverResult;
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

  const proofPlanningStartedAt = context.now();
  const initialProofLimits = remainingProofLimits(request, discoveryResult.metrics);
  if (initialProofLimits === null) return discoveryResult;
  const proofDeadline = initialProofLimits?.maxElapsedMs === undefined
    ? Number.POSITIVE_INFINITY
    : proofPlanningStartedAt + initialProofLimits.maxElapsedMs;

  const board = compileSearchBoard(request.board);
  const boxCount = request.snapshot.boxes.length;

  let algorithm: ProofAlgorithm;
  if (options.proofAlgorithm === "auto") {
    algorithm = selectProofAlgorithm(board, boxCount, request.limits?.maxMemoryBytes);
  } else {
    algorithm = options.proofAlgorithm;
  }

  const proofLaunchAt = context.now();
  const proofPlanningElapsedMs = Math.max(
    0,
    proofLaunchAt - proofPlanningStartedAt,
  );
  const launchElapsedMs = initialProofLimits?.maxElapsedMs === undefined
    ? undefined
    : Math.max(0, Math.floor(proofDeadline - proofLaunchAt));
  if (launchElapsedMs === 0) return discoveryResult;
  const proofLimits = initialProofLimits === undefined
    ? undefined
    : {
        ...initialProofLimits,
        ...(launchElapsedMs === undefined ? {} : { maxElapsedMs: launchElapsedMs }),
      };

  const proofRequest: SolverRequest = {
    ...request,
    limits: proofLimits,
  };
  const proofContext: SolverExecutionContext = {
    signal: context.signal,
    now: context.now,
    reportProgress(progress) {
      context.reportProgress({
        ...progress,
        elapsedMs:
          discoveryResult.metrics.elapsedMs +
          proofPlanningElapsedMs +
          progress.elapsedMs,
        ...(progress.expandedStates === undefined
          ? {}
          : {
              expandedStates:
                (discoveryResult.metrics.expandedStates ?? 0) +
                progress.expandedStates,
            }),
        ...(progress.generatedStates === undefined
          ? {}
          : {
              generatedStates:
                (discoveryResult.metrics.generatedStates ?? 0) +
                progress.generatedStates,
            }),
      });
    },
  };

  let proofResult: SolverResult;
  if (algorithm === "astar") {
    proofResult = await runExactMoveAStar(proofRequest, proofContext, { incumbent });
  } else {
    const idaOptions: ExactMoveIdaStarOptions = {
      incumbent,
      reachabilityPolicy: options.idaReachabilitySnapshots,
      snapshotPeriod: options.idaSnapshotPeriod,
      persistTransposition: false,
      ...(checkpointOptions?.checkpoint
        ? { checkpoint: checkpointOptions.checkpoint }
        : {}),
      ...((checkpointOptions?.onCheckpoint && checkpointOptions.solverVersion)
        ? {
            onCheckpoint: checkpointOptions.onCheckpoint,
            checkpointContext: {
              boardContentKey: createBoardContentKey(request.board, request.snapshot),
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
    proofResult = await runIdaStarSearch(proofRequest, proofContext, idaOptions);
  }

  const combinedMetrics = mergeProofMetrics(
    discoveryResult.metrics,
    {
      ...proofResult.metrics,
      elapsedMs: proofPlanningElapsedMs + proofResult.metrics.elapsedMs,
    },
  );
  if (proofResult.status === "solved") {
    return withMetrics(proofResult, combinedMetrics);
  }

  return withMetrics(discoveryResult, combinedMetrics);
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
  metrics?: SolverRunMetrics;
}

export interface ConcurrentProofOptions {
  readonly createProofWorker: () => SokomindProofWorker;
  readonly proofParallelism: number;
  readonly silenceTimeoutMs?: number;
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

  const proofPlanningStartedAt = context.now();
  const initialProofLimits = remainingProofLimits(request, discoveryResult.metrics);
  if (initialProofLimits === null) return discoveryResult;
  const proofDeadline = initialProofLimits?.maxElapsedMs === undefined
    ? Number.POSITIVE_INFINITY
    : proofPlanningStartedAt + initialProofLimits.maxElapsedMs;

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

  const launchElapsedMs = initialProofLimits?.maxElapsedMs === undefined
    ? undefined
    : Math.max(0, Math.floor(proofDeadline - context.now()));
  if (launchElapsedMs === 0) return discoveryResult;
  const proofLimits = initialProofLimits === undefined
    ? undefined
    : {
        ...initialProofLimits,
        ...(launchElapsedMs === undefined ? {} : { maxElapsedMs: launchElapsedMs }),
      };

  if (
    (proofLimits?.maxExpandedStates !== undefined &&
      proofLimits.maxExpandedStates < partitions.length) ||
    (proofLimits?.maxGeneratedStates !== undefined &&
      proofLimits.maxGeneratedStates < partitions.length)
  ) {
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
  try {
    for (let i = 0; i < workerCount; i++) {
      workers.push(concurrentOptions.createProofWorker());
    }
  } catch {
    for (const worker of workers) worker.terminate();
    return discoveryResult;
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

  // Per-worker partition queues: only one partition runs at a time on each
  // worker to avoid shared mutable state cross-talk (abortController,
  // pendingUpperBound, activePrefixCost are module-level in the worker).
  const workerQueues = new Map<SokomindProofWorker, number[]>();
  for (const worker of workers) {
    workerQueues.set(worker, []);
  }
  for (let i = 0; i < trackers.length; i++) {
    workerQueues.get(trackers[i].worker)!.push(i);
  }

  const perPartitionLimits = proofLimits === undefined
    ? undefined
    : {
        ...proofLimits,
        ...(proofLimits.maxExpandedStates === undefined
          ? {}
          : {
              maxExpandedStates: Math.floor(
                proofLimits.maxExpandedStates / partitions.length,
              ),
            }),
        ...(proofLimits.maxGeneratedStates === undefined
          ? {}
          : {
              maxGeneratedStates: Math.floor(
                proofLimits.maxGeneratedStates / partitions.length,
              ),
            }),
        ...(proofLimits.maxMemoryBytes === undefined
          ? {}
          : {
              maxMemoryBytes: Math.floor(
                proofLimits.maxMemoryBytes / workerCount,
              ),
            }),
      };
  const proofStartedAt = proofPlanningStartedAt;

  return new Promise<SolverResult>((resolve) => {
    let settled = false;
    const activeByWorker = new Map<SokomindProofWorker, PartitionTracker>();
    const messageListeners = new Map<SokomindProofWorker, ProofMessageListener>();
    const errorListeners = new Map<SokomindProofWorker, ProofErrorListener>();
    const silenceTimers = new Map<SokomindProofWorker, ReturnType<typeof setTimeout>>();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const aggregateProofMetrics = (): SolverRunMetrics => {
      const completedTrackers = trackers.filter(
        (tracker): tracker is PartitionTracker & { metrics: SolverRunMetrics } =>
          tracker.metrics !== undefined,
      );
      const completed = completedTrackers.map((tracker) => tracker.metrics);
      const counters: Record<string, number> = {};
      const perWorkerMaxCounters = new Map<SokomindProofWorker, Record<string, number>>();
      const retainedStructureCounters = new Set([
        "retainedStates",
        "peakRetainedStates",
        "frontierSize",
        "estimatedMemoryBytes",
        "currentEstimatedMemoryBytes",
        "peakEstimatedMemoryBytes",
        "memoryStaticBytes",
        "memoryTranspositionBytes",
        "memoryHeuristicCacheBytes",
        "memoryDfsStackBytes",
        "memoryReachabilitySnapshotBytes",
        "pdbTableEntries",
        "pdbRetainedBytes",
        "interactionBoostRetainedBytes",
        "interactionBoostSearchCacheRetainedBytes",
        "deadlockTableRegions",
        "deadlockTablePatterns",
        "deadlockTableRetainedBytes",
        "preprocessingRetainedBytes",
      ]);
      const globalMaximumCounters = new Set(["maxDepth"]);
      let featureMask: number | undefined;
      let featureMaskMismatch = false;
      for (const tracker of completedTrackers) {
        const metric = tracker.metrics;
        for (const [name, value] of Object.entries(metric.counters ?? {})) {
          if (name === "exactFeatureMask") {
            if (featureMask === undefined) featureMask = value;
            else if (featureMask !== value) featureMaskMismatch = true;
            continue;
          }
          if (name === "lowerBound") continue;
          if (globalMaximumCounters.has(name)) {
            counters[name] = Math.max(counters[name] ?? 0, value);
            continue;
          }
          if (retainedStructureCounters.has(name)) {
            const maxima = perWorkerMaxCounters.get(tracker.worker) ?? {};
            maxima[name] = Math.max(maxima[name] ?? 0, value);
            perWorkerMaxCounters.set(tracker.worker, maxima);
            continue;
          }
          counters[name] = (counters[name] ?? 0) + value;
        }
      }
      for (const maxima of perWorkerMaxCounters.values()) {
        for (const [name, value] of Object.entries(maxima)) {
          counters[name] = (counters[name] ?? 0) + value;
        }
      }
      if (featureMask !== undefined) counters.exactFeatureMask = featureMask;
      if (featureMaskMismatch) counters.exactFeatureMaskMismatch = 1;
      if (trackers.length > 0) {
        counters.lowerBound = Math.min(...trackers.map(partitionLowerBound));
      }

      const perWorkerPeakFrontier = new Map<SokomindProofWorker, number>();
      for (const tracker of completedTrackers) {
        perWorkerPeakFrontier.set(
          tracker.worker,
          Math.max(
            perWorkerPeakFrontier.get(tracker.worker) ?? 0,
            tracker.metrics.peakFrontierSize ?? 0,
          ),
        );
      }
      return {
        elapsedMs: Math.max(
          0,
          context.now() - proofStartedAt,
          ...completed.map((metric) => metric.elapsedMs),
        ),
        expandedStates: completed.reduce(
          (sum, metric) => sum + (metric.expandedStates ?? 0),
          0,
        ),
        generatedStates: completed.reduce(
          (sum, metric) => sum + (metric.generatedStates ?? 0),
          0,
        ),
        peakFrontierSize: [...perWorkerPeakFrontier.values()].reduce(
          (sum, peak) => sum + peak,
          0,
        ),
        counters,
      };
    };

    const combinedMetrics = () =>
      mergeProofMetrics(discoveryResult.metrics, aggregateProofMetrics());

    const clearSilenceTimer = (worker: SokomindProofWorker): void => {
      const timer = silenceTimers.get(worker);
      if (timer !== undefined) clearTimeout(timer);
      silenceTimers.delete(worker);
    };

    const cleanup = (): void => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      context.signal.removeEventListener("abort", onAbort);
      for (const worker of workers) {
        clearSilenceTimer(worker);
        const messageListener = messageListeners.get(worker);
        const errorListener = errorListeners.get(worker);
        if (messageListener) worker.removeEventListener("message", messageListener);
        if (errorListener) {
          worker.removeEventListener("error", errorListener);
          worker.removeEventListener("messageerror", errorListener);
        }
      }
    };

    function finish(result: SolverResult): void {
      if (settled) return;
      settled = true;
      cleanup();
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

    function partitionLowerBound(t: PartitionTracker): number {
      if (t.failed) return 0;
      if (t.exhausted && t.completed) return bestCost;
      return t.lowerBound;
    }

    function solvedResult(provedOptimal: boolean, lowerBound: number): SolverResult {
      const boundedLower = Math.max(0, Math.min(lowerBound, bestCost));
      return {
        status: "solved",
        solution: {
          ...bestSolution,
          optimality: provedOptimal ? "proven" : "unknown",
        },
        metrics: combinedMetrics(),
        proof: provedOptimal
          ? {
              objective: { kind: "moves" },
              kind: "optimal",
              lowerBound: bestCost,
              upperBound: bestCost,
              gap: 0,
              algorithm: proofAlgorithmLabel,
            }
          : {
              objective: { kind: "moves" },
              kind: "bounded",
              lowerBound: boundedLower,
              upperBound: bestCost,
              gap: bestCost - boundedLower,
              algorithm: proofAlgorithmLabel,
            },
      };
    }

    function checkTermination(): void {
      if (settled) return;

      const allComplete = trackers.every((t) => t.completed || t.failed);
      const globalLower = Math.min(
        ...trackers.map((t) => partitionLowerBound(t)),
      );

      if (allComplete) {
        const allProved = trackers.every(
          (t) => !t.failed && (t.exhausted || t.lowerBound >= bestCost),
        );
        const anyFailed = trackers.some((t) => t.failed);
        const provedOptimal = allProved && !anyFailed;
        finish(solvedResult(provedOptimal, globalLower));
        return;
      }

      if (globalLower >= bestCost) {
        finish(solvedResult(true, bestCost));
      }
    }

    function failActive(worker: SokomindProofWorker): void {
      const tracker = activeByWorker.get(worker);
      if (!tracker) return;
      tracker.completed = true;
      tracker.failed = true;
      activeByWorker.delete(worker);
      clearSilenceTimer(worker);
      dispatchNext(worker);
    }

    function armSilenceTimer(worker: SokomindProofWorker): void {
      clearSilenceTimer(worker);
      const configured = concurrentOptions.silenceTimeoutMs ?? 30_000;
      const timeout = Math.max(
        1,
        Math.min(configured, proofLimits?.maxElapsedMs ?? configured),
      );
      silenceTimers.set(worker, setTimeout(() => handleWorkerError(worker), timeout));
    }

    function dispatchPartition(index: number): void {
      const partition = partitions[index];
      const tracker = trackers[index];

      const localU = bestCost - partition.prefixCost;
      if (localU <= 0) {
        tracker.completed = true;
        tracker.exhausted = true;
        tracker.lowerBound = partition.prefixCost;
        dispatchNext(tracker.worker);
        return;
      }

      activeByWorker.set(tracker.worker, tracker);

      const command: ProofStartPartition = {
        type: "proof/start-partition",
        partitionId: partition.partitionId,
        request: {
          ...buildPartitionRequest(request, partition),
          limits: perPartitionLimits,
        },
        initialUpperBound: localU,
        prefixCost: partition.prefixCost,
        prefixSteps: partition.prefixSteps,
        algorithm,
        deterministic: options.deterministic,
      };
      try {
        tracker.worker.postMessage(command);
        armSilenceTimer(tracker.worker);
      } catch {
        failActive(tracker.worker);
      }
    }

    function dispatchNext(worker: SokomindProofWorker): void {
      if (settled) return;
      const queue = workerQueues.get(worker);
      if (!queue || queue.length === 0) {
        checkTermination();
        return;
      }
      const next = queue.shift()!;
      dispatchPartition(next);
      checkTermination();
    }

    function handleMessage(worker: SokomindProofWorker, data: unknown): void {
      if (!isProofResult(data)) {
        handleWorkerError(worker);
        return;
      }
      const result: ProofResult = data;
      const tracker = trackerById.get(result.partitionId);
      const active = activeByWorker.get(worker);
      if (tracker?.completed) return;
      if (!active || tracker !== active || tracker.worker !== worker) {
        handleWorkerError(worker);
        return;
      }
      armSilenceTimer(worker);

      switch (result.type) {
        case "proof/progress": {
          tracker.metrics = {
            elapsedMs: Math.max(0, context.now() - proofStartedAt),
            expandedStates: Math.max(
              tracker.metrics?.expandedStates ?? 0,
              result.expandedStates,
            ),
            generatedStates: Math.max(
              tracker.metrics?.generatedStates ?? 0,
              result.generatedStates ?? 0,
            ),
            counters: result.counters,
          };
          if (result.lowerBound < tracker.lowerBound) {
            failActive(worker);
          } else if (result.lowerBound > tracker.lowerBound) {
            tracker.lowerBound = result.lowerBound;
          }
          break;
        }

        case "proof/solution": {
          const verification = verifySolverSolution(request, result.solution);
          if (!verification.valid || result.totalCost !== result.solution.moves) {
            failActive(worker);
            break;
          }
          if (result.totalCost < bestCost) {
            bestCost = result.totalCost;
            bestSolution = result.solution;
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
          break;
        }

        case "proof/partition-complete": {
          if (result.lowerBound < tracker.lowerBound) {
            failActive(worker);
            break;
          }
          tracker.completed = true;
          tracker.exhausted = result.exhausted;
          tracker.lowerBound = result.lowerBound;
          tracker.metrics = result.metrics;
          activeByWorker.delete(worker);
          clearSilenceTimer(worker);
          dispatchNext(worker);
          break;
        }

        case "proof/error": {
          failActive(worker);
          break;
        }
      }
    }

    function handleWorkerError(worker: SokomindProofWorker): void {
      clearSilenceTimer(worker);
      const active = activeByWorker.get(worker);
      if (active) {
        active.completed = true;
        active.failed = true;
        activeByWorker.delete(worker);
      }
      const queue = workerQueues.get(worker) ?? [];
      for (const index of queue.splice(0)) {
        trackers[index].completed = true;
        trackers[index].failed = true;
      }
      checkTermination();
    }

    for (const worker of workers) {
      const msgListener: ProofMessageListener = (event) =>
        handleMessage(worker, event.data);
      const errListener: ProofErrorListener = () => handleWorkerError(worker);
      messageListeners.set(worker, msgListener);
      errorListeners.set(worker, errListener);
      worker.addEventListener("message", msgListener);
      worker.addEventListener("error", errListener);
      worker.addEventListener("messageerror", errListener);
    }

    function onAbort(): void {
      finish({
        status: "cancelled",
        metrics: combinedMetrics(),
      });
    }
    if (context.signal.aborted) {
      onAbort();
      return;
    }
    context.signal.addEventListener("abort", onAbort, { once: true });

    if (proofLimits?.maxElapsedMs !== undefined) {
      const deadlineDelayMs = Math.max(
        0,
        Math.floor(proofDeadline - context.now()),
      );
      deadlineTimer = setTimeout(() => {
        for (const tracker of trackers) {
          if (!tracker.completed) {
            tracker.completed = true;
            tracker.failed = true;
          }
        }
        checkTermination();
      }, Math.max(1, deadlineDelayMs));
    }

    // Dispatch only the first partition to each worker; subsequent
    // partitions are queued and dispatched when the current one completes.
    for (const [, queue] of workerQueues) {
      if (queue.length > 0) {
        const first = queue.shift()!;
        dispatchPartition(first);
      }
    }

    checkTermination();
  });
}
