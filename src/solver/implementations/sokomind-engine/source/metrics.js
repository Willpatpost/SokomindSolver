// Performance timing, memory sampling, heap tracking, and productivity gates.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

let activePerformance = null;

const now = () => globalThis.performance?.now?.() ?? Date.now();

function currentHeapSample() {
  let injected = null;
  try {
    injected = globalThis.__sokomindMemoryUsage?.();
  } catch (_error) {
    injected = null;
  }
  if (Number.isFinite(injected) && injected >= 0) {
    return {bytes: Math.round(injected), source: "injected-runtime"};
  }
  const browserHeap = globalThis.performance?.memory?.usedJSHeapSize;
  return Number.isFinite(browserHeap) && browserHeap >= 0
    ? {bytes: Math.round(browserHeap), source: "browser-performance-memory"}
    : null;
}

function samplePerformanceMemory(metrics) {
  const sample = currentHeapSample();
  if (sample === null) return;
  const heap = sample.bytes;
  if (metrics._heapStartBytes === null) metrics._heapStartBytes = heap;
  metrics._heapSource = sample.source;
  metrics.heapSupported = true;
  metrics.heapUsedBytes = heap;
  metrics.heapPeakBytes = Math.max(metrics.heapPeakBytes || 0, heap);
  metrics.heapDeltaBytes = heap - metrics._heapStartBytes;
  metrics.heapSamples++;
}

