import type {
  SolverRequest,
  SolverRunMetrics,
} from "../contracts.ts";
import {
  BudgetTracker,
  type AggregateSnapshot,
  type BudgetStopReason,
} from "./sokomind-budget-tracker.ts";
import type { EngineResult } from "./sokomind-engine/engine-protocol.ts";
import {
  finiteNonNegative,
  numericProperty,
  objectRecord,
  optionalFiniteNonNegative,
  type LegacyRecord,
} from "./sokomind-legacy.ts";
import type { SokomindTuningProfile } from "./sokomind-tuning.ts";
import {
  WorkerExecutionRegistry,
  type WorkerMemoryBreakdown,
} from "./sokomind-worker-registry.ts";

export const DEFAULT_MEMORY_ESTIMATE_BYTES = 16 * 1024 * 1024;
const ESTIMATED_SEARCH_RETAINED_STATE_BYTES = 1_536;
const ESTIMATED_BIDIRECTIONAL_RETAINED_STATE_BYTES = 384;
const ESTIMATED_CACHE_ENTRY_BYTES = 384;
const ESTIMATED_FRONTIER_STATE_BYTES = 1_024;
export const ESTIMATED_RECORD_BASE_BYTES = 512;
const BIDIRECTIONAL_CLONE_RESERVE_BYTES = 1024 * 1024;
export const PROGRESS_THROTTLE_MS = 200;
export const WORKER_SILENCE_WATCHDOG_MS = 120_000;

export type PhaseStopReason = BudgetStopReason;

export interface SearchRunState {
  readonly startedAt: number;
  readonly deadline: number;
  readonly request: SolverRequest;
  readonly context: import("../contracts.ts").SolverExecutionContext;
  readonly profile: SokomindTuningProfile;
  readonly workerSilenceTimeoutMs: number;
  readonly structuralHeadStartLimitMs: number;
  readonly registry: WorkerExecutionRegistry;
  readonly budget: BudgetTracker;
  rejectedCandidates: number;
  completedWorkers: number;
  phaseTimeouts: number;
  watchdogTimeouts: number;
  lastProgressAt: number;
  progressPhase: "searching" | "harvesting" | "improving";
  initialSolutionMoves: number;
  bestSolutionMoves: number;
  solutionImprovements: number;
  suppressedImprovementErrors: number;
  suppressedHarvestErrors: number;
  aggregateGeneration: number;
  cachedAggregate: AggregateSnapshot | null;
}

export function elapsed(run: SearchRunState): number {
  return Math.max(0, run.context.now() - run.startedAt);
}

function valueFromPerformance(
  performance: Readonly<Record<string, unknown>>,
  key: string,
): number {
  return numericProperty(performance, key);
}

