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
import { COORDINATOR_MEMORY_RESERVATION_BYTES } from "./sokomind-worker-limits.ts";
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
  worker?: SokomindProofWorker;
  allocatedLimits?: SolverRequest["limits"];
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

  const workerCount = Math.min(
    concurrentOptions.proofParallelism,
    partitions.length,
  );
  const perWorkerMemoryLimit = proofLimits?.maxMemoryBytes === undefined
    ? undefined
    : Math.floor(
        (proofLimits.maxMemoryBytes - COORDINATOR_MEMORY_RESERVATION_BYTES) / workerCount,
      );
  if (workerCount < 1 || (perWorkerMemoryLimit !== undefined && perWorkerMemoryLimit <= 0)) {
    return discoveryResult;
  }
  // Automatic selection must use the memory actually available to one lane.
  const algorithm: ProofAlgorithm = options.proofAlgorithm === "auto"
    ? selectProofAlgorithm(board, boxCount, perWorkerMemoryLimit)
    : options.proofAlgorithm;
  let bestSolution: SolverSolution = discoveryResult.solution;
  let bestCost = discoveryResult.solution.moves;
  const proofAlgorithmLabel: SolverProofAlgorithm = workerCount > 1
    ? (algorithm === "astar" ? "parallel-move-astar" : "parallel-move-ida-star")
    : (algorithm === "astar" ? "move-astar" : "move-ida-star");

  const workers: SokomindProofWorker[] = [];
  try {
    for (let i = 0; i < workerCount; i++) {
      workers.push(concurrentOptions.createProofWorker());
    }
  } catch {
    for (const worker of workers) worker.terminate();
    return discoveryResult;
  }

  const trackers: PartitionTracker[] = partitions.map((p) => ({
    partitionId: p.partitionId,
    prefixCost: p.prefixCost,
    lowerBound: p.prefixCost,
    completed: false,
    exhausted: false,
    failed: false,
  }));

  const trackerById = new Map(trackers.map((t) => [t.partitionId, t]));

  // Idle lanes claim the next partition; slow or failed lanes cannot strand
  // work in a private queue. Each lane still runs exactly one task at a time.
  const pendingPartitions = trackers.map((_, index) => index);

  function dynamicPartitionLimits(): typeof proofLimits | null {
    if (proofLimits === undefined) return undefined;
    const remainingCount = trackers.filter((t) => !t.worker && !t.completed).length;
    const share = (name: "maxExpandedStates" | "maxGeneratedStates"): number | undefined => {
      const total = proofLimits[name];
      if (total === undefined) return undefined;
      const metricName = name === "maxExpandedStates" ? "expandedStates" : "generatedStates";
      // Reserve the full grant of active/failed tasks. A silent lane may have
      // consumed work which has not yet reached the coordinator. Only a clean
      // completion refunds unused work; progress never makes it spendable twice.
      const committed = trackers.reduce((sum, t) => sum + (
        !t.worker ? 0
        : t.completed && !t.failed ? (t.metrics?.[metricName] ?? t.allocatedLimits?.[name] ?? 0)
        : (t.allocatedLimits?.[name] ?? 0)
      ), 0);
      return Math.floor((total - committed) / Math.max(1, remainingCount));
    };
    const maxExpandedStates = share("maxExpandedStates");
    const maxGeneratedStates = share("maxGeneratedStates");
    const maxElapsedMs = proofLimits.maxElapsedMs === undefined
      ? undefined
      : Math.max(0, Math.floor(proofDeadline - context.now()));
    if ((maxExpandedStates !== undefined && maxExpandedStates <= 0) ||
        (maxGeneratedStates !== undefined && maxGeneratedStates <= 0) || maxElapsedMs === 0) return null;
    return {
      ...proofLimits,
      ...(maxElapsedMs === undefined ? {} : { maxElapsedMs }),
      ...(maxExpandedStates === undefined ? {} : { maxExpandedStates }),
      ...(maxGeneratedStates === undefined ? {} : { maxGeneratedStates }),
      ...(perWorkerMemoryLimit === undefined
        ? {}
        : { maxMemoryBytes: perWorkerMemoryLimit }),
    };
  }

  const proofStartedAt = proofPlanningStartedAt;

  return new Promise<SolverResult>((resolve) => {
    let settled = false;
    const activeByWorker = new Map<SokomindProofWorker, PartitionTracker>();
    const unavailableWorkers = new Set<SokomindProofWorker>();
    const messageListeners = new Map<SokomindProofWorker, ProofMessageListener>();
    const errorListeners = new Map<SokomindProofWorker, ProofErrorListener>();
    const silenceTimers = new Map<SokomindProofWorker, ReturnType<typeof setTimeout>>();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let lastProgressAt = Number.NEGATIVE_INFINITY;

    const aggregateProofMetrics = (): SolverRunMetrics => {
      const completedTrackers = trackers.filter(
        (tracker): tracker is PartitionTracker & {
          metrics: SolverRunMetrics; worker: SokomindProofWorker;
        } => tracker.metrics !== undefined && tracker.worker !== undefined,
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
        "pdbSearchCacheRetainedBytes",
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
      counters.proofWorkerCount = workerCount;
      counters.activeProofWorkers = activeByWorker.size;
      counters.pendingProofPartitions = pendingPartitions.length;
      counters.completedProofPartitions = trackers.filter((t) => t.completed).length;

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

    function reportProgress(force = false): void {
      const now = context.now();
      if (!force && now - lastProgressAt < 100) return;
      lastProgressAt = now;
      const metrics = combinedMetrics();
      const lowerBound = Math.min(bestCost, ...trackers.map(committedLowerBound));
      const provisionalBound = Math.min(bestCost, ...trackers.map(partitionLowerBound));
      context.reportProgress({
        phase: "proving",
        elapsedMs: metrics.elapsedMs,
        expandedStates: metrics.expandedStates,
        generatedStates: metrics.generatedStates,
        counters: metrics.counters,
        incumbent: {
          moves: bestCost,
          pushes: bestSolution.pushes,
          objectiveScore: bestCost,
        },
        lowerBound,
        upperBound: bestCost,
        gap: bestCost - lowerBound,
        detail: `Proving optimality: ${activeByWorker.size} active workers, ${pendingPartitions.length} pending partitions` +
          (provisionalBound > lowerBound ? `, provisional lower bound ${provisionalBound}` : ""),
      });
    }

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
      // Prefix length is independently known even if the lane fails. Discard
      // worker-provided bounds on failure, while preserving this safe minimum.
      if (t.failed) return Math.min(t.prefixCost, bestCost);
      if (t.exhausted && t.completed) return bestCost;
      return t.lowerBound;
    }

    // Published progress bounds may never fall. A running lane's own bound is
    // withdrawn if the lane later fails, so it counts only once the partition
    // completes; until then the detail text shows it as provisional.
    function committedLowerBound(t: PartitionTracker): number {
      return t.completed ? partitionLowerBound(t) : t.prefixCost;
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

    function atDeadline(): boolean {
      if (settled) return true;
      if (context.signal.aborted) {
        onAbort();
        return true;
      }
      if (context.now() >= proofDeadline) {
        finish(solvedResult(false, Math.min(...trackers.map(partitionLowerBound))));
        return true;
      }
      return false;
    }

    function failActive(worker: SokomindProofWorker): void {
      handleWorkerError(worker);
    }

    function exceedsWorkGrant(tracker: PartitionTracker, metrics: SolverRunMetrics): boolean {
      const limits = tracker.allocatedLimits;
      return (limits?.maxExpandedStates !== undefined &&
        (metrics.expandedStates ?? 0) > limits.maxExpandedStates) ||
        (limits?.maxGeneratedStates !== undefined &&
          (metrics.generatedStates ?? 0) > limits.maxGeneratedStates);
    }

    function armSilenceTimer(worker: SokomindProofWorker): void {
      clearSilenceTimer(worker);
      const configured = concurrentOptions.silenceTimeoutMs ?? 30_000;
      const timeout = Math.max(
        1,
        Math.min(configured, proofDeadline - context.now()),
      );
      silenceTimers.set(worker, setTimeout(() => handleWorkerError(worker), timeout));
    }

    function dispatchPartition(index: number, worker: SokomindProofWorker): void {
      if (atDeadline()) return;
      const partition = partitions[index];
      const tracker = trackers[index];

      const localU = bestCost - partition.prefixCost;
      if (localU <= 0) {
        tracker.completed = true;
        tracker.exhausted = true;
        tracker.lowerBound = partition.prefixCost;
        dispatchNext(worker);
        return;
      }

      const limits = dynamicPartitionLimits();
      if (limits === null) {
        tracker.completed = true;
        tracker.failed = true;
        dispatchNext(worker);
        return;
      }
      tracker.worker = worker;
      tracker.allocatedLimits = limits;
      activeByWorker.set(worker, tracker);

      const command: ProofStartPartition = {
        type: "proof/start-partition",
        partitionId: partition.partitionId,
        request: {
          ...buildPartitionRequest(request, partition),
          limits,
        },
        initialUpperBound: localU,
        prefixCost: partition.prefixCost,
        prefixSteps: partition.prefixSteps,
        algorithm,
        deterministic: options.deterministic,
      };
      try {
        worker.postMessage(command);
        armSilenceTimer(worker);
      } catch {
        handleWorkerError(worker);
      }
    }

    function dispatchNext(worker: SokomindProofWorker): void {
      if (atDeadline() || unavailableWorkers.has(worker) || activeByWorker.has(worker)) return;
      if (pendingPartitions.length === 0) {
        checkTermination();
        return;
      }
      const next = pendingPartitions.shift()!;
      dispatchPartition(next, worker);
      checkTermination();
    }

    function handleMessage(worker: SokomindProofWorker, data: unknown): void {
      if (atDeadline() || unavailableWorkers.has(worker)) return;
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
          if (result.lowerBound < tracker.lowerBound || exceedsWorkGrant(tracker, tracker.metrics)) {
            failActive(worker);
          } else if (result.lowerBound > tracker.lowerBound) {
            tracker.lowerBound = result.lowerBound;
          }
          checkTermination();
          if (!settled) reportProgress();
          break;
        }

        case "proof/solution": {
          const verification = verifySolverSolution(request, result.solution);
          if (atDeadline()) return;
          if (!verification.valid || result.totalCost !== result.solution.moves || result.solution.moves < tracker.prefixCost) {
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
            checkTermination();
            if (!settled) reportProgress(true);
          }
          break;
        }

        case "proof/partition-complete": {
          if (result.lowerBound < tracker.lowerBound || exceedsWorkGrant(tracker, result.metrics) ||
              (result.metrics.expandedStates ?? 0) < (tracker.metrics?.expandedStates ?? 0) ||
              (result.metrics.generatedStates ?? 0) < (tracker.metrics?.generatedStates ?? 0)) {
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
          if (!settled) reportProgress();
          break;
        }

        case "proof/error": {
          failActive(worker);
          break;
        }
      }
    }

    function handleWorkerError(worker: SokomindProofWorker): void {
      if (settled || unavailableWorkers.has(worker)) return;
      unavailableWorkers.add(worker);
      try {
        worker.postMessage({ type: "proof/cancel" });
      } catch {
        // A crashed lane may no longer accept commands.
      }
      worker.terminate();
      clearSilenceTimer(worker);
      const active = activeByWorker.get(worker);
      if (active) {
        active.completed = true;
        active.failed = true;
        activeByWorker.delete(worker);
      }
      if (workers.every((lane) => unavailableWorkers.has(lane))) {
        for (const index of pendingPartitions.splice(0)) {
          trackers[index].completed = true;
          trackers[index].failed = true;
        }
      } else {
        for (const lane of workers) dispatchNext(lane);
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
        finish(solvedResult(false, Math.min(...trackers.map(partitionLowerBound))));
      }, Math.max(1, deadlineDelayMs));
    }

    for (const worker of workers) dispatchNext(worker);

    checkTermination();
    if (!settled) reportProgress(true);
  });
}