function createPerformanceMetrics() {
  const metrics = {
    _startedAt: now(),
    _heapStartBytes: null,
    _heapSource: null,
    _engineMemorySampler: null,
    _engineMemoryPeakBytes: 0,
    _engineCachePeakEntries: 0,
    schemaVersion: 4,
    totalMs: 0,
    heapSupported: false,
    heapUsedBytes: null,
    heapPeakBytes: null,
    heapDeltaBytes: null,
    heapSamples: 0,
    parseMs: 0,
    graphCompileMs: 0,
    graphNodes: 0,
    graphEdges: 0,
    denseCells: 0,
    denseBuildMs: 0,
    denseLayoutBuilds: 0,
    denseLayoutDerivations: 0,
    denseTransitionCacheHits: 0,
    denseTransitionCacheEvictions: 0,
    denseIdentityUpdates: 0,
    occupancyWordsBuilt: 0,
    occupancyWordCopies: 0,
    signatureCalls: 0,
    signatureCacheHits: 0,
    signatureCharacters: 0,
    signatureMs: 0,
    packedIdentityCalls: 0,
    packedIdentityCacheHits: 0,
    packedIdentityValues: 0,
    preparedBoardReuses: 0,
    preparedBoardFallbacks: 0,
    preparedBoardHydrateMs: 0,
    preparedSeedBytes: 0,
    preparedPlayerDistanceTables: 0,
    heuristicCalls: 0,
    heuristicCacheHits: 0,
    heuristicMs: 0,
    commitmentCalls: 0,
    commitmentCacheHits: 0,
    commitmentBoxLocks: 0,
    commitmentMs: 0,
    strategicOrderingEvaluations: 0,
    strategicOrderingSkips: 0,
    strategicOrderingChanges: 0,
    strategicOrderingUseful: 0,
    strategicOrderingCooldowns: 0,
    relevanceOrderingEvaluations: 0,
    relevanceOrderingChanges: 0,
    relevanceAssignmentUses: 0,
    relevanceDependencyUses: 0,
    relevanceBottleneckUses: 0,
    relevanceRecentUses: 0,
    relevanceDoorwayUses: 0,
    relevanceRestorationUses: 0,
    relevanceGoalAccessUses: 0,
    strategicSignalEvaluations: 0,
    strategicSignalSkips: 0,
    strategicSignalUseful: 0,
    supportDependencyCalls: 0,
    supportDependencyCacheHits: 0,
    supportDependencyOptions: 0,
    supportDependencyBlockers: 0,
    supportDependencyMs: 0,
    localRoomCalls: 0,
    localRoomCacheHits: 0,
    localRoomStates: 0,
    reversePackingBuilds: 0,
    reversePackingStates: 0,
    reversePackingHits: 0,
    roomPatternBuilds: 0,
    roomPatternStates: 0,
    roomPatternHits: 0,
    roomPatternBoost: 0,
    pairConflictBuilds: 0,
    pairConflictStates: 0,
    pairConflictCandidates: 0,
    pairConflictHits: 0,
    pairConflictBoost: 0,
    capacityPatternBuilds: 0,
    capacityPatternStates: 0,
    capacityPatternHits: 0,
    capacityPatternBoost: 0,
    patternSelectionCutoffs: 0,
    goalCutCertificates: 0,
    goalCutComponents: 0,
    beamFeatureCells: 0,
    beamFeatureSelections: 0,
    beamBandSelections: 0,
    localRoomMs: 0,
    localCorralCalls: 0,
    localCorralCacheHits: 0,
    localCorralStates: 0,
    localCorralMs: 0,
    localExactProofs: 0,
    localExactCutoffs: 0,
    localExactOversized: 0,
    localExactDeadlockProofs: 0,
    localExactStateBoundPeak: 0,
    localExactDecompositions: 0,
    doorwayFlowCalls: 0,
    doorwayFlowCacheHits: 0,
    doorwayFlowMs: 0,
    doorwayScheduleCalls: 0,
    doorwayScheduleMs: 0,
    roomEvacuationCalls: 0,
    roomEvacuationMs: 0,
    goalAccessCalls: 0,
    goalAccessCacheHits: 0,
    goalAccessBlockedGoals: 0,
    goalAccessMs: 0,
    assignmentCalls: 0,
    incrementalAssignmentCalls: 0,
    incrementalAssignmentFallbacks: 0,
    incrementalAssignmentRowsReused: 0,
    pushDistanceCalls: 0,
    pushDistanceCacheHits: 0,
    pushDistanceMs: 0,
    goalTableBuilds: 0,
    goalTableStates: 0,
    goalTableHits: 0,
    goalTableMs: 0,
    reachabilityCalls: 0,
    reachabilityCacheHits: 0,
    reachabilityCells: 0,
    reachabilityMs: 0,
    pushNeighborCalls: 0,
    pushCandidates: 0,
    pushesRetained: 0,
    macroIntermediateStates: 0,
    macroHardDeadlockRejections: 0,
    macroDiscoveryRejections: 0,
    macroEgressRejections: 0,
    macroPackingRejections: 0,
    macroGoalAccessRejections: 0,
    macroTargetUnreachableStates: 0,
    macroCheapExpansions: 0,
    macroFullExpansions: 0,
    macroWidenings: 0,
    macroEndpointsRetained: 0,
    macroTargetBoundCutoffs: 0,
    planAnalysisCacheHits: 0,
    planAnalysisCacheMisses: 0,
    planAnalysisCacheEvictions: 0,
    staticDeadPrunes: 0,
    dynamicDeadPrunes: 0,
    patternDeadlockCalls: 0,
    patternDeadlockCacheHits: 0,
    patternDeadlockStates: 0,
    patternDeadlockPrunes: 0,
    patternCanonicalizations: 0,
    recursiveFreezeChecks: 0,
    recursiveFreezeBoxes: 0,
  };
  samplePerformanceMemory(metrics);
  return metrics;
}