function laneCounterStem(id: string): string {
  return id
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

export function invalidateAggregate(run: SearchRunState): void {
  run.aggregateGeneration += 1;
}

export function aggregate(run: SearchRunState): AggregateSnapshot {
  if (run.cachedAggregate !== null && run.aggregateGeneration === 0) {
    return run.cachedAggregate;
  }
  run.aggregateGeneration = 0;

  let expandedStates = 0;
  let generatedStates = 0;
  let frontierSize = 0;
  let retainedStates = 0;
  let peakRetainedStates = 0;
  let currentWorkerMemoryBytes = 0;
  let browserProcessMemoryBytes = 0;
  let peakBrowserProcessMemoryBytes = 0;
  let currentMemory =
    run.budget.coordinatorEstimatedMemoryBytes +
    run.budget.preparedBoardEstimatedMemoryBytes;
  let historicalPeakCandidate = currentMemory;
  const memoryBreakdown = {
    runtimeBytes: 0,
    boardBytes: 0,
    retainedBytes: 0,
    frontierBytes: 0,
    cacheBytes: 0,
    arenaBytes: 0,
    recordBytes: 0,
    isolateSampleBytes: 0,
  };
  const laneCounters: Record<string, number> = {};
  let heuristicCalls = 0;
  let reachabilityFloods = 0;
  let deadlockPrunes = 0;
  let infeasiblePrunes = 0;

  for (const [id, telemetry] of run.registry.entries()) {
    expandedStates += telemetry.visited;
    generatedStates += telemetry.generatedForLimit;
    peakRetainedStates += telemetry.peakRetained;
    const stem = laneCounterStem(id);
    laneCounters[`memoryCurrent${stem}Bytes`] = telemetry.active
      ? telemetry.estimatedMemoryBytes
      : 0;
    laneCounters[`memoryPeak${stem}Bytes`] =
      telemetry.peakEstimatedMemoryBytes;
    laneCounters[`memoryCurrent${stem}ProcessBytes`] = telemetry.active
      ? telemetry.processMemoryBytes
      : 0;
    laneCounters[`memoryPeak${stem}ProcessBytes`] =
      telemetry.peakProcessMemoryBytes;
    laneCounters[`memory${stem}RetainedStates`] = telemetry.active
      ? telemetry.retained
      : 0;
    laneCounters[`memory${stem}FrontierStates`] = telemetry.active
      ? telemetry.frontier
      : 0;
    laneCounters[`memory${stem}CacheBytes`] = telemetry.active
      ? telemetry.memoryBreakdown.cacheBytes
      : 0;
    if (telemetry.active) {
      frontierSize += telemetry.frontier;
      retainedStates += telemetry.retained;
      currentWorkerMemoryBytes += telemetry.estimatedMemoryBytes;
      currentMemory += telemetry.estimatedMemoryBytes;
      historicalPeakCandidate += telemetry.peakEstimatedMemoryBytes;
      for (const key of Object.keys(
        memoryBreakdown,
      ) as (keyof WorkerMemoryBreakdown)[]) {
        memoryBreakdown[key] += telemetry.memoryBreakdown[key];
      }
      browserProcessMemoryBytes = Math.max(
        browserProcessMemoryBytes,
        telemetry.processMemoryBytes,
      );
    }
    peakBrowserProcessMemoryBytes = Math.max(
      peakBrowserProcessMemoryBytes,
      telemetry.peakProcessMemoryBytes,
    );
    const performance = telemetry.performance;
    heuristicCalls += valueFromPerformance(performance, "heuristicCalls");
    reachabilityFloods += valueFromPerformance(
      performance,
      "reachabilityCalls",
    );
    deadlockPrunes +=
      valueFromPerformance(performance, "staticDeadPrunes") +
      valueFromPerformance(performance, "dynamicDeadPrunes") +
      valueFromPerformance(performance, "patternDeadlockPrunes");
    infeasiblePrunes +=
      valueFromPerformance(performance, "macroDiscoveryRejections") +
      valueFromPerformance(performance, "macroPackingRejections") +
      valueFromPerformance(performance, "macroGoalAccessRejections");
  }
  currentMemory = Math.max(currentMemory, browserProcessMemoryBytes);
  historicalPeakCandidate = Math.max(
    historicalPeakCandidate,
    peakBrowserProcessMemoryBytes,
  );
  run.budget.peakFrontierSize = Math.max(run.budget.peakFrontierSize, frontierSize);
  run.budget.peakEstimatedMemoryBytes = Math.max(
    run.budget.peakEstimatedMemoryBytes,
    currentMemory,
    historicalPeakCandidate,
  );
  const snapshot = Object.freeze({
    expandedStates,
    generatedStates,
    frontierSize,
    peakFrontierSize: run.budget.peakFrontierSize,
    estimatedMemoryBytes: currentMemory,
    peakEstimatedMemoryBytes: run.budget.peakEstimatedMemoryBytes,
    counters: Object.freeze({
      uniqueStates: expandedStates,
      duplicateStates: Math.max(0, generatedStates - expandedStates),
      retainedStates,
      peakRetainedStates,
      deadlockPrunes,
      infeasiblePrunes,
      heuristicCalls,
      reachabilityFloods,
      estimatedMemoryBytes: currentMemory,
      currentEstimatedMemoryBytes: currentMemory,
      peakEstimatedMemoryBytes: run.budget.peakEstimatedMemoryBytes,
      currentWorkerMemoryBytes,
      currentCoordinatorMemoryBytes:
        run.budget.coordinatorEstimatedMemoryBytes,
      currentPreparedBoardMemoryBytes:
        run.budget.preparedBoardEstimatedMemoryBytes,
      workerRuntimeMemoryBytes: memoryBreakdown.runtimeBytes,
      workerBoardMemoryBytes: memoryBreakdown.boardBytes,
      workerRetainedMemoryBytes: memoryBreakdown.retainedBytes,
      workerFrontierMemoryBytes: memoryBreakdown.frontierBytes,
      workerCacheMemoryBytes: memoryBreakdown.cacheBytes,
      workerArenaMemoryBytes: memoryBreakdown.arenaBytes,
      workerRecordMemoryBytes: memoryBreakdown.recordBytes,
      workerIsolateSampleBytes: memoryBreakdown.isolateSampleBytes,
      browserProcessMemoryBytes,
      peakBrowserProcessMemoryBytes,
      workersCompleted: run.completedWorkers,
      rejectedCandidates: run.rejectedCandidates,
      phaseTimeouts: run.phaseTimeouts,
      watchdogTimeouts: run.watchdogTimeouts,
      coordinatorRecords: run.budget.coordinatorRecordCount,
      peakCoordinatorRecords: run.budget.peakCoordinatorRecordCount,
      initialSolutionMoves: run.initialSolutionMoves,
      bestSolutionMoves: run.bestSolutionMoves,
      solutionImprovements: run.solutionImprovements,
      ...laneCounters,
    }),
  });
  run.cachedAggregate = snapshot;
  return snapshot;
}

export function metrics(run: SearchRunState): SolverRunMetrics {
  const snapshot = aggregate(run);
  const suppressedErrors =
    run.suppressedImprovementErrors + run.suppressedHarvestErrors;
  return Object.freeze({
    elapsedMs: elapsed(run),
    expandedStates: snapshot.expandedStates,
    generatedStates: snapshot.generatedStates,
    peakFrontierSize: snapshot.peakFrontierSize,
    counters: Object.freeze({
      ...snapshot.counters,
      ...(suppressedErrors > 0 ? {
        suppressedImprovementErrors: run.suppressedImprovementErrors,
        suppressedHarvestErrors: run.suppressedHarvestErrors,
      } : {}),
    }),
  });
}

export function report(
  run: SearchRunState,
  detail: string,
  force = false,
): void {
  const now = run.context.now();
  if (!force && now - run.lastProgressAt < PROGRESS_THROTTLE_MS) return;
  run.lastProgressAt = now;
  const snapshot = aggregate(run);
  run.context.reportProgress({
    phase: run.progressPhase,
    elapsedMs: Math.max(0, now - run.startedAt),
    expandedStates: snapshot.expandedStates,
    generatedStates: snapshot.generatedStates,
    frontierSize: snapshot.frontierSize,
    counters: snapshot.counters,
    detail,
  });
}

export function updateTelemetry(
  run: SearchRunState,
  id: string,
  message: EngineResult,
): void {
  const telemetry = run.registry.get(id);
  if (!telemetry) return;
  invalidateAggregate(run);
  if (Array.isArray(message.records)) {
    telemetry.publishedRecords += message.records.length;
  }
  telemetry.visited = Math.max(
    telemetry.visited,
    finiteNonNegative(message.visited),
    telemetry.publishedRecords,
  );
  telemetry.generated = Math.max(
    telemetry.generated,
    finiteNonNegative(message.generated),
  );
  const currentFrontier = optionalFiniteNonNegative(message.frontier);
  if (currentFrontier !== undefined) {
    telemetry.frontier = currentFrontier;
  }
  telemetry.peakFrontier = Math.max(
    telemetry.peakFrontier,
    finiteNonNegative(message.peakFrontier),
    telemetry.frontier,
  );
  const currentRetained =
    optionalFiniteNonNegative(message.retained) ??
    optionalFiniteNonNegative(message.arenaStates);
  if (currentRetained !== undefined) {
    telemetry.retained = currentRetained;
  }
  telemetry.peakRetained = Math.max(
    telemetry.peakRetained,
    telemetry.retained,
  );
  if (
    typeof message.performance === "object" &&
    message.performance !== null
  ) {
    telemetry.performance = message.performance;
  }
  const exactGenerated =
    typeof message.generated === "number" &&
    Number.isFinite(message.generated) &&
    message.generated >= 0;
  telemetry.generatedForLimit = Math.max(
    telemetry.generatedForLimit,
    exactGenerated
      ? finiteNonNegative(message.generated)
      : valueFromPerformance(telemetry.performance, "pushCandidates"),
  );
  const floorCells = run.request.board.floor.length;
  const fallbackBoardBytes =
    floorCells * 4 * 1024 +
    floorCells * run.request.board.goals.length * 64;
  const engineMemory = objectRecord(telemetry.performance.engineMemory);
  const boardBytes = Math.max(
    fallbackBoardBytes,
    finiteNonNegative(engineMemory?.boardBytes),
  );
  const cacheEntries = finiteNonNegative(engineMemory?.cacheEntries);
  const cacheBytes = Math.max(
    finiteNonNegative(engineMemory?.cacheBytes),
    cacheEntries * ESTIMATED_CACHE_ENTRY_BYTES,
  );
  const arenaBytes =
    finiteNonNegative(message.compactArenaAllocatedBytes) +
    finiteNonNegative(message.compactPathBytes);
  const retainedEntries =
    telemetry.mode === "search"
      ? telemetry.retained
      : Math.max(
          telemetry.retained,
          telemetry.visited,
          telemetry.publishedRecords,
        );
  const retainedBytes =
    telemetry.mode === "search" && arenaBytes === 0
      ? retainedEntries * ESTIMATED_SEARCH_RETAINED_STATE_BYTES
      : 0;
  const recordBytes =
    telemetry.mode === "search"
      ? 0
      : retainedEntries *
        ESTIMATED_BIDIRECTIONAL_RETAINED_STATE_BYTES;
  const frontierBytes =
    telemetry.frontier * ESTIMATED_FRONTIER_STATE_BYTES;
  const runtimeBytes =
    DEFAULT_MEMORY_ESTIMATE_BYTES +
    (telemetry.mode === "search"
      ? 0
      : BIDIRECTIONAL_CLONE_RESERVE_BYTES);
  const fallbackMemory =
    runtimeBytes +
    boardBytes +
    retainedBytes +
    frontierBytes +
    cacheBytes +
    arenaBytes +
    recordBytes;
  const memoryDetails = objectRecord(telemetry.performance.memory);
  const browserProcessSample =
    memoryDetails?.source === "browser-performance-memory";
  const reportedCurrentMemory = Math.max(
    valueFromPerformance(telemetry.performance, "heapUsedBytes"),
    finiteNonNegative(memoryDetails?.usedBytes),
  );
  const reportedPeakMemory = Math.max(
    valueFromPerformance(telemetry.performance, "heapPeakBytes"),
    finiteNonNegative(memoryDetails?.peakBytes),
  );
  telemetry.estimatedMemoryBytes =
    !browserProcessSample && reportedCurrentMemory > 0
      ? reportedCurrentMemory
      : fallbackMemory;
  telemetry.processMemoryBytes = browserProcessSample
    ? reportedCurrentMemory
    : 0;
  telemetry.peakProcessMemoryBytes = Math.max(
    telemetry.peakProcessMemoryBytes,
    browserProcessSample ? reportedPeakMemory : 0,
    telemetry.processMemoryBytes,
  );
  telemetry.peakEstimatedMemoryBytes = Math.max(
    telemetry.peakEstimatedMemoryBytes,
    telemetry.estimatedMemoryBytes,
    !browserProcessSample ? reportedPeakMemory : 0,
  );
  telemetry.memoryBreakdown = Object.freeze({
    runtimeBytes,
    boardBytes,
    retainedBytes,
    frontierBytes,
    cacheBytes,
    arenaBytes,
    recordBytes,
    isolateSampleBytes:
      !browserProcessSample && reportedCurrentMemory > 0
        ? reportedCurrentMemory
        : 0,
  });
}

export function estimateLegacyRecordBytes(record: LegacyRecord): number {
  const segmentLength =
    typeof record.segment === "string"
      ? record.segment.length
      : record.segment.reduce(
          (total: number, direction: string) => total + direction.length,
          0,
        );
  return (
    ESTIMATED_RECORD_BASE_BYTES +
    4 *
      (record.id.length +
        (record.parent?.length ?? 0) +
        segmentLength)
  );
}

export function retainLegacyRecord(
  run: SearchRunState,
  records: Map<string, LegacyRecord>,
  record: LegacyRecord,
): void {
  const previous = records.get(record.id);
  if (previous) {
    run.budget.updateRecord(
      estimateLegacyRecordBytes(previous),
      estimateLegacyRecordBytes(record),
    );
  } else {
    run.budget.retainRecord(estimateLegacyRecordBytes(record));
  }
  records.set(record.id, record);
}

export function reachedLimit(run: SearchRunState): BudgetStopReason | undefined {
  return run.budget.checkLimit(
    aggregate(run),
    run.request.limits,
    run.context.signal,
    run.context.now(),
    run.deadline,
  );
}

export function withRemainingLimits(
  run: SearchRunState,
): SolverRequest | null {
  const aggregateMetrics = aggregate(run);
  const original = run.request.limits;
  const remainingMs = Number.isFinite(run.deadline)
    ? Math.max(0, run.deadline - run.context.now())
    : undefined;
  const remainingExpanded =
    original?.maxExpandedStates === undefined
      ? undefined
      : Math.max(
          0,
          original.maxExpandedStates - aggregateMetrics.expandedStates,
        );
  const remainingGenerated =
    original?.maxGeneratedStates === undefined
      ? undefined
      : Math.max(
          0,
          original.maxGeneratedStates - aggregateMetrics.generatedStates,
        );
  if (
    remainingMs === 0 ||
    remainingExpanded === 0 ||
    remainingGenerated === 0
  ) {
    return null;
  }
  return Object.freeze({
    ...run.request,
    limits: Object.freeze({
      ...original,
      ...(remainingMs === undefined
        ? {}
        : { maxElapsedMs: Math.max(1, Math.ceil(remainingMs)) }),
      ...(remainingExpanded === undefined
        ? {}
        : { maxExpandedStates: Math.max(1, remainingExpanded) }),
      ...(remainingGenerated === undefined
        ? {}
        : { maxGeneratedStates: Math.max(1, remainingGenerated) }),
    }),
  });
}