function sampleEngineMemory(metrics) {
  if (typeof metrics._engineMemorySampler !== "function") return null;
  let sample = null;
  try {
    sample = metrics._engineMemorySampler();
  } catch (_error) {
    sample = null;
  }
  if (!sample || typeof sample !== "object") return null;
  const boardBytes = Number.isFinite(sample.boardBytes)
    ? Math.max(0, Math.round(sample.boardBytes))
    : 0;
  const cacheEntries = Number.isFinite(sample.cacheEntries)
    ? Math.max(0, Math.round(sample.cacheEntries))
    : 0;
  const cacheBytes = Number.isFinite(sample.cacheBytes)
    ? Math.max(0, Math.round(sample.cacheBytes))
    : 0;
  const currentBytes = boardBytes + cacheBytes;
  metrics._engineMemoryPeakBytes = Math.max(
    metrics._engineMemoryPeakBytes || 0,
    currentBytes,
  );
  metrics._engineCachePeakEntries = Math.max(
    metrics._engineCachePeakEntries || 0,
    cacheEntries,
  );
  return {
    boardBytes,
    cacheEntries,
    peakCacheEntries: metrics._engineCachePeakEntries,
    cacheBytes,
    currentBytes,
    peakBytes: metrics._engineMemoryPeakBytes,
  };
}

function performanceSnapshot(metrics) {
  samplePerformanceMemory(metrics);
  const engineMemory = sampleEngineMemory(metrics);
  const rounded = {
    ...metrics,
    totalMs: metrics._startedAt === null ? metrics.totalMs : now() - metrics._startedAt,
  };
  delete rounded._startedAt;
  delete rounded._heapStartBytes;
  delete rounded._heapSource;
  delete rounded._engineMemorySampler;
  delete rounded._engineMemoryPeakBytes;
  delete rounded._engineCachePeakEntries;
  rounded.memory = {
    supported: metrics.heapSupported,
    source: metrics._heapSource,
    usedBytes: metrics.heapUsedBytes,
    peakBytes: metrics.heapPeakBytes,
    deltaBytes: metrics.heapDeltaBytes,
    samples: metrics.heapSamples,
    gcControlled: false,
  };
  if (engineMemory) rounded.engineMemory = engineMemory;
  for (const key of ["totalMs", "parseMs", "graphCompileMs", "denseBuildMs",
    "preparedBoardHydrateMs", "signatureMs", "heuristicMs", "commitmentMs",
    "supportDependencyMs", "localRoomMs", "localCorralMs", "doorwayFlowMs",
    "doorwayScheduleMs", "roomEvacuationMs", "pushDistanceMs", "goalTableMs",
    "reachabilityMs"]) {
    rounded[key] = Math.round((rounded[key] || 0) * 1000) / 1000;
  }
  return rounded;
}


function createOrderingProductivityGate(warmup = 64, cooldown = 512) {
  const sampleSize = Math.max(1, Math.floor(warmup) || 1);
  const cooldownSize = Math.max(1, Math.floor(cooldown) || 1);
  let evaluated = 0, changed = 0, useful = 0, cooldownRemaining = 0;
  return {
    shouldEvaluate() {
      if (cooldownRemaining <= 0) return true;
      cooldownRemaining--;
      return false;
    },
    observe(observation) {
      const changedOrdering = typeof observation === "object"
        ? Boolean(observation.changed)
        : Boolean(observation);
      const usefulProgress = typeof observation === "object"
        ? Boolean(observation.useful)
        : changedOrdering;
      evaluated++;
      if (changedOrdering) changed++;
      if (usefulProgress) useful++;
      if (evaluated < sampleSize) return;
      if (!useful) cooldownRemaining = cooldownSize;
      evaluated = 0;
      changed = 0;
      useful = 0;
    },
    snapshot: () => ({
      evaluated,
      productive: useful,
      changed,
      useful,
      cooldownRemaining,
    }),
  };
}

// --- Module registration ---
const SokomindMetrics = {
  activePerformance,
  now,
  currentHeapSample,
  samplePerformanceMemory,
  sampleEngineMemory,
  createPerformanceMetrics,
  performanceSnapshot,
  createOrderingProductivityGate,
};
if (typeof globalThis !== "undefined") globalThis.SokomindMetrics = SokomindMetrics;
if (typeof module === "object" && module.exports) module.exports = SokomindMetrics;
