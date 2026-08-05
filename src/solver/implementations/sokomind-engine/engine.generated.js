/*
 * GENERATED FILE - DO NOT EDIT DIRECTLY.
 *
 * Regenerate with: npm run prepare:sokomind-solver
 *
 * Provenance:
 * - baseline search engine: ../Sokomind/src
 * - assignment heuristic: ../Sokomind/src/heuristic.js
 * - adapter protocol: record telemetry and structural generated-state cap
 *
 * The source modules are vendored beside this file. They are concatenated
 * because the original engine is a classic-worker script family whose
 * declarations intentionally share one lexical scope.
 */

/* ===== state.js ===== */
// State identity, box signatures, dense box layouts, and core constants.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

const DIRS = {Up: [-1, 0], Down: [1, 0], Left: [0, -1], Right: [0, 1]};
const DIRECTION_ENTRIES = Object.entries(DIRS);
const OPPOSITE_DIRECTION_INDEX = [1, 0, 3, 2];
const OPPOSITE = {Up: "Down", Down: "Up", Left: "Right", Right: "Left"};
const MOVE_CODE = {Up: "U", Down: "D", Left: "L", Right: "R"};
const pkey = (y, x) => `${y},${x}`;
function cellId(y, x, dense) {
  const index = y * dense.width + x;
  return (index >= 0 && index < dense.idByYX.length) ? dense.idByYX[index] : -1;
}
function boxSignatureReference(boxes) {
  return boxes.map(box => box.join(",")).sort().join(";");
}

function packedIdentityFromTokens(tokens, board) {
  const sorted = Uint32Array.from(tokens);
  sorted.sort();
  const shift = BigInt(board.dense.tokenBits);
  let identity = BigInt(tokens.length);
  for (const value of sorted) identity = (identity << shift) | BigInt(value);
  // Pre-compute Zobrist hash for O(1) incremental identity derivation.
  const {zobristHi, zobristLo} = board.dense;
  let zHi = 0, zLo = 0;
  for (let i = 0; i < tokens.length; i++) {
    zHi = (zHi ^ zobristHi[tokens[i]]) >>> 0;
    zLo = (zLo ^ zobristLo[tokens[i]]) >>> 0;
  }
  return {
    identity,
    zobristHi: zHi,
    zobristLo: zLo,
    signature: [...sorted].map(value => value.toString(36)).join("."),
  };
}

function denseBoxLayout(boxes, board) {
  const cached = board.denseBoxMemo.get(boxes);
  if (cached) return cached;
  const cells = new Uint32Array(boxes.length);
  const labels = new Uint16Array(boxes.length);
  const tokens = new Uint32Array(boxes.length);
  const indexByCell = new Int32Array(board.dense.keys.length);
  const occupancyBits = new Uint32Array(Math.ceil(board.dense.keys.length / 32));
  indexByCell.fill(-1);
  let valid = true;
  for (let index = 0; index < boxes.length; index++) {
    const [y, x, label] = boxes[index];
    const cell = cellId(y, x, board.dense);
    const labelId = board.dense.labelIds.get(label);
    if (cell < 0 || labelId === undefined) {
      valid = false;
      continue;
    }
    cells[index] = cell;
    labels[index] = labelId;
    tokens[index] = labelId * board.dense.keys.length + cell;
    indexByCell[cell] = index;
    occupancyBits[cell >>> 5] |= 1 << (cell & 31);
  }
  const packed = valid
    ? packedIdentityFromTokens(tokens, board)
    : {identity: null, signature: boxSignatureReference(boxes)};
  const layout = {
    cells,
    labels,
    tokens,
    orderedSignature: tokens.join("."),
    indexByCell,
    occupancyBits,
    valid,
    ...packed,
  };
  board.denseBoxMemo.set(boxes, layout);
  board.metrics.denseLayoutBuilds++;
  board.metrics.occupancyWordsBuilt += occupancyBits.length;
  return layout;
}

function deriveDenseBoxLayout(parentBoxes, boxes, changedIndex, destinationId, board) {
  const parent = denseBoxLayout(parentBoxes, board);
  if (!parent.valid) {
    denseBoxLayout(boxes, board);
    return;
  }
  const cells = parent.cells.slice();
  const labels = parent.labels;
  const tokens = parent.tokens.slice();
  const indexByCell = parent.indexByCell.slice();
  const occupancyBits = parent.occupancyBits.slice();
  const previousId = cells[changedIndex];
  const oldToken = tokens[changedIndex];
  cells[changedIndex] = destinationId;
  const newToken = labels[changedIndex] * board.dense.keys.length + destinationId;
  tokens[changedIndex] = newToken;
  indexByCell[previousId] = -1;
  indexByCell[destinationId] = changedIndex;
  occupancyBits[previousId >>> 5] &= ~(1 << (previousId & 31));
  occupancyBits[destinationId >>> 5] |= 1 << (destinationId & 31);
  const packed = packedIdentityFromTokens(tokens, board);
  board.denseBoxMemo.set(boxes, {
    cells,
    labels,
    tokens,
    orderedSignature: tokens.join("."),
    indexByCell,
    occupancyBits,
    valid: true,
    ...packed,
  });
  board.metrics.denseLayoutDerivations++;
  board.metrics.occupancyWordCopies += occupancyBits.length;
  board.metrics.denseIdentityUpdates++;
}

function cachedPushedBoxes(parentBoxes, changedIndex, destinationId, label, board) {
  const parentLayout = denseBoxLayout(parentBoxes, board);
  const key = `${parentLayout.orderedSignature}|${changedIndex}|${destinationId}`;
  const cached = memoLookup(board.pushTransitionMemo, key);
  if (cached) {
    board.metrics.denseTransitionCacheHits++;
    return cached;
  }
  const boxes = parentBoxes.slice();
  boxes[changedIndex] = [
    board.dense.y[destinationId],
    board.dense.x[destinationId],
    label,
  ];
  deriveDenseBoxLayout(parentBoxes, boxes, changedIndex, destinationId, board);
  if (board.pushTransitionMemo.size >= PUSH_TRANSITION_MEMO_LIMIT) {
    board.pushTransitionMemo.delete(board.pushTransitionMemo.keys().next().value);
    board.metrics.denseTransitionCacheEvictions++;
  }
  board.pushTransitionMemo.set(key, boxes);
  return boxes;
}

function boxSignature(boxes, board = null) {
  const metrics = board?.metrics;
  if (metrics) metrics.signatureCalls++;
  if (board?.boxSignatureMemo.has(boxes)) {
    metrics.signatureCacheHits++;
    return board.boxSignatureMemo.get(boxes);
  }
  const started = metrics ? now() : 0;
  let signature = null;
  if (board) {
    signature = denseBoxLayout(boxes, board).signature;
  }
  signature ??= boxSignatureReference(boxes);
  if (board) board.boxSignatureMemo.set(boxes, signature);
  if (metrics) {
    metrics.signatureMs += now() - started;
    metrics.signatureCharacters += signature.length;
  }
  return signature;
}

function packedBoxIdentity(boxes, board) {
  const metrics = board.metrics;
  metrics.packedIdentityCalls++;
  if (board.boxIdentityMemo.has(boxes)) {
    metrics.packedIdentityCacheHits++;
    return board.boxIdentityMemo.get(boxes);
  }
  const layout = denseBoxLayout(boxes, board);
  if (!layout.valid) {
    throw new Error("Cannot densely encode a box outside the prepared board.");
  }
  const identity = layout.identity;
  board.boxIdentityMemo.set(boxes, identity);
  metrics.packedIdentityValues += layout.tokens.length;
  return identity;
}

function denseStateIdentity(state, board, robotId) {
  if (robotId === undefined || robotId < 0) return exactPushKey(state, board);
  return (packedBoxIdentity(state.boxes, board) << BigInt(board.dense.cellBits)) |
    BigInt(robotId);
}

function exactPushIdentity(state, board) {
  const robotId = cellId(state.robot[0], state.robot[1], board.dense);
  return denseStateIdentity(state, board, robotId >= 0 ? robotId : undefined);
}

function pushIdentity(state, reachable) {
  if (reachable.board && reachable.regionId !== undefined) {
    return denseStateIdentity(state, reachable.board, reachable.regionId);
  }
  return pushKey(state, reachable);
}

function exactPushKey(state, board = null) {
  const robotId = board?.dense ? cellId(state.robot[0], state.robot[1], board.dense) : -1;
  const robot = robotId < 0 ? state.robot.join(",") : robotId.toString(36);
  return `${robot}|${boxSignature(state.boxes, board)}`;
}

// --- Module registration ---
const SokomindState = {
  DIRS,
  DIRECTION_ENTRIES,
  OPPOSITE_DIRECTION_INDEX,
  OPPOSITE,
  MOVE_CODE,
  pkey,
  cellId,
  boxSignatureReference,
  packedIdentityFromTokens,
  denseBoxLayout,
  deriveDenseBoxLayout,
  cachedPushedBoxes,
  boxSignature,
  packedBoxIdentity,
  denseStateIdentity,
  exactPushIdentity,
  pushIdentity,
  exactPushKey,
};

/* ===== memo.js ===== */
// Memo limits, bounded caching utilities, and tuning constants.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

const HEURISTIC_MEMO_LIMIT = 100000;
const DEADLOCK_MEMO_LIMIT = 50000;
const PUSH_TRANSITION_MEMO_LIMIT = 10000;
const REACHABILITY_MEMO_LIMIT = 512;
const PATTERN_DEADLOCK_MEMO_LIMIT = 50000;
const PATTERN_EXACT_STATE_LIMIT = 512;
const PATTERN_FLOOR_LIMIT = 18;
const PATTERN_BOX_LIMIT = 4;
const ROOM_PATTERN_MAX_STATES = 12000;
const ROOM_PATTERN_SELECTION_LIMIT = 512;
const PAIR_CONFLICT_MAX_STATES = 4000;
const CAPACITY_PATTERN_MAX_STATES = 20000;
const CAPACITY_PATTERN_MAX_FLOOR = 32;
const CAPACITY_PATTERN_MAX_BOXES = 3;
const PAIR_CONFLICT_DISTANCE_LIMIT = 18;
const INCREMENTAL_ASSIGNMENT_CROSSOVER = 3;
function incrementalAssignmentCrossover() {
  return INCREMENTAL_ASSIGNMENT_CROSSOVER;
}
const COMMITMENT_MEMO_LIMIT = 10000;
const SUPPORT_DEPENDENCY_MEMO_LIMIT = 5000;
const LOCAL_ROOM_MEMO_LIMIT = 5000;
const LOCAL_CORRAL_MEMO_LIMIT = 5000;
const LOCAL_EXACT_STATE_LIMIT = 250000;
const LOCAL_ROOM_CELL_LIMIT = 16;
const LOCAL_DOMAIN_CELL_LIMIT = 24;
const LOCAL_BOX_LIMIT = 5;
function localReasoningLimits() {
  return {
    patternMaxStates: PATTERN_EXACT_STATE_LIMIT,
    patternMaxFloor: PATTERN_FLOOR_LIMIT,
    patternMaxBoxes: PATTERN_BOX_LIMIT,
    localExactMaxStates: LOCAL_EXACT_STATE_LIMIT,
    roomMaxCells: LOCAL_ROOM_CELL_LIMIT,
    domainMaxCells: LOCAL_DOMAIN_CELL_LIMIT,
    localMaxBoxes: LOCAL_BOX_LIMIT,
  };
}
const DOORWAY_FLOW_MEMO_LIMIT = 5000;
const GOAL_ACCESS_MEMO_LIMIT = 5000;
const GOAL_COMMITMENT = Object.freeze({
  TEMPORARY: "temporary",
  CONDITIONAL: "conditional",
  PROVEN: "proven",
});

function memoLookup(memo, key) {
  const value = memo.get(key);
  if (value !== undefined) {
    memo.delete(key);
    memo.set(key, value);
  }
  return value;
}

function memoizeBounded(memo, key, value, limit = HEURISTIC_MEMO_LIMIT) {
  if (memo.size >= limit) memo.delete(memo.keys().next().value);
  memo.set(key, value);
  return value;
}

class BoundedDepthMap {
  constructor(limit) {
    this.limit = limit;
    this.values = new Map();
    this.evictions = 0;
  }
  get(key) {
    const value = this.values.get(key);
    if (value !== undefined) {
      this.values.delete(key);
      this.values.set(key, value);
    }
    return value;
  }
  has(key) { return this.values.has(key); }
  set(key, value) {
    if (this.values.has(key)) this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.limit) {
      this.values.delete(this.values.keys().next().value);
      this.evictions++;
    }
  }
  get size() { return this.values.size; }
}

// --- Module registration ---
const SokomindMemo = {
  memoLookup,
  HEURISTIC_MEMO_LIMIT,
  DEADLOCK_MEMO_LIMIT,
  PUSH_TRANSITION_MEMO_LIMIT,
  REACHABILITY_MEMO_LIMIT,
  PATTERN_DEADLOCK_MEMO_LIMIT,
  PATTERN_EXACT_STATE_LIMIT,
  PATTERN_FLOOR_LIMIT,
  PATTERN_BOX_LIMIT,
  ROOM_PATTERN_MAX_STATES,
  ROOM_PATTERN_SELECTION_LIMIT,
  PAIR_CONFLICT_MAX_STATES,
  CAPACITY_PATTERN_MAX_STATES,
  CAPACITY_PATTERN_MAX_FLOOR,
  CAPACITY_PATTERN_MAX_BOXES,
  PAIR_CONFLICT_DISTANCE_LIMIT,
  INCREMENTAL_ASSIGNMENT_CROSSOVER,
  incrementalAssignmentCrossover,
  COMMITMENT_MEMO_LIMIT,
  SUPPORT_DEPENDENCY_MEMO_LIMIT,
  LOCAL_ROOM_MEMO_LIMIT,
  LOCAL_CORRAL_MEMO_LIMIT,
  LOCAL_EXACT_STATE_LIMIT,
  LOCAL_ROOM_CELL_LIMIT,
  LOCAL_DOMAIN_CELL_LIMIT,
  LOCAL_BOX_LIMIT,
  localReasoningLimits,
  DOORWAY_FLOW_MEMO_LIMIT,
  GOAL_ACCESS_MEMO_LIMIT,
  GOAL_COMMITMENT,
  memoizeBounded,
  BoundedDepthMap,
};

/* ===== metrics.js ===== */
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

/* ===== topology.js ===== */
// Heap data structure, floor graph analysis, articulation points, and room topology.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

class Heap {
  constructor() { this.items = []; }
  push(item) {
    const a = this.items; a.push(item); let i = a.length - 1;
    while (i) { const p = (i - 1) >> 1; if (a[p][0] <= item[0]) break; a[i] = a[p]; i = p; }
    a[i] = item;
  }
  pop() {
    const a = this.items, root = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      while (true) {
        let c = i * 2 + 1; if (c >= a.length) break;
        if (c + 1 < a.length && a[c + 1][0] < a[c][0]) c++;
        if (a[c][0] >= last[0]) break; a[i] = a[c]; i = c;
      }
      a[i] = last;
    }
    return root;
  }
  retainBest(limit) {
    if (this.items.length <= limit) return;
    const kept = this.items
      .sort((left, right) => left[0] - right[0] || left[1] - right[1])
      .slice(0, limit);
    this.items = [];
    kept.forEach(item => this.push(item));
  }
  get length() { return this.items.length; }
}

function floorNeighbors(position, floor) {
  const [y, x] = position.split(",").map(Number);
  return Object.values(DIRS).map(([dy, dx]) => pkey(y + dy, x + dx))
    .filter(next => floor.has(next));
}

function floorComponents(floor, blocked = null) {
  const remaining = new Set(floor);
  if (blocked) remaining.delete(blocked);
  const components = [];
  while (remaining.size) {
    const start = remaining.values().next().value;
    const component = new Set([start]), queue = [start];
    remaining.delete(start);
    for (let head = 0; head < queue.length; head++) {
      for (const next of floorNeighbors(queue[head], floor)) {
        if (next === blocked || !remaining.has(next)) continue;
        remaining.delete(next);
        component.add(next);
        queue.push(next);
      }
    }
    components.push(component);
  }
  return components;
}

function articulationPoints(floor) {
  const discovered = new Map(), low = new Map(), parent = new Map(), result = new Set();
  let time = 0;
  const visit = position => {
    discovered.set(position, ++time);
    low.set(position, time);
    let children = 0;
    for (const next of floorNeighbors(position, floor)) {
      if (!discovered.has(next)) {
        parent.set(next, position);
        children++;
        visit(next);
        low.set(position, Math.min(low.get(position), low.get(next)));
        if (!parent.has(position) && children > 1) result.add(position);
        if (parent.has(position) && low.get(next) >= discovered.get(position)) result.add(position);
      } else if (next !== parent.get(position)) {
        low.set(position, Math.min(low.get(position), discovered.get(next)));
      }
    }
  };
  for (const position of floor) if (!discovered.has(position)) visit(position);
  return result;
}

function analyzeTopology(floor, goals) {
  const articulations = articulationPoints(floor);
  const tunnels = new Set([...floor].filter(position => {
    const neighbors = floorNeighbors(position, floor);
    if (neighbors.length !== 2) return false;
    const coordinates = neighbors.map(next => next.split(",").map(Number));
    return coordinates[0][0] === coordinates[1][0] || coordinates[0][1] === coordinates[1][1];
  }));
  const candidates = [];
  for (const gate of articulations) {
    const components = floorComponents(floor, gate).sort((left, right) => right.size - left.size);
    for (const cells of components) {
      if (cells.size < 2 || cells.size > floor.size * 0.72) continue;
      const roomGoals = [...goals.keys()].filter(goal => cells.has(goal));
      if (!roomGoals.length) continue;
      const depths = new Map(), queue = [];
      for (const neighbor of floorNeighbors(gate, floor)) {
        if (!cells.has(neighbor)) continue;
        depths.set(neighbor, 1);
        queue.push(neighbor);
      }
      for (let head = 0; head < queue.length; head++) {
        const position = queue[head], distance = depths.get(position);
        for (const next of floorNeighbors(position, floor)) {
          if (!cells.has(next) || depths.has(next)) continue;
          depths.set(next, distance + 1);
          queue.push(next);
        }
      }
      const traffic = new Map([...cells].map(cell => [cell, 0]));
      for (const goal of roomGoals) {
        const goalDistances = new Map([[goal, 0]]), goalQueue = [goal];
        for (let head = 0; head < goalQueue.length; head++) {
          const position = goalQueue[head], distance = goalDistances.get(position);
          for (const next of floorNeighbors(position, floor)) {
            if (!cells.has(next) || goalDistances.has(next)) continue;
            goalDistances.set(next, distance + 1);
            goalQueue.push(next);
          }
        }
        const goalDepth = depths.get(goal);
        for (const cell of cells) {
          if ((depths.get(cell) ?? Infinity) + (goalDistances.get(cell) ?? Infinity) === goalDepth) {
            traffic.set(cell, traffic.get(cell) + 1);
          }
        }
      }
      const dependencies = [];
      for (const blocker of roomGoals) {
        const reducedFloor = new Set(floor);
        reducedFloor.delete(blocker);
        for (const target of roomGoals) {
          if (target === blocker) continue;
          const normallyReachable = reversePushDistances(floor, target).has(gate);
          const blockedReachable = reversePushDistances(reducedFloor, target).has(gate);
          if (normallyReachable && !blockedReachable) dependencies.push([blocker, target]);
        }
      }
      const approach = new Map(), approachQueue = [];
      for (const neighbor of floorNeighbors(gate, floor)) {
        if (cells.has(neighbor)) continue;
        approach.set(neighbor, 1);
        approachQueue.push(neighbor);
      }
      for (let head = 0; head < approachQueue.length; head++) {
        const position = approachQueue[head], distance = approach.get(position);
        if (distance >= 3) continue;
        for (const next of floorNeighbors(position, floor)) {
          if (next === gate || cells.has(next) || approach.has(next)) continue;
          approach.set(next, distance + 1);
          approachQueue.push(next);
        }
      }
      const [gateY, gateX] = gate.split(",").map(Number);
      const doorwayLanes = floorNeighbors(gate, floor)
        .filter(inside => cells.has(inside))
        .map(inside => {
          const [insideY, insideX] = inside.split(",").map(Number);
          const dy = insideY - gateY, dx = insideX - gateX;
          const outside = pkey(gateY - dy, gateX - dx);
          const importSupport = pkey(gateY - 2 * dy, gateX - 2 * dx);
          const exportSupport = pkey(gateY + 2 * dy, gateX + 2 * dx);
          return {
            inside,
            outside,
            importSupport,
            exportSupport,
            importPossible: floor.has(outside) && floor.has(importSupport),
            exportPossible: floor.has(outside) && floor.has(exportSupport),
          };
        });
      const interiorStaging = new Set([...cells].filter(cell => (depths.get(cell) || 0) <= 2));
      const exteriorStaging = new Set([...approach]
        .filter(([, distance]) => distance <= 2)
        .map(([position]) => position));
      candidates.push({
        gate,
        cells,
        goals: roomGoals,
        depths,
        traffic,
        dependencies,
        approach,
        doorwayLanes,
        interiorStaging,
        exteriorStaging,
      });
    }
  }
  candidates.sort((left, right) => right.cells.size - left.cells.size);
  const rooms = [];
  for (const candidate of candidates) {
    if (rooms.some(room => [...candidate.cells].every(cell => room.cells.has(cell)))) continue;
    rooms.push(candidate);
  }
  const goalAccess = [...goals].map(([goal, label]) => {
    const [y, x] = goal.split(",").map(Number);
    const lanes = DIRECTION_ENTRIES.flatMap(([, [dy, dx]]) => {
      const source = pkey(y - dy, x - dx);
      const support = pkey(y - 2 * dy, x - 2 * dx);
      if (!floor.has(source) || !floor.has(support)) return [];
      return [{
        source,
        support,
        blockingGoals: [source, support].filter(position => goals.has(position)),
      }];
    });
    return {goal, label, lanes};
  });
  // Compile maximal tunnel segments from individual tunnel cells
  const tunnelSegments = compileTunnelSegments(tunnels, floor, goals);

  return {articulations, rooms, tunnels, tunnelSegments, goalAccess};
}

function compileTunnelSegments(tunnels, floor, goals) {
  const visited = new Set();
  const segments = [];
  for (const cell of tunnels) {
    if (visited.has(cell)) continue;
    // Extend in both directions along the tunnel
    const neighbors = floorNeighbors(cell, floor);
    if (neighbors.length !== 2) continue;
    const [n0, n1] = neighbors;
    const [n0y, n0x] = n0.split(",").map(Number);
    const [n1y, n1x] = n1.split(",").map(Number);
    // Determine direction: horizontal or vertical
    const [cy, cx] = cell.split(",").map(Number);
    const dy = n1y - n0y === 0 ? 0 : (n1y > n0y ? 1 : -1);
    const dx = n1x - n0x === 0 ? 0 : (n1x > n0x ? 1 : -1);
    // Normalize direction: extend the segment in both directions
    const cellsInSegment = [cell];
    visited.add(cell);
    // Extend forward (toward n1)
    let current = cell;
    while (true) {
      const [y, x] = current.split(",").map(Number);
      const next = pkey(y + dy, x + dx);
      if (!tunnels.has(next) || visited.has(next)) {
        break;
      }
      visited.add(next);
      cellsInSegment.push(next);
      current = next;
    }
    // Extend backward (toward n0)
    current = cell;
    while (true) {
      const [y, x] = current.split(",").map(Number);
      const next = pkey(y - dy, x - dx);
      if (!tunnels.has(next) || visited.has(next)) {
        break;
      }
      visited.add(next);
      cellsInSegment.unshift(next);
      current = next;
    }
    if (cellsInSegment.length < 1) continue;
    // Determine entry and exit: the cells just beyond the segment ends
    const first = cellsInSegment[0];
    const last = cellsInSegment[cellsInSegment.length - 1];
    const [fy, fx] = first.split(",").map(Number);
    const [ly, lx] = last.split(",").map(Number);
    const entryNeighbor = pkey(fy - dy, fx - dx);
    const exitNeighbor = pkey(ly + dy, lx + dx);
    // Check if ends are dead-ends (wall) or open
    const entryIsDeadEnd = !floor.has(entryNeighbor);
    const exitIsDeadEnd = !floor.has(exitNeighbor);
    // One-way tunnel: one end is a dead-end
    const oneWay = entryIsDeadEnd || exitIsDeadEnd;
    // Goals within the tunnel
    const segmentGoals = cellsInSegment.filter(c => goals.has(c));
    segments.push({
      cells: cellsInSegment,
      entry: entryIsDeadEnd ? exitNeighbor : entryNeighbor,
      exit: entryIsDeadEnd ? entryNeighbor : exitNeighbor,
      entryEnd: entryIsDeadEnd ? first : last,
      exitEnd: entryIsDeadEnd ? last : first,
      goals: segmentGoals,
      length: cellsInSegment.length,
      oneWay,
      deadEnd: entryIsDeadEnd ? entryNeighbor : (exitIsDeadEnd ? exitNeighbor : null),
    });
  }
  return segments;
}

// --- Module registration ---
const SokomindTopology = {
  Heap,
  floorNeighbors,
  floorComponents,
  articulationPoints,
  analyzeTopology,
  compileTunnelSegments,
};

/* ===== board.js ===== */
// Board parsing, dense board compilation, push distances, single-box graphs, and goal push tables.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

const PREPARED_BOARD_SCHEMA = 3;
const boardContentKey = rows => rows.join("\n");
const ESTIMATED_BOARD_CACHE_ENTRY_BYTES = 384;

const BOARD_CACHE_MAPS = Object.freeze([
  "heuristicMemo",
  "discoveryHeuristicMemo",
  "playerPushDistances",
  "deadlockMemo",
  "patternDeadlockMemo",
  "patternWindowMemo",
  "commitmentMemo",
  "stateCommitmentMemo",
  "commitmentPushDistances",
  "supportDependencyMemo",
  "goalAccessMemo",
  "localRoomMemo",
  "shortestCorridorMemo",
  "localCorralMemo",
  "doorwayFlowMemo",
  "reachabilityMemo",
  "pushTransitionMemo",
]);

const BOARD_TABLE_MAPS = Object.freeze([
  "goalRoomPackingTables",
  "roomPatternTables",
  "pairConflictTables",
  "capacityPatternTables",
]);

function estimatePreparedBoardBytes(board) {
  const stringBytes = values => [...values].reduce((sum, value) => sum + 2 * value.length, 0);
  const nestedMapEntries = map => [...map.values()].reduce(
    (sum, value) => sum + (value?.size || 0),
    0,
  );
  return (
    stringBytes(board.rows) +
    stringBytes(board.floor) +
    stringBytes(board.walls) +
    stringBytes(board.goals.keys()) +
    board.dense.y.byteLength +
    board.dense.x.byteLength +
    board.dense.neighbors.byteLength +
    board.singleBoxGraph.nodes.size * 32 +
    board.metrics.graphEdges * 16 +
    nestedMapEntries(board.pushDistances) * 12 +
    nestedMapEntries(board.goalPushTables.byGoal) * 12 +
    nestedMapEntries(board.playerPushDistances) * 12
  );
}

function boardCacheMemorySnapshot(board) {
  let cacheEntries = 0;
  for (const name of BOARD_CACHE_MAPS) {
    cacheEntries += board[name]?.size || 0;
  }
  for (const name of BOARD_TABLE_MAPS) {
    const tables = board[name];
    if (!tables?.values) continue;
    cacheEntries += tables.size || 0;
    for (const table of tables.values()) {
      cacheEntries += table?.states?.size || 0;
    }
  }
  return {
    boardBytes: board._estimatedStaticBytes || 0,
    cacheEntries,
    cacheBytes: cacheEntries * ESTIMATED_BOARD_CACHE_ENTRY_BYTES,
  };
}

function attachBoardMemorySampler(board) {
  board._estimatedStaticBytes = Math.max(0, estimatePreparedBoardBytes(board));
  board.metrics._engineMemorySampler = () => boardCacheMemorySnapshot(board);
  return board;
}

function createPreparedBoardSeed(board) {
  const estimatedBytes = estimatePreparedBoardBytes(board);
  board.metrics.preparedSeedBytes = estimatedBytes;
  board.metrics.preparedPlayerDistanceTables = board.playerPushDistances.size;
  return {
    schemaVersion: PREPARED_BOARD_SCHEMA,
    boardContentKey: boardContentKey(board.rows),
    floor: board.floor,
    walls: board.walls,
    goals: board.goals,
    goalsByLabel: board.goalsByLabel,
    pushDistances: board.pushDistances,
    goalPressure: board.goalPressure,
    topology: board.topology,
    singleBoxGraph: board.singleBoxGraph,
    goalPushTables: board.goalPushTables,
    playerPushDistances: board.playerPushDistances,
    dense: board.dense,
    goalRoomPackingTables: board.goalRoomPackingTables,
    roomPatternTables: board.roomPatternTables,
    pairConflictTables: board.pairConflictTables,
    capacityPatternTables: board.capacityPatternTables,
    graphNodes: board.metrics.graphNodes,
    graphEdges: board.metrics.graphEdges,
    estimatedBytes,
  };
}

function preparedBoardMatches(data, seed) {
  return seed?.schemaVersion === PREPARED_BOARD_SCHEMA &&
    seed.boardContentKey === boardContentKey(data.rows) &&
    typeof seed.floor?.has === "function" && typeof seed.goals?.get === "function" &&
    typeof seed.singleBoxGraph?.nodes?.get === "function" &&
    typeof seed.goalPushTables?.byGoal?.get === "function" &&
    typeof seed.dense?.idByKey?.get === "function";
}

function hydratePreparedBoard(data, seed, metrics) {
  const started = now();
  metrics.preparedBoardReuses++;
  metrics.graphNodes = seed.graphNodes;
  metrics.graphEdges = seed.graphEdges;
  metrics.denseCells = seed.dense.keys.length;
  metrics.preparedSeedBytes = seed.estimatedBytes || 0;
  metrics.preparedPlayerDistanceTables = seed.playerPushDistances?.size || 0;
  metrics.goalTableBuilds = seed.goalPushTables.byGoal.size;
  metrics.goalTableStates = [...seed.goalPushTables.byGoal.values()]
    .reduce((sum, distances) => sum + distances.size, 0);
  const board = {
    rows: data.rows,
    floor: seed.floor,
    walls: seed.walls,
    goals: seed.goals,
    goalsByLabel: seed.goalsByLabel,
    pushDistances: seed.pushDistances,
    goalPressure: seed.goalPressure,
    topology: seed.topology,
    singleBoxGraph: seed.singleBoxGraph,
    goalPushTables: seed.goalPushTables,
    dense: seed.dense,
    heuristicMemo: new Map(),
    discoveryHeuristicMemo: new Map(),
    assignmentMemo: new WeakMap(),
    discoveryAssignmentMemo: new WeakMap(),
    assignmentParentMemo: new WeakMap(),
    playerPushDistances: new Map(seed.playerPushDistances || []),
    deadlockMemo: new Map(),
    patternDeadlockMemo: new Map(),
    patternWindowMemo: new Map(),
    commitmentMemo: new Map(),
    stateCommitmentMemo: new Map(),
    commitmentPushDistances: new Map(),
    supportDependencyMemo: new Map(),
    goalAccessMemo: new Map(),
    localRoomMemo: new Map(),
    goalRoomPackingTables: new Map(seed.goalRoomPackingTables || []),
    roomPatternTables: new Map(seed.roomPatternTables || []),
    pairConflictTables: new Map(seed.pairConflictTables || []),
    capacityPatternTables: new Map(seed.capacityPatternTables || []),
    shortestCorridorMemo: new Map(),
    localCorralMemo: new Map(),
    doorwayFlowMemo: new Map(),
    reachabilityMemo: new Map(),
    denseBoxMemo: new WeakMap(),
    pushTransitionMemo: new Map(),
    boxSignatureMemo: new WeakMap(),
    boxIdentityMemo: new WeakMap(),
    metrics,
  };
  metrics.preparedBoardHydrateMs += now() - started;
  return attachBoardMemorySampler(board);
}

function validatePuzzleRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("Puzzle is empty.");
  if (rows.some(row => typeof row !== "string")) {
    throw new Error("Every puzzle row must be a string.");
  }
  const reserved = new Set(["O", "R", "S", "X"]);
  const boxCounts = new Map(), goalCounts = new Map();
  let robots = 0;
  rows.forEach((row, y) => [...row].forEach((cell, x) => {
    const uppercase = cell >= "A" && cell <= "Z";
    const lowercase = cell >= "a" && cell <= "z";
    const dedicatedBox = uppercase && !reserved.has(cell);
    const dedicatedGoal = lowercase && !reserved.has(cell.toUpperCase());
    if (!(cell === " " || reserved.has(cell) || dedicatedBox || dedicatedGoal)) {
      throw new Error(`Unsupported symbol ${JSON.stringify(cell)} at row ${y + 1}, column ${x + 1}.`);
    }
    if (cell === "R") robots++;
    if (cell === "X" || dedicatedBox) {
      boxCounts.set(cell, (boxCounts.get(cell) || 0) + 1);
    }
    if (cell === "S") goalCounts.set("X", (goalCounts.get("X") || 0) + 1);
    if (dedicatedGoal) {
      const label = cell.toUpperCase();
      goalCounts.set(label, (goalCounts.get(label) || 0) + 1);
    }
  }));
  if (robots !== 1) {
    throw new Error(`Puzzle must contain exactly one robot; found ${robots}.`);
  }
  const labels = new Set([...boxCounts.keys(), ...goalCounts.keys()]);
  for (const label of [...labels].sort()) {
    const boxes = boxCounts.get(label) || 0, goals = goalCounts.get(label) || 0;
    if (boxes === goals) continue;
    if (label === "X") {
      throw new Error(`Generic boxes/goals mismatch: ${boxes} box(es), ${goals} goal(s).`);
    }
    throw new Error(
      `Dedicated box ${JSON.stringify(label)} has ${boxes} box(es) but ${goals} goal(s).`,
    );
  }
  return true;
}

function parse(data) {
  const parseStarted = now();
  const metrics = activePerformance || createPerformanceMetrics();
  if (preparedBoardMatches(data, data.preparedBoard)) {
    const board = hydratePreparedBoard(data, data.preparedBoard, metrics);
    metrics.parseMs += now() - parseStarted;
    return board;
  }
  if (data.preparedBoard) metrics.preparedBoardFallbacks++;
  const floor = new Set(), walls = new Set(), goals = new Map(), goalsByLabel = new Map();
  data.rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const p = pkey(y, x);
    if (ch === "O") walls.add(p); else floor.add(p);
    const label = ch === "S" ? "X" : /[a-z]/.test(ch) ? ch.toUpperCase() : null;
    if (label) {
      goals.set(p, label);
      if (!goalsByLabel.has(label)) goalsByLabel.set(label, []);
      goalsByLabel.get(label).push(p);
    }
  }));
  const pushDistances = new Map([...goals.keys()].map(goal => [goal, reversePushDistances(floor, goal)]));
  const goalPressure = new Map([...goals.keys()].map(goal => [
    goal,
    floor.size / Math.max(1, pushDistances.get(goal).size),
  ]));
  const dense = compileDenseBoard(floor, goals, metrics);
  const singleBoxGraph = compileSingleBoxPushGraph(floor, metrics);
  const goalPushTables = compileGoalPushTables(singleBoxGraph, goals, metrics);
  const topology = analyzeTopology(floor, goals);
  metrics.parseMs += now() - parseStarted;
  return attachBoardMemorySampler({
    rows: data.rows, floor, walls, goals, goalsByLabel, pushDistances, goalPressure,
    topology, heuristicMemo: new Map(), discoveryHeuristicMemo: new Map(),
    assignmentMemo: new WeakMap(), discoveryAssignmentMemo: new WeakMap(),
    assignmentParentMemo: new WeakMap(), playerPushDistances: new Map(),
    deadlockMemo: new Map(), commitmentMemo: new Map(), stateCommitmentMemo: new Map(),
    patternDeadlockMemo: new Map(),
    patternWindowMemo: new Map(),
    commitmentPushDistances: new Map(),
    supportDependencyMemo: new Map(),
    goalAccessMemo: new Map(),
    localRoomMemo: new Map(),
    goalRoomPackingTables: new Map(),
    roomPatternTables: new Map(),
    pairConflictTables: new Map(),
    capacityPatternTables: new Map(),
    shortestCorridorMemo: new Map(),
    localCorralMemo: new Map(),
    doorwayFlowMemo: new Map(),
    reachabilityMemo: new Map(),
    denseBoxMemo: new WeakMap(),
    pushTransitionMemo: new Map(),
    boxSignatureMemo: new WeakMap(),
    boxIdentityMemo: new WeakMap(),
    singleBoxGraph, goalPushTables, dense, metrics,
  });
}

function compileDenseBoard(floor, goals, metrics) {
  const started = now();
  const keys = [...floor];
  const idByKey = new Map(keys.map((position, id) => [position, id]));
  const y = new Int16Array(keys.length), x = new Int16Array(keys.length);
  const neighbors = new Int32Array(keys.length * DIRECTION_ENTRIES.length);
  neighbors.fill(-1);
  keys.forEach((position, id) => {
    const [cellY, cellX] = position.split(",").map(Number);
    y[id] = cellY;
    x[id] = cellX;
    DIRECTION_ENTRIES.forEach(([, [dy, dx]], direction) => {
      neighbors[id * DIRECTION_ENTRIES.length + direction] =
        idByKey.get(pkey(cellY + dy, cellX + dx)) ?? -1;
    });
  });
  const maxY = keys.length ? Math.max(...y) + 1 : 0;
  const maxX = keys.length ? Math.max(...x) + 1 : 0;
  const width = maxX;
  const idByYX = new Int32Array(maxY * width);
  idByYX.fill(-1);
  for (let id = 0; id < keys.length; id++) {
    idByYX[y[id] * width + x[id]] = id;
  }
  metrics.denseCells = keys.length;
  metrics.denseBuildMs += now() - started;
  const labelIds = new Map([...new Set(goals.values())].sort()
    .map((label, index) => [label, index]));
  const cellBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, keys.length))));
  const tokenCount = Math.max(2, keys.length * Math.max(1, labelIds.size));
  const tokenBits = Math.max(1, Math.ceil(Math.log2(tokenCount)));
  // Zobrist table: two 32-bit deterministic hash values per (label, cell) token
  // for 64-bit collision safety. Uses splitmix32 seeded by token index for
  // reproducibility across runs and across workers.
  const labelCount = Math.max(1, labelIds.size);
  const zobristHi = new Uint32Array(labelCount * keys.length);
  const zobristLo = new Uint32Array(labelCount * keys.length);
  for (let i = 0; i < zobristHi.length; i++) {
    // splitmix32 with two rounds per token for hi/lo
    let z = (i + 1) * 0x9E3779B9;
    z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B);
    z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35);
    zobristHi[i] = (z ^ (z >>> 16)) >>> 0;
    z = (i + 1) * 0x9E3779B9 + 0x6A09E667;
    z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B);
    z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35);
    zobristLo[i] = (z ^ (z >>> 16)) >>> 0;
  }
  return {keys, idByKey, y, x, neighbors, labelIds, cellBits, tokenBits, idByYX, width,
    zobristHi, zobristLo, labelCount};
}
function reversePushDistances(floor, goalKey) {
  const [gy, gx] = goalKey.split(",").map(Number);
  const distances = new Map([[goalKey, 0]]), queue = [[gy, gx]];
  let head = 0;
  for (; head < queue.length; head++) {
    const [y, x] = queue[head], distance = distances.get(pkey(y, x));
    for (const [dy, dx] of Object.values(DIRS)) {
      const previous = pkey(y - dy, x - dx);
      const support = pkey(y - 2 * dy, x - 2 * dx);
      if (!floor.has(previous) || !floor.has(support) || distances.has(previous)) continue;
      distances.set(previous, distance + 1);
      queue.push([y - dy, x - dx]);
    }
  }
  return distances;
}
function minimumAssignment(costs) {
  const size = costs.length;
  if (!size) return {
    cost: 0,
    rowPotential: [0],
    columnPotential: [0],
    matching: [0],
  };
  if (costs.some(row => row.length !== size || row.every(cost => !Number.isFinite(cost)))) {
    return {cost: Infinity};
  }
  const blocked = 1e9;
  const rowPotential = Array(size + 1).fill(0);
  const columnPotential = Array(size + 1).fill(0);
  const matching = Array(size + 1).fill(0);
  const predecessor = Array(size + 1).fill(0);
  for (let row = 1; row <= size; row++) {
    matching[0] = row;
    const minimum = Array(size + 1).fill(blocked);
    const used = Array(size + 1).fill(false);
    let column = 0;
    do {
      used[column] = true;
      const matchedRow = matching[column];
      let delta = blocked, nextColumn = 0;
      for (let candidate = 1; candidate <= size; candidate++) {
        if (used[candidate]) continue;
        const cost = costs[matchedRow - 1][candidate - 1];
        const reduced = (Number.isFinite(cost) ? cost : blocked) -
          rowPotential[matchedRow] - columnPotential[candidate];
        if (reduced < minimum[candidate]) {
          minimum[candidate] = reduced;
          predecessor[candidate] = column;
        }
        if (minimum[candidate] < delta) {
          delta = minimum[candidate];
          nextColumn = candidate;
        }
      }
      if (delta >= blocked) return {cost: Infinity};
      for (let candidate = 0; candidate <= size; candidate++) {
        if (used[candidate]) {
          rowPotential[matching[candidate]] += delta;
          columnPotential[candidate] -= delta;
        } else {
          minimum[candidate] -= delta;
        }
      }
      column = nextColumn;
    } while (matching[column] !== 0);
    do {
      const previous = predecessor[column];
      matching[column] = matching[previous];
      column = previous;
    } while (column !== 0);
  }
  let total = 0;
  for (let column = 1; column <= size; column++) {
    const cost = costs[matching[column] - 1][column - 1];
    if (!Number.isFinite(cost)) return {cost: Infinity};
    total += cost;
  }
  return {cost: total, rowPotential, columnPotential, matching};
}

function repairMinimumAssignment(previous, costs, changedRow) {
  const size = costs.length;
  if (!previous || !Number.isInteger(changedRow) || changedRow < 0 || changedRow >= size ||
      !Number.isFinite(previous.cost) || previous.matching?.length !== size + 1 ||
      costs.some(row => row.length !== size || row.every(cost => !Number.isFinite(cost)))) {
    return null;
  }
  const blocked = 1e9, row = changedRow + 1;
  const rowPotential = [...previous.rowPotential];
  const columnPotential = [...previous.columnPotential];
  const matching = [...previous.matching];
  const freedColumn = matching.findIndex((matchedRow, column) => column > 0 && matchedRow === row);
  if (freedColumn < 1) return null;
  matching[freedColumn] = 0;
  rowPotential[row] = Math.min(...costs[changedRow].map((cost, index) =>
    (Number.isFinite(cost) ? cost : blocked) - columnPotential[index + 1]));

  matching[0] = row;
  const minimum = Array(size + 1).fill(blocked);
  const used = Array(size + 1).fill(false);
  const predecessor = Array(size + 1).fill(0);
  let column = 0;
  do {
    used[column] = true;
    const matchedRow = matching[column];
    let delta = blocked, nextColumn = 0;
    for (let candidate = 1; candidate <= size; candidate++) {
      if (used[candidate]) continue;
      const cost = costs[matchedRow - 1][candidate - 1];
      const reduced = (Number.isFinite(cost) ? cost : blocked) -
        rowPotential[matchedRow] - columnPotential[candidate];
      if (reduced < minimum[candidate]) {
        minimum[candidate] = reduced;
        predecessor[candidate] = column;
      }
      if (minimum[candidate] < delta) {
        delta = minimum[candidate];
        nextColumn = candidate;
      }
    }
    if (delta >= blocked) return {cost: Infinity};
    for (let candidate = 0; candidate <= size; candidate++) {
      if (used[candidate]) {
        rowPotential[matching[candidate]] += delta;
        columnPotential[candidate] -= delta;
      } else {
        minimum[candidate] -= delta;
      }
    }
    column = nextColumn;
  } while (matching[column] !== 0);
  do {
    const previousColumn = predecessor[column];
    matching[column] = matching[previousColumn];
    column = previousColumn;
  } while (column !== 0);

  let total = 0;
  for (let candidate = 1; candidate <= size; candidate++) {
    const cost = costs[matching[candidate] - 1][candidate - 1];
    if (!Number.isFinite(cost)) return {cost: Infinity};
    total += cost;
  }
  return {cost: total, rowPotential, columnPotential, matching};
}

function minimumAssignmentCost(costs) {
  return minimumAssignment(costs).cost;
}

function singleBoxReachable(floor, boxKey, startKey) {
  const reached = new Set([startKey]), queue = [startKey];
  for (let head = 0; head < queue.length; head++) {
    const [y, x] = queue[head].split(",").map(Number);
    for (const [dy, dx] of Object.values(DIRS)) {
      const next = pkey(y + dy, x + dx);
      if (next === boxKey || !floor.has(next) || reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

function compileSingleBoxPushGraph(floor, metrics = createPerformanceMetrics()) {
  const started = now();
  const regionsByBox = new Map();
  for (const boxKey of floor) {
    const components = floorComponents(floor, boxKey);
    const representativeByPosition = new Map();
    const representatives = [];
    for (const component of components) {
      const representative = [...component].sort()[0];
      representatives.push(representative);
      component.forEach(position => representativeByPosition.set(position, representative));
    }
    regionsByBox.set(boxKey, {representativeByPosition, representatives, components});
  }

  const nodes = new Map(), startsByBox = new Map();
  for (const [boxKey, regionData] of regionsByBox) {
    const [y, x] = boxKey.split(",").map(Number);
    const starts = [];
    regionData.components.forEach((component, index) => {
      const representative = regionData.representatives[index];
      const nodeKey = `${boxKey}|${representative}`;
      const transitions = [];
      for (const [dy, dx] of Object.values(DIRS)) {
        const support = pkey(y - dy, x - dx), destination = pkey(y + dy, x + dx);
        if (!component.has(support) || !floor.has(destination)) continue;
        const nextRepresentative = regionsByBox.get(destination)
          .representativeByPosition.get(boxKey);
        if (nextRepresentative === undefined) continue;
        transitions.push({destination, nodeKey: `${destination}|${nextRepresentative}`});
      }
      nodes.set(nodeKey, {boxKey, representative, transitions});
      starts.push(nodeKey);
    });
    startsByBox.set(boxKey, starts);
  }
  metrics.graphCompileMs += now() - started;
  metrics.graphNodes += nodes.size;
  metrics.graphEdges += [...nodes.values()].reduce((sum, node) => sum + node.transitions.length, 0);
  return {nodes, startsByBox};
}

function compileGoalPushTables(singleBoxGraph, goals, metrics = createPerformanceMetrics()) {
  const started = now();
  const predecessors = new Map();
  for (const [nodeKey, node] of singleBoxGraph.nodes) {
    for (const transition of node.transitions) {
      if (!predecessors.has(transition.nodeKey)) predecessors.set(transition.nodeKey, []);
      predecessors.get(transition.nodeKey).push(nodeKey);
    }
  }
  const byGoal = new Map();
  const byLabel = new Map();
  for (const [goal, label] of goals) {
    const nodeDistances = new Map();
    const queue = [];
    for (const nodeKey of singleBoxGraph.startsByBox.get(goal) || []) {
      nodeDistances.set(nodeKey, 0);
      queue.push(nodeKey);
    }
    for (let head = 0; head < queue.length; head++) {
      const nodeKey = queue[head];
      const distance = nodeDistances.get(nodeKey);
      for (const previous of predecessors.get(nodeKey) || []) {
        if (nodeDistances.has(previous)) continue;
        nodeDistances.set(previous, distance + 1);
        queue.push(previous);
      }
    }
    const distances = new Map();
    for (const [box, starts] of singleBoxGraph.startsByBox) {
      let best = Infinity;
      for (const nodeKey of starts) {
        best = Math.min(best, nodeDistances.get(nodeKey) ?? Infinity);
      }
      if (Number.isFinite(best)) distances.set(box, best);
    }
    byGoal.set(goal, distances);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push({goal, distances});
    metrics.goalTableBuilds++;
    metrics.goalTableStates += nodeDistances.size;
  }
  metrics.goalTableMs += now() - started;
  return {byGoal, byLabel};
}

function compiledGoalPushDistance(board, start, goal) {
  const table = board.goalPushTables.byGoal.get(goal);
  if (!table) return Infinity;
  board.metrics.goalTableHits++;
  return table.get(start) ?? Infinity;
}

function playerAwarePushDistancesReference(floor, startKey) {
  const initialRegions = [], unassigned = new Set(floor);
  unassigned.delete(startKey);
  while (unassigned.size) {
    const representative = unassigned.values().next().value;
    const region = singleBoxReachable(floor, startKey, representative);
    region.forEach(position => unassigned.delete(position));
    initialRegions.push(representative);
  }
  const distances = new Map([[startKey, 0]]), seen = new Set(), queue = [];
  const enqueue = (boxKey, robotKey, distance) => {
    const region = singleBoxReachable(floor, boxKey, robotKey);
    const representative = [...region].sort()[0];
    const signature = `${boxKey}|${representative}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    queue.push({boxKey, region, distance});
  };
  initialRegions.forEach(robotKey => enqueue(startKey, robotKey, 0));
  for (let head = 0; head < queue.length; head++) {
    const {boxKey, region, distance} = queue[head];
    const [y, x] = boxKey.split(",").map(Number);
    for (const [dy, dx] of Object.values(DIRS)) {
      const support = pkey(y - dy, x - dx), destination = pkey(y + dy, x + dx);
      if (!region.has(support) || !floor.has(destination)) continue;
      const nextDistance = distance + 1;
      if (nextDistance < (distances.get(destination) ?? Infinity)) {
        distances.set(destination, nextDistance);
      }
      enqueue(destination, boxKey, nextDistance);
    }
  }
  return distances;
}

function playerAwarePushDistances(board, startKey) {
  const metrics = board.metrics;
  metrics.pushDistanceCalls++;
  if (board.playerPushDistances.has(startKey)) {
    metrics.pushDistanceCacheHits++;
    return board.playerPushDistances.get(startKey);
  }
  const started = now();
  const distances = new Map([[startKey, 0]]), seen = new Set(), queue = [];
  const enqueue = (nodeKey, distance) => {
    if (seen.has(nodeKey)) return;
    seen.add(nodeKey);
    queue.push({nodeKey, distance});
  };
  (board.singleBoxGraph.startsByBox.get(startKey) || []).forEach(nodeKey => enqueue(nodeKey, 0));

  for (let head = 0; head < queue.length; head++) {
    const {nodeKey, distance} = queue[head];
    const node = board.singleBoxGraph.nodes.get(nodeKey);
    for (const transition of node.transitions) {
      const nextDistance = distance + 1;
      if (nextDistance < (distances.get(transition.destination) ?? Infinity)) {
        distances.set(transition.destination, nextDistance);
      }
      enqueue(transition.nodeKey, nextDistance);
    }
  }
  board.playerPushDistances.set(startKey, distances);
  metrics.pushDistanceMs += now() - started;
  return distances;
}

// --- Module registration ---
const SokomindBoard = {
  PREPARED_BOARD_SCHEMA,
  boardContentKey,
  estimatePreparedBoardBytes,
  boardCacheMemorySnapshot,
  attachBoardMemorySampler,
  createPreparedBoardSeed,
  preparedBoardMatches,
  hydratePreparedBoard,
  validatePuzzleRows,
  parse,
  compileDenseBoard,
  reversePushDistances,
  minimumAssignment,
  repairMinimumAssignment,
  minimumAssignmentCost,
  singleBoxReachable,
  compileSingleBoxPushGraph,
  compileGoalPushTables,
  compiledGoalPushDistance,
  playerAwarePushDistancesReference,
  playerAwarePushDistances,
};

/* ===== heuristic.js ===== */
// Assignment-based heuristic, topology penalty, doorway flow, goal access, and relevance ordering.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

function boxesByLabelWithIndices(boxes) {
  const byLabel = new Map();
  boxes.forEach(([y, x, label], index) => {
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push({y, x, index});
  });
  return byLabel;
}

function cacheAssignmentDetail(boxes, board, includeInteractions) {
  const memo = includeInteractions
    ? board.assignmentMemo : board.discoveryAssignmentMemo;
  if (memo.has(boxes)) return memo.get(boxes);
  const labels = new Map();
  const assignedTargets = new Map();
  let total = 0;
  for (const [label, entries] of boxesByLabelWithIndices(boxes)) {
    const targets = board.goalsByLabel.get(label) || [];
    const costs = entries.map(({y, x}) =>
      targets.map(target => compiledGoalPushDistance(board, pkey(y, x), target)));
    board.metrics.assignmentCalls++;
    const assignment = minimumAssignment(costs);
    labels.set(label, {boxIndices: entries.map(entry => entry.index), costs, assignment});
    for (let column = 1; column < (assignment.matching?.length || 0); column++) {
      const row = assignment.matching[column] - 1;
      if (row >= 0) assignedTargets.set(entries[row].index, targets[column - 1]);
    }
    total += assignment.cost;
  }
  if (includeInteractions) {
    total += interactionHeuristicBoost(
      boxes,
      board,
      new Map([...labels].map(([label, detail]) => [label, detail.assignment.cost])),
    );
  }
  const detail = {labels, assignedTargets, cost: total};
  memo.set(boxes, detail);
  return detail;
}

function cacheFullAssignmentDetail(boxes, board) {
  return cacheAssignmentDetail(boxes, board, true);
}

function cacheDiscoveryAssignmentDetail(boxes, board) {
  return cacheAssignmentDetail(boxes, board, false);
}

function heuristicWithInteractions(boxes, board, includeInteractions) {
  const metrics = board.metrics;
  metrics.heuristicCalls++;
  const signature = boxSignature(boxes, board);
  const heuristicMemo = includeInteractions
    ? board.heuristicMemo : board.discoveryHeuristicMemo;
  const assignmentDetail = includeInteractions
    ? cacheFullAssignmentDetail : cacheDiscoveryAssignmentDetail;
  const cachedHeuristic = memoLookup(heuristicMemo, signature);
  if (cachedHeuristic !== undefined) {
    metrics.heuristicCacheHits++;
    return cachedHeuristic;
  }
  const started = now();
  const parentHint = board.assignmentParentMemo.get(boxes);
  if (!parentHint) {
    const detail = assignmentDetail(boxes, board);
    const lcAssignments = new Map();
    for (const [label, labelDetail] of detail.labels) {
      lcAssignments.set(label, labelDetail.assignment);
    }
    const grouped = boxesByLabelWithIndices(boxes);
    const lcBoost = linearConflictFromGrouped(grouped, board, lcAssignments);
    metrics.heuristicMs += now() - started;
    return memoizeBounded(heuristicMemo, signature, detail.cost + lcBoost);
  }
  const grouped = boxesByLabelWithIndices(boxes);
  const changedEntries = [...grouped.values()].find(entries =>
    entries.some(entry => entry.index === parentHint.changedIndex));
  const parentDetail = changedEntries?.length >= INCREMENTAL_ASSIGNMENT_CROSSOVER
    ? assignmentDetail(parentHint.parentBoxes, board)
    : null;
  let total = 0;
  const assignmentCosts = new Map();
  const lcAssignments = new Map();
  for (const [label, entries] of grouped) {
    const targets = board.goalsByLabel.get(label) || [];
    const previous = parentDetail?.labels.get(label);
    const boxIndices = entries.map(entry => entry.index);
    const changedRow = parentHint ? boxIndices.indexOf(parentHint.changedIndex) : -1;
    const canReuseRows = changedRow >= 0 && previous &&
      previous.boxIndices.length === boxIndices.length &&
      previous.boxIndices.every((index, row) => index === boxIndices[row]);
    const costs = canReuseRows ? [...previous.costs] : entries.map(({y, x}) =>
      targets.map(target => compiledGoalPushDistance(board, pkey(y, x), target)));
    if (canReuseRows) {
      const {y, x} = entries[changedRow];
      costs[changedRow] = targets.map(target =>
        compiledGoalPushDistance(board, pkey(y, x), target));
    }
    metrics.assignmentCalls++;
    let assignment = canReuseRows
      ? repairMinimumAssignment(previous.assignment, costs, changedRow)
      : null;
    if (canReuseRows) {
      metrics.incrementalAssignmentCalls++;
      metrics.incrementalAssignmentRowsReused += Math.max(0, entries.length - 1);
    }
    if (!assignment) {
      if (canReuseRows) metrics.incrementalAssignmentFallbacks++;
      assignment = minimumAssignment(costs);
    }
    total += assignment.cost;
    assignmentCosts.set(label, assignment.cost);
    lcAssignments.set(label, assignment);
  }
  if (includeInteractions) {
    total += interactionHeuristicBoost(boxes, board, assignmentCosts);
  }
  total += linearConflictFromGrouped(grouped, board, lcAssignments);
  metrics.heuristicMs += now() - started;
  return memoizeBounded(heuristicMemo, signature, total);
}

function heuristic(boxes, board) {
  return heuristicWithInteractions(boxes, board, true);
}

function discoveryHeuristic(boxes, board) {
  return heuristicWithInteractions(boxes, board, false);
}

function topologyPenalty(boxes, board) {
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  let penalty = 0;
  for (const room of board.topology.rooms) {
    const boxesInside = boxes.filter(([y, x]) => room.cells.has(pkey(y, x)));
    penalty += Math.abs(boxesInside.length - room.goals.length);
    const currentLabels = new Map(), targetLabels = new Map();
    boxesInside.forEach(([, , label]) => currentLabels.set(label, (currentLabels.get(label) || 0) + 1));
    room.goals.forEach(goal => {
      const label = board.goals.get(goal);
      targetLabels.set(label, (targetLabels.get(label) || 0) + 1);
    });
    const labels = new Set([...currentLabels.keys(), ...targetLabels.keys()]);
    let labelFlow = 0;
    labels.forEach(label => {
      labelFlow += Math.abs((currentLabels.get(label) || 0) - (targetLabels.get(label) || 0));
    });
    penalty += 2 * labelFlow;
    for (const [y, x, label] of boxesInside) {
      const position = pkey(y, x);
      if (board.goals.get(position) !== label) penalty += 0.35 * (room.traffic.get(position) || 0);
    }

    const unsolved = room.goals.filter(goal => occupied.get(goal) !== board.goals.get(goal));
    const trafficDemand = unsolved.length + labelFlow;
    for (const [position, distance] of room.approach) {
      if (occupied.has(position)) penalty += 0.75 * trafficDemand * (4 - distance);
    }
    for (const goal of room.goals) {
      if (occupied.get(goal) !== board.goals.get(goal)) continue;
      const depth = room.depths.get(goal) || 0;
      for (const pending of unsolved) {
        const pendingDepth = room.depths.get(pending) || 0;
        if (pendingDepth > depth) penalty += 1 + pendingDepth - depth;
      }
    }
    for (const [blocker, prerequisite] of room.dependencies) {
      const blockerSolved = occupied.get(blocker) === board.goals.get(blocker);
      const prerequisiteSolved = occupied.get(prerequisite) === board.goals.get(prerequisite);
      if (blockerSolved && !prerequisiteSolved) penalty += 4;
    }
    if (occupied.has(room.gate) && unsolved.length) penalty += 2 * unsolved.length;
  }
  return penalty;
}

function roomEvacuationPenalty(boxes, board) {
  const started = now();
  board.metrics.roomEvacuationCalls++;
  const occupied = new Set(boxes.map(([y, x]) => pkey(y, x)));
  let penalty = 0;
  for (const room of board.topology.rooms) {
    const current = new Map(), target = new Map();
    const inside = boxes.filter(([y, x]) => room.cells.has(pkey(y, x)));
    inside.forEach(([, , label]) => current.set(label, (current.get(label) || 0) + 1));
    room.goals.forEach(goal => {
      const label = board.goals.get(goal);
      target.set(label, (target.get(label) || 0) + 1);
    });
    let surplus = 0;
    current.forEach((count, label) => {
      surplus += Math.max(0, count - (target.get(label) || 0));
    });
    if (!surplus) continue;
    penalty += 20 * inside.length + 8 * surplus;
    for (const [position, distance] of room.approach) {
      if (occupied.has(position)) penalty += 3 * (4 - distance);
    }
  }
  board.metrics.roomEvacuationMs += now() - started;
  return penalty;
}

function assignmentDoorwayPlan(boxes, board, discovery = false) {
  const assignment = discovery
    ? cacheDiscoveryAssignmentDetail(boxes, board)
    : cacheFullAssignmentDetail(boxes, board);
  if (assignment.doorwayPlan) return assignment.doorwayPlan;
  const occupied = new Set(boxes.map(([y, x]) => pkey(y, x)));
  const tasks = [];
  for (let roomIndex = 0; roomIndex < board.topology.rooms.length; roomIndex++) {
    const room = board.topology.rooms[roomIndex];
    boxes.forEach(([y, x, label], boxIndex) => {
      const box = pkey(y, x), target = assignment.assignedTargets.get(boxIndex);
      if (!target) return;
      const inside = room.cells.has(box), targetInside = room.cells.has(target);
      const direction = inside && !targetInside
        ? "export" : !inside && targetInside ? "import" : null;
      if (direction) {
        tasks.push({box, boxIndex, label, target, direction, roomIndex, gate: room.gate});
      }
    });
  }
  let penalty = tasks.length;
  for (const room of board.topology.rooms) {
    const crossings = tasks.filter(task => task.gate === room.gate).length;
    if (crossings && occupied.has(room.gate)) penalty += 2 * crossings;
  }
  assignment.doorwayPlan = {tasks, penalty};
  return assignment.doorwayPlan;
}

const DOORWAY_TASK_PARTITION_MEMO = new WeakMap();

function doorwayTaskPartitions(tasks, roomCount) {
  const cached = DOORWAY_TASK_PARTITION_MEMO.get(tasks);
  if (cached?.length === roomCount) return cached;
  const partitions = Array.from({length: roomCount}, () => ({
    exports: [],
    imports: [],
  }));
  for (const task of tasks) {
    const partition = partitions[task.roomIndex];
    if (!partition) continue;
    partition[task.direction === "export" ? "exports" : "imports"].push(task);
  }
  DOORWAY_TASK_PARTITION_MEMO.set(tasks, partitions);
  return partitions;
}

function doorwayScheduleState(boxes, board, tasks) {
  const started = now();
  board.metrics.doorwayScheduleCalls++;
  let penalty = 0, pendingExports = 0, remainingImports = 0;
  let prematureImports = 0, gateBlockers = 0, crossingConflicts = 0;
  let crossingDistance = 0, packingDistance = 0, unpackedImports = 0;
  let stagingBlockers = 0, strandedExports = 0, blockedImportAccess = 0;
  let packingOrderViolations = 0;
  const occupied = new Set(boxes.map(([y, x]) => pkey(y, x)));
  const partitions = doorwayTaskPartitions(tasks, board.topology.rooms.length);
  for (let roomIndex = 0; roomIndex < board.topology.rooms.length; roomIndex++) {
    const room = board.topology.rooms[roomIndex];
    const {exports, imports} = partitions[roomIndex];
    const pending = exports.filter(task => {
      const [y, x] = boxes[task.boxIndex];
      const position = pkey(y, x);
      return room.cells.has(position) || position === room.gate;
    });
    const imported = imports.filter(task => {
      const [y, x] = boxes[task.boxIndex];
      return room.cells.has(pkey(y, x));
    });
    const unpacked = imported.filter(task => {
      const [y, x] = boxes[task.boxIndex];
      return task.target && pkey(y, x) !== task.target;
    });
    const blocking = imports.filter(task => {
      const [y, x] = boxes[task.boxIndex];
      return pkey(y, x) === room.gate;
    });
    const completedExports = exports.length - pending.length;
    const requiredExportLead = Math.max(0, exports.length - imports.length);
    const balancedImports = Math.max(0, completedExports - requiredExportLead);
    const allowedImports = pending.length
      ? Math.min(1, balancedImports) : balancedImports;
    const excessImports = Math.max(0, imported.length - allowedImports);
    const blockedImports = blocking.length && imported.length >= allowedImports
      ? blocking.length : 0;
    const conflicts = occupied.has(room.gate)
      ? room.doorwayLanes.filter(lane =>
        occupied.has(lane.inside) || occupied.has(lane.outside)).length
      : 0;
    const exportedInApproach = exports.filter(task => {
      const [y, x] = boxes[task.boxIndex];
      return !pending.includes(task) && room.exteriorStaging.has(pkey(y, x));
    });
    const blockedStaging = pending.length && exportedInApproach.length
      ? [...room.exteriorStaging].filter(position =>
        occupied.has(position)).length
      : !pending.length && imported.length < imports.length
        ? exportedInApproach.length
        : 0;
    let accessible = null;
    const crossingAccessible = () => {
      if (accessible) return accessible;
      const accessStart = !occupied.has(room.gate)
        ? room.gate
        : [...room.cells].find(position => !occupied.has(position));
      accessible = new Set(accessStart ? [accessStart] : []);
      const accessQueue = accessStart ? [accessStart] : [];
      for (let head = 0; head < accessQueue.length; head++) {
        for (const next of floorNeighbors(accessQueue[head], board.floor)) {
          if (occupied.has(next) || accessible.has(next)) continue;
          accessible.add(next);
          accessQueue.push(next);
        }
      }
      return accessible;
    };
    let stranded = 0;
    if (imported.length && pending.length) {
      const reached = crossingAccessible();
      stranded = pending.filter(task => {
        const [y, x] = boxes[task.boxIndex];
        return !DIRECTION_ENTRIES.some(([, [dy, dx]]) => {
          const destination = pkey(y + dy, x + dx);
          const support = pkey(y - dy, x - dx);
          return board.floor.has(destination) && !occupied.has(destination) &&
            reached.has(support) &&
            !staticDead(y + dy, x + dx, board, task.label);
        });
      }).length;
    }
    let inaccessibleImports = 0;
    if (!pending.length) {
      const reached = crossingAccessible();
      inaccessibleImports = imports.filter(task => {
        const [y, x] = boxes[task.boxIndex];
        const position = pkey(y, x);
        if (room.cells.has(position)) return false;
        const currentDistance = playerAwarePushDistances(board, position).get(room.gate);
        return !DIRECTION_ENTRIES.some(([, [dy, dx]]) => {
          const destination = pkey(y + dy, x + dx);
          const support = pkey(y - dy, x - dx);
          const nextDistance = playerAwarePushDistances(board, destination).get(room.gate);
          const candidateBoxes = boxes.slice();
          candidateBoxes[task.boxIndex] = [y + dy, x + dx, task.label];
          return board.floor.has(destination) && !occupied.has(destination) &&
            reached.has(support) && nextDistance < currentDistance &&
            !staticDead(y + dy, x + dx, board, task.label) &&
            !createsDynamicDeadlock(candidateBoxes, board, [y + dy, x + dx]);
        });
      }).length;
    }
    const packingViolations = room.dependencies.filter(([blocker, prerequisite]) =>
      occupied.has(blocker) &&
      boxes.some(([y, x, label]) =>
        pkey(y, x) === blocker && board.goals.get(blocker) === label) &&
      !boxes.some(([y, x, label]) =>
        pkey(y, x) === prerequisite && board.goals.get(prerequisite) === label),
    ).length;
    const distanceTasks = pending.length ? pending : imports.filter(task => {
      const [y, x] = boxes[task.boxIndex];
      return !room.cells.has(pkey(y, x));
    });
    for (const task of distanceTasks) {
      const [y, x] = boxes[task.boxIndex];
      const distance = playerAwarePushDistances(board, pkey(y, x)).get(room.gate);
      crossingDistance += Number.isFinite(distance) ? Math.min(12, distance + 1) : 12;
    }
    for (const task of unpacked) {
      const [y, x] = boxes[task.boxIndex];
      const distance = compiledGoalPushDistance(board, pkey(y, x), task.target);
      packingDistance += Number.isFinite(distance) ? Math.min(12, distance) : 12;
    }
    pendingExports += pending.length;
    remainingImports += imports.length - imported.length;
    unpackedImports += unpacked.length;
    prematureImports += excessImports;
    gateBlockers += blockedImports;
    crossingConflicts += conflicts;
    stagingBlockers += blockedStaging;
    strandedExports += stranded;
    blockedImportAccess += inaccessibleImports;
    packingOrderViolations += packingViolations;
    penalty += pending.length + imports.length - imported.length;
    penalty += 8 * excessImports + 12 * blockedImports +
      40 * conflicts + 6 * blockedStaging + 8 * inaccessibleImports +
      20 * packingViolations;
  }
  penalty += crossingDistance + packingDistance;
  const result = {
    penalty,
    pendingExports,
    remainingImports,
    unpackedImports,
    prematureImports,
    gateBlockers,
    crossingConflicts,
    stagingBlockers,
    strandedExports,
    blockedImportAccess,
    packingOrderViolations,
    crossingDistance,
    packingDistance,
  };
  board.metrics.doorwayScheduleMs += now() - started;
  return result;
}

function typedDoorwayFlow(boxes, board) {
  const metrics = board.metrics;
  metrics.doorwayFlowCalls++;
  const signature = boxSignature(boxes, board);
  const cachedDoorwayFlow = memoLookup(board.doorwayFlowMemo, signature);
  if (cachedDoorwayFlow !== undefined) {
    metrics.doorwayFlowCacheHits++;
    return cachedDoorwayFlow;
  }
  const started = now();
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const assignedTargets = cacheFullAssignmentDetail(boxes, board).assignedTargets;
  const assignmentComplete = assignedTargets.size === boxes.length;
  let penalty = 0;
  const rooms = board.topology.rooms.map((room, index) => {
    const current = new Map(), target = new Map();
    boxes.forEach(([y, x, label]) => {
      if (room.cells.has(pkey(y, x))) current.set(label, (current.get(label) || 0) + 1);
    });
    room.goals.forEach(goal => {
      const label = board.goals.get(goal);
      target.set(label, (target.get(label) || 0) + 1);
    });
    const imports = new Map(), exports = new Map(), crossingTasks = [];
    boxes.forEach(([y, x, label], boxIndex) => {
      const box = pkey(y, x);
      const assigned = assignedTargets.get(boxIndex);
      if (!assigned) return;
      const inside = room.cells.has(box);
      const targetInside = room.cells.has(assigned);
      const direction = inside && !targetInside
        ? "export" : !inside && targetInside ? "import" : null;
      if (!direction) return;
      const flow = direction === "import" ? imports : exports;
      flow.set(label, (flow.get(label) || 0) + 1);
      crossingTasks.push({
        id: `${box}|${index}|${direction}`,
        box,
        label,
        direction,
        roomIndex: index,
        order: 0,
        gate: room.gate,
        target: assigned,
      });
    });
    if (!assignmentComplete) {
      imports.clear();
      exports.clear();
      crossingTasks.length = 0;
      for (const label of new Set([...current.keys(), ...target.keys()])) {
        const difference = (target.get(label) || 0) - (current.get(label) || 0);
        if (difference > 0) imports.set(label, difference);
        if (difference < 0) exports.set(label, -difference);
      }
      for (const [direction, flow] of [["export", exports], ["import", imports]]) {
        for (const [label, count] of flow) {
          boxes.filter(([y, x, boxLabel]) =>
            boxLabel === label &&
            room.cells.has(pkey(y, x)) === (direction === "export"))
            .slice(0, count)
            .forEach(([y, x]) => {
              const box = pkey(y, x);
              crossingTasks.push({
                id: `${box}|${index}|${direction}`,
                box,
                label,
                direction,
                roomIndex: index,
                order: 0,
                gate: room.gate,
                target: null,
              });
            });
        }
      }
    }
    const importTotal = [...imports.values()].reduce((sum, count) => sum + count, 0);
    const exportTotal = [...exports.values()].reduce((sum, count) => sum + count, 0);
    const interiorCapacity = [...room.interiorStaging].filter(cell => !occupied.has(cell)).length;
    const exteriorCapacity = [...room.exteriorStaging].filter(cell => !occupied.has(cell)).length;
    const importLanes = room.doorwayLanes.filter(lane => lane.importPossible);
    const exportLanes = room.doorwayLanes.filter(lane => lane.exportPossible);
    const readyImportLanes = importLanes.filter(lane =>
      !occupied.has(room.gate) && !occupied.has(lane.inside) && !occupied.has(lane.importSupport));
    const readyExportLanes = exportLanes.filter(lane =>
      !occupied.has(room.gate) && !occupied.has(lane.outside) && !occupied.has(lane.exportSupport));
    const contradictions = [];
    if (importTotal && !importLanes.length) contradictions.push("no-import-lane");
    if (exportTotal && !exportLanes.length) contradictions.push("no-export-lane");
    if (importTotal && !exteriorCapacity) contradictions.push("exterior-staging-full");
    if (exportTotal && !interiorCapacity) contradictions.push("interior-staging-full");
    const gateLabel = occupied.get(room.gate) || null;
    const crossings = importTotal + exportTotal;
    const roomPenalty = crossings +
      (gateLabel && crossings ? 2 * crossings : 0) +
      (importTotal && !readyImportLanes.length ? 2 : 0) +
      (exportTotal && !readyExportLanes.length ? 2 : 0) +
      2 * contradictions.length;
    penalty += roomPenalty;
    const distanceToGate = ([y, x]) => {
      const [gateY, gateX] = room.gate.split(",").map(Number);
      return Math.abs(y - gateY) + Math.abs(x - gateX);
    };
    for (const direction of ["export", "import"]) {
      const ordered = crossingTasks
        .filter(task => task.direction === direction)
        .sort((left, right) => {
          const leftBox = boxes.find(([y, x]) => pkey(y, x) === left.box);
          const rightBox = boxes.find(([y, x]) => pkey(y, x) === right.box);
          return distanceToGate(leftBox) - distanceToGate(rightBox) ||
            left.box.localeCompare(right.box);
        });
      ordered.forEach((task, order) => { task.order = order; });
    }
    const restoration = [];
    if (gateLabel && crossings) restoration.push(room.gate);
    if (importTotal && !exteriorCapacity) {
      restoration.push(...[...room.exteriorStaging].filter(cell => occupied.has(cell)));
    }
    if (exportTotal && !interiorCapacity) {
      restoration.push(...[...room.interiorStaging].filter(cell => occupied.has(cell)));
    }
    return {
      index,
      room,
      imports,
      exports,
      importTotal,
      exportTotal,
      interiorCapacity,
      exteriorCapacity,
      readyImportLanes: readyImportLanes.length,
      readyExportLanes: readyExportLanes.length,
      gateLabel,
      contradictions,
      crossingTasks,
      restoration: [...new Set(restoration)],
      penalty: roomPenalty,
    };
  });
  const tasks = rooms.flatMap(flow => flow.crossingTasks);
  const scheduleDependencies = new Map(tasks.map(task => [task.id, new Set()]));
  const sharesCorridor = (leftIndex, rightIndex) => {
    if (leftIndex === rightIndex) return true;
    const left = rooms[leftIndex].room;
    const right = rooms[rightIndex].room;
    return left.gate === right.gate ||
      [...left.approach].some(([cell]) => right.approach.has(cell));
  };
  for (const task of tasks) {
    for (const predecessor of tasks) {
      if (task === predecessor) continue;
      if (task.roomIndex === predecessor.roomIndex &&
          task.direction === predecessor.direction &&
          predecessor.order < task.order) {
        scheduleDependencies.get(task.id).add(predecessor.id);
      }
      if (task.box === predecessor.box &&
          predecessor.direction === "export" && task.direction === "import") {
        scheduleDependencies.get(task.id).add(predecessor.id);
      }
      if (task.roomIndex !== predecessor.roomIndex &&
          sharesCorridor(task.roomIndex, predecessor.roomIndex) &&
          predecessor.direction === "export" &&
          task.direction === "import") {
        scheduleDependencies.get(task.id).add(predecessor.id);
      }
    }
  }
  const orderedTasks = [...tasks].sort((left, right) =>
    Number(left.direction === "import") - Number(right.direction === "import") ||
    left.roomIndex - right.roomIndex || left.order - right.order ||
    left.id.localeCompare(right.id));
  const waves = [];
  for (const task of orderedTasks) {
    const dependencies = scheduleDependencies.get(task.id);
    let wave = waves.find(candidate => candidate.every(other =>
      !dependencies.has(other.id) &&
      !scheduleDependencies.get(other.id).has(task.id) &&
      !sharesCorridor(task.roomIndex, other.roomIndex)));
    if (!wave) {
      wave = [];
      waves.push(wave);
    }
    wave.push(task);
  }
  const result = {
    rooms,
    penalty,
    tasks,
    orderedTasks,
    waves,
    scheduleDependencies,
    restoration: new Set(rooms.flatMap(flow => flow.restoration)),
    exactContradictions: [],
  };
  metrics.doorwayFlowMs += now() - started;
  return memoizeBounded(board.doorwayFlowMemo, signature, result, DOORWAY_FLOW_MEMO_LIMIT);
}

function doorwayFlowDelta(analysis, state, next) {
  const from = next.pushedFrom, to = next.pushedTo;
  const label = state.boxes.find(([y, x]) => pkey(y, x) === from)?.[2] ||
    next.pushClass?.split(":")[0];
  let delta = 0;
  for (const flow of analysis.rooms) {
    const {room} = flow;
    const fromInside = room.cells.has(from), toInside = room.cells.has(to);
    let direction = null;
    if ((to === room.gate && !fromInside) || (from === room.gate && toInside)) {
      direction = "import";
    } else if ((to === room.gate && fromInside) || (from === room.gate && !toInside)) {
      direction = "export";
    }
    if (direction === "import") delta += flow.imports.has(label) ? -1.5 : 1.5;
    if (direction === "export") delta += flow.exports.has(label) ? -1.5 : 1.5;
    if (flow.importTotal) {
      if (room.exteriorStaging.has(to)) delta += 0.25;
      if (room.exteriorStaging.has(from) && flow.imports.has(label)) delta -= 0.25;
    }
    if (flow.exportTotal) {
      if (room.interiorStaging.has(to)) delta += 0.25;
      if (room.interiorStaging.has(from) && flow.exports.has(label)) delta -= 0.25;
    }
  }
  if (analysis.restoration.has(from)) delta -= 0.75;
  if (analysis.restoration.has(to)) delta += 0.75;
  for (const task of analysis.tasks) {
    if (task.box !== from || task.label !== label) continue;
    const flow = analysis.rooms[task.roomIndex];
    const fromInside = flow.room.cells.has(from);
    const toInside = flow.room.cells.has(to);
    if (task.direction === "import" && !fromInside && toInside) delta -= 1;
    if (task.direction === "export" && fromInside && !toInside) delta -= 1;
  }
  return delta;
}

function evaluateGoalAccess(goalAccess, occupied) {
  let penalty = 0;
  const goals = goalAccess.map(entry => {
    const solved = occupied.get(entry.goal) === entry.label;
    const lanes = entry.lanes.map(lane => {
      const sourceLabel = occupied.get(lane.source);
      const supportLabel = occupied.get(lane.support);
      const sourceCompatible = sourceLabel === undefined || sourceLabel === entry.label;
      const open = supportLabel === undefined && sourceCompatible;
      const blockers = [];
      if (sourceLabel !== undefined && sourceLabel !== entry.label) blockers.push(lane.source);
      if (supportLabel !== undefined) blockers.push(lane.support);
      return {...lane, open, ready: sourceLabel === entry.label && !supportLabel, blockers};
    });
    const openLanes = lanes.filter(lane => lane.open).length;
    let accessPenalty = 0;
    if (!solved && lanes.length) {
      accessPenalty = (lanes.length - openLanes) / lanes.length;
      if (!openLanes) accessPenalty += 4;
      else if (openLanes === 1 && lanes.length > 1) accessPenalty += 0.5;
      penalty += accessPenalty;
    }
    return {
      goal: entry.goal,
      label: entry.label,
      solved,
      lanes,
      openLanes,
      accessPenalty,
      blockers: new Set(lanes.flatMap(lane => lane.blockers)),
    };
  });
  return {
    goals,
    penalty,
    blockedGoals: goals.filter(goal => !goal.solved && !goal.openLanes),
  };
}

function goalAccessAnalysis(boxes, board) {
  const metrics = board.metrics;
  metrics.goalAccessCalls++;
  const signature = boxSignature(boxes, board);
  const cachedGoalAccess = memoLookup(board.goalAccessMemo, signature);
  if (cachedGoalAccess !== undefined) {
    metrics.goalAccessCacheHits++;
    return cachedGoalAccess;
  }
  const started = now();
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const result = evaluateGoalAccess(board.topology.goalAccess, occupied);
  result.packingRisk = new Map();
  result.safeGoals = new Set();
  for (const goal of result.goals) {
    if (goal.solved) continue;
    let risk = 5;
    if (!occupied.has(goal.goal)) {
      const packed = new Map(occupied);
      packed.set(goal.goal, goal.label);
      risk = evaluateGoalAccess(board.topology.goalAccess, packed).penalty - result.penalty;
    }
    result.packingRisk.set(goal.goal, risk);
    if (risk <= 0) result.safeGoals.add(goal.goal);
  }
  metrics.goalAccessBlockedGoals += result.blockedGoals.length;
  metrics.goalAccessMs += now() - started;
  return memoizeBounded(
    board.goalAccessMemo,
    signature,
    result,
    GOAL_ACCESS_MEMO_LIMIT,
  );
}

function goalAccessDelta(analysis, state, next, board) {
  const occupied = new Map(state.boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const label = occupied.get(next.pushedFrom);
  if (label === undefined) return 0;
  occupied.delete(next.pushedFrom);
  occupied.set(next.pushedTo, label);
  return evaluateGoalAccess(board.topology.goalAccess, occupied).penalty - analysis.penalty;
}

function relevanceOrderingScore(state, board, next, evidence = {}) {
  const dependency = evidence.supportDependency;
  const doorway = evidence.doorway;
  const goalAccess = evidence.goalAccess;
  const recent = evidence.recentPush;
  const movedIndex = state.boxes.findIndex(([y, x]) => pkey(y, x) === next.pushedFrom);
  const target = dependency?.assignedTargets.get(movedIndex);
  const beforeDistance = target
    ? compiledGoalPushDistance(board, next.pushedFrom, target) : Infinity;
  const afterDistance = target
    ? compiledGoalPushDistance(board, next.pushedTo, target) : Infinity;
  const rawAssignmentProgress = Number.isFinite(beforeDistance) && Number.isFinite(afterDistance)
    ? afterDistance - beforeDistance : 0;
  const targetPackingRisk = target && goalAccess?.packingRisk.get(target) || 0;
  const assignmentProgress = targetPackingRisk > 0
    ? rawAssignmentProgress < 0
      ? -rawAssignmentProgress * Math.min(1, targetPackingRisk)
      : -0.5 * rawAssignmentProgress
    : rawAssignmentProgress;
  const dependencyDelta = dependency ? supportDependencyDelta(dependency, next) : 0;
  const doorwayDelta = doorway ? doorwayFlowDelta(doorway, state, next) : 0;
  const bottleneck = dependency?.nodes.reduce((best, node) =>
    node.minimumBlockerDisplacement > (best?.minimumBlockerDisplacement || -1)
      ? node : best, null);
  const bottleneckDelta = bottleneck?.box === next.pushedFrom ? -0.5 :
    bottleneck?.prerequisites.has(next.pushedFrom) ? -1 : 0;
  const recentEnablement = recent && dependency?.stagingSides
    .get(next.pushedFrom)?.some(side => side.support === recent.pushedFrom)
    ? -0.75 : 0;
  const restorationDelta = doorway?.restoration.has(next.pushedFrom) ? -0.5 :
    doorway?.restoration.has(next.pushedTo) ? 0.5 : 0;
  const goalAccessChange = goalAccess
    ? goalAccessDelta(goalAccess, state, next, board)
    : 0;
  const signals = {
    assignment: assignmentProgress,
    dependency: dependencyDelta,
    bottleneck: bottleneckDelta,
    recentEnablement,
    doorway: doorwayDelta,
    restoration: restorationDelta,
    goalAccess: goalAccessChange,
  };
  return {
    score: Object.values(signals).reduce((total, value) => total + value, 0),
    signals,
  };
}

function recordRelevanceOrdering(metrics, relevance) {
  metrics.relevanceOrderingEvaluations++;
  if (relevance.score) metrics.relevanceOrderingChanges++;
  const mapping = {
    assignment: "relevanceAssignmentUses",
    dependency: "relevanceDependencyUses",
    bottleneck: "relevanceBottleneckUses",
    recentEnablement: "relevanceRecentUses",
    doorway: "relevanceDoorwayUses",
    restoration: "relevanceRestorationUses",
    goalAccess: "relevanceGoalAccessUses",
  };
  for (const [signal, metric] of Object.entries(mapping)) {
    if (relevance.signals[signal]) metrics[metric]++;
  }
  return relevance.score;
}

function roomFlowSignature(boxes, board) {
  return board.topology.rooms.map((room, index) => {
    const labels = boxes
      .filter(([y, x]) => room.cells.has(pkey(y, x)))
      .map(([, , label]) => label)
      .sort()
      .join("");
    return `${index}:${labels}`;
  }).join("|");
}

function roomTransitionEvent(before, after, board) {
  const previous = roomFlowSignature(before, board);
  const current = roomFlowSignature(after, board);
  return previous === current ? null : current;
}

function linearConflictFromGrouped(grouped, board, assignmentMap) {
  let conflicts = 0;
  for (const [label, entries] of grouped) {
    const targets = board.goalsByLabel.get(label) || [];
    const assignment = assignmentMap
      ? assignmentMap.get(label)
      : minimumAssignment(entries.map(({y, x}) =>
          targets.map(target => compiledGoalPushDistance(board, pkey(y, x), target))));
    if (!assignment?.matching || !Number.isFinite(assignment.cost)) continue;
    const pairs = [];
    for (let column = 1; column < assignment.matching.length; column++) {
      const row = assignment.matching[column] - 1;
      if (row < 0 || row >= entries.length) continue;
      const goalKey = targets[column - 1];
      if (!goalKey) continue;
      const [goalY, goalX] = goalKey.split(",").map(Number);
      pairs.push({boxY: entries[row].y, boxX: entries[row].x, goalY, goalX});
    }
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const a = pairs[i], b = pairs[j];
        if (a.boxY === b.boxY && a.goalY === a.boxY && b.goalY === b.boxY) {
          if ((a.boxX < b.boxX && a.goalX > b.goalX) ||
              (a.boxX > b.boxX && a.goalX < b.goalX)) {
            conflicts++;
          }
        }
      }
    }
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const a = pairs[i], b = pairs[j];
        if (a.boxX === b.boxX && a.goalX === a.boxX && b.goalX === b.boxX) {
          if ((a.boxY < b.boxY && a.goalY > b.goalY) ||
              (a.boxY > b.boxY && a.goalY < b.goalY)) {
            conflicts++;
          }
        }
      }
    }
  }
  return 2 * conflicts;
}

function linearConflict(boxes, board) {
  return linearConflictFromGrouped(boxesByLabelWithIndices(boxes), board, null);
}

// --- Module registration ---
const SokomindHeuristic = {
  linearConflict,
  linearConflictFromGrouped,
  boxesByLabelWithIndices,
  cacheAssignmentDetail,
  cacheFullAssignmentDetail,
  cacheDiscoveryAssignmentDetail,
  heuristicWithInteractions,
  heuristic,
  discoveryHeuristic,
  topologyPenalty,
  roomEvacuationPenalty,
  assignmentDoorwayPlan,
  DOORWAY_TASK_PARTITION_MEMO,
  doorwayTaskPartitions,
  doorwayScheduleState,
  typedDoorwayFlow,
  doorwayFlowDelta,
  evaluateGoalAccess,
  goalAccessAnalysis,
  goalAccessDelta,
  relevanceOrderingScore,
  recordRelevanceOrdering,
  roomFlowSignature,
  roomTransitionEvent,
};

/* ===== deadlock.js ===== */
// Deadlock detection: corner, static dead, 2x2, frozen component, closed diagonal, pattern database, and dynamic.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

function corner(y, x, board, label) {
  if (board.goals.get(pkey(y, x)) === label) return false;
  const wall = (dy, dx) => board.walls.has(pkey(y + dy, x + dx));
  return (wall(-1, 0) && wall(0, -1)) || (wall(-1, 0) && wall(0, 1)) ||
    (wall(1, 0) && wall(0, -1)) || (wall(1, 0) && wall(0, 1));
}
function staticDead(y, x, board, label) {
  if (board.goals.get(pkey(y, x)) === label) return false;
  const distances = playerAwarePushDistances(board, pkey(y, x));
  return !(board.goalsByLabel.get(label) || []).some(goal => distances.has(goal));
}
function creates2x2Deadlock(boxes, board, movedBox) {
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const [boxY, boxX] = movedBox;
  for (const originY of [boxY - 1, boxY]) {
    for (const originX of [boxX - 1, boxX]) {
      const cells = [
        [originY, originX], [originY + 1, originX],
        [originY, originX + 1], [originY + 1, originX + 1],
      ];
      if (!cells.every(([y, x]) => board.walls.has(pkey(y, x)) || occupied.has(pkey(y, x)))) continue;
      if (cells.some(([y, x]) => {
        const label = occupied.get(pkey(y, x));
        return label && board.goals.get(pkey(y, x)) !== label;
      })) return true;
    }
  }
  return false;
}
function createsFrozenComponentDeadlock(boxes, board, movedBox) {
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const start = pkey(movedBox[0], movedBox[1]);
  if (!occupied.has(start)) return false;
  const component = new Set([start]), queue = [movedBox];
  for (let head = 0; head < queue.length; head++) {
    const [y, x] = queue[head];
    for (const [dy, dx] of Object.values(DIRS)) {
      const adjacent = pkey(y + dy, x + dx);
      if (!occupied.has(adjacent) || component.has(adjacent)) continue;
      component.add(adjacent);
      queue.push([y + dy, x + dx]);
    }
  }
  board.metrics.recursiveFreezeChecks++;
  const recursivelyFrozen = new Set();
  const isBlocker = position =>
    !board.floor.has(position) ||
    (occupied.has(position) && recursivelyFrozen.has(position));
  let changed = true;
  while (changed) {
    changed = false;
    for (const position of component) {
      if (recursivelyFrozen.has(position)) continue;
      const [y, x] = position.split(",").map(Number);
      const horizontal = isBlocker(pkey(y, x - 1)) || isBlocker(pkey(y, x + 1));
      const vertical = isBlocker(pkey(y - 1, x)) || isBlocker(pkey(y + 1, x));
      if (!horizontal || !vertical) continue;
      recursivelyFrozen.add(position);
      changed = true;
    }
  }
  board.metrics.recursiveFreezeBoxes += recursivelyFrozen.size;
  if ([...recursivelyFrozen]
    .some(position => board.goals.get(position) !== occupied.get(position))) return true;
  const movable = queue.some(([y, x]) => Object.values(DIRS).some(([dy, dx]) => {
    const destination = pkey(y + dy, x + dx);
    const support = pkey(y - dy, x - dx);
    return board.floor.has(destination) && board.floor.has(support) &&
      !occupied.has(destination) && !occupied.has(support);
  }));
  if (movable) return false;
  return [...component].some(position => board.goals.get(position) !== occupied.get(position));
}

function createsClosedDiagonalDeadlock(boxes, board, movedBox) {
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const movedKey = pkey(movedBox[0], movedBox[1]);
  if (!occupied.has(movedKey)) return false;
  const limit = board.rows.length + Math.max(...board.rows.map(row => row.length)) + 2;
  const blocked = (y, x) => board.walls.has(pkey(y, x)) || occupied.has(pkey(y, x));

  const scanHalf = (startY, startX, stepY, stepX) => {
    const boxesOnBorder = new Set();
    const boxSides = [];
    let y = startY, x = startX;
    for (let distance = 0; distance < limit; distance++, y += stepY, x += stepX) {
      const center = pkey(y, x);
      if (board.walls.has(center)) {
        return {closed: true, boxes: boxesOnBorder, boxSides, rows: distance};
      }
      if (occupied.has(center) && staticallyImmovable(center, board)) {
        boxesOnBorder.add(center);
        return {closed: true, boxes: boxesOnBorder, boxSides, rows: distance};
      }
      if (!board.floor.has(center) || occupied.has(center) || board.goals.has(center)) {
        return {closed: false, boxes: boxesOnBorder, boxSides, rows: distance};
      }
      let rowBoxSide = null;
      for (const [sideOffset, sideX] of [[-1, x - 1], [1, x + 1]]) {
        const side = pkey(y, sideX);
        if (!blocked(y, sideX) || (board.goals.has(side) && !occupied.has(side))) {
          return {closed: false, boxes: boxesOnBorder, boxSides, rows: distance};
        }
        if (occupied.has(side)) {
          if (rowBoxSide !== null) {
            return {closed: false, boxes: boxesOnBorder, boxSides, rows: distance};
          }
          rowBoxSide = sideOffset;
          boxesOnBorder.add(side);
        }
      }
      if (rowBoxSide === null) {
        return {closed: false, boxes: boxesOnBorder, boxSides, rows: distance};
      }
      boxSides.push(rowBoxSide);
    }
    return {closed: false, boxes: boxesOnBorder, boxSides, rows: limit};
  };

  for (const centerX of [movedBox[1] - 1, movedBox[1] + 1]) {
    for (const slope of [-1, 1]) {
      const up = scanHalf(movedBox[0], centerX, -1, -slope);
      const down = scanHalf(movedBox[0] + 1, centerX + slope, 1, slope);
      if (!up.closed || !down.closed || up.rows + down.rows < 2) continue;
      const participants = new Set([...up.boxes, ...down.boxes]);
      const boxSides = [...up.boxSides].reverse().concat(down.boxSides);
      const outwardFacing = boxSides.length === 2 &&
        boxSides[0] === -slope && boxSides[1] === slope;
      const unfinished = [...participants]
        .some(position => board.goals.get(position) !== occupied.get(position));
      if (!unfinished || !participants.has(movedKey) || participants.size < 2) continue;
      if (outwardFacing || createsPatternDatabaseDeadlock(boxes, board, movedBox)) return true;
    }
  }
  return false;
}

function canonicalLocalPattern(floor, boxes, goals) {
  const points = [...floor].map(position => position.split(",").map(Number));
  const transforms = [
    ([y, x]) => [y, x], ([y, x]) => [y, -x],
    ([y, x]) => [-y, x], ([y, x]) => [-y, -x],
    ([y, x]) => [x, y], ([y, x]) => [x, -y],
    ([y, x]) => [-x, y], ([y, x]) => [-x, -y],
  ];
  const variants = transforms.map(transform => {
    const transformed = points.map(transform);
    const minY = Math.min(...transformed.map(([y]) => y));
    const minX = Math.min(...transformed.map(([, x]) => x));
    const keyFor = position => {
      const [y, x] = transform(position.split(",").map(Number));
      return `${y - minY},${x - minX}`;
    };
    const floorKey = [...floor].map(keyFor).sort().join(".");
    const goalKey = [...goals]
      .filter(([position]) => floor.has(position))
      .map(([position, label]) => `${keyFor(position)},${label}`).sort().join(".");
    const boxKey = boxes
      .map(([position, label]) => `${keyFor(position)},${label}`).sort().join(".");
    return `${floorKey}|${goalKey}|${boxKey}`;
  });
  return variants.sort()[0];
}

function createsPatternDatabaseDeadlock(
  boxes,
  board,
  movedBox,
  maxStates = PATTERN_EXACT_STATE_LIMIT,
) {
  const metrics = board.metrics;
  metrics.patternDeadlockCalls++;
  const [centerY, centerX] = movedBox;
  const inside = position => {
    const [y, x] = position.split(",").map(Number);
    return Math.abs(y - centerY) <= 4 && Math.abs(x - centerX) <= 4;
  };
  const windowKey = `${centerY},${centerX}`;
  let window = memoLookup(board.patternWindowMemo, windowKey);
  if (!window) {
    const floor = new Set([...board.floor].filter(inside));
    const eligible = floor.size <= PATTERN_FLOOR_LIMIT &&
      ![...floor].some(position => floorNeighbors(position, board.floor).length > 2);
    window = {floor, eligible};
    board.patternWindowMemo.set(windowKey, window);
  }
  if (!window.eligible) return false;
  const localFloor = window.floor;
  const localBoxes = boxes
    .map(([y, x, label]) => [pkey(y, x), label])
    .filter(([position]) => localFloor.has(position));
  if (localBoxes.length < 2 || localBoxes.length > PATTERN_BOX_LIMIT) return false;
  const stateUpperBound = localExactStateUpperBound(localFloor.size, localBoxes);
  if (stateUpperBound > PATTERN_EXACT_STATE_LIMIT) return false;
  const cacheKey = canonicalLocalPattern(localFloor, localBoxes, board.goals);
  metrics.patternCanonicalizations++;
  const cachedPatternDeadlock = memoLookup(board.patternDeadlockMemo, cacheKey);
  if (cachedPatternDeadlock !== undefined) {
    metrics.patternDeadlockCacheHits++;
    return cachedPatternDeadlock;
  }

  const signature = local => local
    .map(([position, label]) => `${position},${label}`).sort().join(";");
  const queue = [localBoxes], seen = new Set([signature(localBoxes)]);
  let head = 0, salvaged = false;
  const stateLimit = Math.min(maxStates, PATTERN_EXACT_STATE_LIMIT, stateUpperBound + 1);
  for (; head < queue.length && seen.size <= stateLimit; head++) {
    const current = queue[head];
    if (current.every(([position, label]) => board.goals.get(position) === label)) {
      salvaged = true;
      break;
    }
    const occupied = new Set(current.map(([position]) => position));
    current.forEach(([position, label], boxIndex) => {
      const [y, x] = position.split(",").map(Number);
      for (const [dy, dx] of Object.values(DIRS)) {
        const support = pkey(y - dy, x - dx);
        const destination = pkey(y + dy, x + dx);
        if (!board.floor.has(support) || occupied.has(support) ||
            !board.floor.has(destination) || occupied.has(destination)) continue;
        const next = inside(destination)
          ? current.map((box, index) => index === boxIndex ? [destination, label] : box)
          : current.filter((_, index) => index !== boxIndex);
        const nextSignature = signature(next);
        if (seen.has(nextSignature)) continue;
        seen.add(nextSignature);
        queue.push(next);
      }
    });
  }
  metrics.patternDeadlockStates += Math.min(head, queue.length);
  const cutoff = !salvaged && head < queue.length;
  const deadlocked = !salvaged && !cutoff;
  if (deadlocked) metrics.patternDeadlockPrunes++;
  return cutoff ? false : memoizeBounded(
    board.patternDeadlockMemo, cacheKey, deadlocked, PATTERN_DEADLOCK_MEMO_LIMIT);
}

function createsDynamicDeadlock(boxes, board, movedBox) {
  const signature = `${boxSignature(boxes, board)}|${movedBox.join(",")}`;
  const cachedDeadlock = memoLookup(board.deadlockMemo, signature);
  if (cachedDeadlock !== undefined) return cachedDeadlock;
  const deadlocked = DYNAMIC_HARD_PRUNING_RULES.some(
    rule => rule.detect(boxes, board, movedBox),
  );
  // The legacy PI-corral helper guessed the keeper region from an arbitrary
  // free neighbor of the moved box. That is not a proof and can reject legal
  // states. Exact-player-region corral checks remain active in analysis.js.
  return memoizeBounded(board.deadlockMemo, signature, deadlocked, DEADLOCK_MEMO_LIMIT);
}

// --- Module registration ---
const SokomindDeadlock = {
  corner,
  staticDead,
  creates2x2Deadlock,
  createsFrozenComponentDeadlock,
  createsClosedDiagonalDeadlock,
  canonicalLocalPattern,
  createsPatternDatabaseDeadlock,
  createsDynamicDeadlock,
};

/* ===== analysis.js ===== */
// Puzzle analysis, goal commitments, reachability, neighbors, support dependencies, local exact search, corral analysis, and hard pruning rules.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

function analyzePuzzleForSearch(data) {
  const board = parse(data);
  const boxes = data.boxes.map(([position, label]) => [
    ...position.split(",").map(Number), label,
  ]);
  const initial = {robot: data.robot, boxes};
  const labels = {};
  boxes.forEach(([, , label]) => { labels[label] = (labels[label] || 0) + 1; });
  const initialHeuristic = heuristic(boxes, board);
  const evacuationPenalty = roomEvacuationPenalty(boxes, board);
  const initialGoalAccess = goalAccessAnalysis(boxes, board);
  const legalPushes = pushNeighbors(initial, board).length;
  const solvedBoxes = boxes.filter(([y, x, label]) =>
    board.goals.get(pkey(y, x)) === label).length;
  const roomSummaries = board.topology.rooms.map(room => {
    const inside = boxes.filter(([y, x]) => room.cells.has(pkey(y, x)));
    const current = {}, target = {};
    inside.forEach(([, , label]) => { current[label] = (current[label] || 0) + 1; });
    room.goals.forEach(goal => {
      const label = board.goals.get(goal);
      target[label] = (target[label] || 0) + 1;
    });
    const surplus = Object.entries(current).reduce((sum, [label, count]) =>
      sum + Math.max(0, count - (target[label] || 0)), 0);
    return {
      gate: room.gate,
      cells: room.cells.size,
      goals: room.goals.length,
      boxes: inside.length,
      surplus,
      dependencies: room.dependencies.length,
      maxDepth: Math.max(0, ...room.depths.values()),
    };
  });
  const searchScale = boxes.length * board.floor.size;
  const dependencyCount = roomSummaries.reduce((sum, room) => sum + room.dependencies, 0);
  const surplusBoxes = roomSummaries.reduce((sum, room) => sum + room.surplus, 0);
  const reversePortfolio = reverseStartPortfolio(board, boxes);
  const productiveReverseRegions = reversePortfolio.filter(entry => entry.pullOptions > 0);
  for (const [y, x] of boxes) playerAwarePushDistances(board, pkey(y, x));
  const pressure = searchScale * (1 + 0.18 * board.topology.rooms.length) *
    (1 + 0.08 * dependencyCount) * (1 + 0.06 * Math.max(0, legalPushes - 2));
  const difficulty = pressure >= 1800 ? "extreme" : pressure >= 700 ? "complex" :
    pressure >= 180 ? "moderate" : "small";
  const phases = [];
  if (surplusBoxes) phases.push({id: "evacuation", reason: `${surplusBoxes} surplus room box${surplusBoxes === 1 ? "" : "es"}`});
  if (board.topology.rooms.length) phases.push({id: "room-packing", reason: `${board.topology.rooms.length} gated goal room${board.topology.rooms.length === 1 ? "" : "s"}`});
  if (board.topology.tunnels.size) phases.push({id: "tunnel-macros", reason: `${board.topology.tunnels.size} tunnel cells`});
  if (boxes.length >= 4 && difficulty !== "extreme") {
    phases.push({id: "feature-space", reason: "label-aware packing and connectivity axes"});
  }
  if (difficulty === "complex" || difficulty === "extreme") {
    phases.push({id: "milestone-reverse", reason: "large canonical push space"});
    phases.push({id: "landmark-bridges", reason: "connect forward phases to reverse layouts"});
  }
  phases.push({id: "exact-proof", reason: "complete fallback after heuristic workers"});
  const recommendations = {
    reverseWorkerLimit: difficulty === "extreme" ? 2 : difficulty === "complex" ? 2 : 3,
    sideVisitedLimit: difficulty === "extreme" ? 100000 : difficulty === "complex" ? 200000 : 250000,
    beamAttempts: difficulty === "small" ? 1 : 2,
    beamWidth: difficulty === "extreme" ? 300 : difficulty === "complex" ? 700 : 1200,
    beamVisited: difficulty === "extreme" ? 110000 : difficulty === "complex" ? 180000 : 250000,
    useEvacuation: surplusBoxes > 0,
    useSequenceMacros: board.topology.tunnels.size > 0 || board.topology.rooms.length > 0,
    useFess: boxes.length >= 4 && difficulty !== "extreme",
    useMilestoneReverse: difficulty === "complex" || difficulty === "extreme",
    checkpointLimit: difficulty === "extreme" ? 12 : 8,
  };
  const preparedBoard = createPreparedBoardSeed(board);
  return {
    dimensions: {rows: data.rows.length, columns: Math.max(...data.rows.map(row => row.length))},
    floorCells: board.floor.size,
    boxes: boxes.length,
    goals: board.goals.size,
    labels,
    solvedBoxes,
    initialHeuristic,
    legalPushes,
    articulations: board.topology.articulations.size,
    tunnelCells: board.topology.tunnels.size,
    rooms: roomSummaries,
    surplusBoxes,
    evacuationPenalty,
    goalAccessClauses: board.topology.goalAccess.reduce(
      (total, goal) => total + goal.lanes.filter(lane => lane.blockingGoals.length).length,
      0,
    ),
    blockedGoalAccess: initialGoalAccess.blockedGoals.length,
    goalAccessPenalty: initialGoalAccess.penalty,
    dependencyCount,
    reverseStartRegions: reversePortfolio.length,
    productiveReverseStartRegions: productiveReverseRegions.length,
    reverseStartPulls: reversePortfolio.reduce((sum, entry) => sum + entry.pullOptions, 0),
    searchScale,
    pressure: Math.round(pressure),
    difficulty,
    phases,
    recommendations,
    preparedBoard,
    preparedBoardStats: {
      estimatedBytes: preparedBoard.estimatedBytes,
      goalTables: preparedBoard.goalPushTables.byGoal.size,
      playerDistanceTables: preparedBoard.playerPushDistances.size,
      graphNodes: board.metrics.graphNodes,
      graphEdges: board.metrics.graphEdges,
      buildMs: Math.round(board.metrics.parseMs * 1000) / 1000,
    },
  };
}

function stratifiedCheckpoints(checkpoints) {
  const bands = new Map();
  for (const checkpoint of checkpoints) {
    if (!bands.has(checkpoint.checkpointBand)) bands.set(checkpoint.checkpointBand, []);
    bands.get(checkpoint.checkpointBand).push(checkpoint);
  }
  const queues = [...bands.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, items]) => items);
  const result = [];
  for (let depth = 0; queues.some(items => depth < items.length); depth++) {
    for (const items of queues) if (depth < items.length) result.push(items[depth]);
  }
  return result;
}
function targetMapFromBoxes(boxes, board) {
  const targets = new Map();
  boxes.forEach(([y, x, label]) => {
    if (!targets.has(label)) targets.set(label, []);
    targets.get(label).push({distances: playerAwarePushDistances(board, pkey(y, x))});
  });
  targets.memo = new Map();
  targets.board = board;
  return targets;
}
function homeHeuristic(boxes, targetsByLabel) {
  const signature = boxSignature(boxes, targetsByLabel.board);
  if (targetsByLabel.memo.has(signature)) return targetsByLabel.memo.get(signature);
  const byLabel = new Map();
  boxes.forEach(([y, x, label]) => {
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push([y, x]);
  });
  let total = 0;
  for (const [label, positions] of byLabel) {
    const targets = targetsByLabel.get(label) || [];
    const costs = positions.map(([y, x]) => targets.map(target => (
      target.distances.get(pkey(y, x)) ?? Infinity
    )));
    total += minimumAssignmentCost(costs);
  }
  return memoizeBounded(targetsByLabel.memo, signature, total);
}

function targetLayoutHeuristic(boxes, targetBoxes, board, memo) {
  const signature = boxSignature(boxes, board);
  if (memo.has(signature)) return memo.get(signature);
  const targetsByLabel = new Map();
  targetBoxes.forEach(([y, x, label]) => {
    if (!targetsByLabel.has(label)) targetsByLabel.set(label, []);
    targetsByLabel.get(label).push(pkey(y, x));
  });
  const byLabel = new Map();
  boxes.forEach(([y, x, label]) => {
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push([y, x]);
  });
  let total = 0;
  for (const [label, positions] of byLabel) {
    const targets = targetsByLabel.get(label) || [];
    const costs = positions.map(([y, x]) => {
      const distances = playerAwarePushDistances(board, pkey(y, x));
      return targets.map(target => distances.get(target) ?? Infinity);
    });
    total += minimumAssignmentCost(costs);
  }
  return memoizeBounded(memo, signature, total);
}
function goal(boxes, goals) {
  return boxes.every(([y, x, label]) => goals.get(pkey(y, x)) === label);
}

function staticallyImmovable(position, board) {
  const [y, x] = position.split(",").map(Number);
  return !Object.values(DIRS).some(([dy, dx]) =>
    board.floor.has(pkey(y + dy, x + dx)) &&
    board.floor.has(pkey(y - dy, x - dx)));
}

function commitmentPushDistances(board, fixedPosition, target) {
  const key = `${fixedPosition}|${target}`;
  board.commitmentPushDistances ??= new Map();
  if (board.commitmentPushDistances.has(key)) return board.commitmentPushDistances.get(key);
  const floor = new Set(board.floor);
  floor.delete(fixedPosition);
  const distances = reversePushDistances(floor, target);
  board.commitmentPushDistances.set(key, distances);
  return distances;
}

function residualMatchingSurvives(boxes, board, fixedIndex, fixedPosition) {
  const remaining = boxes.filter((_, index) => index !== fixedIndex);
  const boxesByLabel = new Map(), goalsByLabel = new Map();
  for (const [y, x, label] of remaining) {
    if (!boxesByLabel.has(label)) boxesByLabel.set(label, []);
    boxesByLabel.get(label).push(pkey(y, x));
  }
  for (const [position, label] of board.goals) {
    if (position === fixedPosition) continue;
    if (!goalsByLabel.has(label)) goalsByLabel.set(label, []);
    goalsByLabel.get(label).push(position);
  }
  const labels = new Set([...boxesByLabel.keys(), ...goalsByLabel.keys()]);
  for (const label of labels) {
    const positions = boxesByLabel.get(label) || [];
    const targets = goalsByLabel.get(label) || [];
    if (positions.length !== targets.length) return false;
    const distances = targets.map(target =>
      commitmentPushDistances(board, fixedPosition, target));
    const costs = positions.map(position =>
      distances.map(distance => distance.get(position) ?? Infinity));
    if (!Number.isFinite(minimumAssignmentCost(costs))) return false;
  }
  return true;
}

function blocksPendingRoomWork(position, occupied, board) {
  for (const room of board.topology.rooms) {
    if (!room.cells.has(position) && room.gate !== position) continue;
    const pending = room.goals.filter(goal =>
      goal !== position && occupied.get(goal) !== board.goals.get(goal));
    if (room.gate === position && pending.length) return true;
    if (room.dependencies.some(([blocker, prerequisite]) =>
      blocker === position &&
      occupied.get(prerequisite) !== board.goals.get(prerequisite))) return true;
  }
  return false;
}

function commitmentPositionConflict(position, evidence) {
  const dependencyGraph = evidence?.supportDependency;
  if ((dependencyGraph?.supportDemand?.get(position) || 0) > 0 ||
      (dependencyGraph?.prerequisiteDemand?.get(position) || 0) > 0) return true;
  for (const flow of evidence?.doorway?.rooms || []) {
    const crossings = flow.importTotal + flow.exportTotal;
    if (crossings && position === flow.room.gate) return true;
    if (flow.importTotal && flow.room.exteriorStaging.has(position)) return true;
    if (flow.exportTotal && flow.room.interiorStaging.has(position)) return true;
  }
  for (const analysis of evidence?.localAnalyses || []) {
    if (analysis.status !== "solvable" || !analysis.firstPushes?.size) continue;
    const requiredSources = new Set(
      [...analysis.firstPushes].map(push => push.split(">")[0]),
    );
    if (requiredSources.size === 1 && requiredSources.has(position)) return true;
  }
  return false;
}

function commitmentPrerequisitesProven(position, evidence) {
  const graph = evidence?.supportDependency;
  if (!graph) return true;
  if (graph.assignmentComplete === false || graph.cycles?.size) return false;
  return !(graph.prerequisiteClosure?.get(position)?.size) &&
    !(graph.supportDemand?.get(position) > 0) &&
    !(graph.prerequisiteDemand?.get(position) > 0);
}

function exactRoomCompletionProven(analysis, evidence) {
  if (analysis.kind === "corral" || analysis.roomIndex === undefined ||
      analysis.proofComplete === false) return false;
  const transition = evidence?.transition;
  if (analysis.status === "packed") {
    return !transition ||
      (!analysis.domain.has(transition.pushedFrom) && !analysis.domain.has(transition.pushedTo));
  }
  return analysis.status === "solvable" && analysis.pushes === 1 &&
    transition?.pushes === 1 &&
    analysis.firstPushes.has(`${transition.pushedFrom}>${transition.pushedTo}`);
}

function refineGoalCommitments(base, boxes, board, evidence) {
  const commitments = new Map(base);
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  for (const position of commitments.keys()) {
    if (commitmentPositionConflict(position, evidence)) {
      commitments.set(position, GOAL_COMMITMENT.TEMPORARY);
    }
  }
  for (const analysis of evidence?.localAnalyses || []) {
    if (analysis.kind === "corral" && analysis.proofComplete) {
      for (const position of analysis.provenCommitments || []) {
        if (commitments.get(position) === GOAL_COMMITMENT.TEMPORARY ||
            commitmentPositionConflict(position, evidence) ||
            !commitmentPrerequisitesProven(position, evidence)) continue;
        commitments.set(position, GOAL_COMMITMENT.PROVEN);
      }
      continue;
    }
    if (!exactRoomCompletionProven(analysis, evidence)) continue;
    const room = board.topology.rooms[analysis.roomIndex];
    const flow = evidence?.doorway?.rooms?.find(candidate => candidate.index === analysis.roomIndex);
    if (!room || !flow || flow.importTotal || flow.exportTotal || flow.contradictions.length ||
        flow.gateLabel) continue;
    for (const position of room.cells) {
      const label = occupied.get(position);
      if (label === undefined || board.goals.get(position) !== label ||
          commitmentPositionConflict(position, evidence) ||
          !commitmentPrerequisitesProven(position, evidence)) continue;
      if (commitments.get(position) !== GOAL_COMMITMENT.TEMPORARY) {
        commitments.set(position, GOAL_COMMITMENT.PROVEN);
      }
    }
  }
  return commitments;
}

function goalCommitments(boxes, board, evidence = null) {
  const metrics = board.metrics;
  if (metrics) metrics.commitmentCalls++;
  const signature = boxSignature(boxes, board);
  const cachedCommitment = memoLookup(board.commitmentMemo, signature);
  if (cachedCommitment !== undefined) {
    if (metrics) metrics.commitmentCacheHits++;
    return evidence ? refineGoalCommitments(cachedCommitment, boxes, board, evidence) : cachedCommitment;
  }
  const started = metrics ? now() : 0;
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const commitments = new Map();
  boxes.forEach(([y, x, label], index) => {
    const position = pkey(y, x);
    if (board.goals.get(position) !== label) return;
    const safeForRemaining = !blocksPendingRoomWork(position, occupied, board) &&
      residualMatchingSurvives(boxes, board, index, position);
    commitments.set(position, !safeForRemaining
      ? GOAL_COMMITMENT.TEMPORARY
      : staticallyImmovable(position, board)
        ? GOAL_COMMITMENT.PROVEN
        : GOAL_COMMITMENT.CONDITIONAL);
  });
  const result = memoizeBounded(
    board.commitmentMemo,
    signature,
    commitments,
    COMMITMENT_MEMO_LIMIT,
  );
  if (metrics) metrics.commitmentMs += now() - started;
  return evidence ? refineGoalCommitments(result, boxes, board, evidence) : result;
}

function goalPackingBonus(boxes, board, evidence = null) {
  const commitments = goalCommitments(boxes, board, evidence);
  return boxes.reduce((bonus, [y, x]) => {
    const position = pkey(y, x);
    const commitment = commitments.get(position);
    const safetyWeight = commitment === GOAL_COMMITMENT.PROVEN
      ? 1
      : commitment === GOAL_COMMITMENT.CONDITIONAL ? 0.25 : 0;
    return bonus + safetyWeight * (board.goalPressure.get(position) || 0);
  }, 0);
}

function stateCommitmentEvidence(state, board, reachable = reachablePaths(state, board)) {
  return {
    doorway: typedDoorwayFlow(state.boxes, board),
    supportDependency: supportDependencyGraph(state, board, reachable),
    localAnalyses: [
      ...exactLocalRoomAnalyses(state, board, reachable),
      ...exactLocalCorralAnalyses(state, board, reachable),
    ],
  };
}

function stateGoalCommitments(state, board, reachable = reachablePaths(state, board)) {
  const region = reachable.regionId ?? [...reachable.keys()].sort()[0] ?? "sealed";
  const key = `${region}|${boxSignature(state.boxes, board)}`;
  const cachedStateCommitment = memoLookup(board.stateCommitmentMemo, key);
  if (cachedStateCommitment !== undefined) return cachedStateCommitment;
  const commitments = goalCommitments(
    state.boxes,
    board,
    stateCommitmentEvidence(state, board, reachable),
  );
  return memoizeBounded(
    board.stateCommitmentMemo,
    key,
    commitments,
    COMMITMENT_MEMO_LIMIT,
  );
}

function neighbors(state, board, pruneDeadlocks = true) {
  const occupied = denseOccupancy(state, board), result = [];
  const robotId = cellId(state.robot[0], state.robot[1], board.dense);
  for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
    const [move, [dy, dx]] = DIRECTION_ENTRIES[direction];
    const [y, x] = state.robot;
    const nextId = board.dense.neighbors[robotId * DIRECTION_ENTRIES.length + direction];
    if (nextId < 0) continue;
    const ny = board.dense.y[nextId], nx = board.dense.x[nextId];
    let boxes = state.boxes;
    if (occupied[nextId] >= 0) {
      const beyondId = board.dense.neighbors[nextId * DIRECTION_ENTRIES.length + direction];
      if (beyondId < 0 || occupied[beyondId] >= 0) continue;
      const by = board.dense.y[beyondId], bx = board.dense.x[beyondId];
      const index = occupied[nextId], label = boxes[index][2];
      boxes = boxes.slice();
      boxes[index] = [by, bx, label];
      if (pruneDeadlocks && staticDead(by, bx, board, label)) continue;
      deriveDenseBoxLayout(state.boxes, boxes, index, beyondId, board);
      if (pruneDeadlocks && createsDynamicDeadlock(boxes, board, [by, bx])) continue;
    }
    result.push({robot: [ny, nx], boxes, move});
  }
  return result;
}

function reachablePathsReference(state, board) {
  const occupied = new Set(state.boxes.map(b => pkey(b[0], b[1])));
  const start = pkey(state.robot[0], state.robot[1]);
  const parents = new Map([[start, {parent: null, move: null}]]);
  const queue = [state.robot];
  for (let head = 0; head < queue.length; head++) {
    const [y, x] = queue[head], current = pkey(y, x);
    for (const [move, [dy, dx]] of DIRECTION_ENTRIES) {
      const next = pkey(y + dy, x + dx);
      if (parents.has(next) || !board.floor.has(next) || occupied.has(next)) continue;
      parents.set(next, {parent: current, move});
      queue.push([y + dy, x + dx]);
    }
  }
  return {
    has: position => parents.has(position),
    get: position => {
      const path = [];
      let current = position;
      while (parents.has(current) && parents.get(current).parent !== null) {
        const record = parents.get(current);
        path.unshift(record.move);
        current = record.parent;
      }
      return path;
    },
    keys: () => parents.keys(),
    size: parents.size,
  };
}

function denseOccupancy(state, board) {
  return denseBoxLayout(state.boxes, board).indexByCell;
}

function reachablePaths(state, board) {
  const started = now();
  board.metrics.reachabilityCalls++;
  const {dense} = board, layout = denseBoxLayout(state.boxes, board);
  const occupied = layout.indexByCell;
  const start = cellId(state.robot[0], state.robot[1], dense);
  // Reachability geometry is permutation-invariant, but occupied cell values are
  // box indices consumed by push generation. Keep the order-sensitive layout key.
  const cacheKey = `${start}|${layout.orderedSignature}`;
  const memoLimit = board.reachabilityMemoLimit || 0;
  const cached = memoLimit ? memoLookup(board.reachabilityMemo, cacheKey) : null;
  if (cached) {
    board.metrics.reachabilityCacheHits++;
    board.metrics.reachabilityMs += now() - started;
    return cached;
  }
  const parents = new Int32Array(dense.keys.length), parentMoves = new Int8Array(dense.keys.length);
  parents.fill(-2);
  parents[start] = -1;
  const queue = new Int32Array(dense.keys.length);
  queue[0] = start;
  let tail = 1, regionId = start;
  for (let head = 0; head < tail; head++) {
    const current = queue[head];
    for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
      const next = dense.neighbors[current * DIRECTION_ENTRIES.length + direction];
      if (next < 0 || parents[next] !== -2 || occupied[next] >= 0) continue;
      parents[next] = current;
      parentMoves[next] = direction;
      queue[tail++] = next;
      regionId = Math.min(regionId, next);
    }
  }
  const pathToId = id => {
    if (id === undefined || id < 0 || parents[id] === -2) return [];
    const path = [];
    for (let current = id; parents[current] !== -1; current = parents[current]) {
      path.push(DIRECTION_ENTRIES[parentMoves[current]][0]);
    }
    path.reverse();
    return path;
  };
  board.metrics.reachabilityCells += tail;
  board.metrics.reachabilityMs += now() - started;
  const result = {
    has: position => {
      const id = dense.idByKey.get(position);
      return id !== undefined && parents[id] !== -2;
    },
    hasId: id => id >= 0 && parents[id] !== -2,
    get: position => pathToId(dense.idByKey.get(position)),
    getId: pathToId,
    keys: function* () {
      for (let index = 0; index < tail; index++) yield dense.keys[queue[index]];
    },
    size: tail,
    occupied,
    board,
    regionId,
  };
  return memoLimit
    ? memoizeBounded(board.reachabilityMemo, cacheKey, result, memoLimit)
    : result;
}

function minimumBlockerRoutes(reachable, board) {
  const {dense} = board, size = dense.keys.length;
  const distances = new Int16Array(size), parents = new Int32Array(size);
  distances.fill(32767);
  parents.fill(-1);
  const front = [], back = [];
  for (const position of reachable.keys()) {
    const id = dense.idByKey.get(position);
    distances[id] = 0;
    back.push(id);
  }
  while (front.length || back.length) {
    if (!front.length) {
      while (back.length) front.push(back.pop());
    }
    const current = front.pop();
    const best = distances[current];
    for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
      const next = dense.neighbors[current * DIRECTION_ENTRIES.length + direction];
      if (next < 0) continue;
      const blocked = reachable.occupied[next] >= 0;
      const distance = best + Number(blocked);
      if (distance >= distances[next]) continue;
      distances[next] = distance;
      parents[next] = current;
      if (blocked) back.push(next);
      else front.push(next);
    }
  }
  const routeTo = destination => {
    if (destination < 0 || distances[destination] === 32767) return null;
    const route = [], blockers = [];
    for (let current = destination; current >= 0; current = parents[current]) {
      route.push(dense.keys[current]);
      if (reachable.occupied[current] >= 0) blockers.push(dense.keys[current]);
    }
    route.reverse();
    blockers.reverse();
    return {route, blockers, blockerCount: distances[destination]};
  };
  return {routeTo};
}

function supportDependencyGraph(state, board, reachable = reachablePaths(state, board)) {
  const metrics = board.metrics;
  metrics.supportDependencyCalls++;
  const key = `${reachable.regionId}|${boxSignature(state.boxes, board)}`;
  const cachedSupportDep = memoLookup(board.supportDependencyMemo, key);
  if (cachedSupportDep !== undefined) {
    metrics.supportDependencyCacheHits++;
    return cachedSupportDep;
  }
  const started = now(), routes = minimumBlockerRoutes(reachable, board);
  const assignment = cacheFullAssignmentDetail(state.boxes, board);
  const assignedTargets = new Map(assignment.assignedTargets);
  let assignmentComplete = Number.isFinite(assignment.cost) &&
    assignedTargets.size === state.boxes.length;
  const nodes = [], supportDemand = new Map(), prerequisiteDemand = new Map();
  const prerequisiteEdges = new Map(), enablingActions = new Map();
  const stagingSides = new Map();
  let penalty = 0, optionCount = 0;
  for (let boxIndex = 0; boxIndex < state.boxes.length; boxIndex++) {
    const [y, x, label] = state.boxes[boxIndex];
    const box = pkey(y, x);
    if (board.goals.get(box) === label) continue;
    const assigned = assignedTargets.get(boxIndex);
    const targets = assigned ? [assigned] : [];
    if (!targets.length) {
      assignmentComplete = false;
      continue;
    }
    let bestDistance = Infinity;
    for (const target of targets) {
      bestDistance = Math.min(
        bestDistance,
        board.pushDistances.get(target)?.get(box) ?? Infinity,
      );
    }
    if (!Number.isFinite(bestDistance) || bestDistance <= 0) continue;
    const options = [], seen = new Set();
    for (const target of targets) {
      const targetDistances = board.pushDistances.get(target);
      if ((targetDistances?.get(box) ?? Infinity) !== bestDistance) continue;
      for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
        const [move, [dy, dx]] = DIRECTION_ENTRIES[direction];
        const destination = pkey(y + dy, x + dx);
        if ((targetDistances.get(destination) ?? Infinity) !== bestDistance - 1) continue;
        const support = pkey(y - dy, x - dx);
        const supportId = board.dense.idByKey.get(support);
        if (supportId === undefined || seen.has(`${support}|${destination}`)) continue;
        seen.add(`${support}|${destination}`);
        const accessible = reachable.hasId(supportId);
        const route = accessible
          ? {route: [support], blockers: [], blockerCount: 0}
          : routes.routeTo(supportId);
        options.push({target, destination, support, move, accessible, ...route});
      }
    }
    if (!options.length) continue;
    optionCount += options.length;
    const available = options.some(option => option.accessible);
    const viable = options.filter(option => option.blockerCount !== undefined);
    const minimumBlockers = viable.length
      ? Math.min(...viable.map(option => option.blockerCount))
      : Infinity;
    const preferred = available
      ? options.filter(option => option.accessible)
      : viable.filter(option => option.blockerCount === minimumBlockers);
    const share = 1 / Math.max(1, preferred.length);
    for (const option of preferred) {
      supportDemand.set(option.support, (supportDemand.get(option.support) || 0) + share);
      if (!stagingSides.has(box)) stagingSides.set(box, []);
      stagingSides.get(box).push({
        support: option.support,
        destination: option.destination,
        target: option.target,
        move: option.move,
      });
      for (const blocker of option.blockers || []) {
        prerequisiteDemand.set(blocker, (prerequisiteDemand.get(blocker) || 0) + share);
        if (blocker !== box) {
          if (!prerequisiteEdges.has(box)) prerequisiteEdges.set(box, new Set());
          prerequisiteEdges.get(box).add(blocker);
          if (!enablingActions.has(blocker)) enablingActions.set(blocker, []);
          enablingActions.get(blocker).push({
            action: "vacate",
            blocker,
            unlocks: box,
            support: option.support,
            destination: option.destination,
            target: option.target,
          });
        }
      }
    }
    penalty += available ? 0 : 1 + (Number.isFinite(minimumBlockers) ? minimumBlockers : 4);
    nodes.push({box, label, distance: bestDistance, available, options: preferred});
  }
  const prerequisiteClosure = new Map(), cycles = new Set();
  for (const origin of prerequisiteEdges.keys()) {
    const closure = new Set(), queue = [...(prerequisiteEdges.get(origin) || [])];
    for (let head = 0; head < queue.length; head++) {
      const prerequisite = queue[head];
      if (prerequisite === origin) {
        cycles.add(origin);
        continue;
      }
      if (closure.has(prerequisite)) continue;
      closure.add(prerequisite);
      queue.push(...(prerequisiteEdges.get(prerequisite) || []));
    }
    if (closure.size) prerequisiteClosure.set(origin, closure);
  }
  for (const prerequisites of prerequisiteClosure.values()) {
    for (const prerequisite of prerequisites) {
      prerequisiteDemand.set(
        prerequisite,
        (prerequisiteDemand.get(prerequisite) || 0) + 1,
      );
    }
  }
  const displacementBoxes = new Set();
  for (const prerequisites of prerequisiteClosure.values()) {
    prerequisites.forEach(position => displacementBoxes.add(position));
  }
  for (const node of nodes) {
    node.prerequisites = prerequisiteClosure.get(node.box) || new Set();
    node.minimumBlockerDisplacement = node.prerequisites.size;
    node.stagingSides = stagingSides.get(node.box) || [];
  }
  const graph = {
    nodes,
    supportDemand,
    prerequisiteDemand,
    prerequisiteEdges,
    prerequisiteClosure,
    cycles,
    assignedTargets,
    enablingActions,
    stagingSides,
    minimumBlockerDisplacement: displacementBoxes.size,
    displacementBoxes,
    exactContradictions: [],
    assignmentComplete,
    penalty,
  };
  metrics.supportDependencyOptions += optionCount;
  metrics.supportDependencyBlockers += prerequisiteDemand.size;
  metrics.supportDependencyMs += now() - started;
  return memoizeBounded(
    board.supportDependencyMemo,
    key,
    graph,
    SUPPORT_DEPENDENCY_MEMO_LIMIT,
  );
}

function supportDependencyDelta(graph, next) {
  const destroysAccess = graph.supportDemand.get(next.pushedTo) || 0;
  const enablesAccess = graph.prerequisiteDemand.get(next.pushedFrom) || 0;
  const enablingActions = graph.enablingActions.get(next.pushedFrom)?.length || 0;
  const restoresStaging = [...graph.stagingSides.values()].some(options =>
    options.some(option => option.support === next.pushedFrom));
  return 1.25 * destroysAccess - enablesAccess - 0.5 * enablingActions -
    (restoresStaging ? 0.25 : 0);
}

function localBoxSignature(boxes) {
  return boxes.map(([position, label]) => `${position},${label}`).sort().join(";");
}

function localReachable(domain, boxes, start) {
  const occupied = new Set(boxes.map(([position]) => position));
  if (!domain.has(start) || occupied.has(start)) return new Set();
  const reached = new Set([start]), queue = [start];
  for (let head = 0; head < queue.length; head++) {
    for (const next of floorNeighbors(queue[head], domain)) {
      if (occupied.has(next) || reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

function canonicalLocalState(domain, boxes, robot) {
  const reached = localReachable(domain, boxes, robot);
  if (!reached.size) return null;
  const region = [...reached].sort()[0];
  return {region, signature: `${region}|${localBoxSignature(boxes)}`, reached};
}

function relaxedReversePushTable(board, targetBoxes, maxStates) {
  const states = new Map([[localBoxSignature(targetBoxes), 0]]);
  const queue = [targetBoxes], floor = board.floor;
  let head = 0, cutoff = false;
  for (; head < queue.length && head < maxStates; head++) {
    const current = queue[head], pushes = states.get(localBoxSignature(current));
    const occupied = new Set(current.map(([position]) => position));
    current.forEach(([destination, label], boxIndex) => {
      const [y, x] = destination.split(",").map(Number);
      for (const [, [dy, dx]] of DIRECTION_ENTRIES) {
        const previous = pkey(y - dy, x - dx);
        const support = pkey(y - 2 * dy, x - 2 * dx);
        if (!floor.has(previous) || !floor.has(support) ||
            occupied.has(previous) || occupied.has(support)) continue;
        const predecessor = current.map((box, index) =>
          index === boxIndex ? [previous, label] : box);
        const signature = localBoxSignature(predecessor);
        if (states.has(signature)) continue;
        if (states.size >= maxStates) {
          cutoff = true;
          continue;
        }
        states.set(signature, pushes + 1);
        queue.push(predecessor);
      }
    });
  }
  const complete = !cutoff && head >= queue.length;
  return {status: complete ? "ready" : "cutoff", complete, states, visited: head};
}

function combinationCount(size, selected) {
  if (selected < 0 || selected > size) return 0;
  selected = Math.min(selected, size - selected);
  let count = 1;
  for (let index = 1; index <= selected; index++) {
    count = count * (size - selected + index) / index;
    if (count > ROOM_PATTERN_SELECTION_LIMIT) return count;
  }
  return count;
}

function combinations(values, selected) {
  if (selected === 0) return [[]];
  const result = [];
  const visit = (start, current) => {
    if (current.length === selected) {
      result.push([...current]);
      return;
    }
    for (let index = start;
      index <= values.length - (selected - current.length);
      index++) {
      current.push(values[index]);
      visit(index + 1, current);
      current.pop();
    }
  };
  visit(0, []);
  return result;
}

function buildRoomPatternTable(board, room, targetGoals,
  maxStates = ROOM_PATTERN_MAX_STATES) {
  const roomIndex = board.topology.rooms.indexOf(room);
  const key = `${roomIndex}|${[...targetGoals].sort().join(".")}`;
  if (board.roomPatternTables.has(key)) return board.roomPatternTables.get(key);
  const targetBoxes = targetGoals.map(goal => [goal, board.goals.get(goal)]);
  const labels = new Set(targetBoxes.map(([, label]) => label));
  if (roomIndex < 0 || targetBoxes.length < 2 || targetBoxes.length > 4) {
    const skipped = {status: "ineligible", complete: false, labels,
      targetBoxes, states: new Map(), visited: 0};
    board.roomPatternTables.set(key, skipped);
    return skipped;
  }

  // Non-pattern boxes and robot connectivity are removed, while walls, box
  // collisions, labels, and support squares remain. The resulting distance is
  // a lower bound on pushes by these labels in the full puzzle.
  const result = {
    ...relaxedReversePushTable(board, targetBoxes, maxStates),
    labels,
    targetBoxes,
  };
  board.metrics.roomPatternBuilds++;
  board.metrics.roomPatternStates += result.visited;
  board.roomPatternTables.set(key, result);
  return result;
}

function roomPatternGoalPartitions(room, board) {
  const byLabel = new Map();
  for (const goal of room.goals) {
    const label = board.goals.get(goal);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(goal);
  }
  const groups = [...byLabel.values()]
    .filter(goals => goals.length <= 4)
    .sort((left, right) => right.length - left.length);
  const totalGoals = groups.reduce((total, goals) => total + goals.length, 0);
  const partitions = Array.from(
    {length: Math.max(1, Math.ceil(totalGoals / 4))},
    () => [],
  );
  for (const goals of groups) {
    const partition = partitions
      .filter(candidate => candidate.length + goals.length <= 4)
      .sort((left, right) => left.length - right.length)[0];
    if (!partition) continue;
    partition.push(...goals);
  }
  return partitions.filter(goals => goals.length >= 2);
}

function reverseRoomPatternTables(board, room, maxStates = ROOM_PATTERN_MAX_STATES) {
  return roomPatternGoalPartitions(room, board)
    .map(goals => buildRoomPatternTable(board, room, goals, maxStates));
}

function reverseRoomPatternTable(board, room, maxStates = ROOM_PATTERN_MAX_STATES) {
  const tables = reverseRoomPatternTables(board, room, maxStates);
  if (tables.length === 1 && tables[0].targetBoxes.length === room.goals.length) {
    return tables[0];
  }
  return {
    status: tables.length ? "partitioned" : "ineligible",
    complete: tables.length > 0 && tables.every(table => table.complete),
    labels: new Set(tables.flatMap(table => [...table.labels])),
    states: new Map(),
    visited: tables.reduce((total, table) => total + table.visited, 0),
    partitions: tables,
  };
}

function compatiblePatternReplacementCost(boxes, board, table) {
  const goalsByLabel = new Map();
  for (const [goal, label] of table.targetBoxes) {
    if (!goalsByLabel.has(label)) goalsByLabel.set(label, []);
    goalsByLabel.get(label).push(goal);
  }
  const boxesByLabel = boxesByLabelWithIndices(boxes);
  let selectionCount = 1;
  const choices = [];
  for (const [label, targetGoals] of goalsByLabel) {
    const entries = boxesByLabel.get(label) || [];
    const count = combinationCount(entries.length, targetGoals.length);
    selectionCount *= count;
    if (!count || selectionCount > ROOM_PATTERN_SELECTION_LIMIT) {
      board.metrics.patternSelectionCutoffs++;
      return null;
    }
    choices.push({label, targetGoals, entries,
      selections: combinations(entries, targetGoals.length)});
  }
  let best = Infinity;
  const visit = (choiceIndex, selectedByLabel) => {
    if (choiceIndex < choices.length) {
      const choice = choices[choiceIndex];
      for (const selection of choice.selections) {
        selectedByLabel.set(choice.label, selection);
        visit(choiceIndex + 1, selectedByLabel);
      }
      selectedByLabel.delete(choice.label);
      return;
    }
    const patternBoxes = [];
    let outsideCost = 0;
    for (const choice of choices) {
      const selected = selectedByLabel.get(choice.label);
      const selectedIndices = new Set(selected.map(entry => entry.index));
      selected.forEach(({y, x}) => patternBoxes.push([pkey(y, x), choice.label]));
      const outsideBoxes = choice.entries.filter(entry => !selectedIndices.has(entry.index));
      const targetSet = new Set(choice.targetGoals);
      const outsideGoals = (board.goalsByLabel.get(choice.label) || [])
        .filter(goal => !targetSet.has(goal));
      const costs = outsideBoxes.map(({y, x}) => outsideGoals.map(goal =>
        compiledGoalPushDistance(board, pkey(y, x), goal)));
      const assignment = minimumAssignment(costs).cost;
      if (!Number.isFinite(assignment)) return;
      outsideCost += assignment;
    }
    const distance = table.states.get(localBoxSignature(patternBoxes));
    if (distance !== undefined) best = Math.min(best, distance + outsideCost);
  };
  visit(0, new Map());
  return Number.isFinite(best) ? best : null;
}

function roomPatternHeuristicCandidates(boxes, board, assignmentCosts) {
  const candidates = [];
  for (const room of board.topology.rooms) {
    for (const table of reverseRoomPatternTables(board, room)) {
      if (!table.states.size) continue;
      const replacement = compatiblePatternReplacementCost(boxes, board, table);
      if (replacement === null) continue;
      board.metrics.roomPatternHits++;
      const assignment = [...table.labels]
        .reduce((total, label) => total + (assignmentCosts.get(label) ?? Infinity), 0);
      const boost = replacement - assignment;
      if (boost > 0 && Number.isFinite(boost)) {
        candidates.push({labels: table.labels, boost, kind: "room"});
      }
    }
  }
  return candidates;
}

function shortestPushCriticalCells(position, goal, board) {
  const cacheKey = `${position}>${goal}`;
  const cachedCorridor = memoLookup(board.shortestCorridorMemo, cacheKey);
  if (cachedCorridor !== undefined) return cachedCorridor;
  const distances = board.pushDistances.get(goal), critical = new Set();
  const initial = distances?.get(position);
  if (!Number.isFinite(initial)) {
    return memoizeBounded(board.shortestCorridorMemo, cacheKey, critical, 10000);
  }
  const seen = new Set([position]), queue = [position];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head], distance = distances.get(current);
    if (board.topology.articulations.has(current) || board.topology.tunnels.has(current)) {
      critical.add(current);
    }
    if (distance === 0) continue;
    const [y, x] = current.split(",").map(Number);
    for (const [dy, dx] of Object.values(DIRS)) {
      const next = pkey(y + dy, x + dx);
      if (distances.get(next) !== distance - 1 || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return memoizeBounded(board.shortestCorridorMemo, cacheKey, critical, 10000);
}

function reversePairConflictTable(board, leftLabel, rightLabel,
  maxStates = PAIR_CONFLICT_MAX_STATES) {
  const labels = [leftLabel, rightLabel].sort();
  const cacheKey = labels.join("|");
  if (board.pairConflictTables.has(cacheKey)) return board.pairConflictTables.get(cacheKey);
  const goals = labels.map(label => board.goalsByLabel.get(label) || []);
  if (goals.some(entries => entries.length !== 1)) {
    const skipped = {status: "ineligible", complete: false,
      labels: new Set(labels), states: new Map(), visited: 0};
    board.pairConflictTables.set(cacheKey, skipped);
    return skipped;
  }
  const targetBoxes = labels.map((label, index) => [goals[index][0], label]);
  const result = {
    ...relaxedReversePushTable(board, targetBoxes, maxStates),
    labels: new Set(labels),
  };
  board.metrics.pairConflictBuilds++;
  board.metrics.pairConflictStates += result.visited;
  board.pairConflictTables.set(cacheKey, result);
  return result;
}

function pairConflictHeuristicCandidates(boxes, board, assignmentCosts) {
  const byLabel = boxesByLabelWithIndices(boxes);
  const entries = [...byLabel]
    .filter(([label, group]) => group.length === 1 &&
      (board.goalsByLabel.get(label) || []).length === 1)
    .map(([label, [{y, x}]]) => ({label, position: pkey(y, x),
      goal: board.goalsByLabel.get(label)[0]}));
  const candidates = [];
  for (let left = 0; left < entries.length; left++) {
    const leftEntry = entries[left];
    const leftCritical = shortestPushCriticalCells(
      leftEntry.position, leftEntry.goal, board);
    if (!leftCritical.size) continue;
    for (let right = left + 1; right < entries.length; right++) {
      const rightEntry = entries[right];
      const assignment = (assignmentCosts.get(leftEntry.label) ?? Infinity) +
        (assignmentCosts.get(rightEntry.label) ?? Infinity);
      if (assignment > PAIR_CONFLICT_DISTANCE_LIMIT) continue;
      const coveredByRoom = [...board.roomPatternTables.values()].some(table =>
        table.states.size && table.labels.has(leftEntry.label) &&
        table.labels.has(rightEntry.label));
      if (coveredByRoom) continue;
      const rightCritical = shortestPushCriticalCells(
        rightEntry.position, rightEntry.goal, board);
      if (![...leftCritical].some(position => rightCritical.has(position))) continue;
      board.metrics.pairConflictCandidates++;
      const table = reversePairConflictTable(
        board, leftEntry.label, rightEntry.label);
      const patternBoxes = [leftEntry, rightEntry]
        .map(entry => [entry.position, entry.label]);
      const distance = table.states.get(localBoxSignature(patternBoxes));
      if (distance === undefined) continue;
      board.metrics.pairConflictHits++;
      const boost = distance - assignment;
      if (boost > 0 && Number.isFinite(boost)) {
        candidates.push({labels: table.labels, boost, kind: "pair"});
      }
    }
  }
  return candidates;
}

function reverseCapacityPatternTable(board, maxStates = CAPACITY_PATTERN_MAX_STATES) {
  const targetBoxes = [...board.goals]
    .map(([goal, label]) => [goal, label])
    .sort((left, right) => left.join(",").localeCompare(right.join(",")));
  const cacheKey = `all|${targetBoxes.map(box => box.join(",")).join(";")}`;
  if (board.capacityPatternTables.has(cacheKey)) {
    return board.capacityPatternTables.get(cacheKey);
  }
  const labels = new Set(targetBoxes.map(([, label]) => label));
  if (targetBoxes.length < 2 || targetBoxes.length > CAPACITY_PATTERN_MAX_BOXES ||
      board.floor.size > CAPACITY_PATTERN_MAX_FLOOR) {
    const skipped = {status: "ineligible", complete: false, labels,
      targetBoxes, states: new Map(), visited: 0};
    board.capacityPatternTables.set(cacheKey, skipped);
    return skipped;
  }
  const result = {
    ...relaxedReversePushTable(board, targetBoxes, maxStates),
    labels,
    targetBoxes,
  };
  board.metrics.capacityPatternBuilds++;
  board.metrics.capacityPatternStates += result.visited;
  board.capacityPatternTables.set(cacheKey, result);
  return result;
}

function capacityPatternHeuristicCandidates(boxes, board, assignmentCosts) {
  const table = reverseCapacityPatternTable(board);
  if (!table.states.size) return [];
  const replacement = compatiblePatternReplacementCost(boxes, board, table);
  if (replacement === null) return [];
  board.metrics.capacityPatternHits++;
  const assignment = [...table.labels]
    .reduce((total, label) => total + (assignmentCosts.get(label) ?? Infinity), 0);
  const boost = replacement - assignment;
  return boost > 0 && Number.isFinite(boost)
    ? [{labels: table.labels, boost, kind: "capacity"}]
    : [];
}

function maximumDisjointPatternSelection(candidates) {
  if (!candidates.length) return [];
  const labels = [...new Set(candidates.flatMap(candidate => [...candidate.labels]))];
  if (labels.length > 20) {
    const selected = [], used = new Set();
    for (const candidate of [...candidates].sort((a, b) => b.boost - a.boost)) {
      if ([...candidate.labels].some(label => used.has(label))) continue;
      selected.push(candidate);
      candidate.labels.forEach(label => used.add(label));
    }
    return selected;
  }
  const labelIndex = new Map(labels.map((label, index) => [label, index]));
  const weighted = candidates.map(candidate => ({
    candidate,
    mask: [...candidate.labels]
      .reduce((mask, label) => mask | (1 << labelIndex.get(label)), 0),
  }));
  const best = new Map([[0, {boost: 0, selected: []}]]);
  for (const {candidate, mask} of weighted) {
    for (const [used, entry] of [...best]) {
      if (used & mask) continue;
      const combined = used | mask, boost = entry.boost + candidate.boost;
      if ((best.get(combined)?.boost ?? -Infinity) >= boost) continue;
      best.set(combined, {boost, selected: [...entry.selected, candidate]});
    }
  }
  return [...best.values()].reduce((left, right) =>
    right.boost > left.boost ? right : left).selected;
}

function interactionHeuristicBoost(boxes, board, assignmentCosts) {
  const selected = maximumDisjointPatternSelection([
    ...roomPatternHeuristicCandidates(boxes, board, assignmentCosts),
    ...pairConflictHeuristicCandidates(boxes, board, assignmentCosts),
    ...capacityPatternHeuristicCandidates(boxes, board, assignmentCosts),
  ]);
  const roomBoost = selected.filter(candidate => candidate.kind === "room")
    .reduce((total, candidate) => total + candidate.boost, 0);
  const pairBoost = selected.filter(candidate => candidate.kind === "pair")
    .reduce((total, candidate) => total + candidate.boost, 0);
  const capacityBoost = selected.filter(candidate => candidate.kind === "capacity")
    .reduce((total, candidate) => total + candidate.boost, 0);
  board.metrics.roomPatternBoost += roomBoost;
  board.metrics.pairConflictBoost += pairBoost;
  board.metrics.capacityPatternBoost += capacityBoost;
  return roomBoost + pairBoost + capacityBoost;
}

function reverseGoalRoomPackingTable(board, room, maxStates = null) {
  const roomIndex = board.topology.rooms.indexOf(room);
  if (board.goalRoomPackingTables.has(roomIndex)) {
    return board.goalRoomPackingTables.get(roomIndex);
  }
  const domain = new Set([...room.cells, room.gate]);
  for (const [position, distance] of room.approach) if (distance <= 2) domain.add(position);
  const targetBoxes = room.goals.map(position => [position, board.goals.get(position)]);
  const stateUpperBound = localExactStateUpperBound(domain.size, targetBoxes);
  const reviewedLimit = maxStates ?? Math.min(
    LOCAL_EXACT_STATE_LIMIT + 1,
    Number.isFinite(stateUpperBound) ? stateUpperBound + 1 : LOCAL_EXACT_STATE_LIMIT + 1,
  );
  if (roomIndex < 0 || room.cells.size > LOCAL_ROOM_CELL_LIMIT ||
      domain.size > LOCAL_DOMAIN_CELL_LIMIT || targetBoxes.length > LOCAL_BOX_LIMIT ||
      stateUpperBound > LOCAL_EXACT_STATE_LIMIT) {
    const skipped = {status: "oversized", complete: false, domain,
      states: new Map(), visited: 0, stateUpperBound, storage: "compact-canonical"};
    board.goalRoomPackingTables.set(roomIndex, skipped);
    return skipped;
  }

  const started = now(), states = new Map(), queue = [];
  const targetOccupied = new Set(targetBoxes.map(([position]) => position));
  for (const robot of domain) {
    if (targetOccupied.has(robot)) continue;
    const canonical = canonicalLocalState(domain, targetBoxes, robot);
    if (!canonical || states.has(canonical.signature)) continue;
    const entry = {pushes: 0, nextPushes: new Set()};
    states.set(canonical.signature, entry);
    queue.push({robot: canonical.region, boxes: targetBoxes, pushes: 0});
  }

  let visited = 0, head = 0;
  for (; head < queue.length && visited < reviewedLimit; head++) {
    const current = queue[head];
    const canonical = canonicalLocalState(domain, current.boxes, current.robot);
    if (!canonical) continue;
    visited++;
    const occupied = new Set(current.boxes.map(([position]) => position));
    current.boxes.forEach(([destination, label], boxIndex) => {
      const [y, x] = destination.split(",").map(Number);
      for (const [, [dy, dx]] of DIRECTION_ENTRIES) {
        const previous = pkey(y - dy, x - dx);
        const support = pkey(y - 2 * dy, x - 2 * dx);
        if (!domain.has(previous) || !domain.has(support) ||
            occupied.has(previous) || occupied.has(support) ||
            !canonical.reached.has(previous)) continue;
        const predecessorBoxes = current.boxes.map((box, index) =>
          index === boxIndex ? [previous, label] : box);
        const predecessor = canonicalLocalState(domain, predecessorBoxes, support);
        if (!predecessor) continue;
        const pushes = current.pushes + 1;
        const forwardPush = `${previous}>${destination}`;
        const known = states.get(predecessor.signature);
        if (!known) {
          states.set(predecessor.signature, {pushes, nextPushes: new Set([forwardPush])});
          queue.push({robot: predecessor.region, boxes: predecessorBoxes, pushes});
        } else if (known.pushes === pushes) {
          known.nextPushes.add(forwardPush);
        }
      }
    });
  }
  const complete = head >= queue.length;
  const result = {
    status: complete ? "ready" : "cutoff",
    complete,
    domain,
    states,
    visited,
    stateUpperBound,
    storage: "compact-canonical",
    closedDomain: localDomainGloballyClosed(domain, board),
  };
  board.metrics.reversePackingBuilds++;
  board.metrics.reversePackingStates += visited;
  board.metrics.localRoomMs += now() - started;
  board.goalRoomPackingTables.set(roomIndex, result);
  return result;
}

function localExactStateUpperBound(domainSize, boxes) {
  if (boxes.length > domainSize) return Infinity;
  let layouts = 1n;
  for (let index = 0; index < boxes.length; index++) layouts *= BigInt(domainSize - index);
  const counts = new Map();
  for (const [, label] of boxes) counts.set(label, (counts.get(label) || 0) + 1);
  for (const count of counts.values()) {
    for (let divisor = 2; divisor <= count; divisor++) layouts /= BigInt(divisor);
  }
  const bound = layouts * BigInt(Math.max(1, domainSize - boxes.length));
  return bound > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(bound);
}

function localDomainComponents(domain) {
  const remaining = new Set(domain), components = [];
  while (remaining.size) {
    const start = remaining.values().next().value;
    const component = new Set([start]), queue = [start];
    remaining.delete(start);
    for (let head = 0; head < queue.length; head++) {
      for (const neighbor of floorNeighbors(queue[head], domain)) {
        if (!remaining.has(neighbor)) continue;
        remaining.delete(neighbor);
        component.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
}

function goalCutDecomposition(boxes, board) {
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const labels = [...board.goalsByLabel.keys()];

  // Try exact balanced cuts first
  for (const cut of board.topology.articulations) {
    if (board.goals.has(cut) || occupied.has(cut)) continue;
    const [cutY, cutX] = cut.split(",").map(Number);
    if (!labels.every(label => staticDead(cutY, cutX, board, label))) continue;
    const remaining = new Set(board.floor);
    remaining.delete(cut);
    const components = localDomainComponents(remaining);
    const active = components.filter(component =>
      [...component].some(position => board.goals.has(position) || occupied.has(position)));
    if (active.length < 2) continue;
    const balance = goalCutBalance(active, occupied, board);
    if (balance.balanced) {
      const certificate = {
        cut,
        components: active,
        reason: "static-dead label-balanced articulation",
        labels: new Set(labels),
      };
      board.metrics.goalCutCertificates++;
      board.metrics.goalCutComponents += active.length;
      return certificate;
    }
  }

  // Try near-balanced cuts: allow one extra box that can cross
  for (const cut of board.topology.articulations) {
    if (board.goals.has(cut) || occupied.has(cut)) continue;
    const [cutY, cutX] = cut.split(",").map(Number);
    if (!labels.every(label => staticDead(cutY, cutX, board, label))) continue;
    const remaining = new Set(board.floor);
    remaining.delete(cut);
    const components = localDomainComponents(remaining);
    const active = components.filter(component =>
      [...component].some(position => board.goals.has(position) || occupied.has(position)));
    if (active.length < 2) continue;
    const balance = goalCutBalance(active, occupied, board);
    if (balance.nearBalanced && balance.totalImbalance <= 1) {
      const certificate = {
        cut,
        components: active,
        reason: "near-balanced articulation (1-box imbalance)",
        labels: new Set(labels),
        nearBalanced: true,
        imbalance: balance.totalImbalance,
      };
      board.metrics.goalCutCertificates =
        (board.metrics.goalCutCertificates || 0) + 1;
      board.metrics.goalCutComponents =
        (board.metrics.goalCutComponents || 0) + active.length;
      return certificate;
    }
  }

  // Try gate-based decomposition using topology rooms
  for (const room of board.topology.rooms) {
    if (!room.gate || occupied.has(room.gate) || board.goals.has(room.gate)) continue;
    const [gateY, gateX] = room.gate.split(",").map(Number);
    if (!labels.every(label => staticDead(gateY, gateX, board, label))) continue;
    const remaining = new Set(board.floor);
    remaining.delete(room.gate);
    const components = localDomainComponents(remaining);
    const active = components.filter(component =>
      [...component].some(position => board.goals.has(position) || occupied.has(position)));
    if (active.length < 2) continue;
    const balance = goalCutBalance(active, occupied, board);
    if (balance.balanced) {
      const certificate = {
        cut: room.gate,
        components: active,
        reason: "gate-based balanced decomposition",
        labels: new Set(labels),
        gateBased: true,
      };
      board.metrics.goalCutCertificates =
        (board.metrics.goalCutCertificates || 0) + 1;
      board.metrics.goalCutComponents =
        (board.metrics.goalCutComponents || 0) + active.length;
      return certificate;
    }
  }

  return null;
}

function goalCutBalance(components, occupied, board) {
  let balanced = true;
  let nearBalanced = true;
  let totalImbalance = 0;
  for (const component of components) {
    const boxCounts = new Map(), goalCounts = new Map();
    for (const position of component) {
      const boxLabel = occupied.get(position), goalLabel = board.goals.get(position);
      if (boxLabel) boxCounts.set(boxLabel, (boxCounts.get(boxLabel) || 0) + 1);
      if (goalLabel) goalCounts.set(goalLabel, (goalCounts.get(goalLabel) || 0) + 1);
    }
    for (const label of new Set([...boxCounts.keys(), ...goalCounts.keys()])) {
      const diff = Math.abs((boxCounts.get(label) || 0) - (goalCounts.get(label) || 0));
      if (diff > 0) balanced = false;
      if (diff > 1) nearBalanced = false;
      totalImbalance += diff;
    }
  }
  return {balanced, nearBalanced, totalImbalance};
}

function multiCutDecomposition(boxes, board) {
  // Try chaining multiple cuts to split into 3+ subproblems
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const labels = [...board.goalsByLabel.keys()];
  const validCuts = [];
  for (const cut of board.topology.articulations) {
    if (board.goals.has(cut) || occupied.has(cut)) continue;
    const [cutY, cutX] = cut.split(",").map(Number);
    if (!labels.every(label => staticDead(cutY, cutX, board, label))) continue;
    validCuts.push(cut);
  }
  if (validCuts.length < 2) return null;

  // Try pairs of cuts
  for (let i = 0; i < validCuts.length && i < 8; i++) {
    for (let j = i + 1; j < validCuts.length && j < 8; j++) {
      const remaining = new Set(board.floor);
      remaining.delete(validCuts[i]);
      remaining.delete(validCuts[j]);
      const components = localDomainComponents(remaining);
      const active = components.filter(component =>
        [...component].some(position => board.goals.has(position) || occupied.has(position)));
      if (active.length < 3) continue;
      const balance = goalCutBalance(active, occupied, board);
      if (balance.balanced) {
        board.metrics.multiCutCertificates =
          (board.metrics.multiCutCertificates || 0) + 1;
        return {
          cuts: [validCuts[i], validCuts[j]],
          components: active,
          reason: "multi-cut balanced decomposition",
          labels: new Set(labels),
        };
      }
    }
  }
  return null;
}

function localExactStatePlan(domain, boxes, robot) {
  const components = localDomainComponents(domain);
  const active = components.find(component => component.has(robot));
  if (!active) return {components: components.length, stateUpperBound: 0};
  const activeBoxes = boxes.filter(([position]) => active.has(position));
  return {
    components: components.length,
    stateUpperBound: localExactStateUpperBound(active.size, activeBoxes),
  };
}

function compileLocalExactDomain(domain, boxes) {
  const keys = [...domain].sort();
  const idByKey = new Map(keys.map((key, index) => [key, index]));
  const coordinates = keys.map(key => key.split(",").map(Number));
  const neighbors = coordinates.map(([y, x]) =>
    DIRECTION_ENTRIES.map(([, [dy, dx]]) => idByKey.get(pkey(y + dy, x + dx)) ?? -1));
  const labels = [...new Set(boxes.map(([, label]) => label))].sort();
  const labelIds = new Map(labels.map((label, index) => [label, index]));
  return {keys, idByKey, neighbors, labelIds};
}

function exactLocalPushSearch({domain, boxes, robot, isGoal, gate, maxStates = 10000}) {
  const dense = compileLocalExactDomain(domain, boxes);
  const initialBoxes = boxes.map(([position, label]) => ({
    cell: dense.idByKey.get(position),
    label,
    labelId: dense.labelIds.get(label),
  }));
  if (initialBoxes.some(box => box.cell === undefined) || !dense.idByKey.has(robot)) {
    return {
      status: "inaccessible",
      pushes: null,
      firstPushes: new Set(),
      visited: 0,
      viableBoundaries: 0,
      complete: true,
      proofComplete: true,
      stateUpperBound: 0,
      decompositionComponents: localDomainComponents(domain).length,
      storage: "dense-bitset",
    };
  }
  const plan = localExactStatePlan(domain, boxes, robot);
  const stateUpperBound = plan.stateUpperBound;
  const queue = [{
    robot: dense.idByKey.get(robot),
    boxes: initialBoxes,
    pushes: 0,
    firstPush: null,
  }];
  const seen = new Set(), firstPushes = new Set();
  const gateId = dense.idByKey.get(gate);
  let visited = 0, viableBoundaries = 0, solutionPushes = Infinity;

  const canonical = current => {
    let occupiedBits = 0n;
    const occupied = new Int16Array(dense.keys.length);
    occupied.fill(-1);
    current.boxes.forEach((box, index) => {
      occupied[box.cell] = index;
      occupiedBits |= 1n << BigInt(box.cell);
    });
    if (current.robot < 0 || occupied[current.robot] >= 0) return null;
    const reached = new Uint8Array(dense.keys.length);
    const reachedIds = new Int16Array(dense.keys.length);
    reached[current.robot] = 1;
    reachedIds[0] = current.robot;
    let tail = 1, region = current.robot;
    for (let head = 0; head < tail; head++) {
      const cell = reachedIds[head];
      for (const next of dense.neighbors[cell]) {
        if (next < 0 || reached[next] || occupied[next] >= 0) continue;
        reached[next] = 1;
        reachedIds[tail++] = next;
        region = Math.min(region, next);
      }
    }
    const tokens = current.boxes
      .map(box => box.labelId * dense.keys.length + box.cell)
      .sort((left, right) => left - right);
    return {
      signature: `${region.toString(36)}|${tokens.map(token => token.toString(36)).join(".")}`,
      occupied,
      occupiedBits,
      reached,
      region,
    };
  };

  let head = 0;
  for (; head < queue.length; head++) {
    if (visited >= maxStates) break;
    const current = queue[head];
    if (current.pushes > solutionPushes) break;
    const state = canonical(current);
    if (!state || seen.has(state.signature)) continue;
    seen.add(state.signature);
    visited++;
    if (gateId !== undefined && state.occupied[gateId] < 0 && state.reached[gateId]) {
      viableBoundaries++;
    }
    const readableOccupied = new Map(current.boxes.map((box, index) =>
      [dense.keys[box.cell], {label: box.label, index}]));
    const readableReached = {
      has: position => {
        const id = dense.idByKey.get(position);
        return id !== undefined && Boolean(state.reached[id]);
      },
      *[Symbol.iterator]() {
        for (let id = 0; id < dense.keys.length; id++) {
          if (state.reached[id]) yield dense.keys[id];
        }
      },
    };
    if (isGoal(readableOccupied, readableReached)) {
      solutionPushes = current.pushes;
      if (current.firstPush) firstPushes.add(current.firstPush);
      continue;
    }
    if (current.pushes >= solutionPushes) continue;
    current.boxes.forEach((box, index) => {
      for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
        const support = dense.neighbors[box.cell][OPPOSITE_DIRECTION_INDEX[direction]];
        const destination = dense.neighbors[box.cell][direction];
        if (support < 0 || destination < 0 || !state.reached[support] ||
            state.occupied[destination] >= 0) continue;
        const nextBoxes = current.boxes.slice();
        nextBoxes[index] = {...box, cell: destination};
        const push = `${dense.keys[box.cell]}>${dense.keys[destination]}`;
        queue.push({
          robot: box.cell,
          boxes: nextBoxes,
          pushes: current.pushes + 1,
          firstPush: current.firstPush || push,
        });
      }
    });
  }
  const complete = head >= queue.length;
  const cutoff = !complete && !Number.isFinite(solutionPushes);
  return {
    status: Number.isFinite(solutionPushes) ? (solutionPushes === 0 ? "packed" : "solvable")
      : cutoff ? "cutoff" : "exhausted",
    pushes: Number.isFinite(solutionPushes) ? solutionPushes : null,
    firstPushes,
    visited,
    viableBoundaries,
    complete: Number.isFinite(solutionPushes) || complete,
    proofComplete: Number.isFinite(solutionPushes) || complete,
    stateUpperBound,
    decompositionComponents: plan.components,
    storage: "dense-bitset",
  };
}

function localDomainGloballyClosed(domain, board) {
  const {dense} = board;
  for (const position of domain) {
    const cell = dense.idByKey.get(position);
    if (cell === undefined) return false;
    for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
      const neighbor = dense.neighbors[cell * DIRECTION_ENTRIES.length + direction];
      if (neighbor >= 0 && !domain.has(dense.keys[neighbor])) return false;
    }
  }
  return true;
}

function cacheCompleteLocalAnalysis(memo, key, result, limit) {
  return result.proofComplete
    ? memoizeBounded(memo, key, result, limit)
    : result;
}

function recordLocalAnalysis(metrics, result) {
  if (result.proofComplete) metrics.localExactProofs++;
  if (result.status === "cutoff") metrics.localExactCutoffs++;
  if (result.status === "oversized") metrics.localExactOversized++;
  if (result.globalDeadlockProven) metrics.localExactDeadlockProofs++;
  if (Number.isFinite(result.stateUpperBound)) {
    metrics.localExactStateBoundPeak = Math.max(
      metrics.localExactStateBoundPeak,
      result.stateUpperBound,
    );
  }
  metrics.localExactDecompositions += Math.max(
    0,
    (result.decompositionComponents || 1) - 1,
  );
  return result;
}

function exactLocalRoomSearch(state, board, room, reachable = reachablePaths(state, board)) {
  const metrics = board.metrics;
  metrics.localRoomCalls++;
  const roomIndex = board.topology.rooms.indexOf(room);
  const domain = new Set([...room.cells, room.gate]);
  for (const [position, distance] of room.approach) if (distance <= 2) domain.add(position);
  const localBoxes = state.boxes
    .map(([y, x, label]) => [pkey(y, x), label])
    .filter(([position]) => domain.has(position));
  const entries = [...domain].filter(position => reachable.has(position)).sort();
  const entrySide = entries[0] || "sealed";
  const localPlan = localExactStatePlan(domain, localBoxes, entrySide);
  const stateUpperBound = localPlan.stateUpperBound;
  const cacheKey = `${roomIndex}|${entrySide}|${localBoxSignature(localBoxes)}`;
  const cachedLocalRoom = memoLookup(board.localRoomMemo, cacheKey);
  if (cachedLocalRoom !== undefined) {
    metrics.localRoomCacheHits++;
    return cachedLocalRoom;
  }
  const started = now();
  const internalCounts = new Map(), localCounts = new Map(), targetCounts = new Map();
  localBoxes.forEach(([position, label]) => {
    localCounts.set(label, (localCounts.get(label) || 0) + 1);
    if (room.cells.has(position)) internalCounts.set(label, (internalCounts.get(label) || 0) + 1);
  });
  room.goals.forEach(goal => {
    const label = board.goals.get(goal);
    targetCounts.set(label, (targetCounts.get(label) || 0) + 1);
  });
  let importsRequired = 0, exportsRequired = 0, missingLocalBox = false;
  for (const [label, count] of targetCounts) {
    importsRequired += Math.max(0, count - (internalCounts.get(label) || 0));
    if ((localCounts.get(label) || 0) < count) missingLocalBox = true;
  }
  if (missingLocalBox) {
      const result = {
        status: "needs-import", importsRequired, exportsRequired,
        doorwayOccupied: localBoxes.some(([position]) => position === room.gate),
        entrySide, domain, roomIndex, firstPushes: new Set(), visited: 0, viableBoundaries: 0,
        proofComplete: false, stateUpperBound,
        decompositionComponents: localPlan.components, storage: "dense-bitset",
      };
      metrics.localRoomMs += now() - started;
    return recordLocalAnalysis(metrics, result);
  }
  for (const [label, count] of internalCounts) {
    exportsRequired += Math.max(0, count - (targetCounts.get(label) || 0));
  }
  if (room.cells.size > LOCAL_ROOM_CELL_LIMIT ||
      domain.size > LOCAL_DOMAIN_CELL_LIMIT || localBoxes.length > LOCAL_BOX_LIMIT ||
      stateUpperBound > LOCAL_EXACT_STATE_LIMIT) {
    const result = {
      status: "oversized", importsRequired, exportsRequired,
      doorwayOccupied: localBoxes.some(([position]) => position === room.gate),
      entrySide, domain, roomIndex, firstPushes: new Set(), visited: 0, viableBoundaries: 0,
      proofComplete: false, stateUpperBound,
      decompositionComponents: localPlan.components, storage: "dense-bitset",
    };
    metrics.localRoomMs += now() - started;
    return recordLocalAnalysis(metrics, result);
  }
  if (!entries.length) {
    const result = {
      status: "inaccessible", importsRequired, exportsRequired,
      doorwayOccupied: localBoxes.some(([position]) => position === room.gate),
      entrySide, domain, roomIndex, firstPushes: new Set(), visited: 0, viableBoundaries: 0,
      proofComplete: true, stateUpperBound,
      decompositionComponents: localPlan.components, storage: "dense-bitset",
    };
    metrics.localRoomMs += now() - started;
      recordLocalAnalysis(metrics, result);
      return cacheCompleteLocalAnalysis(
        board.localRoomMemo, cacheKey, result, LOCAL_ROOM_MEMO_LIMIT);
  }
  const packingTable = reverseGoalRoomPackingTable(board, room);
  const localCanonical = canonicalLocalState(domain, localBoxes, entries[0]);
  const hasSingleLocalEntryRegion = localCanonical &&
    entries.every(position => localCanonical.reached.has(position));
  const tableEntry = localBoxes.length === room.goals.length && exportsRequired === 0 &&
    hasSingleLocalEntryRegion ? packingTable.states.get(localCanonical.signature) : null;
  if (tableEntry) {
    metrics.reversePackingHits++;
    const result = {
      status: tableEntry.pushes === 0 ? "packed" : "solvable",
      pushes: tableEntry.pushes,
      firstPushes: new Set(tableEntry.nextPushes),
      visited: 0,
      viableBoundaries: entries.includes(room.gate) ? 1 : 0,
      importsRequired,
      exportsRequired,
      doorwayOccupied: localBoxes.some(([position]) => position === room.gate),
      entrySide,
      domain,
      roomIndex,
      source: "reverse-packing-table",
      reverseTableComplete: packingTable.complete,
      proofComplete: packingTable.complete,
      stateUpperBound,
      decompositionComponents: localPlan.components,
      storage: "dense-bitset",
      globalDeadlockProven: false,
    };
    metrics.localRoomMs += now() - started;
    recordLocalAnalysis(metrics, result);
    return cacheCompleteLocalAnalysis(
      board.localRoomMemo, cacheKey, result, LOCAL_ROOM_MEMO_LIMIT);
  }
  if (packingTable.complete && packingTable.closedDomain &&
      localBoxes.length === room.goals.length && exportsRequired === 0 &&
      hasSingleLocalEntryRegion) {
    const result = {
      status: "exhausted",
      pushes: null,
      firstPushes: new Set(),
      visited: 0,
      viableBoundaries: 0,
      importsRequired,
      exportsRequired,
      doorwayOccupied: localBoxes.some(([position]) => position === room.gate),
      entrySide,
      domain,
      roomIndex,
      source: "reverse-packing-table-miss",
      reverseTableComplete: true,
      proofComplete: true,
      stateUpperBound,
      decompositionComponents: localPlan.components,
      storage: "compact-canonical",
      globalDeadlockProven: localBoxes.length === state.boxes.length,
    };
    metrics.localRoomMs += now() - started;
    recordLocalAnalysis(metrics, result);
    return cacheCompleteLocalAnalysis(
      board.localRoomMemo, cacheKey, result, LOCAL_ROOM_MEMO_LIMIT);
  }
  const search = exactLocalPushSearch({
    domain,
    boxes: localBoxes,
    robot: entries[0],
    gate: room.gate,
    maxStates: Math.min(LOCAL_EXACT_STATE_LIMIT, stateUpperBound) + 1,
    isGoal: occupied => !occupied.has(room.gate) && room.goals.every(goal =>
      occupied.get(goal)?.label === board.goals.get(goal)) &&
      [...occupied].every(([position, {label}]) =>
        !room.cells.has(position) || board.goals.get(position) === label),
  });
  const result = {
    ...search,
    importsRequired,
    exportsRequired,
    doorwayOccupied: localBoxes.some(([position]) => position === room.gate),
    entrySide,
    domain,
    roomIndex,
    globalDeadlockProven: search.status === "exhausted" && search.proofComplete &&
      importsRequired === 0 && exportsRequired === 0 &&
      localBoxes.length === state.boxes.length &&
      localDomainGloballyClosed(domain, board),
  };
  metrics.localRoomStates += search.visited;
  metrics.localRoomMs += now() - started;
  recordLocalAnalysis(metrics, result);
  return cacheCompleteLocalAnalysis(
    board.localRoomMemo, cacheKey, result, LOCAL_ROOM_MEMO_LIMIT);
}

function exactLocalRoomAnalyses(state, board, reachable = reachablePaths(state, board)) {
  return board.topology.rooms.map(room => exactLocalRoomSearch(state, board, room, reachable));
}

function localRoomOrderingDelta(analyses, next) {
  const push = `${next.pushedFrom}>${next.pushedTo}`;
  let delta = 0;
  for (const analysis of analyses) {
    if (analysis.status !== "solvable") continue;
    const confidence = analysis.kind === "corral" ? 0.2 : 1;
    if (analysis.firstPushes.has(push)) delta -= confidence;
    else if (analysis.domain.has(next.pushedFrom) || analysis.domain.has(next.pushedTo)) {
      delta += 0.2 * confidence;
    }
  }
  return delta;
}

function inaccessibleFloorComponents(reachable, board) {
  const {dense} = board;
  board.corralTraversalVisited ??= new Uint32Array(dense.keys.length);
  board.corralTraversalQueue ??= new Int32Array(dense.keys.length);
  board.corralTraversalEpoch = (board.corralTraversalEpoch || 0) + 1;
  if (board.corralTraversalEpoch === 0xffffffff) {
    board.corralTraversalVisited.fill(0);
    board.corralTraversalEpoch = 1;
  }
  const visited = board.corralTraversalVisited;
  const queue = board.corralTraversalQueue;
  const epoch = board.corralTraversalEpoch;
  const components = [];
  for (let start = 0; start < dense.keys.length; start++) {
    if (visited[start] === epoch || reachable.hasId(start)) continue;
    const component = new Set();
    let head = 0, tail = 1;
    queue[0] = start;
    visited[start] = epoch;
    while (head < tail) {
      const current = queue[head++];
      component.add(dense.keys[current]);
      for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
        const next = dense.neighbors[current * DIRECTION_ENTRIES.length + direction];
        if (next < 0 || visited[next] === epoch || reachable.hasId(next)) continue;
        visited[next] = epoch;
        queue[tail++] = next;
      }
    }
    components.push(component);
  }
  return components;
}

function exactLocalCorralSearch(state, board, component, reachable) {
  const metrics = board.metrics;
  metrics.localCorralCalls++;
  const occupied = new Map(state.boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const componentBoxes = [...component].filter(position => occupied.has(position));
  if (componentBoxes.length === component.size) return null;
  if (!componentBoxes.some(position => board.goals.get(position) !== occupied.get(position))) {
    return null;
  }
  const boundary = new Set();
  for (const position of component) {
    for (const next of floorNeighbors(position, board.floor)) {
      if (reachable.has(next)) boundary.add(next);
    }
  }
  const domain = new Set([...component, ...boundary]);
  const localBoxes = state.boxes
    .map(([y, x, label]) => [pkey(y, x), label])
    .filter(([position]) => domain.has(position));
  const entrySide = [...boundary].sort()[0] || "sealed";
  const localPlan = localExactStatePlan(domain, localBoxes, entrySide);
  const stateUpperBound = localPlan.stateUpperBound;
  const componentKey = [...component].sort().join(".");
  const cacheKey = `${componentKey}|${entrySide}|${localBoxSignature(localBoxes)}`;
  const cachedLocalCorral = memoLookup(board.localCorralMemo, cacheKey);
  if (cachedLocalCorral !== undefined) {
    metrics.localCorralCacheHits++;
    return cachedLocalCorral;
  }
  const started = now();
  if (!boundary.size || component.size > LOCAL_ROOM_CELL_LIMIT ||
      domain.size > LOCAL_DOMAIN_CELL_LIMIT || localBoxes.length > LOCAL_BOX_LIMIT ||
      stateUpperBound > LOCAL_EXACT_STATE_LIMIT) {
    const result = {
      kind: "corral",
      status: !boundary.size ? "sealed" : "oversized",
      domain,
      firstPushes: new Set(),
      visited: 0,
      viableBoundaries: 0,
      proofComplete: false,
      stateUpperBound,
      decompositionComponents: localPlan.components,
      storage: "dense-bitset",
      globalDeadlockProven: false,
    };
    metrics.localCorralMs += now() - started;
    recordLocalAnalysis(metrics, result);
    return cacheCompleteLocalAnalysis(
      board.localCorralMemo, cacheKey, result, LOCAL_CORRAL_MEMO_LIMIT);
  }
  const componentGoals = [...component].filter(position => board.goals.has(position));
  const search = exactLocalPushSearch({
    domain,
    boxes: localBoxes,
    robot: entrySide,
    gate: entrySide,
    maxStates: Math.min(LOCAL_EXACT_STATE_LIMIT, stateUpperBound) + 1,
    isGoal: (localOccupied, reached) =>
      [...reached].some(position => component.has(position)) ||
      (componentGoals.every(goal =>
        localOccupied.get(goal)?.label === board.goals.get(goal)) &&
        [...localOccupied].every(([position, {label}]) =>
          !component.has(position) || board.goals.get(position) === label)),
  });
  const globallyClosed = localBoxes.length === state.boxes.length &&
    localDomainGloballyClosed(domain, board);
  const provenCommitments = new Set();
  if (globallyClosed) {
    for (let fixedIndex = 0; fixedIndex < localBoxes.length; fixedIndex++) {
      const [fixedPosition, fixedLabel] = localBoxes[fixedIndex];
      if (board.goals.get(fixedPosition) !== fixedLabel) continue;
      const fixedDomain = new Set(domain);
      fixedDomain.delete(fixedPosition);
      const remainingBoxes = localBoxes.filter((_, index) => index !== fixedIndex);
      const fixedPlan = localExactStatePlan(fixedDomain, remainingBoxes, entrySide);
      if (fixedPlan.stateUpperBound > LOCAL_EXACT_STATE_LIMIT) continue;
      const fixedSearch = exactLocalPushSearch({
        domain: fixedDomain,
        boxes: remainingBoxes,
        robot: entrySide,
        gate: entrySide,
        maxStates: fixedPlan.stateUpperBound + 1,
        isGoal: localOccupied =>
          [...board.goals].every(([goal, label]) =>
            goal === fixedPosition
              ? label === fixedLabel
              : localOccupied.get(goal)?.label === label),
      });
      if (fixedSearch.status === "packed" || fixedSearch.status === "solvable") {
        provenCommitments.add(fixedPosition);
      }
    }
  }
  const result = {
    ...search,
    kind: "corral",
    domain,
    provenCommitments,
    globalDeadlockProven: search.status === "exhausted" && search.proofComplete &&
      globallyClosed,
  };
  metrics.localCorralStates += search.visited;
  metrics.localCorralMs += now() - started;
  recordLocalAnalysis(metrics, result);
  return cacheCompleteLocalAnalysis(
    board.localCorralMemo, cacheKey, result, LOCAL_CORRAL_MEMO_LIMIT);
}

function exactLocalCorralAnalyses(state, board, reachable = reachablePaths(state, board)) {
  return inaccessibleFloorComponents(reachable, board)
    .map(component => exactLocalCorralSearch(state, board, component, reachable))
    .filter(Boolean);
}

function createsSealedCorralDeadlock(state, board, reachable) {
  const {dense} = board;
  const layout = denseBoxLayout(state.boxes, board);
  const occupied = new Map(state.boxes.map(([y, x, label]) => [pkey(y, x), label]));
  for (const component of inaccessibleFloorComponents(reachable, board)) {
    const componentBoxes = [...component].filter(position => occupied.has(position));
    if (!componentBoxes.some(position => board.goals.get(position) !== occupied.get(position))) continue;
    const canOpen = componentBoxes.some(position => {
      const box = dense.idByKey.get(position);
      return DIRECTION_ENTRIES.some((_, direction) => {
        const support = dense.neighbors[
          box * DIRECTION_ENTRIES.length + OPPOSITE_DIRECTION_INDEX[direction]
        ];
        const destination = dense.neighbors[box * DIRECTION_ENTRIES.length + direction];
        return reachable.hasId(support) && destination >= 0 &&
          layout.indexByCell[destination] < 0;
      });
    });
    if (!canOpen) return true;
    const boundary = new Set();
    for (const position of component) {
      const cell = dense.idByKey.get(position);
      for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
        const neighbor = dense.neighbors[cell * DIRECTION_ENTRIES.length + direction];
        if (reachable.hasId(neighbor)) boundary.add(dense.keys[neighbor]);
      }
    }
    const domain = new Set([...component, ...boundary]);
    if (localDomainGloballyClosed(domain, board)) {
      const analysis = exactLocalCorralSearch(state, board, component, reachable);
      if (analysis?.globalDeadlockProven) return true;
    }
  }
  board.closedLocalRooms ??= board.topology.rooms.filter(room => {
    const domain = new Set([...room.cells, room.gate]);
    for (const [position, distance] of room.approach) if (distance <= 2) domain.add(position);
    return localDomainGloballyClosed(domain, board);
  });
  for (const room of board.closedLocalRooms) {
    if (exactLocalRoomSearch(state, board, room, reachable).globalDeadlockProven) return true;
  }
  return false;
}

// This registry is deliberately executable production data. Differential tests
// enumerate it, so a new hard prune cannot be added without naming an independent
// oracle family that certifies it against unpruned reachability.
const HARD_PRUNING_RULES = Object.freeze([
  Object.freeze({name: "static-dead", oracleFamily: "push-reachability",
    scope: "push", detect: (boxes, board, movedBox, label) =>
      staticDead(movedBox[0], movedBox[1], board, label)}),
  Object.freeze({name: "2x2", oracleFamily: "multi-box-local",
    scope: "dynamic", detect: creates2x2Deadlock}),
  Object.freeze({name: "closed-diagonal", oracleFamily: "closed-diagonal",
    scope: "dynamic", detect: createsClosedDiagonalDeadlock}),
  Object.freeze({name: "freeze", oracleFamily: "interacting-freeze",
    scope: "dynamic", detect: createsFrozenComponentDeadlock}),
  Object.freeze({name: "pattern-database", oracleFamily: "typed-corridor",
    scope: "dynamic", detect: createsPatternDatabaseDeadlock}),
  Object.freeze({name: "sealed-corral", oracleFamily: "corral",
    scope: "state", detect: createsSealedCorralDeadlock}),
  Object.freeze({name: "proven-commitment", oracleFamily: "goal-commitment",
    scope: "push-neighbor", detect: null}),
]);
const DYNAMIC_HARD_PRUNING_RULES = HARD_PRUNING_RULES.filter(
  rule => rule.scope === "dynamic",
);


// --- Module registration ---
const SokomindAnalysis = {
  analyzePuzzleForSearch,
  stratifiedCheckpoints,
  targetMapFromBoxes,
  homeHeuristic,
  targetLayoutHeuristic,
  goal,
  staticallyImmovable,
  commitmentPushDistances,
  residualMatchingSurvives,
  blocksPendingRoomWork,
  commitmentPositionConflict,
  commitmentPrerequisitesProven,
  exactRoomCompletionProven,
  refineGoalCommitments,
  goalCommitments,
  goalPackingBonus,
  stateCommitmentEvidence,
  stateGoalCommitments,
  neighbors,
  reachablePathsReference,
  denseOccupancy,
  reachablePaths,
  minimumBlockerRoutes,
  supportDependencyGraph,
  supportDependencyDelta,
  localBoxSignature,
  localReachable,
  canonicalLocalState,
  relaxedReversePushTable,
  combinationCount,
  combinations,
  buildRoomPatternTable,
  roomPatternGoalPartitions,
  reverseRoomPatternTables,
  reverseRoomPatternTable,
  compatiblePatternReplacementCost,
  roomPatternHeuristicCandidates,
  shortestPushCriticalCells,
  reversePairConflictTable,
  pairConflictHeuristicCandidates,
  reverseCapacityPatternTable,
  capacityPatternHeuristicCandidates,
  maximumDisjointPatternSelection,
  interactionHeuristicBoost,
  reverseGoalRoomPackingTable,
  localExactStateUpperBound,
  localDomainComponents,
  goalCutDecomposition,
  goalCutBalance,
  multiCutDecomposition,
  localExactStatePlan,
  compileLocalExactDomain,
  exactLocalPushSearch,
  localDomainGloballyClosed,
  cacheCompleteLocalAnalysis,
  recordLocalAnalysis,
  exactLocalRoomSearch,
  exactLocalRoomAnalyses,
  localRoomOrderingDelta,
  inaccessibleFloorComponents,
  exactLocalCorralSearch,
  exactLocalCorralAnalyses,
  createsSealedCorralDeadlock,
  HARD_PRUNING_RULES,
  DYNAMIC_HARD_PRUNING_RULES,
};

/* ===== push-generation.js ===== */
// Push neighbor generation, macro expansion, reverse states, and solution path utilities.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

function pushNeighbors(state, board, reachable = reachablePaths(state, board), options = {}) {
  board.metrics.pushNeighborCalls++;
  const occupied = reachable.occupied || denseOccupancy(state, board);
  const commitments = options.commitments || (options.lockProven && board.topology.rooms.length
    ? stateGoalCommitments(state, board, reachable)
    : null);
  const result = [];
  state.boxes.forEach(([y, x, label], index) => {
    const boxId = cellId(y, x, board.dense);
    if (commitments) {
      const boxPosition = board.dense.keys[boxId];
      if (commitments.get(boxPosition) === GOAL_COMMITMENT.PROVEN) {
        board.metrics.commitmentBoxLocks++;
        return;
      }
    }
    for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
      const [move] = DIRECTION_ENTRIES[direction];
      const supportId = board.dense.neighbors[
        boxId * DIRECTION_ENTRIES.length + OPPOSITE_DIRECTION_INDEX[direction]
      ];
      const destinationId = board.dense.neighbors[boxId * DIRECTION_ENTRIES.length + direction];
      if (!reachable.hasId(supportId) || destinationId < 0 || occupied[destinationId] >= 0) continue;
      const destinationY = board.dense.y[destinationId], destinationX = board.dense.x[destinationId];
      const dest = board.dense.keys[destinationId];
      board.metrics.pushCandidates++;
      if (staticDead(destinationY, destinationX, board, label)) {
        board.metrics.staticDeadPrunes++;
        continue;
      }
      const boxes = cachedPushedBoxes(
        state.boxes, index, destinationId, label, board,
      );
      if (createsDynamicDeadlock(boxes, board, [destinationY, destinationX])) {
        board.metrics.dynamicDeadPrunes++;
        continue;
      }
      board.assignmentParentMemo.set(boxes, {parentBoxes: state.boxes, changedIndex: index});
      result.push({
        robot: [y, x],
        boxes,
        path: [...reachable.getId(supportId), move],
        pushClass: `${label}:${y},${x}:${move}`,
        pushedFrom: board.dense.keys[boxId],
        pushedTo: dest,
      });
      board.metrics.pushesRetained++;
    }
  });
  return result;
}

function pushBoxNeighbors(
  state,
  board,
  boxPosition,
  reachable = reachablePaths(state, board),
  options = {},
) {
  const occupied = reachable.occupied || denseOccupancy(state, board);
  const boxId = board.dense.idByKey.get(boxPosition);
  if (boxId === undefined || boxId < 0 || occupied[boxId] < 0) return [];
  const commitments = options.commitments || (options.lockProven && board.topology.rooms.length
    ? stateGoalCommitments(state, board, reachable)
    : null);
  if (commitments?.get(boxPosition) === GOAL_COMMITMENT.PROVEN) {
    board.metrics.commitmentBoxLocks++;
    return [];
  }
  const index = occupied[boxId];
  const [y, x, label] = state.boxes[index], result = [];
  for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
    const [move] = DIRECTION_ENTRIES[direction];
    const supportId = board.dense.neighbors[
      boxId * DIRECTION_ENTRIES.length + OPPOSITE_DIRECTION_INDEX[direction]
    ];
    const destinationId = board.dense.neighbors[boxId * DIRECTION_ENTRIES.length + direction];
    if (!reachable.hasId(supportId) || destinationId < 0 || occupied[destinationId] >= 0) continue;
    const destinationY = board.dense.y[destinationId], destinationX = board.dense.x[destinationId];
    const destination = board.dense.keys[destinationId];
    if (staticDead(destinationY, destinationX, board, label)) continue;
    const boxes = cachedPushedBoxes(
      state.boxes, index, destinationId, label, board,
    );
    if (createsDynamicDeadlock(boxes, board, [destinationY, destinationX])) continue;
    board.assignmentParentMemo.set(boxes, {parentBoxes: state.boxes, changedIndex: index});
    result.push({
      robot: [y, x],
      boxes,
      path: [...reachable.getId(supportId), move],
      pushClass: `${label}:${y},${x}:${move}`,
      pushedFrom: boxPosition,
      pushedTo: destination,
    });
  }
  return result;
}

function pushKey(state, reachable) {
  if (reachable.board && reachable.regionId !== undefined) {
    return `${reachable.regionId.toString(36)}|${boxSignature(state.boxes, reachable.board)}`;
  }
  let robotRegion = null;
  for (const position of reachable.keys()) {
    if (robotRegion === null || position < robotRegion) robotRegion = position;
  }
  return `${robotRegion}|${[...state.boxes.map(b => b.join(","))].sort().join(";")}`;
}

function collapseForcedPushes(first, board, limit = 32, options = {}) {
  let state = {robot: first.robot, boxes: first.boxes};
  const path = [...first.path], seen = new Set([exactPushKey(state, board)]);
  let pushes = 1;
  while (pushes < limit && !goal(state.boxes, board.goals)) {
    const reachable = reachablePaths(state, board);
    if (createsSealedCorralDeadlock(state, board, reachable)) return null;
    const choices = pushNeighbors(state, board, reachable, {lockProven: options.lockProven});
    if (choices.length !== 1) break;
    const next = choices[0], signature = exactPushKey(next, board);
    if (seen.has(signature)) break;
    seen.add(signature);
    path.push(...next.path);
    state = {robot: next.robot, boxes: next.boxes};
    pushes++;
  }
  return {...state, path, pushes, pushClass: first.pushClass};
}

function tunnelSegmentLookup(board) {
  if (board._tunnelSegmentMap) return board._tunnelSegmentMap;
  const map = new Map();
  for (const segment of board.topology.tunnelSegments || []) {
    for (const cell of segment.cells) {
      map.set(cell, segment);
    }
  }
  board._tunnelSegmentMap = map;
  return map;
}

function expandPushMacro(next, board, enabled = true, options = {}) {
  if (!enabled || !board.topology.tunnels.has(next.pushedTo)) return {...next, pushes: 1};

  // Check tunnel segment for one-way dead-end pruning
  const segMap = tunnelSegmentLookup(board);
  const segment = segMap.get(next.pushedTo);
  if (segment && segment.oneWay) {
    // One-way tunnel: check if pushing box into dead end with no matching goal
    const label = next.boxes.find(([y, x]) =>
      pkey(y, x) === next.pushedTo)?.[2];
    if (label && segment.goals.length === 0) {
      // No goals in this one-way tunnel, box will be stuck
      board.metrics.tunnelOneWayPrunes = (board.metrics.tunnelOneWayPrunes || 0) + 1;
      return null;
    }
    // Check if the goals in the tunnel match the box label
    if (label && segment.goals.length > 0) {
      const hasMatchingGoal = segment.goals.some(g => board.goals.get(g) === label);
      if (!hasMatchingGoal) {
        board.metrics.tunnelOneWayPrunes = (board.metrics.tunnelOneWayPrunes || 0) + 1;
        return null;
      }
    }
  }

  return collapseForcedPushes(next, board, 32, options);
}

function recordMacroDiscoveryRejection(metrics, reason) {
  if (!metrics) return;
  metrics.macroDiscoveryRejections++;
  if (reason === "stranded-export") metrics.macroEgressRejections++;
  if (reason === "packing-order") metrics.macroPackingRejections++;
  if (reason === "goal-access") metrics.macroGoalAccessRejections++;
}

function macroPathRoot(path) {
  return {parent: null, segment: path, length: path.length};
}

function extendMacroPath(state, segment) {
  const parent = state.macroPath || macroPathRoot(state.path);
  return {parent, segment, length: parent.length + segment.length};
}

function materializeMacroPath(state) {
  if (!state.macroPath) return state;
  let path = state.path;
  if (!path) {
    const segments = [];
    for (let node = state.macroPath; node; node = node.parent) {
      if (node.segment.length) segments.push(node.segment);
    }
    path = [];
    for (let index = segments.length - 1; index >= 0; index--) {
      path.push(...segments[index]);
    }
  }
  const {macroPath: _macroPath, ...result} = state;
  return {...result, path};
}

function expandPushSequences(
  first,
  board,
  maxPushes = 12,
  maxExplored = 48,
  maxReturned = 8,
  options = {},
) {
  const metrics = activePerformance;
  const initial = {...first, pushes: 1, macroPath: macroPathRoot(first.path)};
  const queue = [initial], endpoints = [];
  const seen = new Set([exactPushKey(initial, board)]);
  let head = 0;
  for (; head < queue.length && queue.length < maxExplored; head++) {
    const current = queue[head];
    if (current.pushes >= maxPushes || goal(current.boxes, board.goals)) {
      endpoints.push(current);
      continue;
    }
    const state = {robot: current.robot, boxes: current.boxes};
    const reachable = reachablePaths(state, board);
    if (createsSealedCorralDeadlock(state, board, reachable)) {
      if (metrics) metrics.macroHardDeadlockRejections++;
      endpoints.push(current);
      continue;
    }
    const continuations = pushBoxNeighbors(
      state,
      board,
      current.pushedTo,
      reachable,
      {lockProven: options.lockProven},
    );
    if (!continuations.length) {
      endpoints.push({...current, macroDecision: true, targetDeadEnd: true});
    }
    else if (continuations.length > 1) endpoints.push({...current, macroDecision: true});
    for (const next of continuations) {
      const sequence = {
        robot: next.robot,
        boxes: next.boxes,
        macroPath: extendMacroPath(current, next.path),
        pushes: current.pushes + 1,
        pushClass: `${first.pushClass}:${current.pushes + 1}`,
        pushedFrom: next.pushedFrom,
        pushedTo: next.pushedTo,
      };
      if (metrics) metrics.macroIntermediateStates++;
      const rejection = options.intermediateGuard?.(sequence, current);
      if (rejection) {
        recordMacroDiscoveryRejection(metrics, rejection);
        endpoints.push({...sequence, macroRejectedReason: rejection});
        continue;
      }
      const signature = exactPushKey(sequence, board);
      if (seen.has(signature)) continue;
      seen.add(signature);
      queue.push(sequence);
      if (queue.length >= maxExplored) break;
    }
  }
  endpoints.push(...queue.slice(head));
  endpoints.sort((left, right) =>
    Number(Boolean(right.macroDecision)) - Number(Boolean(left.macroDecision)) ||
    right.pushes - left.pushes ||
    (left.path?.length ?? left.macroPath.length) -
      (right.path?.length ?? right.macroPath.length));
  const selected = [], destinations = new Set();
  const viableEndpoint = endpoint => {
    if (!(endpoint.targetDistance > 0)) return true;
    const state = {robot: endpoint.robot, boxes: endpoint.boxes};
    const reachable = reachablePaths(state, board);
    return pushBoxNeighbors(
      state,
      board,
      endpoint.pushedTo,
      reachable,
      {lockProven: options.lockProven},
    ).length > 0;
  };
  for (const endpoint of endpoints) {
    if (destinations.has(endpoint.pushedTo)) continue;
    if (!viableEndpoint(endpoint)) continue;
    destinations.add(endpoint.pushedTo);
    selected.push(endpoint);
    if (selected.length >= maxReturned) break;
  }
  const approaches = new Set(selected.map(endpoint =>
    `${endpoint.pushedTo}|${endpoint.robot.join(",")}`));
  for (const endpoint of endpoints) {
    if (selected.length >= maxReturned) break;
    const approach = `${endpoint.pushedTo}|${endpoint.robot.join(",")}`;
    if (approaches.has(approach) || !viableEndpoint(endpoint)) continue;
    approaches.add(approach);
    selected.push(endpoint);
  }
  if (metrics) metrics.macroEndpointsRetained += selected.length;
  return [
    materializeMacroPath(initial),
    ...selected
      .filter(endpoint => exactPushKey(endpoint, board) !== exactPushKey(initial, board))
      .map(materializeMacroPath),
  ];
}

function expandTargetedPushSequence(
  first,
  board,
  objective,
  maxPushes = 24,
  maxExplored = 96,
  maxReturned = 4,
  options = {},
) {
  const metrics = activePerformance;
  const room = Number.isInteger(objective?.roomIndex)
    ? board.topology.rooms[objective.roomIndex] : null;
  const distance = state => {
    const position = state.pushedTo;
    if (objective?.direction === "export" && room) {
      if (!room.cells.has(position) && position !== room.gate) return 0;
      const toGate = playerAwarePushDistances(board, position).get(room.gate);
      return Number.isFinite(toGate) ? toGate + 1 : Infinity;
    }
    if (objective?.direction === "import" && room) {
      if (room.cells.has(position)) return 0;
      const toGate = playerAwarePushDistances(board, position).get(room.gate);
      return Number.isFinite(toGate) ? toGate + 1 : Infinity;
    }
    if (objective?.direction === "clear" && room) {
      if (!room.exteriorStaging.has(position) && position !== room.gate) return 0;
      const distances = playerAwarePushDistances(board, position);
      let best = Infinity;
      for (const candidate of board.floor) {
        if (room.exteriorStaging.has(candidate) || candidate === room.gate) continue;
        best = Math.min(best, distances.get(candidate) ?? Infinity);
      }
      return best;
    }
    if (objective?.target) {
      return compiledGoalPushDistance(board, position, objective.target);
    }
    return Infinity;
  };
  let macroOrder = 0;
  const initial = {
    ...first,
    pushes: 1,
    macroOrder: macroOrder++,
    macroPath: macroPathRoot(first.path),
  };
  initial.targetDistance = distance(initial);
  const open = new Heap(), endpoints = [], completedTargets = new Map();
  const openPriority = sequence => {
    const combined = sequence.pushes + sequence.targetDistance;
    return Number.isFinite(combined)
      ? (combined * 1000 + sequence.targetDistance) * 1000 + sequence.macroOrder
      : 1e15 + sequence.macroOrder;
  };
  open.push([openPriority(initial), initial]);
  const seen = new Set([exactPushKey(initial, board)]);
  let explored = 0;
  while (open.length && explored++ < maxExplored) {
    if (options.targetBound !== false && completedTargets.size >= maxReturned) {
      const worstPushes = Math.max(
        ...[...completedTargets.values()].map(endpoint => endpoint.pushes),
      );
      const bestOpen = open.items[0][1];
      if (bestOpen.pushes + bestOpen.targetDistance > worstPushes) {
        if (metrics) metrics.macroTargetBoundCutoffs++;
        break;
      }
    }
    const current = open.pop()[1];
    if (current.targetDistance === 0 || current.pushes >= maxPushes) {
      endpoints.push(current);
      if (current.targetDistance === 0) {
        const previous = completedTargets.get(current.pushedTo);
        if (!previous || current.pushes < previous.pushes) {
          completedTargets.set(current.pushedTo, current);
        }
      }
      continue;
    }
    const state = {robot: current.robot, boxes: current.boxes};
    const reachable = reachablePaths(state, board);
    if (createsSealedCorralDeadlock(state, board, reachable)) {
      if (metrics) metrics.macroHardDeadlockRejections++;
      continue;
    }
    const continuations = pushBoxNeighbors(
      state,
      board,
      current.pushedTo,
      reachable,
      {lockProven: options.lockProven},
    );
    if (!continuations.length) endpoints.push({...current, macroDecision: true});
    for (const next of continuations) {
      const sequence = {
        robot: next.robot,
        boxes: next.boxes,
        macroPath: extendMacroPath(current, next.path),
        pushes: current.pushes + 1,
        pushClass: `${first.pushClass}:target:${current.pushes + 1}`,
        pushedFrom: next.pushedFrom,
        pushedTo: next.pushedTo,
        macroOrder: macroOrder++,
      };
      if (metrics) metrics.macroIntermediateStates++;
      sequence.targetDistance = distance(sequence);
      if (!Number.isFinite(sequence.targetDistance)) {
        if (metrics) metrics.macroTargetUnreachableStates++;
      }
      const rejection = options.intermediateGuard?.(sequence, current);
      if (rejection) {
        recordMacroDiscoveryRejection(metrics, rejection);
        endpoints.push({...sequence, macroRejectedReason: rejection});
        continue;
      }
      const signature = exactPushKey(sequence, board);
      if (seen.has(signature)) continue;
      seen.add(signature);
      open.push([openPriority(sequence), sequence]);
    }
  }
  endpoints.push(...open.items.map(item => item[1]));
  endpoints.sort((left, right) =>
    Number(Boolean(left.targetDeadEnd)) - Number(Boolean(right.targetDeadEnd)) ||
    left.targetDistance - right.targetDistance ||
    left.pushes - right.pushes ||
    left.macroOrder - right.macroOrder);
  const selected = [], destinations = new Set();
  for (const endpoint of endpoints) {
    if (destinations.has(endpoint.pushedTo)) continue;
    destinations.add(endpoint.pushedTo);
    selected.push(endpoint);
    if (selected.length >= maxReturned) break;
  }
  const approaches = new Set(selected.map(endpoint =>
    `${endpoint.pushedTo}|${endpoint.robot.join(",")}`));
  for (const endpoint of endpoints) {
    if (selected.length >= maxReturned) break;
    const approach = `${endpoint.pushedTo}|${endpoint.robot.join(",")}`;
    if (approaches.has(approach)) continue;
    approaches.add(approach);
    selected.push(endpoint);
  }
  if (metrics) metrics.macroEndpointsRetained += selected.length;
  return [
    materializeMacroPath(initial),
    ...selected
      .filter(endpoint => exactPushKey(endpoint, board) !== exactPushKey(initial, board))
      .map(materializeMacroPath),
  ];
}

function expandStraightPushes(first, board, maxPushes = 8, options = {}) {
  const [fromY, fromX] = first.pushedFrom.split(",").map(Number);
  const [toY, toX] = first.pushedTo.split(",").map(Number);
  const dy = toY - fromY, dx = toX - fromX;
  const results = [{...first, pushes: 1}];
  let current = results[0];
  while (current.pushes < maxPushes && !goal(current.boxes, board.goals)) {
    const state = {robot: current.robot, boxes: current.boxes};
    const reachable = reachablePaths(state, board);
    if (createsSealedCorralDeadlock(state, board, reachable)) break;
    const [y, x] = current.pushedTo.split(",").map(Number);
    const destination = pkey(y + dy, x + dx);
    const next = pushBoxNeighbors(
      state,
      board,
      current.pushedTo,
      reachable,
      {lockProven: options.lockProven},
    )
      .find(candidate => candidate.pushedTo === destination);
    if (!next) break;
    current = {
      ...next,
      path: [...current.path, ...next.path],
      pushes: current.pushes + 1,
      pushClass: `${first.pushClass}:${current.pushes + 1}`,
    };
    results.push(current);
  }
  return results;
}

function invertWalk(path) {
  return [...path].reverse().map(move => OPPOSITE[move]);
}
function encodeMoves(path) {
  return path.map(move => MOVE_CODE[move]).join("");
}

function reversePullNeighbors(state, board, reachable = reachablePaths(state, board)) {
  const occupied = reachable.occupied || denseOccupancy(state, board);
  const result = [];
  state.boxes.forEach(([y, x, label], index) => {
    const boxId = cellId(y, x, board.dense);
    for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
      const [move] = DIRECTION_ENTRIES[direction];
      const opposite = OPPOSITE_DIRECTION_INDEX[direction];
      const boxBeforeId = board.dense.neighbors[boxId * DIRECTION_ENTRIES.length + opposite];
      if (!reachable.hasId(boxBeforeId) || occupied[boxBeforeId] >= 0) continue;
      const robotAfterPullId = board.dense.neighbors[
        boxBeforeId * DIRECTION_ENTRIES.length + opposite
      ];
      if (robotAfterPullId < 0 || occupied[robotAfterPullId] >= 0) continue;
      const boxY = board.dense.y[boxBeforeId], boxX = board.dense.x[boxBeforeId];
      if (staticDead(boxY, boxX, board, label)) continue;
      const boxes = state.boxes.slice();
      boxes[index] = [boxY, boxX, label];
      deriveDenseBoxLayout(state.boxes, boxes, index, boxBeforeId, board);
      if (creates2x2Deadlock(boxes, board, [boxY, boxX]) ||
          createsFrozenComponentDeadlock(boxes, board, [boxY, boxX])) continue;
      const walkToPullSpot = reachable.getId(boxBeforeId);
      const walkFromPushLanding = invertWalk(walkToPullSpot);
      result.push({
        robot: [board.dense.y[robotAfterPullId], board.dense.x[robotAfterPullId]],
        boxes,
        cost: state.cost + 1,
        segment: [move, ...walkFromPushLanding],
      });
    }
  });
  return result;
}

function solvedBoxes(board, initialBoxes) {
  const byLabel = new Map();
  initialBoxes.forEach(([, , label]) => byLabel.set(label, (byLabel.get(label) || 0) + 1));
  const boxes = [];
  for (const [label, count] of byLabel) {
    const goals = [...board.goals]
      .filter(([, goalLabel]) => goalLabel === label)
      .map(([position]) => position.split(",").map(Number))
      .slice(0, count);
    goals.forEach(([y, x]) => boxes.push([y, x, label]));
  }
  return boxes.sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

function reverseStartPortfolio(board, initialBoxes, initialTargets = null) {
  const boxes = solvedBoxes(board, initialBoxes);
  const occupied = new Set(boxes.map(([y, x]) => pkey(y, x)));
  const unique = new Map();
  for (const position of board.floor) {
    if (occupied.has(position)) continue;
    const robot = position.split(",").map(Number);
    const state = {robot, boxes, cost: 0};
    const reachable = reachablePaths(state, board);
    const signature = pushKey(state, reachable);
    if (!unique.has(signature)) unique.set(signature, {state, signature, reachable});
  }
  const targets = initialTargets || targetMapFromBoxes(initialBoxes, board);
  return [...unique.values()].map(entry => {
    const pulls = reversePullNeighbors(entry.state, board, entry.reachable);
    const nextEstimate = pulls.reduce((best, next) =>
      Math.min(best, homeHeuristic(next.boxes, targets)), Infinity);
    const gateAccess = [...board.topology.articulations]
      .filter(position => entry.reachable.has(position)).length;
    return {
      ...entry,
      pullOptions: pulls.length,
      pullSignatures: pulls.map(next => exactPushKey(next, board)),
      nextEstimate,
      reachableCells: entry.reachable.size,
      gateAccess,
    };
  }).sort((left, right) =>
    Number(right.pullOptions > 0) - Number(left.pullOptions > 0) ||
    right.pullOptions - left.pullOptions ||
    left.nextEstimate - right.nextEstimate ||
    right.gateAccess - left.gateAccess ||
    right.reachableCells - left.reachableCells ||
    left.signature.localeCompare(right.signature));
}

function reverseStartStates(board, initialBoxes, shard, initialTargets = null) {
  const portfolio = reverseStartPortfolio(board, initialBoxes, initialTargets);
  const states = portfolio.map(entry => entry.state);
  const assignedPullOptions = portfolio.reduce((sum, entry) => sum +
    entry.pullSignatures.filter(signature => reverseShardOwns(signature, shard)).length, 0);
  states.portfolioStats = {
    totalRegions: portfolio.length,
    productiveRegions: portfolio.filter(entry => entry.pullOptions > 0).length,
    totalPullOptions: portfolio.reduce((sum, entry) => sum + entry.pullOptions, 0),
    assignedRegions: states.length,
    assignedProductiveRegions: portfolio.filter(entry => entry.pullSignatures
      .some(signature => reverseShardOwns(signature, shard))).length,
    assignedPullOptions,
  };
  return states;
}

function reverseShardOwns(signature, shard) {
  if (!shard || shard.count <= 1) return true;
  return Math.floor(signatureNoise(signature, 0x51f15e) * shard.count) === shard.index;
}

// --- Module registration ---
const SokomindPushGeneration = {
  pushNeighbors,
  pushBoxNeighbors,
  pushKey,
  collapseForcedPushes,
  tunnelSegmentLookup,
  expandPushMacro,
  recordMacroDiscoveryRejection,
  macroPathRoot,
  extendMacroPath,
  materializeMacroPath,
  expandPushSequences,
  expandTargetedPushSequence,
  expandStraightPushes,
  invertWalk,
  encodeMoves,
  reversePullNeighbors,
  solvedBoxes,
  reverseStartPortfolio,
  reverseStartStates,
  reverseShardOwns,
};

/* ===== solver-search.js ===== */
function flushRecords(records, telemetry = {}) {
  if (records.length) {
    postMessage({
      type: "records",
      records: records.splice(0, records.length),
      ...telemetry,
    });
  }
}

function reconstructPath(cameFrom, signature) {
  const path = [];
  let current = signature;
  while (cameFrom.has(current)) {
    const {parent, segment} = cameFrom.get(current);
    path.unshift(...segment);
    current = parent;
  }
  return path;
}

function signatureNoise(signature, seed) {
  let hash = (2166136261 ^ seed) >>> 0;
  if (typeof signature === "bigint") {
    let value = signature;
    do {
      hash ^= Number(value & 0xffffffffn);
      hash = Math.imul(hash, 16777619) >>> 0;
      value >>= 32n;
    } while (value);
    return hash / 0x100000000;
  }
  for (let index = 0; index < signature.length; index++) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 0x100000000;
}

function reconstructNodePath(node) {
  const segments = [];
  for (let current = node; current; current = current.parent) segments.push(current.segment);
  const path = [];
  for (let index = segments.length - 1; index >= 0; index--) path.push(...segments[index]);
  return path;
}

function serializeSearchCheckpoint(candidate, board) {
  if (!candidate) return null;
  return {
    state: {
      rows: board.rows,
      robot: candidate.robot,
      boxes: candidate.boxes.map(([y, x, label]) => [pkey(y, x), label]),
    },
    path: reconstructNodePath(candidate.node),
    cost: candidate.cost,
    estimate: candidate.estimate,
  };
}

const PLAN_BOARD_TRANSFORMS = [
  {
    id: "identity",
    dimensions: (height, width) => [height, width],
    forward: (_height, _width, y, x) => [y, x],
    inverse: (_height, _width, y, x) => [y, x],
  },
  {
    id: "mirror-horizontal",
    dimensions: (height, width) => [height, width],
    forward: (_height, width, y, x) => [y, width - 1 - x],
    inverse: (_height, width, y, x) => [y, width - 1 - x],
  },
  {
    id: "mirror-vertical",
    dimensions: (height, width) => [height, width],
    forward: (height, _width, y, x) => [height - 1 - y, x],
    inverse: (height, _width, y, x) => [height - 1 - y, x],
  },
  {
    id: "rotate-180",
    dimensions: (height, width) => [height, width],
    forward: (height, width, y, x) => [height - 1 - y, width - 1 - x],
    inverse: (height, width, y, x) => [height - 1 - y, width - 1 - x],
  },
  {
    id: "rotate-90",
    dimensions: (height, width) => [width, height],
    forward: (height, _width, y, x) => [x, height - 1 - y],
    inverse: (height, _width, y, x) => [height - 1 - x, y],
  },
  {
    id: "rotate-270",
    dimensions: (height, width) => [width, height],
    forward: (_height, width, y, x) => [width - 1 - x, y],
    inverse: (_height, width, y, x) => [x, width - 1 - y],
  },
  {
    id: "transpose",
    dimensions: (height, width) => [width, height],
    forward: (_height, _width, y, x) => [x, y],
    inverse: (_height, _width, y, x) => [x, y],
  },
  {
    id: "transpose-anti",
    dimensions: (height, width) => [width, height],
    forward: (height, width, y, x) => [width - 1 - x, height - 1 - y],
    inverse: (height, width, y, x) => [height - 1 - x, width - 1 - y],
  },
];

function transformPlanMove(move, transform, height, width, inverse = false) {
  const [dy, dx] = DIRS[move];
  const map = inverse ? transform.inverse : transform.forward;
  const [originY, originX] = map(height, width, 1, 1);
  const [nextY, nextX] = map(height, width, 1 + dy, 1 + dx);
  const transformedDy = nextY - originY, transformedDx = nextX - originX;
  return DIRECTION_ENTRIES.find(([, delta]) =>
    delta[0] === transformedDy && delta[1] === transformedDx)?.[0];
}

function canonicalPlanTransform(state) {
  const height = state.rows.length;
  const width = Math.max(...state.rows.map(row => row.length));
  const grid = state.rows.map(row => [...row.padEnd(width, "O")]);
  let staticRobot = null;
  grid.forEach((row, y) => row.forEach((cell, x) => {
    if (cell === "R") staticRobot = [y, x];
  }));
  staticRobot ||= state.robot;
  const candidates = PLAN_BOARD_TRANSFORMS.map(transform => {
    const [nextHeight, nextWidth] = transform.dimensions(height, width);
    const nextGrid = Array.from(
      {length: nextHeight},
      () => Array(nextWidth).fill("O"),
    );
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [nextY, nextX] = transform.forward(height, width, y, x);
        nextGrid[nextY][nextX] = grid[y][x];
      }
    }
    const rows = nextGrid.map(row => row.join(""));
    const robot = transform.forward(height, width, state.robot[0], state.robot[1]);
    const boxes = state.boxes.map(([position, label]) => {
      const [y, x] = position.split(",").map(Number);
      const [nextY, nextX] = transform.forward(height, width, y, x);
      return {position: pkey(nextY, nextX), label, y: nextY, x: nextX};
    })
      .sort((left, right) =>
        left.y - right.y || left.x - right.x || left.label.localeCompare(right.label))
      .map(({position, label}) => [position, label]);
    const anchor = transform.forward(height, width, staticRobot[0], staticRobot[1]);
    const stateKey = `${rows.join("\n")}|${pkey(robot[0], robot[1])}|` +
      boxes.map(([position, label]) => `${position},${label}`).sort().join(";");
    return {
      transform,
      height,
      width,
      rows,
      robot,
      boxes,
      anchorY: anchor[0],
      anchorHeight: nextHeight,
      stateKey,
    };
  });
  candidates.sort((left, right) => {
    const leftDepth = left.anchorY * Math.max(1, right.anchorHeight - 1);
    const rightDepth = right.anchorY * Math.max(1, left.anchorHeight - 1);
    return rightDepth - leftDepth ||
      left.stateKey.localeCompare(right.stateKey) ||
      left.transform.id.localeCompare(right.transform.id);
  });
  return candidates[0];
}

function restorePlanCheckpoint(checkpoint, canonical, originalRows) {
  if (!checkpoint) return checkpoint;
  const restorePosition = position => {
    const [y, x] = position.split(",").map(Number);
    return pkey(...canonical.transform.inverse(
      canonical.height,
      canonical.width,
      y,
      x,
    ));
  };
  return {
    ...checkpoint,
    state: checkpoint.state && {
      ...checkpoint.state,
      rows: originalRows,
      robot: canonical.transform.inverse(
        canonical.height,
        canonical.width,
        checkpoint.state.robot[0],
        checkpoint.state.robot[1],
      ),
      boxes: checkpoint.state.boxes.map(([position, label]) => [
        restorePosition(position),
        label,
      ]),
    },
    path: checkpoint.path?.map(move => transformPlanMove(
      move,
      canonical.transform,
      canonical.height,
      canonical.width,
      true,
    )),
  };
}

function canonicalPlanMacroBeamSearch(payload) {
  if (payload.planCanonicalOrientation === false) return planMacroBeamSearch(payload);
  const canonical = canonicalPlanTransform(payload.state);
  if (canonical.transform.id === "identity") {
    return {...planMacroBeamSearch(payload), planOrientation: "identity"};
  }
  const result = planMacroBeamSearch({
    ...payload,
    preparedBoard: undefined,
    trackedSignatures: undefined,
    state: {
      ...payload.state,
      rows: canonical.rows,
      robot: canonical.robot,
      boxes: canonical.boxes,
    },
  });
  const restorePath = path => path?.map(move => transformPlanMove(
    move,
    canonical.transform,
    canonical.height,
    canonical.width,
    true,
  ));
  return {
    ...result,
    path: restorePath(result.path),
    checkpoint: restorePlanCheckpoint(result.checkpoint, canonical, payload.state.rows),
    checkpoints: result.checkpoints?.map(checkpoint =>
      restorePlanCheckpoint(checkpoint, canonical, payload.state.rows)),
    planOrientation: canonical.transform.id,
  };
}

function takeDiverse(candidates, count, selected, scoreKey, groupKey = "pushClass") {
  const groups = new Map();
  for (const candidate of candidates) {
    const identity = candidate.exactIdentity ?? candidate.exactSignature;
    if (selected.has(identity)) continue;
    const key = candidate[groupKey] || candidate.pushClass || identity;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  let queues = [...groups.values()].map(items => ({
    items: items.sort((left, right) => left[scoreKey] - right[scoreKey]),
    index: 0,
  }));
  queues.sort((left, right) => left.items[0][scoreKey] - right.items[0][scoreKey]);
  const result = [];
  while (result.length < count && queues.length) {
    const remaining = [];
    for (const queue of queues) {
      if (result.length >= count) break;
      const candidate = queue.items[queue.index++];
      const identity = candidate.exactIdentity ?? candidate.exactSignature;
      if (!selected.has(identity)) {
        selected.add(identity);
        result.push(candidate);
      }
      if (queue.index < queue.items.length) remaining.push(queue);
    }
    queues = remaining;
  }
  return result;
}

function thresholdBucket(value, thresholds) {
  for (let index = 0; index < thresholds.length; index++) {
    if (value <= thresholds[index]) return index;
  }
  return thresholds.length;
}

function centeredFeatureBucket(value) {
  if (value <= -1) return 0;
  if (value < -0.1) return 1;
  if (value <= 0.1) return 2;
  if (value < 1) return 3;
  return 4;
}

function beamFeatureClass(candidate, bestEstimate = candidate.estimate) {
  const slack = candidate.estimate - bestEstimate;
  const mobility = candidate.reachable?.size ?? 0;
  return [
    `h${thresholdBucket(slack, [2, 5, 9])}`,
    `r${thresholdBucket(candidate.topology ?? 0, [0, 1, 3])}`,
    `e${thresholdBucket(candidate.evacuation ?? 0, [0, 1, 3])}`,
    `p${thresholdBucket(candidate.packing ?? 0, [0, 1, 3])}`,
    `g${thresholdBucket(candidate.doorway ?? 0, [0, 1, 3])}${centeredFeatureBucket(candidate.doorwayDelta ?? 0)}`,
    `d${centeredFeatureBucket(candidate.dependencyDelta ?? 0)}${centeredFeatureBucket(candidate.localRoomDelta ?? 0)}`,
    `m${thresholdBucket(mobility, [0, 8, 20])}`,
  ].join("|");
}

function selectBeamLayer(candidates, width, profile = "balanced", metrics = null,
  useFeatureSpace = true) {
  if (candidates.length <= width) return candidates;
  let bestEstimate = Infinity;
  for (const candidate of candidates) bestEstimate = Math.min(bestEstimate, candidate.estimate);
  const bands = [[], [], [], []];
  for (const candidate of candidates) {
    const slack = candidate.estimate - bestEstimate;
    bands[slack <= 2 ? 0 : slack <= 5 ? 1 : slack <= 9 ? 2 : 3].push(candidate);
  }
  const ratios = profile === "milestone"
    ? [0.20, 0.20, 0.20, 0.40]
    : profile === "detour"
    ? [0.30, 0.25, 0.25, 0.20]
    : [0.50, 0.25, 0.15, 0.10];
  const groupKey = profile === "milestone" ? "strategicClass" : "pushClass";
  const selected = new Set(), result = [];
  let featureSelectedCount = 0;
  if (useFeatureSpace) {
    const featureRatio = profile === "milestone" ? 0.55 : profile === "detour" ? 0.45 : 0.35;
    for (const candidate of candidates) {
      candidate.featureClass = beamFeatureClass(candidate, bestEstimate);
      candidate.featureArchiveScore = Number.isFinite(candidate.exploreScore)
        ? candidate.exploreScore
        : candidate.score;
    }
    const cells = new Set(candidates.map(candidate => candidate.featureClass));
    const featureQuota = Math.max(1, Math.floor(width * featureRatio));
    const featureSelected = takeDiverse(
      candidates, featureQuota, selected, "featureArchiveScore", "featureClass");
    result.push(...featureSelected);
    featureSelectedCount = featureSelected.length;
    if (metrics) {
      metrics.beamFeatureCells += cells.size;
      metrics.beamFeatureSelections += featureSelected.length;
    }
  }
  const bandWidth = width - result.length;
  bands.forEach((band, index) => {
    const quota = index === bands.length - 1
      ? bandWidth - ratios.slice(0, index)
        .reduce((total, ratio) => total + Math.floor(bandWidth * ratio), 0)
      : Math.floor(bandWidth * ratios[index]);
    const scoreKey = index === bands.length - 1 ? "exploreScore" : "score";
    result.push(...takeDiverse(band, quota, selected, scoreKey, groupKey));
  });
  if (result.length < width) {
    const ranked = [...candidates].sort((left, right) => left.score - right.score);
    result.push(...takeDiverse(ranked, width - result.length, selected, "score", groupKey));
  }
  if (metrics) metrics.beamBandSelections += result.length - featureSelectedCount;
  return result;
}

function planMilestoneSignature(candidate, board) {
  const solved = candidate.boxes
    .filter(([y, x, label]) => board.goals.get(pkey(y, x)) === label)
    .map(([y, x]) => pkey(y, x))
    .sort()
    .join(".");
  const blocked = candidate.goalAccess.blockedGoals
    .map(goal => goal.goal)
    .sort()
    .join(".");
  const schedule = candidate.doorwaySchedule
    ? `${candidate.doorwaySchedule.pendingExports}.` +
      `${candidate.doorwaySchedule.remainingImports}.` +
      `${candidate.doorwaySchedule.unpackedImports}.` +
      `${candidate.doorwaySchedule.prematureImports}.` +
      `${candidate.doorwaySchedule.crossingConflicts}.` +
      `${candidate.doorwaySchedule.stagingBlockers}.` +
      `${candidate.doorwaySchedule.blockedImportAccess}.` +
      `${candidate.doorwaySchedule.packingOrderViolations}`
    : "";
  return `${solved}|${blocked}|${schedule}|${roomFlowSignature(candidate.boxes, board)}`;
}

function selectPlanLayer(candidates, width, board) {
  const ranked = [...candidates].sort((left, right) =>
    left.score - right.score ||
    left.estimate - right.estimate ||
    left.moves - right.moves ||
    left.cost - right.cost);
  if (ranked.length <= width) return ranked;
  const groups = new Map();
  for (const candidate of ranked) {
    const key = planMilestoneSignature(candidate, board);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const selected = [], selectedIds = new Set();
  const structuralEliteCount = Math.max(1, Math.ceil(width * 0.1));
  const structuralElites = [...ranked]
    .filter(candidate => Number.isFinite(candidate.planCheckpointRank))
    .sort((left, right) =>
      left.planCheckpointRank - right.planCheckpointRank ||
      left.score - right.score)
    .slice(0, structuralEliteCount);
  for (const candidate of structuralElites) {
    selected.push(candidate);
    selectedIds.add(candidate.exactIdentity);
  }
  const heuristicEliteCount = Math.max(1, Math.ceil(width * 0.1));
  const heuristicElites = [...ranked]
    .sort((left, right) =>
      left.estimate - right.estimate ||
      left.moves - right.moves ||
      left.cost - right.cost ||
      left.score - right.score)
    .slice(0, heuristicEliteCount);
  for (const candidate of heuristicElites) {
    if (selectedIds.has(candidate.exactIdentity)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.exactIdentity);
  }
  let queues = [...groups.values()];
  while (selected.length < Math.ceil(width * 0.7) && queues.length) {
    const remaining = [];
    for (const queue of queues) {
      if (selected.length >= Math.ceil(width * 0.7)) break;
      const candidate = queue.shift();
      if (!selectedIds.has(candidate.exactIdentity)) {
        selected.push(candidate);
        selectedIds.add(candidate.exactIdentity);
      }
      if (queue.length) remaining.push(queue);
    }
    queues = remaining;
  }
  for (const candidate of ranked) {
    if (selected.length >= width) break;
    if (selectedIds.has(candidate.exactIdentity)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.exactIdentity);
  }
  return selected;
}

function fessPackingOrder(board) {
  const records = [...board.goals].map(([goal, label]) => {
    let depth = 0, traffic = 0;
    for (const room of board.topology.rooms) {
      if (!room.cells.has(goal)) continue;
      depth = Math.max(depth, room.depths.get(goal) || 0);
      traffic = Math.max(traffic, room.traffic.get(goal) || 0);
    }
    return {goal, label, depth, traffic};
  });
  const byGoal = new Map(records.map(record => [record.goal, record]));
  const outgoing = new Map(records.map(record => [record.goal, new Set()]));
  const indegree = new Map(records.map(record => [record.goal, 0]));
  for (const room of board.topology.rooms) {
    for (const [blocker, target] of room.dependencies) {
      if (!byGoal.has(blocker) || !byGoal.has(target) ||
          outgoing.get(target).has(blocker)) continue;
      outgoing.get(target).add(blocker);
      indegree.set(blocker, indegree.get(blocker) + 1);
    }
  }
  const compare = (left, right) =>
    right.depth - left.depth ||
    right.traffic - left.traffic ||
    left.label.localeCompare(right.label) ||
    left.goal.localeCompare(right.goal);
  const ready = records.filter(record => indegree.get(record.goal) === 0).sort(compare);
  const ordered = [];
  while (ready.length) {
    const record = ready.shift();
    ordered.push(record);
    for (const next of outgoing.get(record.goal)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        ready.push(byGoal.get(next));
        ready.sort(compare);
      }
    }
  }
  if (ordered.length < records.length) {
    const included = new Set(ordered.map(record => record.goal));
    ordered.push(...records.filter(record => !included.has(record.goal)).sort(compare));
  }
  return ordered;
}

function fessConnectivityRegions(boxes, board) {
  const {dense} = board;
  const occupied = denseBoxLayout(boxes, board).indexByCell;
  const seen = new Uint8Array(dense.keys.length);
  const queue = new Uint32Array(dense.keys.length);
  let regions = 0;
  for (let start = 0; start < dense.keys.length; start++) {
    if (occupied[start] >= 0 || seen[start]) continue;
    regions++;
    let head = 0, tail = 1;
    queue[0] = start;
    seen[start] = 1;
    while (head < tail) {
      const current = queue[head++];
      for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
        const next = dense.neighbors[current * DIRECTION_ENTRIES.length + direction];
        if (next < 0 || occupied[next] >= 0 || seen[next]) continue;
        seen[next] = 1;
        queue[tail++] = next;
      }
    }
  }
  return regions;
}

function fessAccessBlockers(boxes, board, context) {
  const started = now();
  board.metrics.goalAccessCalls++;
  const signature = boxSignature(boxes, board);
  if (context.accessMemo.has(signature)) {
    board.metrics.goalAccessCacheHits++;
    return context.accessMemo.get(signature);
  }
  const occupied = new Map(
    boxes.map(([y, x, label]) => [pkey(y, x), label]),
  );
  const blockers = new Set();
  let blockedGoals = 0;
  for (const entry of board.topology.goalAccess) {
    if (occupied.get(entry.goal) === entry.label) continue;
    let openLanes = 0;
    const goalBlockers = [];
    for (const lane of entry.lanes) {
      const sourceLabel = occupied.get(lane.source);
      const supportLabel = occupied.get(lane.support);
      if (supportLabel === undefined &&
          (sourceLabel === undefined || sourceLabel === entry.label)) {
        openLanes++;
        continue;
      }
      if (sourceLabel !== undefined && sourceLabel !== entry.label) {
        goalBlockers.push(lane.source);
      }
      if (supportLabel !== undefined) goalBlockers.push(lane.support);
    }
    if (!openLanes && entry.lanes.length) {
      blockedGoals++;
      for (const blocker of goalBlockers) blockers.add(blocker);
    }
  }
  board.metrics.goalAccessBlockedGoals += blockedGoals;
  board.metrics.goalAccessMs += now() - started;
  return memoizeBounded(context.accessMemo, signature, blockers, 5000);
}

function fessFeatureValues(state, board, context, reachable = reachablePaths(state, board)) {
  const occupied = new Map(
    state.boxes.map(([y, x, label]) => [pkey(y, x), label]),
  );
  let packing = 0;
  for (const target of context.packingOrder) {
    if (occupied.get(target.goal) !== target.label) break;
    packing++;
  }
  const connectivity = fessConnectivityRegions(state.boxes, board);
  const roomConnectivity = new Set(
    board.topology.rooms
      .filter(room => occupied.has(room.gate))
      .map(room => room.gate),
  ).size;
  const accessBlockers = fessAccessBlockers(state.boxes, board, context);
  const schedule = context.doorwayTasks.length
    ? doorwayScheduleState(state.boxes, board, context.doorwayTasks)
    : null;
  const outOfPlan = accessBlockers.size +
    (schedule?.prematureImports || 0) +
    (schedule?.strandedExports || 0) +
    (schedule?.packingOrderViolations || 0) +
    (schedule?.blockedImportAccess || 0);
  const estimate = discoveryHeuristic(state.boxes, board);
  return {
    packing,
    connectivity,
    roomConnectivity,
    outOfPlan,
    mobility: reachable.size,
    estimate,
    accessBlockers,
    cell: `${packing}|${connectivity}|${roomConnectivity}|${outOfPlan}`,
  };
}

function fessAdvisor(parent, child, movedIndex, target, board) {
  const signals = new Map();
  if (child.features.packing > parent.features.packing) {
    signals.set("packing", child.features.packing - parent.features.packing);
  }
  if (child.features.connectivity < parent.features.connectivity) {
    signals.set("connectivity",
      parent.features.connectivity - child.features.connectivity);
  }
  if (child.features.roomConnectivity < parent.features.roomConnectivity) {
    signals.set("room-connectivity",
      parent.features.roomConnectivity - child.features.roomConnectivity);
  }
  if (child.features.outOfPlan < parent.features.outOfPlan) {
    signals.set("out-of-plan",
      parent.features.outOfPlan - child.features.outOfPlan);
  }
  if (parent.features.accessBlockers.has(child.firstPushedFrom)) {
    signals.set("blocking-box", 1 +
      Math.max(0, parent.features.outOfPlan - child.features.outOfPlan));
  }
  if (target && movedIndex >= 0) {
    const before = pkey(parent.boxes[movedIndex][0], parent.boxes[movedIndex][1]);
    const after = pkey(child.boxes[movedIndex][0], child.boxes[movedIndex][1]);
    const beforeDistance = compiledGoalPushDistance(board, before, target);
    const afterDistance = compiledGoalPushDistance(board, after, target);
    if (afterDistance < beforeDistance) {
      signals.set("assignment", beforeDistance - afterDistance);
    }
  }
  if (child.features.mobility > parent.features.mobility &&
      child.features.connectivity <= parent.features.connectivity) {
    signals.set("access", child.features.mobility - parent.features.mobility);
  }
  return signals;
}

const FESS_STATE_CHUNK = 1024;
const FESS_PATH_CHUNK = 65536;
const FESS_MOVE_ID = new Map(
  DIRECTION_ENTRIES.map(([move], index) => [move, index]),
);

class FessActionHeap {
  constructor() {
    this.ranks = [];
    this.stateIds = [];
  }
  push(rank, stateId) {
    const ranks = this.ranks, stateIds = this.stateIds;
    let index = ranks.length;
    ranks.push(rank);
    stateIds.push(stateId);
    while (index) {
      const parent = (index - 1) >> 1;
      if (ranks[parent] <= rank) break;
      ranks[index] = ranks[parent];
      stateIds[index] = stateIds[parent];
      index = parent;
    }
    ranks[index] = rank;
    stateIds[index] = stateId;
  }
  pop() {
    const ranks = this.ranks, stateIds = this.stateIds;
    if (!ranks.length) return null;
    const rank = ranks[0], stateId = stateIds[0];
    const lastRank = ranks.pop(), lastStateId = stateIds.pop();
    if (ranks.length) {
      let index = 0;
      while (true) {
        let child = index * 2 + 1;
        if (child >= ranks.length) break;
        if (child + 1 < ranks.length && ranks[child + 1] < ranks[child]) child++;
        if (ranks[child] >= lastRank) break;
        ranks[index] = ranks[child];
        stateIds[index] = stateIds[child];
        index = child;
      }
      ranks[index] = lastRank;
      stateIds[index] = lastStateId;
    }
    return {rank, stateId};
  }
  compact(isLive) {
    const live = [];
    for (let index = 0; index < this.ranks.length; index++) {
      if (isLive(this.stateIds[index], this.ranks[index])) {
        live.push([this.ranks[index], this.stateIds[index]]);
      }
    }
    const removed = this.ranks.length - live.length;
    this.ranks = [];
    this.stateIds = [];
    for (const [rank, stateId] of live) this.push(rank, stateId);
    return removed;
  }
  get length() { return this.ranks.length; }
}

function createFessStateArena(board, initialBoxes) {
  const boxCount = initialBoxes.length;
  const labels = initialBoxes.map(([, , label]) => label);
  const chunks = [], pathChunks = [];
  let size = 0, pathSize = 0;
  const createChunk = () => {
    const chunk = {
      robot: new Uint32Array(FESS_STATE_CHUNK),
      boxes: new Uint32Array(FESS_STATE_CHUNK * boxCount),
      cost: new Uint32Array(FESS_STATE_CHUNK),
      moves: new Uint32Array(FESS_STATE_CHUNK),
      weight: new Uint32Array(FESS_STATE_CHUNK),
      parent: new Int32Array(FESS_STATE_CHUNK),
      pathStart: new Uint32Array(FESS_STATE_CHUNK),
      pathLength: new Uint32Array(FESS_STATE_CHUNK),
      rank: new Float64Array(FESS_STATE_CHUNK),
      packing: new Uint32Array(FESS_STATE_CHUNK),
      connectivity: new Uint32Array(FESS_STATE_CHUNK),
      roomConnectivity: new Uint32Array(FESS_STATE_CHUNK),
      outOfPlan: new Uint32Array(FESS_STATE_CHUNK),
      mobility: new Uint32Array(FESS_STATE_CHUNK),
      estimate: new Float64Array(FESS_STATE_CHUNK),
      queued: new Uint8Array(FESS_STATE_CHUNK),
    };
    chunk.parent.fill(-1);
    chunks.push(chunk);
    return chunk;
  };
  const appendPath = segment => {
    const start = pathSize;
    for (const move of segment) {
      const chunkIndex = Math.floor(pathSize / (FESS_PATH_CHUNK * 4));
      const packedOffset = pathSize % (FESS_PATH_CHUNK * 4);
      const offset = packedOffset >>> 2;
      const shift = (packedOffset & 3) * 2;
      if (!pathChunks[chunkIndex]) pathChunks[chunkIndex] = new Uint8Array(FESS_PATH_CHUNK);
      pathChunks[chunkIndex][offset] |= FESS_MOVE_ID.get(move) << shift;
      pathSize++;
    }
    return [start, segment.length];
  };
  const locate = id => [chunks[Math.floor(id / FESS_STATE_CHUNK)], id % FESS_STATE_CHUNK];
  const add = (state, parentId, segment, rank) => {
    const id = size++;
    const chunkIndex = Math.floor(id / FESS_STATE_CHUNK);
    const chunk = chunks[chunkIndex] || createChunk();
    const offset = id % FESS_STATE_CHUNK;
    const robot = board.dense.idByKey.get(pkey(state.robot[0], state.robot[1]));
    const cells = denseBoxLayout(state.boxes, board).cells;
    const [pathStart, pathLength] = appendPath(segment);
    chunk.robot[offset] = robot;
    chunk.boxes.set(cells, offset * boxCount);
    chunk.cost[offset] = state.cost;
    chunk.moves[offset] = state.moves;
    chunk.weight[offset] = state.weight;
    chunk.parent[offset] = parentId;
    chunk.pathStart[offset] = pathStart;
    chunk.pathLength[offset] = pathLength;
    chunk.rank[offset] = rank;
    chunk.packing[offset] = state.features.packing;
    chunk.connectivity[offset] = state.features.connectivity;
    chunk.roomConnectivity[offset] = state.features.roomConnectivity;
    chunk.outOfPlan[offset] = state.features.outOfPlan;
    chunk.mobility[offset] = state.features.mobility;
    chunk.estimate[offset] = state.features.estimate;
    chunk.queued[offset] = 1;
    return id;
  };
  const materialize = id => {
    const [chunk, offset] = locate(id);
    const boxOffset = offset * boxCount;
    const boxes = labels.map((label, index) => {
      const cell = chunk.boxes[boxOffset + index];
      return [board.dense.y[cell], board.dense.x[cell], label];
    });
    const robot = chunk.robot[offset];
    const packing = chunk.packing[offset];
    const connectivity = chunk.connectivity[offset];
    const roomConnectivity = chunk.roomConnectivity[offset];
    const outOfPlan = chunk.outOfPlan[offset];
    return {
      robot: [board.dense.y[robot], board.dense.x[robot]],
      boxes,
      cost: chunk.cost[offset],
      moves: chunk.moves[offset],
      weight: chunk.weight[offset],
      features: {
        packing,
        connectivity,
        roomConnectivity,
        outOfPlan,
        mobility: chunk.mobility[offset],
        estimate: chunk.estimate[offset],
        cell: `${packing}|${connectivity}|${roomConnectivity}|${outOfPlan}`,
      },
    };
  };
  const reconstruct = id => {
    const segments = [];
    for (let current = id; current >= 0;) {
      const [chunk, offset] = locate(current);
      const start = chunk.pathStart[offset], length = chunk.pathLength[offset];
      if (length) segments.push([start, length]);
      current = chunk.parent[offset];
    }
    const path = [];
    for (let index = segments.length - 1; index >= 0; index--) {
      const [start, length] = segments[index];
      for (let position = start; position < start + length; position++) {
        const chunkIndex = Math.floor(position / (FESS_PATH_CHUNK * 4));
        const packedOffset = position % (FESS_PATH_CHUNK * 4);
        const byte = pathChunks[chunkIndex][packedOffset >>> 2];
        const code = (byte >>> ((packedOffset & 3) * 2)) & 3;
        path.push(DIRECTION_ENTRIES[code][0]);
      }
    }
    return path;
  };
  const metadataBytes = 12 * 4 + 2 * 8 + 1;
  return {
    add,
    materialize,
    reconstruct,
    rank: id => {
      const [chunk, offset] = locate(id);
      return chunk.rank[offset];
    },
    moves: id => {
      const [chunk, offset] = locate(id);
      return chunk.moves[offset];
    },
    cost: id => {
      const [chunk, offset] = locate(id);
      return chunk.cost[offset];
    },
    estimate: id => {
      const [chunk, offset] = locate(id);
      return chunk.estimate[offset];
    },
    isQueued: id => {
      const [chunk, offset] = locate(id);
      return chunk.queued[offset] === 1;
    },
    markDequeued: id => {
      const [chunk, offset] = locate(id);
      chunk.queued[offset] = 0;
    },
    get size() { return size; },
    get pathBytes() { return Math.ceil(pathSize / 4); },
    get usedBytes() {
      return size * (metadataBytes + boxCount * 4) + Math.ceil(pathSize / 4);
    },
    get allocatedBytes() {
      return chunks.length * FESS_STATE_CHUNK * (metadataBytes + boxCount * 4) +
        pathChunks.length * FESS_PATH_CHUNK;
    },
  };
}

function fessSearch(payload) {
  const board = payload.preparedBoard || parse(payload.state);
  const initial = {
    robot: payload.state.robot,
    boxes: payload.state.boxes.map(([position, label]) => [
      ...position.split(",").map(Number), label,
    ]),
    cost: 0,
    moves: 0,
    weight: 0,
    node: null,
  };
  const context = {
    packingOrder: fessPackingOrder(board),
    doorwayTasks: assignmentDoorwayPlan(initial.boxes, board, true).tasks,
    accessMemo: new Map(),
  };
  const cells = new Map(), cellOrder = [];
  const transpositions = new Map();
  const advisorUses = new Map();
  const arena = createFessStateArena(board, initial.boxes);
  const maxVisited = payload.maxVisited ?? Infinity;
  const maxDepth = payload.maxDepth ?? Infinity;
  const macroPushes = payload.fessMacroPushes || 12;
  const macroExplored = payload.fessMacroExplored || 48;
  const macroResults = payload.fessMacroResults || 6;
  const progressInterval = payload.progressInterval || 500;
  const progressIntervalMs = payload.progressIntervalMs || 5000;
  let cursor = 0, order = 0, visited = 0, generated = 0;
  let cellVisits = 0, peakFrontier = 0, pendingActions = 0;
  let staleActions = 0, staleReplacements = 0, heapCompactions = 0;
  let lastProgressAt = now(), bestCheckpoint = null;

  const ensureCell = key => {
    if (!cells.has(key)) {
      cells.set(key, {key, actions: new FessActionHeap(), visits: 0});
      cellOrder.push(key);
    }
    return cells.get(key);
  };
  const checkpointRank = state =>
    (context.packingOrder.length - state.features.packing) * 100000 +
    state.features.outOfPlan * 10000 +
    state.features.roomConnectivity * 1000 +
    state.features.connectivity * 100 +
    state.features.estimate;
  const rememberCheckpoint = (stateId, state) => {
    const rank = checkpointRank(state);
    if (!bestCheckpoint || rank < bestCheckpoint.rank ||
        (rank === bestCheckpoint.rank && state.moves < bestCheckpoint.moves)) {
      bestCheckpoint = {stateId, rank, moves: state.moves};
    }
  };
  const compactHeaps = () => {
    let removed = 0;
    for (const cell of cells.values()) {
      removed += cell.actions.compact(stateId => arena.isQueued(stateId));
    }
    if (removed) {
      pendingActions -= removed;
      staleActions += removed;
      heapCompactions++;
    }
    staleReplacements = 0;
  };
  const enqueueActions = stateId => {
    const state = arena.materialize(stateId);
    const cell = ensureCell(state.features.cell);
    const reachable = reachablePaths(state, board);
    if (createsSealedCorralDeadlock(state, board, reachable)) return;
    state.features.accessBlockers = fessAccessBlockers(state.boxes, board, context);
    const assignment = cacheDiscoveryAssignmentDetail(state.boxes, board);
    const local = new Set();
    const candidates = [];
    for (const raw of pushNeighbors(state, board, reachable, {lockProven: false})) {
      const movedIndex = state.boxes.findIndex(
        ([y, x]) => pkey(y, x) === raw.pushedFrom,
      );
      const target = assignment.assignedTargets.get(movedIndex);
      const macros = payload.fessMacros === false
        ? [{...raw, pushes: 1}]
        : expandPushSequences(
          raw,
          board,
          macroPushes,
          macroExplored,
          macroResults,
          {lockProven: false},
        );
      for (const next of macros) {
        const child = {
          robot: next.robot,
          boxes: next.boxes,
          cost: state.cost + (next.pushes || 1),
          moves: state.moves + next.path.length,
          weight: state.weight,
          firstPushedFrom: raw.pushedFrom,
        };
        if (child.cost > maxDepth) continue;
        const childReachable = reachablePaths(child, board);
        if (createsSealedCorralDeadlock(child, board, childReachable)) continue;
        child.identity = pushIdentity(child, childReachable);
        if (local.has(child.identity)) continue;
        local.add(child.identity);
        child.features = fessFeatureValues(child, board, context, childReachable);
        if (!Number.isFinite(child.features.estimate)) continue;
        candidates.push({
          child,
          segment: next.path,
          signals: fessAdvisor(state, child, movedIndex, target, board),
        });
      }
    }
    const recommended = new Map();
    for (const candidate of candidates) {
      for (const [reason, value] of candidate.signals) {
        const previous = recommended.get(reason);
        if (!previous || value > previous.value ||
            (value === previous.value &&
              candidate.child.moves < previous.candidate.child.moves)) {
          recommended.set(reason, {candidate, value});
        }
      }
    }
    const recommendations = new Map();
    for (const [reason, choice] of recommended) {
      if (!recommendations.has(choice.candidate)) recommendations.set(choice.candidate, []);
      recommendations.get(choice.candidate).push(reason);
    }
    for (const candidate of candidates) {
        const {child, segment} = candidate;
        const progress = recommendations.get(candidate) || [];
        const advice = {weight: progress.length ? 0 : 1, progress};
        delete child.firstPushedFrom;
        child.weight += advice.weight;
        const rank = child.weight * 1e9 + child.moves * 1000 + order;
        const previous = transpositions.get(child.identity);
        const previousRank = previous === undefined ? Infinity : arena.rank(previous);
        if (rank >= previousRank) continue;
        if (previous !== undefined && arena.isQueued(previous)) {
          arena.markDequeued(previous);
          staleReplacements++;
        }
        for (const reason of advice.progress) {
          advisorUses.set(reason, (advisorUses.get(reason) || 0) + 1);
        }
        const childId = arena.add(child, stateId, segment, rank);
        transpositions.set(child.identity, childId);
        cell.actions.push(rank, childId);
        order++;
        generated++;
        pendingActions++;
    }
    peakFrontier = Math.max(peakFrontier, pendingActions);
    if (staleReplacements >= Math.max(1024, pendingActions >>> 2)) compactHeaps();
  };
  const nextAction = () => {
    if (!cellOrder.length) return null;
    let checked = 0;
    while (checked++ < cellOrder.length) {
      const key = cellOrder[cursor];
      cursor = (cursor + 1) % cellOrder.length;
      const cell = cells.get(key);
      while (cell.actions.length) {
        const action = cell.actions.pop();
        pendingActions--;
        if (!arena.isQueued(action.stateId)) {
          staleActions++;
          continue;
        }
        arena.markDequeued(action.stateId);
        cell.visits++;
        cellVisits++;
        return action;
      }
    }
    return null;
  };

  const initialReachable = reachablePaths(initial, board);
  initial.identity = pushIdentity(initial, initialReachable);
  initial.features = fessFeatureValues(initial, board, context, initialReachable);
  if (!Number.isFinite(initial.features.estimate)) {
    return {path: null, visited: 0, generated: 0, retained: 0, peakFrontier: 0};
  }
  const initialId = arena.add(initial, -1, [], 0);
  arena.markDequeued(initialId);
  transpositions.set(initial.identity, initialId);
  rememberCheckpoint(initialId, initial);
  if (goal(initial.boxes, board.goals)) {
    return {path: [], visited: 0, generated: 0, retained: 1, peakFrontier: 0,
      arenaStates: 1, compactArenaBytes: arena.usedBytes, compactPathBytes: 0,
      compactArenaAllocatedBytes: arena.allocatedBytes,
      strategy: "FESS"};
  }
  enqueueActions(initialId);

  while (visited < maxVisited) {
    const action = nextAction();
    if (!action) break;
    const {stateId} = action;
    const child = arena.materialize(stateId);
    visited++;
    rememberCheckpoint(stateId, child);
    if (goal(child.boxes, board.goals)) {
      return {
        path: arena.reconstruct(stateId),
        visited,
        generated,
        retained: visited + 1,
        peakFrontier,
        featureCells: cells.size,
        featureCellVisits: cellVisits,
        advisorUses: Object.fromEntries(advisorUses),
        arenaStates: arena.size,
        compactArenaBytes: arena.usedBytes,
        compactArenaAllocatedBytes: arena.allocatedBytes,
        compactPathBytes: arena.pathBytes,
        staleActions,
        heapCompactions,
        bestEstimate: 0,
        bestPushes: child.cost,
        bestMoves: child.moves,
        strategy: "FESS",
      };
    }
    enqueueActions(stateId);
    const currentTime = now();
    if (visited % progressInterval === 0 ||
        currentTime - lastProgressAt >= progressIntervalMs) {
      lastProgressAt = currentTime;
      postMessage({
        type: "progress",
        visited,
        generated,
        frontier: pendingActions,
        retained: arena.size,
        featureCells: cells.size,
        featureCellVisits: cellVisits,
        arenaStates: arena.size,
        compactArenaBytes: arena.usedBytes,
        compactArenaAllocatedBytes: arena.allocatedBytes,
        compactPathBytes: arena.pathBytes,
        staleActions,
        heapCompactions,
        bestEstimate: bestCheckpoint === null
          ? undefined : arena.estimate(bestCheckpoint.stateId),
        bestPushes: bestCheckpoint === null
          ? undefined : arena.cost(bestCheckpoint.stateId),
        bestMoves: bestCheckpoint?.moves,
        performance: performanceSnapshot(board.metrics),
      });
    }
  }
  const checkpointState = bestCheckpoint === null
    ? null : arena.materialize(bestCheckpoint.stateId);
  return {
    path: null,
    visited,
    generated,
    retained: visited + 1,
    peakFrontier,
    featureCells: cells.size,
    featureCellVisits: cellVisits,
    advisorUses: Object.fromEntries(advisorUses),
    arenaStates: arena.size,
    compactArenaBytes: arena.usedBytes,
    compactArenaAllocatedBytes: arena.allocatedBytes,
    compactPathBytes: arena.pathBytes,
    staleActions,
    heapCompactions,
    bestEstimate: bestCheckpoint === null
      ? undefined : arena.estimate(bestCheckpoint.stateId),
    bestPushes: bestCheckpoint === null
      ? undefined : arena.cost(bestCheckpoint.stateId),
    bestMoves: bestCheckpoint?.moves,
    checkpoint: checkpointState && {
      state: {
        rows: board.rows,
        robot: checkpointState.robot,
        boxes: checkpointState.boxes.map(([y, x, label]) => [pkey(y, x), label]),
      },
      path: arena.reconstruct(bestCheckpoint.stateId),
      cost: checkpointState.cost,
      estimate: checkpointState.features.estimate,
    },
    cutoff: visited >= maxVisited,
    terminationReason: visited >= maxVisited ? "state-budget" : "feature-space-exhausted",
  };
}

function canonicalFessSearch(payload) {
  if (payload.fessCanonicalOrientation === false) return fessSearch(payload);
  const canonical = canonicalPlanTransform(payload.state);
  if (canonical.transform.id === "identity") {
    return {...fessSearch(payload), fessOrientation: "identity"};
  }
  const result = fessSearch({
    ...payload,
    preparedBoard: undefined,
    state: {
      ...payload.state,
      rows: canonical.rows,
      robot: canonical.robot,
      boxes: canonical.boxes,
      preparedBoard: undefined,
    },
  });
  return {
    ...result,
    path: result.path?.map(move => transformPlanMove(
      move,
      canonical.transform,
      canonical.height,
      canonical.width,
      true,
    )),
    checkpoint: restorePlanCheckpoint(result.checkpoint, canonical, payload.state.rows),
    fessOrientation: canonical.transform.id,
  };
}

function planMacroBeamSearch(payload) {
  const board = payload.preparedBoard || parse(payload.state);
  board.reachabilityMemoLimit = payload.reachabilityMemoLimit ?? REACHABILITY_MEMO_LIMIT;
  const initial = {
    robot: payload.state.robot,
    boxes: payload.state.boxes.map(([position, label]) => [
      ...position.split(",").map(Number), label,
    ]),
    cost: 0,
    moves: 0,
    node: null,
  };
  const width = payload.planBeamWidth || payload.beamWidth || 80;
  const maxSegments = payload.maxPlanSegments || 80;
  const maxVisited = payload.maxVisited || 20000;
  const maxGenerated = payload.maxGenerated ?? Infinity;
  const maxPushes = payload.maxDepth || 320;
  const solutionComparisonBudget = payload.planSolutionComparisonBudget ?? 96;
  const boxBranchLimit = payload.planBoxBranches || 8;
  const macroLimit = payload.sequenceMacroLimit || 24;
  const macroExplored = payload.sequenceMacroExplored || 64;
  const macroResults = payload.sequenceMacroResults || 5;
  const seen = new BoundedDepthMap(payload.transpositionLimit || 60000);
  const seenExact = new BoundedDepthMap(payload.transpositionLimit || 60000);
  let beam = [initial], visited = 0, generated = 0, peakFrontier = 1;
  let trackedThrough = payload.trackedSignatures ? 0 : undefined;
  const rootDoorwayTasks = payload.planDoorwaySchedule === false
    ? [] : assignmentDoorwayPlan(initial.boxes, board, true).tasks;
  const hasEvacuationPlan = rootDoorwayTasks.some(task => task.direction === "export");
  const analysisCache = new WeakMap();
  const structuralAnalysis = (boxes, includeGoalAccess = false) => {
    if (payload.planAnalysisCache === false) {
      return {
        estimate: discoveryHeuristic(boxes, board),
        evacuation: roomEvacuationPenalty(boxes, board),
        doorwaySchedule: doorwayScheduleState(boxes, board, rootDoorwayTasks),
        goalAccess: includeGoalAccess ? goalAccessAnalysis(boxes, board) : null,
      };
    }
    let analysis = analysisCache.get(boxes);
    if (analysis) {
      if (activePerformance) activePerformance.planAnalysisCacheHits++;
    } else {
      if (activePerformance) activePerformance.planAnalysisCacheMisses++;
      analysis = {
        estimate: discoveryHeuristic(boxes, board),
        evacuation: roomEvacuationPenalty(boxes, board),
        doorwaySchedule: doorwayScheduleState(boxes, board, rootDoorwayTasks),
        goalAccess: null,
      };
      analysisCache.set(boxes, analysis);
    }
    if (includeGoalAccess && !analysis.goalAccess) {
      analysis.goalAccess = goalAccessAnalysis(boxes, board);
    }
    return analysis;
  };
  const evaluateDoorwaySchedule = boxes =>
    structuralAnalysis(boxes).doorwaySchedule;
  let bestEstimate = structuralAnalysis(initial.boxes).estimate, bestPushes = 0;
  let bestMoves = 0;
  const planBound = Math.min(
    Number.isFinite(payload.upperBound) ? payload.upperBound : Infinity,
    bestEstimate + (payload.planSlack ?? 192),
  );
  let bestCheckpoint = null, bestCheckpointRank = Infinity;
  let bestHeuristicCheckpoint = null;
  const importAccessBlockers = (state, reachable) => {
    const blockers = new Map();
    if (!state.doorwaySchedule.blockedImportAccess) return blockers;
    const routes = minimumBlockerRoutes(reachable, board);
    const occupied = new Set(state.boxes.map(([y, x]) => pkey(y, x)));
    for (const task of rootDoorwayTasks.filter(task => task.direction === "import")) {
      const room = board.topology.rooms[task.roomIndex];
      const [y, x, label] = state.boxes[task.boxIndex];
      const position = pkey(y, x);
      if (room.cells.has(position)) continue;
      const currentDistance = playerAwarePushDistances(board, position).get(room.gate);
      const options = [];
      for (const [, [dy, dx]] of DIRECTION_ENTRIES) {
        const destination = pkey(y + dy, x + dx);
        const support = pkey(y - dy, x - dx);
        if (!board.floor.has(destination) || occupied.has(destination) ||
            staticDead(y + dy, x + dx, board, label)) continue;
        const nextDistance = playerAwarePushDistances(board, destination).get(room.gate);
        if (nextDistance >= currentDistance) continue;
        const candidateBoxes = state.boxes.slice();
        candidateBoxes[task.boxIndex] = [y + dy, x + dx, label];
        if (createsDynamicDeadlock(candidateBoxes, board, [y + dy, x + dx])) {
          state.boxes.forEach(([boxY, boxX], index) => {
            if (index === task.boxIndex) return;
            if (Math.abs(boxY - (y + dy)) <= 1 && Math.abs(boxX - (x + dx)) <= 1) {
              const blocker = pkey(boxY, boxX);
              blockers.set(blocker, (blockers.get(blocker) || 0) + 1);
            }
          });
          continue;
        }
        const route = routes.routeTo(board.dense.idByKey.get(support) ?? -1);
        if (route) options.push(route);
      }
      const minimum = Math.min(...options.map(option => option.blockerCount));
      for (const option of options.filter(candidate => candidate.blockerCount === minimum)) {
        for (const blocker of option.blockers) {
          blockers.set(blocker, (blockers.get(blocker) || 0) + 1);
        }
      }
    }
    return blockers;
  };
  const scoreCandidate = child => {
    const analysis = structuralAnalysis(child.boxes, true);
    child.estimate = analysis.estimate;
    child.goalAccess = child.macroContext?.goalAccess || analysis.goalAccess;
    child.evacuation = analysis.evacuation;
    child.doorwaySchedule = child.macroContext?.doorwaySchedule ||
      analysis.doorwaySchedule;
    const evacuationActive = child.doorwaySchedule.pendingExports > 0 ||
      child.doorwaySchedule.stagingBlockers > 0 ||
      child.doorwaySchedule.blockedImportAccess > 0;
    const evacuationComplete = hasEvacuationPlan &&
      child.doorwaySchedule.pendingExports === 0;
    child.score = child.cost + (payload.planMoveWeight ?? 0.005) * child.moves +
      (evacuationActive ? 0.25 : 1.15) * child.estimate +
      4 * child.goalAccess.penalty + 0.08 * child.evacuation +
      (evacuationActive ? 4 : 3) * child.doorwaySchedule.penalty -
      (evacuationComplete ? 250 : 0);
    return child;
  };
  const checkpointRank = child => {
    const schedule = child.doorwaySchedule;
    const unsafe = schedule.prematureImports + schedule.gateBlockers +
      schedule.crossingConflicts + schedule.strandedExports +
      schedule.packingOrderViolations;
    const remaining = schedule.pendingExports + schedule.remainingImports +
      schedule.unpackedImports;
    const evacuationComplete = hasEvacuationPlan && schedule.pendingExports === 0;
    return 1000 * unsafe + 100 * remaining -
      (evacuationComplete ? 200 : 0) +
      50 * schedule.blockedImportAccess + 20 * schedule.stagingBlockers +
      2 * child.cost + child.estimate + 4 * child.goalAccess.penalty;
  };
  initial.exactIdentity = exactPushIdentity(initial, board);
  initial.goalAccess = structuralAnalysis(initial.boxes, true).goalAccess;
  initial.doorwaySchedule = evaluateDoorwaySchedule(initial.boxes);
  seenExact.set(initial.exactIdentity, 0);

  for (let segment = 0;
    segment < maxSegments && beam.length &&
      visited < maxVisited && generated < maxGenerated;
    segment++) {
    const candidates = new Map();
    let layerSolution = null;
    let layerSolutionGeneratedAt = null, layerSolutionCandidates = 0;
    const expansionBeam = bestEstimate <= 20
      ? [...beam].sort((left, right) =>
          left.estimate - right.estimate ||
          left.moves - right.moves ||
          left.score - right.score)
      : beam;
    layerExpansion:
    for (const current of expansionBeam) {
      if (visited++ >= maxVisited) break;
      const reachable = reachablePaths(current, board);
      if (createsSealedCorralDeadlock(current, board, reachable)) continue;
      const accessBlockers = importAccessBlockers(current, reachable);
      const firstPushes = pushNeighbors(current, board, reachable);
      const rankedFirst = firstPushes.map(next => {
        const analysis = structuralAnalysis(next.boxes);
        const estimate = analysis.estimate;
        const accessDelta = goalAccessDelta(current.goalAccess, current, next, board);
        const evacuation = analysis.evacuation;
        const schedule = analysis.doorwaySchedule;
        const blockerProgress = accessBlockers.get(next.pushedFrom) || 0;
        const estimateWeight = current.doorwaySchedule.pendingExports ||
          current.doorwaySchedule.stagingBlockers ||
          current.doorwaySchedule.blockedImportAccess ? 0.25 : 1;
        const completesEvacuation = hasEvacuationPlan &&
          current.doorwaySchedule.pendingExports > 0 &&
          schedule.pendingExports === 0;
        return {
          next,
          score: estimateWeight * estimate + 5 * accessDelta + 0.08 * evacuation +
            4 * (schedule.penalty - current.doorwaySchedule.penalty) -
            (completesEvacuation ? 250 : 0) - 12 * blockerProgress,
        };
      }).sort((left, right) => left.score - right.score);
      const selectedBoxes = new Set(), selectedFirst = [];
      for (const candidate of rankedFirst) {
        if (selectedBoxes.has(candidate.next.pushedFrom)) continue;
        selectedBoxes.add(candidate.next.pushedFrom);
        selectedFirst.push(candidate.next);
        if (selectedBoxes.size >= boxBranchLimit) break;
      }
      for (const candidate of rankedFirst) {
        if (selectedFirst.length >= boxBranchLimit + 2) break;
        if (selectedFirst.includes(candidate.next)) continue;
        selectedFirst.push(candidate.next);
      }
      for (let firstIndex = 0; firstIndex < selectedFirst.length; firstIndex++) {
        const first = selectedFirst[firstIndex];
        const movedIndex = current.boxes.findIndex(([y, x]) =>
          pkey(y, x) === first.pushedFrom);
        const doorwayTask = rootDoorwayTasks.find(task => task.boxIndex === movedIndex);
        const doorwayRoom = doorwayTask
          ? board.topology.rooms[doorwayTask.roomIndex] : null;
        const currentPosition = movedIndex >= 0
          ? pkey(current.boxes[movedIndex][0], current.boxes[movedIndex][1]) : null;
        const crossingComplete = doorwayTask?.direction === "export"
          ? !doorwayRoom.cells.has(currentPosition) && currentPosition !== doorwayRoom.gate
          : doorwayTask?.direction === "import"
            ? doorwayRoom.cells.has(currentPosition)
            : false;
        const clearingStaging = doorwayTask &&
          current.doorwaySchedule.stagingBlockers > 0 &&
          doorwayRoom.exteriorStaging.has(currentPosition);
        const assignedTarget = doorwayTask?.target ||
          cacheDiscoveryAssignmentDetail(
            current.boxes,
            board,
          ).assignedTargets.get(movedIndex);
        const objective = clearingStaging
          ? {direction: "clear", roomIndex: doorwayTask.roomIndex}
          : doorwayTask && !crossingComplete
            ? doorwayTask : assignedTarget ? {target: assignedTarget} : null;
        const sameBoxDirections = rankedFirst.filter(candidate =>
          candidate.next.pushedFrom === first.pushedFrom).length;
        const ambiguity = sameBoxDirections +
          Number(Boolean(doorwayTask)) +
          Number(current.doorwaySchedule.crossingConflicts > 0) +
          Number(current.doorwaySchedule.stagingBlockers > 0);
        const forcedMacro = current.boxes.length <= 4 &&
          sameBoxDirections === 1 &&
          board.topology.tunnels.has(first.pushedTo);
        const cheapExplored = ambiguity <= 2 ? 16 : 32;
        const cheapResults = macroResults;
        const fullExplored = objective
          ? payload.targetedMacroExplored || Math.max(96, macroExplored)
          : macroExplored;
        const movedPosition = sequence =>
          pkey(sequence.boxes[movedIndex][0], sequence.boxes[movedIndex][1]);
        const intermediateGuard = sequence => {
          if (!doorwayTask && !assignedTarget) return false;
          const position = movedPosition(sequence);
          const crossedDoorway = doorwayTask?.direction === "export"
            ? (doorwayRoom.cells.has(currentPosition) ||
                currentPosition === doorwayRoom.gate) &&
              !doorwayRoom.cells.has(position) && position !== doorwayRoom.gate
            : doorwayTask?.direction === "import" &&
              !doorwayRoom.cells.has(currentPosition) &&
              doorwayRoom.cells.has(position);
          const objectiveComplete = position === assignedTarget ||
            crossedDoorway ||
            (clearingStaging && !doorwayRoom.exteriorStaging.has(position) &&
              position !== doorwayRoom.gate);
          if (!objectiveComplete) return false;
          let analysis = structuralAnalysis(sequence.boxes);
          const doorwaySchedule = analysis.doorwaySchedule;
          if (payload.planEgressGuard !== false &&
              doorwayTask?.direction === "import" &&
              doorwaySchedule.strandedExports >
                current.doorwaySchedule.strandedExports) {
            sequence.macroContext = {doorwaySchedule};
            return "stranded-export";
          }
          analysis = structuralAnalysis(sequence.boxes, true);
          sequence.macroContext = {
            doorwaySchedule,
            goalAccess: analysis.goalAccess,
          };
          return false;
        };
        const expand = (explored, results) => objective
          ? expandTargetedPushSequence(
            first, board, objective, macroLimit, explored, results,
            {lockProven: false, intermediateGuard:
              payload.incrementalMacroGuard === false ? undefined : intermediateGuard,
            targetBound: payload.targetedMacroBound !== false},
          )
          : expandPushSequences(
            first, board, macroLimit, explored, results,
            {lockProven: false, intermediateGuard:
              payload.incrementalMacroGuard === false ? undefined : intermediateGuard},
          );
        let expanded;
        if (payload.adaptiveMacroEffort === false) {
          if (activePerformance) activePerformance.macroFullExpansions++;
          expanded = expand(fullExplored, macroResults);
        } else if (!forcedMacro) {
          if (activePerformance) activePerformance.macroFullExpansions++;
          expanded = expand(fullExplored, macroResults);
        } else {
          if (activePerformance) activePerformance.macroCheapExpansions++;
          expanded = expand(Math.min(cheapExplored, fullExplored), cheapResults);
          const cheapEndpoints = expanded.filter(next => next.pushes > 1);
          if (fullExplored > cheapExplored &&
              cheapEndpoints.length === 0) {
            if (activePerformance) {
              activePerformance.macroWidenings++;
              activePerformance.macroFullExpansions++;
            }
            expanded = expand(fullExplored, macroResults);
          }
        }
        const endpoints = expanded.filter(next => next.pushes > 1);
        const successors = endpoints.length
          ? (firstIndex < 2 ? [expanded[0], ...endpoints] : endpoints)
          : expanded;
        for (const next of successors) {
          if (next.macroRejectedReason) continue;
          const cost = current.cost + next.pushes;
          if (cost > maxPushes) continue;
          const child = {
            robot: next.robot,
            boxes: next.boxes,
            cost,
            moves: current.moves + next.path.length,
            node: {parent: current.node, segment: next.path},
            pushClass: next.pushClass,
            macroContext: next.macroContext,
          };
          child.exactIdentity = exactPushIdentity(child, board);
          if ((seenExact.get(child.exactIdentity) ?? Infinity) <= cost) continue;
          scoreCandidate(child);
          if (payload.planEgressGuard !== false &&
              doorwayTask?.direction === "import" &&
              child.doorwaySchedule.strandedExports >
                current.doorwaySchedule.strandedExports) continue;
          if (payload.planEgressGuard !== false &&
              child.doorwaySchedule.packingOrderViolations >
                current.doorwaySchedule.packingOrderViolations) continue;
          if (payload.planGoalAccessGuard !== false) {
            const blockedBefore = new Set(
              current.goalAccess.blockedGoals.map(goalState => goalState.goal),
            );
            if (child.goalAccess.blockedGoals.some(goalState =>
              !blockedBefore.has(goalState.goal))) continue;
          }
          if (payload.planEgressGuard !== false && assignedTarget) {
            const [movedY, movedX] = child.boxes[movedIndex];
            const movedPosition = pkey(movedY, movedX);
            if (movedPosition !== assignedTarget) {
              const crossedDoorway = doorwayTask?.direction === "export"
                ? (doorwayRoom.cells.has(currentPosition) ||
                    currentPosition === doorwayRoom.gate) &&
                  !doorwayRoom.cells.has(movedPosition) &&
                  movedPosition !== doorwayRoom.gate
                : doorwayTask?.direction === "import" &&
                  !doorwayRoom.cells.has(currentPosition) &&
                  doorwayRoom.cells.has(movedPosition);
              const childReachable = reachablePaths(child, board);
              if (!crossedDoorway && !pushBoxNeighbors(
                child,
                board,
                movedPosition,
                childReachable,
                {lockProven: false},
              ).length) continue;
            }
          }
          if (!Number.isFinite(child.estimate)) continue;
          if (child.cost + child.estimate > planBound) continue;
          generated++;
          const solvedChild = goal(child.boxes, board.goals);
          if (solvedChild) {
            layerSolutionCandidates++;
            layerSolutionGeneratedAt ??= generated;
            if (!layerSolution || child.moves < layerSolution.moves) {
              layerSolution = child;
            }
          }
          if (layerSolution &&
              generated - layerSolutionGeneratedAt >= solutionComparisonBudget) {
            break layerExpansion;
          }
          if (generated >= maxGenerated) {
            break layerExpansion;
          }
          if (solvedChild) continue;
          const existing = candidates.get(child.exactIdentity);
          if (!existing || child.score < existing.score) {
            candidates.set(child.exactIdentity, child);
          }
          if (child.estimate < bestEstimate ||
              (child.estimate === bestEstimate && child.moves < bestMoves)) {
            bestEstimate = child.estimate;
            bestPushes = cost;
            bestMoves = child.moves;
            bestHeuristicCheckpoint = child;
          }
          const childCheckpointRank = checkpointRank(child);
          child.planCheckpointRank = childCheckpointRank;
          if (childCheckpointRank < bestCheckpointRank) {
            bestCheckpointRank = childCheckpointRank;
            bestCheckpoint = child;
          }
        }
      }
    }
    if (layerSolution) {
      return {
        path: reconstructNodePath(layerSolution.node),
        visited,
        generated,
        retained: seen.size + seenExact.size,
        peakFrontier,
        bestEstimate: 0,
        bestPushes: layerSolution.cost,
        bestMoves: layerSolution.moves,
        solutionCandidates: layerSolutionCandidates,
        solutionComparisonStates: generated - layerSolutionGeneratedAt,
        strategy: "Plan Macro Beam",
      };
    }
    peakFrontier = Math.max(peakFrontier, candidates.size);
    const eligible = [];
    for (const child of selectPlanLayer(candidates.values(), width * 2, board)) {
      const reachable = reachablePaths(child, board);
      if (createsSealedCorralDeadlock(child, board, reachable)) continue;
      child.identity = pushIdentity(child, reachable);
      if ((seen.get(child.identity) ?? Infinity) <= child.cost) continue;
      child.signature = pushKey(child, reachable);
      eligible.push(child);
    }
    beam = selectPlanLayer(eligible, width, board);
    for (const child of beam) {
      seen.set(child.identity, child.cost);
      seenExact.set(child.exactIdentity, child.cost);
      if (payload.trackedSignatures?.[child.cost] === child.signature) {
        trackedThrough = Math.max(trackedThrough, child.cost);
      }
    }
    if ((segment + 1) % 2 === 0) {
      postMessage({
        type: "progress",
        visited,
        bestEstimate,
        bestPushes,
        bestMoves,
        depth: segment + 1,
        frontier: beam.length,
        generated,
        retained: seen.size + seenExact.size,
        performance: performanceSnapshot(board.metrics),
      });
    }
  }
  const checkpoint = serializeSearchCheckpoint(bestCheckpoint, board);
  const heuristicCheckpoint = serializeSearchCheckpoint(bestHeuristicCheckpoint, board);
  const checkpoints = [checkpoint];
  if (heuristicCheckpoint &&
      (!checkpoint || heuristicCheckpoint.cost !== checkpoint.cost ||
        heuristicCheckpoint.estimate !== checkpoint.estimate)) {
    checkpoints.push(heuristicCheckpoint);
  }
  return {
    path: null,
    visited,
    generated,
    retained: seen.size + seenExact.size,
    peakFrontier,
    bestEstimate,
    bestPushes,
    bestMoves,
    trackedThrough,
    checkpoint,
    checkpoints: checkpoints.filter(Boolean),
    cutoff: true,
    terminationReason: visited >= maxVisited ? "state-budget" :
      generated >= maxGenerated ? "generated-budget" : "plan-frontier-exhausted",
  };
}

function beamSearch(payload) {
  const board = payload.preparedBoard || parse(payload.state);
  const initial = {
    robot: payload.state.robot,
    boxes: payload.state.boxes.map(([position, label]) => [
      ...position.split(",").map(Number), label,
    ]),
    cost: 0,
  };
  const width = payload.beamWidth || 3000;
  const maxDepth = payload.maxDepth || 500;
  const maxVisited = payload.maxVisited ?? Infinity;
  const maxGenerated = payload.maxGenerated ?? Infinity;
  const weight = payload.weight ?? 3;
  const diversity = payload.diversity ?? 1.5;
  const goalPackingWeight = payload.goalPackingWeight ?? 0.8;
  const mobilityWeight = payload.mobilityWeight ?? 0.03;
  const topologyWeight = payload.topologyWeight ?? 0.7;
  const evacuationWeight = payload.evacuationWeight ?? 0;
  const supportDependencyWeight = payload.supportDependencyWeight ?? 0.8;
  const localRoomWeight = payload.localRoomWeight ?? 0.6;
  const doorwayFlowWeight = payload.doorwayFlowWeight ?? 0.35;
  const lockProvenCommitments = payload.lockProvenCommitments !== false;
  const beamProfile = payload.beamProfile || "balanced";
  const seed = payload.seed || 0;
  const transpositionLimit = payload.transpositionLimit || Math.max(12000, width * 60);
  const seenDepth = new BoundedDepthMap(transpositionLimit);
  const seenExactDepth = new BoundedDepthMap(Math.max(8000, Math.floor(transpositionLimit / 2)));
  const handoffLimit = payload.checkpointLimit || 12;
  const progressInterval = payload.progressInterval || 5000;
  const progressIntervalMs = payload.progressIntervalMs || 5000;
  const handoffCheckpoints = new Map();
  let visited = 0, reported = 0, bestEstimate = Infinity, bestPushes = 0;
  let generated = 0, peakFrontier = 1;
  let lastProgressAt = now();
  let beamCutoff = false;
  let bestCheckpoint = null;
  let bestHandoff = null;
  let phaseHandoff = null;
  const endgameCheckpoints = [];
  let trackedThrough = payload.trackedSignatures ? 0 : undefined;
  const childDoorwayGate = createOrderingProductivityGate(
    payload.strategicSignalWarmup || 64,
    payload.strategicSignalCooldown || 512,
  );
  const childPackingGate = createOrderingProductivityGate(
    payload.strategicSignalWarmup || 64,
    payload.strategicSignalCooldown || 512,
  );
  if (maxVisited <= 0 || maxGenerated <= 0) {
    return {
      path: null,
      visited: 0,
      generated: 0,
      retained: 0,
      peakFrontier: 0,
      cutoff: true,
      terminationReason:
        maxVisited <= 0 ? "state-budget" : "generated-budget",
    };
  }

  initial.reachable = reachablePaths(initial, board);
  if (createsSealedCorralDeadlock(initial, board, initial.reachable)) {
    return {path: null, visited};
  }
  initial.identity = pushIdentity(initial, initial.reachable);
  initial.signature = pushKey(initial, initial.reachable);
  initial.strategicHistory = "";
  initial.openingHistory = "";
  const initialEstimate = heuristic(initial.boxes, board);
  if (!Number.isFinite(initialEstimate)) return {path: null, visited};
  bestEstimate = initialEstimate;
  seenDepth.set(initial.identity, 0);
  let beam = [initial];

  searchLayers: for (let depth = 0; beam.length && depth <= maxDepth; depth++) {
    const candidates = new Map();
    for (const current of beam) {
      visited++;
      if (goal(current.boxes, board.goals)) {
        return {
          path: reconstructNodePath(current.node),
          visited,
          generated,
          retained: seenDepth.size,
          peakFrontier,
          transpositionEvictions: seenDepth.evictions + seenExactDepth.evictions,
        };
      }
      if (visited >= maxVisited) {
        beamCutoff = true;
        break searchLayers;
      }
      const dependencyGraph = supportDependencyGraph(current, board, current.reachable);
      const localRooms = [
        ...exactLocalRoomAnalyses(current, board, current.reachable),
        ...exactLocalCorralAnalyses(current, board, current.reachable),
      ];
      const doorwayBefore = typedDoorwayFlow(current.boxes, board);
      const goalAccessBefore = payload.goalAccessOrdering === false
        ? null : goalAccessAnalysis(current.boxes, board);
      const currentCommitments = lockProvenCommitments ? goalCommitments(current.boxes, board, {
        doorway: doorwayBefore,
        supportDependency: dependencyGraph,
        localAnalyses: localRooms,
      }) : null;
      for (const rawNext of pushNeighbors(
        current,
        board,
        current.reachable,
        {commitments: currentCommitments},
      )) {
        const expansions = payload.straightMacros
          ? expandStraightPushes(
              rawNext,
              board,
              payload.straightMacroLimit || 8,
              {lockProven: lockProvenCommitments},
            )
          : payload.sequenceMacros
          ? expandPushSequences(
              rawNext,
              board,
              payload.sequenceMacroLimit || 12,
              payload.sequenceMacroExplored || 48,
              payload.sequenceMacroResults || 8,
              {lockProven: lockProvenCommitments},
            )
          : [expandPushMacro(
              rawNext,
              board,
              payload.forcedMacros !== false,
              {lockProven: lockProvenCommitments},
            )].filter(Boolean);
        for (const next of expansions) {
        const child = {robot: next.robot, boxes: next.boxes, cost: current.cost + next.pushes};
        if (child.cost > maxDepth) continue;
        if (payload.upperBound && child.cost > payload.upperBound) continue;
        if (goal(child.boxes, board.goals)) {
          return {
            path: [...reconstructNodePath(current.node), ...next.path],
            visited,
            generated: generated + candidates.size + 1,
            retained: seenDepth.size,
            peakFrontier: Math.max(peakFrontier, beam.length, candidates.size + 1),
            transpositionEvictions: seenDepth.evictions + seenExactDepth.evictions,
          };
        }
        child.exactIdentity = exactPushIdentity(child, board);
        if ((seenExactDepth.get(child.exactIdentity) ?? Infinity) <= child.cost) continue;
        const estimate = heuristic(child.boxes, board);
        if (!Number.isFinite(estimate)) continue;
        if (payload.upperBound && child.cost + estimate > payload.upperBound) continue;
        const previousBestEstimate = bestEstimate;
        if (estimate < bestEstimate) {
          bestEstimate = estimate;
          bestPushes = child.cost;
        }
        const topology = topologyPenalty(child.boxes, board);
        const dependencyDelta = supportDependencyDelta(dependencyGraph, next);
        const localRoomDelta = localRoomOrderingDelta(localRooms, next);
        const evaluateDoorway = childDoorwayGate.shouldEvaluate();
        const evaluatePacking = childPackingGate.shouldEvaluate();
        const doorway = evaluateDoorway || evaluatePacking
          ? typedDoorwayFlow(child.boxes, board)
          : doorwayBefore;
        const packing = evaluatePacking ? goalPackingBonus(child.boxes, board, {
          doorway,
          supportDependency: dependencyGraph,
          localAnalyses: localRooms,
          transition: next,
        }) : 0;
        const usefulSignal = estimate < previousBestEstimate ||
          goal(child.boxes, board.goals);
        for (const [gate, evaluated] of [
          [childDoorwayGate, evaluateDoorway],
          [childPackingGate, evaluatePacking],
        ]) {
          if (evaluated) {
            board.metrics.strategicSignalEvaluations++;
            gate.observe({changed: true, useful: usefulSignal});
            if (usefulSignal) board.metrics.strategicSignalUseful++;
          } else {
            board.metrics.strategicSignalSkips++;
          }
        }
        const doorwayDelta = doorwayFlowDelta(doorwayBefore, current, next);
        const relevance = relevanceOrderingScore(current, board, next, {
          supportDependency: dependencyGraph,
          doorway: doorwayBefore,
          goalAccess: goalAccessBefore,
          recentPush: current.recentPush,
        });
        const relevanceScore = recordRelevanceOrdering(board.metrics, relevance);
        const evacuation = evacuationWeight
          ? roomEvacuationPenalty(child.boxes, board)
          : 0;
        if (beamProfile === "milestone") {
          const transition = roomTransitionEvent(current.boxes, child.boxes, board);
          child.strategicHistory = transition
            ? `${current.strategicHistory || ""}>${transition}`.split(">").slice(-4).join(">")
            : current.strategicHistory || "";
          child.openingHistory = child.cost <= 10
            ? `${current.openingHistory || ""}/${next.pushClass}`
            : current.openingHistory || "";
        }
        const score = (payload.costWeight ?? 0) * child.cost +
          weight * estimate + topologyWeight * topology +
          evacuationWeight * evacuation -
          goalPackingWeight * packing +
          supportDependencyWeight * dependencyDelta +
          localRoomWeight * localRoomDelta +
          doorwayFlowWeight *
            (0.2 * (evaluateDoorway ? doorway.penalty : doorwayBefore.penalty) +
              doorwayDelta) +
          (payload.relevanceWeight ?? 0.6) * relevanceScore +
          diversity * signatureNoise(child.exactIdentity, seed);
        const exploreScore = topologyWeight * topology + evacuationWeight * evacuation -
          goalPackingWeight * packing +
          supportDependencyWeight * dependencyDelta +
          localRoomWeight * localRoomDelta +
          doorwayFlowWeight *
            (0.2 * (evaluateDoorway ? doorway.penalty : doorwayBefore.penalty) +
              doorwayDelta) +
          (payload.relevanceWeight ?? 0.6) * relevanceScore +
          diversity * signatureNoise(child.exactIdentity, seed + 7919);
        const existing = candidates.get(child.exactIdentity);
        if (!existing || score < existing.score) {
          if (!existing && generated + candidates.size >= maxGenerated) {
            generated += candidates.size;
            beamCutoff = true;
            break searchLayers;
          }
          const candidate = {
            ...child,
            node: {parent: current.node || null, segment: next.path},
            estimate,
            topology,
            evacuation,
            packing,
            dependencyDelta,
            relevance: relevance.signals,
            localRoomDelta,
            doorway: doorway.penalty,
            doorwayDelta,
            score,
            exploreScore,
            pushClass: next.pushClass,
            strategicClass: beamProfile === "milestone"
              ? `${child.openingHistory}|${child.strategicHistory}|${roomFlowSignature(child.boxes, board)}`
              : null,
            strategicHistory: child.strategicHistory,
            openingHistory: child.openingHistory,
            recentPush: {pushedFrom: next.pushedFrom, pushedTo: next.pushedTo},
          };
          candidates.set(child.exactIdentity, candidate);
          if (!bestCheckpoint || estimate < bestCheckpoint.estimate ||
              (estimate === bestCheckpoint.estimate && child.cost < bestCheckpoint.cost)) {
            bestCheckpoint = candidate;
          }
          if ((payload.endgameVisited || payload.continuationVisited) &&
              estimate <= (payload.endgameThreshold || 60)) {
            const solvedGoals = candidate.boxes
              .filter(([y, x, label]) => board.goals.get(pkey(y, x)) === label)
              .map(([y, x, label]) => `${y},${x},${label}`)
              .sort()
              .join(";");
            candidate.checkpointClass =
              `${roomFlowSignature(candidate.boxes, board)}|${solvedGoals}|${next.pushClass}`;
            candidate.checkpointBand = Math.floor(estimate / 10);
            const existingCheckpoint = endgameCheckpoints.findIndex(checkpoint =>
              checkpoint.checkpointClass === candidate.checkpointClass);
            if (existingCheckpoint >= 0) {
              if (candidate.estimate >= endgameCheckpoints[existingCheckpoint].estimate) continue;
              endgameCheckpoints.splice(existingCheckpoint, 1);
            }
            endgameCheckpoints.push(candidate);
            endgameCheckpoints.sort((left, right) =>
              left.estimate - right.estimate ||
              (left.cost + left.estimate) - (right.cost + right.estimate) ||
              left.cost - right.cost);
            if (endgameCheckpoints.length > (payload.endgameCandidates || 24)) {
              const bandCounts = new Map();
              endgameCheckpoints.forEach(checkpoint => bandCounts.set(
                checkpoint.checkpointBand,
                (bandCounts.get(checkpoint.checkpointBand) || 0) + 1,
              ));
              let crowdedBand = null, crowdedCount = 0;
              for (const [band, count] of bandCounts) {
                if (count > crowdedCount || (count === crowdedCount && band < crowdedBand)) {
                  crowdedBand = band;
                  crowdedCount = count;
                }
              }
              for (let remove = endgameCheckpoints.length - 1; remove >= 0; remove--) {
                if (endgameCheckpoints[remove].checkpointBand !== crowdedBand) continue;
                endgameCheckpoints.splice(remove, 1);
                break;
              }
            }
          }
        }
        }
      }
      const progressNow = now();
      if (visited - reported >= progressInterval ||
          progressNow - lastProgressAt >= progressIntervalMs) {
        postMessage({type: "progress", visited: (payload.progressOffset || 0) + visited,
          bestEstimate, bestPushes, frontier: beam.length, depth, generated,
          retained: seenDepth.size + seenExactDepth.size,
          performance: performanceSnapshot(board.metrics)});
        reported = visited;
        lastProgressAt = progressNow;
      }
    }
    generated += candidates.size;
    peakFrontier = Math.max(peakFrontier, beam.length, candidates.size);
    const shortlist = selectBeamLayer(
      [...candidates.values()],
      width * 3,
      beamProfile,
      board.metrics,
      payload.featureSpaceQueues !== false,
    );
    beam = [];
    for (const child of shortlist) {
      child.reachable = reachablePaths(child, board);
      if (createsSealedCorralDeadlock(child, board, child.reachable)) continue;
      child.identity = pushIdentity(child, child.reachable);
      if ((seenDepth.get(child.identity) ?? Infinity) <= child.cost) continue;
      child.signature = pushKey(child, child.reachable);
      child.score -= mobilityWeight * child.reachable.size;
      child.exploreScore -= mobilityWeight * child.reachable.size;
      seenDepth.set(child.identity, child.cost);
      seenExactDepth.set(child.exactIdentity, child.cost);
      beam.push(child);
      if (!bestHandoff || child.estimate < bestHandoff.estimate ||
          (child.estimate === bestHandoff.estimate && child.cost < bestHandoff.cost)) {
        bestHandoff = child;
      }
      if (!handoffCheckpoints.has(child.signature)) {
        handoffCheckpoints.set(child.signature, child);
        if (handoffCheckpoints.size > handoffLimit * 3) {
          const retained = [...handoffCheckpoints.entries()]
            .sort(([, left], [, right]) =>
              left.estimate - right.estimate ||
              (left.cost + left.estimate) - (right.cost + right.estimate))
            .slice(0, handoffLimit);
          handoffCheckpoints.clear();
          retained.forEach(([signature, checkpoint]) =>
            handoffCheckpoints.set(signature, checkpoint));
        }
      }
      if (evacuationWeight && child.evacuation === 0 &&
          (!phaseHandoff || child.cost + child.estimate <
            phaseHandoff.cost + phaseHandoff.estimate)) {
        phaseHandoff = child;
      }
    }
    beam = selectBeamLayer(
      beam,
      width,
      beamProfile,
      board.metrics,
      payload.featureSpaceQueues !== false,
    );
    if (payload.trackedSignatures) {
      for (const child of beam) {
        if (payload.trackedSignatures[child.cost] === child.signature) {
          trackedThrough = Math.max(trackedThrough, child.cost);
        }
      }
    }
  }
  const probeCheckpoints = stratifiedCheckpoints(endgameCheckpoints);
  if (payload.continuationVisited && probeCheckpoints.length) {
    let remainingVisited = payload.continuationVisited;
    const profiles = payload.continuationProfiles?.length
      ? payload.continuationProfiles
      : [{beamProfile: "detour", weight: 3.5, topologyWeight: 0.6}];
    const attempts = Math.min(payload.continuationAttempts || 8, probeCheckpoints.length);
    for (let index = 0; index < attempts && remainingVisited > 0; index++) {
      const checkpoint = probeCheckpoints[index];
      const remainingBound = (payload.upperBound || maxDepth) - checkpoint.cost;
      const attemptVisited = Math.ceil(remainingVisited / (attempts - index));
      const continuation = beamSearch({
        ...payload,
        ...profiles[index % profiles.length],
        preparedBoard: board,
        state: {
          rows: board.rows,
          robot: checkpoint.robot,
          boxes: checkpoint.boxes.map(([y, x, label]) => [pkey(y, x), label]),
        },
        upperBound: remainingBound,
        maxDepth: remainingBound,
        maxVisited: attemptVisited,
        beamWidth: payload.continuationWidth || 36,
        transpositionLimit: payload.continuationTranspositionLimit || 10000,
        seed: seed + (index + 1) * 32452843,
        progressOffset: (payload.progressOffset || 0) + visited,
        continuationVisited: 0,
        endgameVisited: 0,
      });
      if (continuation.path) {
        return {
          path: [...reconstructNodePath(checkpoint.node), ...continuation.path],
          visited: visited + continuation.visited,
          generated: generated + continuation.generated,
          retained: seenDepth.size + continuation.retained,
          peakFrontier: Math.max(peakFrontier, continuation.peakFrontier),
          transpositionEvictions:
            seenDepth.evictions +
            seenExactDepth.evictions +
            continuation.transpositionEvictions,
          bestEstimate: 0,
          bestPushes: checkpoint.cost,
          continuation: true,
        };
      }
      visited += continuation.visited;
      remainingVisited -= continuation.visited;
      if ((continuation.bestEstimate ?? Infinity) < bestEstimate) {
        bestEstimate = continuation.bestEstimate;
        bestPushes = checkpoint.cost + (continuation.bestPushes || 0);
      }
    }
  }
  if (payload.endgameVisited && probeCheckpoints.length) {
    let remainingVisited = payload.endgameVisited;
    const attempts = Math.min(payload.endgameAttempts || 12, probeCheckpoints.length);
    for (let index = 0; index < attempts && remainingVisited > 0; index++) {
      const checkpoint = probeCheckpoints[index];
      const remainingBound = (payload.upperBound || maxDepth) - checkpoint.cost;
      const attemptVisited = Math.ceil(remainingVisited / (attempts - index));
    const endgame = boundedPushDepthFirstSearch({
      algorithm: "bounded-push-dfs",
      preparedBoard: board,
      state: {
        rows: board.rows,
        robot: checkpoint.robot,
        boxes: checkpoint.boxes.map(([y, x, label]) => [pkey(y, x), label]),
      },
      upperBound: remainingBound,
      maxDepth: remainingBound,
      maxVisited: attemptVisited,
      transpositionLimit: payload.endgameTranspositionLimit || 30000,
      dfsProfile: payload.endgameProfiles?.[index % payload.endgameProfiles.length] ||
        payload.endgameProfile || "balanced",
      diversity: payload.diversity,
      seed: seed + 15485863,
      progressOffset: (payload.progressOffset || 0) + visited,
      forcedMacros: false,
    });
    if (endgame.path) {
      return {
        path: [...reconstructNodePath(checkpoint.node), ...endgame.path],
        visited: visited + endgame.visited,
        generated: generated + (endgame.generated || 0),
        retained: seenDepth.size + (endgame.retained || 0),
        peakFrontier: Math.max(peakFrontier, endgame.peakFrontier || 0),
        transpositionEvictions:
          seenDepth.evictions +
          seenExactDepth.evictions +
          (endgame.transpositionEvictions || 0),
        bestEstimate: 0,
        bestPushes: checkpoint.cost,
        endgame: true,
      };
    }
    visited += endgame.visited;
      remainingVisited -= endgame.visited;
    }
  }
  return {
    path: null,
    visited,
    generated,
    retained: seenDepth.size,
    peakFrontier,
    transpositionEvictions: seenDepth.evictions + seenExactDepth.evictions,
    cutoff: beamCutoff,
    terminationReason: beamCutoff ? "budget" : "frontier-exhausted",
    bestEstimate,
    bestPushes,
    trackedThrough,
    checkpoint: serializeSearchCheckpoint(bestHandoff, board),
    checkpoints: [...handoffCheckpoints.values()]
      .sort((left, right) =>
        left.estimate - right.estimate ||
        (left.cost + left.estimate) - (right.cost + right.estimate))
      .slice(0, handoffLimit)
      .map(checkpoint => serializeSearchCheckpoint(checkpoint, board)),
    phaseCheckpoint: serializeSearchCheckpoint(phaseHandoff, board),
  };
}

function beamRestartSearch(payload) {
  const restartCount = payload.restartCount || 3;
  const restartVisited = payload.restartVisited || 180000;
  const seedStride = payload.seedStride || 104729;
  const profiles = payload.restartProfiles?.length ? payload.restartProfiles : [{}];
  const preparedBoard = parse(payload.state);
  let visited = 0, bestEstimate = Infinity, bestPushes = 0;
  for (let restart = 0; restart < restartCount; restart++) {
    const result = beamSearch({
      ...payload,
      ...profiles[restart % profiles.length],
      algorithm: "push-beam",
      preparedBoard,
      maxVisited: restartVisited,
      progressOffset: visited,
      seed: (payload.seed || 0) + restart * seedStride,
    });
    visited += result.visited;
    if ((result.bestEstimate ?? Infinity) < bestEstimate) {
      bestEstimate = result.bestEstimate;
      bestPushes = result.bestPushes || 0;
    }
    if (result.path) return {...result, visited, restart: restart + 1};
  }
  return {path: null, visited, cutoff: true, terminationReason: "restart-budget",
    bestEstimate, bestPushes, restarts: restartCount};
}

function boundedPushDepthFirstSearch(payload) {
  const board = payload.preparedBoard || parse(payload.state);
  const initial = {
    robot: payload.state.robot,
    boxes: payload.state.boxes.map(([position, label]) => [
      ...position.split(",").map(Number), label,
    ]),
  };
  const bound = payload.upperBound ?? payload.pushBound ?? 300;
  const maxVisited = payload.maxVisited || 250000;
  const maxDepth = payload.maxDepth || bound;
  const seed = payload.seed || 0;
  const profile = payload.dfsProfile || "balanced";
  const discrepancyLimit = payload.discrepancyLimit ?? Infinity;
  const lockProvenCommitments = payload.lockProvenCommitments !== false;
  const transpositions = new BoundedDepthMap(payload.transpositionLimit || 60000);
  const activePath = new Set(), segments = [];
  const checkpointLimit = payload.checkpointLimit || 8;
  const checkpoints = new Map();
  let visited = 0, reported = 0, cutoff = false, solution = null;
  const progressInterval = payload.progressInterval || 5000;
  const progressIntervalMs = payload.progressIntervalMs || 5000;
  let lastProgressAt = now();
  let bestEstimate = Infinity, bestPushes = 0;
  let bestCheckpoint = null;
  let trackedThrough = payload.trackedSignatures ? 0 : undefined;

  const visit = (state, cost, discrepancyRemaining) => {
    if (cutoff || solution) return;
    visited++;
    if (visited >= maxVisited) {
      cutoff = true;
      return;
    }
    const progressNow = now();
    if (visited - reported >= progressInterval ||
        progressNow - lastProgressAt >= progressIntervalMs) {
      postMessage({type: "progress", visited: (payload.progressOffset || 0) + visited,
        bestEstimate, bestPushes, depth: cost, retained: transpositions.size,
        performance: performanceSnapshot(board.metrics)});
      reported = visited;
      lastProgressAt = progressNow;
    }
    if (goal(state.boxes, board.goals)) {
      solution = segments.flatMap(segment => segment);
      return;
    }
    const reachable = reachablePaths(state, board);
    if (createsSealedCorralDeadlock(state, board, reachable)) return;
    const identity = pushIdentity(state, reachable);
    if (payload.trackedSignatures &&
        payload.trackedSignatures[cost] === pushKey(state, reachable)) {
      trackedThrough = Math.max(trackedThrough, cost);
    }
    if (activePath.has(identity) || (transpositions.get(identity) ?? Infinity) <= cost) return;
    activePath.add(identity);
    transpositions.set(identity, cost);

    const dependencyGraph = supportDependencyGraph(state, board, reachable);
    const localRooms = [
      ...exactLocalRoomAnalyses(state, board, reachable),
      ...exactLocalCorralAnalyses(state, board, reachable),
    ];
    const doorwayBefore = typedDoorwayFlow(state.boxes, board);
    const goalAccessBefore = payload.goalAccessOrdering === false
      ? null : goalAccessAnalysis(state.boxes, board);
    const currentCommitments = lockProvenCommitments ? goalCommitments(state.boxes, board, {
      doorway: doorwayBefore,
      supportDependency: dependencyGraph,
      localAnalyses: localRooms,
    }) : null;
    const candidates = [];
    for (const rawNext of pushNeighbors(
      state,
      board,
      reachable,
      {commitments: currentCommitments},
    )) {
      const next = expandPushMacro(
        rawNext,
        board,
        payload.forcedMacros !== false,
        {lockProven: lockProvenCommitments},
      );
      if (!next) continue;
      const childCost = cost + next.pushes;
      if (childCost > maxDepth || childCost > bound) continue;
      const estimate = heuristic(next.boxes, board);
      if (!Number.isFinite(estimate) || childCost + estimate > bound) continue;
      const checkpointIdentity = exactPushIdentity(next, board);
      if (!checkpoints.has(checkpointIdentity)) {
        checkpoints.set(checkpointIdentity, {
          state: {
            rows: board.rows,
            robot: next.robot,
            boxes: next.boxes.map(([y, x, label]) => [pkey(y, x), label]),
          },
          path: [...segments.flatMap(segment => segment), ...next.path],
          cost: childCost,
          estimate,
        });
        if (checkpoints.size > checkpointLimit * 3) {
          const retained = [...checkpoints.entries()]
            .sort(([, left], [, right]) =>
              left.estimate - right.estimate ||
              (left.cost + left.estimate) - (right.cost + right.estimate))
            .slice(0, checkpointLimit);
          checkpoints.clear();
          retained.forEach(([retainedIdentity, checkpoint]) =>
            checkpoints.set(retainedIdentity, checkpoint));
        }
      }
      if (estimate < bestEstimate) {
        bestEstimate = estimate;
        bestPushes = childCost;
        bestCheckpoint = {
          state: {
            rows: board.rows,
            robot: next.robot,
            boxes: next.boxes.map(([y, x, label]) => [pkey(y, x), label]),
          },
          path: [...segments.flatMap(segment => segment), ...next.path],
          cost: childCost,
          estimate,
        };
      }
      const topology = topologyPenalty(next.boxes, board);
      const evacuation = profile === "evacuation" ? roomEvacuationPenalty(next.boxes, board) : 0;
      const dependencyDelta = supportDependencyDelta(dependencyGraph, next);
      const localRoomDelta = localRoomOrderingDelta(localRooms, next);
      const doorway = typedDoorwayFlow(next.boxes, board);
      const packing = goalPackingBonus(next.boxes, board, {
        doorway,
        supportDependency: dependencyGraph,
        localAnalyses: localRooms,
        transition: next,
      });
      const doorwayDelta = doorwayFlowDelta(doorwayBefore, state, next);
      const relevance = relevanceOrderingScore(state, board, next, {
        supportDependency: dependencyGraph,
        doorway: doorwayBefore,
        goalAccess: goalAccessBefore,
        recentPush: state.recentPush,
      });
      const relevanceScore = recordRelevanceOrdering(board.metrics, relevance);
      let score = 2.5 * estimate + topology - 0.8 * packing;
      if (profile === "detour") score = 1.5 * estimate + 1.4 * topology - packing;
      if (profile === "setup" && childCost <= 12) score = -estimate + topology - packing;
      if (profile === "room-flow") score = estimate + 6 * topology - packing;
      if (profile === "evacuation") score = estimate + 8 * evacuation + topology - packing;
      score += (payload.supportDependencyWeight ?? 0.8) * dependencyDelta;
      score += (payload.localRoomWeight ?? 0.6) * localRoomDelta;
      score += (payload.doorwayFlowWeight ?? 0.35) *
        (0.2 * doorway.penalty + doorwayDelta);
      score += (payload.relevanceWeight ?? 0.6) * relevanceScore;
      score += (payload.diversity ?? 1.5) *
        signatureNoise(exactPushIdentity(next, board), seed + childCost);
      candidates.push({next, cost: childCost, score, relevance: relevance.signals});
    }
    candidates.sort((left, right) => left.score - right.score);
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const discrepancy = index === 0 ? 0 : Math.ceil(Math.log2(index + 1));
      if (discrepancy > discrepancyRemaining) continue;
      segments.push(candidate.next.path);
      visit(
        {
          robot: candidate.next.robot,
          boxes: candidate.next.boxes,
          recentPush: {
            pushedFrom: candidate.next.pushedFrom,
            pushedTo: candidate.next.pushedTo,
          },
        },
        candidate.cost,
        discrepancyRemaining - discrepancy,
      );
      segments.pop();
      if (cutoff || solution) break;
    }
    activePath.delete(identity);
  };

  const initialEstimate = heuristic(initial.boxes, board);
  bestEstimate = initialEstimate;
  if (Number.isFinite(initialEstimate) && initialEstimate <= bound) {
    visit(initial, 0, discrepancyLimit);
  }
  return {
    path: solution,
    visited,
    cutoff,
    terminationReason: solution ? "solution" : cutoff ? "budget" : "profile-exhausted",
    bestEstimate,
    bestPushes,
    bound,
    discrepancyLimit,
    retained: transpositions.size,
    trackedThrough,
    checkpoint: bestCheckpoint,
    checkpoints: [...checkpoints.values()]
      .sort((left, right) =>
        left.estimate - right.estimate ||
        (left.cost + left.estimate) - (right.cost + right.estimate))
      .slice(0, checkpointLimit),
  };
}

const EXACT_CHECKPOINT_VERSION = 1;

function exactProblemHash(state) {
  const boxes = [...state.boxes].map(([position, label]) => `${label}@${position}`).sort();
  const source = `${state.rows.join("\n")}|r:${state.robot.join(",")}|b:${boxes.join(";")}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function encodeExactIdentity(identity) {
  if (identity === null || identity === undefined) return null;
  return typeof identity === "bigint" ? `b:${identity}` : `s:${identity}`;
}

function decodeExactIdentity(identity) {
  if (identity === null || identity === undefined) return null;
  return identity.startsWith("b:") ? BigInt(identity.slice(2)) : identity.slice(2);
}

function pushIterativeDeepeningAStar(payload) {
  const board = parse(payload.state);
  const initial = {
    robot: payload.state.robot,
    boxes: payload.state.boxes.map(([position, label]) => [
      ...position.split(",").map(Number), label,
    ]),
  };
  const upperBound = payload.upperBound ?? payload.pushBound ?? 300;
  const maxVisited = payload.maxVisited || 300000;
  const seed = payload.seed || 0;
  const profile = payload.idaProfile || "balanced";
  const exactShard = payload.exactShard;
  const problemHash = exactProblemHash(payload.state);
  const checkpointBuild = payload.solverBuild || "development";
  const lockProvenCommitments = payload.lockProvenCommitments !== false;
  const progressInterval = payload.progressInterval || 25000;
  const resume = payload.resumeExactCheckpoint;
  if (resume && (
    resume.version !== EXACT_CHECKPOINT_VERSION ||
    resume.problemHash !== problemHash ||
    resume.solverBuild !== checkpointBuild ||
    JSON.stringify(resume.exactShard || null) !== JSON.stringify(exactShard || null) ||
    resume.upperBound !== (Number.isFinite(upperBound) ? upperBound : "Infinity")
  )) {
    return {path: null, visited: 0, cutoff: false, failed: true,
      terminationReason: "checkpoint-incompatible", checkpointRejected: true};
  }

  let visited = resume?.visited || 0, reported = visited, solution = null, cutoff = false;
  let bestEstimate = resume?.bestEstimate ?? heuristic(initial.boxes, board);
  let bestPushes = resume?.bestPushes || 0;
  let generated = resume?.generated || 0, thresholdPrunes = resume?.thresholdPrunes || 0;
  let upperBoundPrunes = resume?.upperBoundPrunes || 0;
  let corralPrunes = resume?.corralPrunes || 0, cyclePrunes = resume?.cyclePrunes || 0;
  let transpositionPrunes = resume?.transpositionPrunes || 0;
  let shardRejections = resume?.shardRejected || 0, shardAcceptances = resume?.shardAccepted || 0;
  let maxDepth = resume?.maxDepth || 0;
  let transpositionEvictions = resume?.transpositionEvictions || 0;
  let maxTranspositions = resume?.maxTranspositions || 0;
  let nextThresholdCandidate = resume?.nextThreshold ?? Infinity;
  let trackedThrough = payload.trackedSignatures ? (resume?.trackedThrough || 0) : undefined;
  let threshold = resume?.threshold ?? bestEstimate;
  let stack = (resume?.stack || []).map(frame => ({
    ...frame,
    identity: decodeExactIdentity(frame.identity),
  }));
  let transpositions = new BoundedDepthMap(payload.transpositionLimit || 80000);
  if (resume?.transpositions) {
    for (const [identity, cost] of resume.transpositions) {
      transpositions.set(decodeExactIdentity(identity), cost);
    }
    transpositions.evictions = resume.currentTranspositionEvictions || 0;
  }
  const activePath = new Set(stack.filter(frame => frame.entered).map(frame => frame.identity));
  const pauseAt = payload.pauseAfterVisited
    ? visited + payload.pauseAfterVisited : Infinity;
  const strategicOrderingGate = createOrderingProductivityGate(
    payload.strategicOrderingWarmup || 64,
    payload.strategicOrderingCooldown || 512,
  );
  if (!Number.isFinite(bestEstimate)) {
    return {path: null, visited, cutoff: false, terminationReason: "infeasible-root",
      bestEstimate, bestPushes};
  }

  const orderingScore = (state, cost) => {
    const estimate = heuristic(state.boxes, board);
    const topology = topologyPenalty(state.boxes, board);
    if (profile === "milestone") {
      return estimate + 2.5 * topology +
        0.35 * signatureNoise(roomFlowSignature(state.boxes, board), seed + cost);
    }
    if (profile === "detour") return estimate + 1.25 * topology;
    return estimate + 0.6 * topology;
  };
  const makeRootFrame = () => ({
    state: initial, cost: 0, accepted: false, entered: false,
    identity: null, candidates: null, nextIndex: 0, pathFromParent: [],
  });
  const makeCheckpoint = () => ({
    version: EXACT_CHECKPOINT_VERSION,
    problemHash,
    solverBuild: checkpointBuild,
    exactShard: exactShard || null,
    upperBound: Number.isFinite(upperBound) ? upperBound : "Infinity",
    threshold,
    visited,
    bestEstimate,
    bestPushes,
    generated,
    thresholdPrunes,
    upperBoundPrunes,
    corralPrunes,
    cyclePrunes,
    transpositionPrunes,
    shardRejected: shardRejections,
    shardAccepted: shardAcceptances,
    maxDepth,
    transpositionEvictions,
    maxTranspositions,
    nextThreshold: Number.isFinite(nextThresholdCandidate) ? nextThresholdCandidate : null,
    trackedThrough,
    stack: stack.map(frame => ({
      ...frame,
      identity: encodeExactIdentity(frame.identity),
      state: {
        robot: [...frame.state.robot],
        boxes: frame.state.boxes.map(box => [...box]),
        recentPush: frame.state.recentPush ? {...frame.state.recentPush} : undefined,
      },
      candidates: frame.candidates?.map(candidate => ({
        ...candidate,
        state: {
          robot: [...candidate.state.robot],
          boxes: candidate.state.boxes.map(box => [...box]),
          recentPush: candidate.state.recentPush
            ? {...candidate.state.recentPush} : undefined,
        },
        path: [...candidate.path],
      })) || null,
      pathFromParent: [...frame.pathFromParent],
    })),
    // Transpositions are a performance cache, not proof progress. Retaining only
    // a recent bounded tail keeps durable checkpoints within browser storage
    // limits; omitted entries can only cause repeated work after resume.
    transpositions: [...transpositions.values].slice(-2000)
      .map(([identity, cost]) => [encodeExactIdentity(identity), cost]),
    currentTranspositionEvictions: transpositions.evictions,
  });
  const emitProgress = (cost, includeCheckpoint = false) => {
    postMessage({type: "progress", visited, threshold, bestEstimate, bestPushes,
      depth: cost, maxDepth, generated, thresholdPrunes, upperBoundPrunes,
      corralPrunes, cyclePrunes, transpositionPrunes,
      shardRejected: shardRejections, shardAccepted: shardAcceptances,
      transpositions: transpositions.size, transpositionEvictions: transpositions.evictions,
      nextThreshold: Number.isFinite(nextThresholdCandidate) ? nextThresholdCandidate : undefined,
      exactCheckpoint: includeCheckpoint ? makeCheckpoint() : undefined,
      performance: performanceSnapshot(board.metrics)});
    reported = visited;
  };

  while (Number.isFinite(threshold) && threshold <= upperBound && !solution && !cutoff) {
    if (!stack.length) {
      postMessage({type: "contour", threshold, visited, exactShard});
      activePath.clear();
      transpositions = new BoundedDepthMap(payload.transpositionLimit || 80000);
      nextThresholdCandidate = Infinity;
      stack = [makeRootFrame()];
    }
    while (stack.length && !solution && !cutoff) {
      const frame = stack[stack.length - 1];
      const {state, cost} = frame;
      maxDepth = Math.max(maxDepth, cost);
      if (!frame.entered) {
        const estimate = heuristic(state.boxes, board);
        const total = cost + estimate;
        if (!frame.accepted && exactShard && cost >= exactShard.depth) {
          const bucket = Math.floor(
            signatureNoise(exactPushIdentity(state, board), 0) * exactShard.count,
          );
          if (bucket !== exactShard.index) {
            shardRejections++;
            stack.pop();
            continue;
          }
          frame.accepted = true;
          shardAcceptances++;
        }
        if (total > threshold) {
          thresholdPrunes++;
          nextThresholdCandidate = Math.min(nextThresholdCandidate, total);
          stack.pop();
          continue;
        }
        if (goal(state.boxes, board.goals)) {
          solution = stack.flatMap(candidate => candidate.pathFromParent);
          break;
        }
        visited++;
        if (visited >= maxVisited) {
          cutoff = true;
          break;
        }
        const reachable = reachablePaths(state, board);
        if (createsSealedCorralDeadlock(state, board, reachable)) {
          corralPrunes++;
          stack.pop();
          continue;
        }
        const identity = pushIdentity(state, reachable);
        if (payload.trackedSignatures &&
            payload.trackedSignatures[cost] === pushKey(state, reachable)) {
          trackedThrough = Math.max(trackedThrough, cost);
        }
        if (activePath.has(identity)) {
          cyclePrunes++;
          stack.pop();
          continue;
        }
        if ((transpositions.get(identity) ?? Infinity) <= cost) {
          transpositionPrunes++;
          stack.pop();
          continue;
        }
        activePath.add(identity);
        transpositions.set(identity, cost);
        frame.identity = identity;
        frame.entered = true;
        const dependencyGraph = supportDependencyGraph(state, board, reachable);
        const localRooms = [
          ...exactLocalRoomAnalyses(state, board, reachable),
          ...exactLocalCorralAnalyses(state, board, reachable),
        ];
        const doorwayBefore = typedDoorwayFlow(state.boxes, board);
        const goalAccessBefore = payload.goalAccessOrdering === false
          ? null : goalAccessAnalysis(state.boxes, board);
        const commitments = lockProvenCommitments ? goalCommitments(state.boxes, board, {
          doorway: doorwayBefore,
          supportDependency: dependencyGraph,
          localAnalyses: localRooms,
        }) : null;
        const candidates = [];
        for (const rawNext of pushNeighbors(state, board, reachable, {commitments})) {
          generated++;
          const next = expandPushMacro(rawNext, board, payload.forcedMacros !== false,
            {lockProven: lockProvenCommitments});
          if (!next) continue;
          const childCost = cost + next.pushes;
          const childEstimate = heuristic(next.boxes, board);
          if (childCost > upperBound || !Number.isFinite(childEstimate) ||
              childCost + childEstimate > upperBound) {
            upperBoundPrunes++;
            continue;
          }
          if (childEstimate < bestEstimate) {
            bestEstimate = childEstimate;
            bestPushes = childCost;
          }
          const doorwayDelta = doorwayFlowDelta(doorwayBefore, state, next);
          const relevance = relevanceOrderingScore(state, board, next, {
            supportDependency: dependencyGraph,
            doorway: doorwayBefore,
            goalAccess: goalAccessBefore,
            recentPush: state.recentPush,
          });
          const relevanceScore = recordRelevanceOrdering(board.metrics, relevance);
          const baseScore = orderingScore(next, childCost) +
            (payload.supportDependencyWeight ?? 0.5) *
              supportDependencyDelta(dependencyGraph, next) +
            (payload.localRoomWeight ?? 0.4) * localRoomOrderingDelta(localRooms, next) +
            (payload.doorwayFlowWeight ?? 0.25) * doorwayDelta +
            (payload.relevanceWeight ?? 0.6) * relevanceScore +
            (payload.diversity ?? 0.2) *
              signatureNoise(exactPushIdentity(next, board), seed + childCost);
          candidates.push({
            state: {
              robot: next.robot,
              boxes: next.boxes,
              recentPush: {pushedFrom: next.pushedFrom, pushedTo: next.pushedTo},
            },
            path: next.path,
            cost: childCost,
            total: childCost + childEstimate,
            baseScore,
            score: baseScore,
            relevance: relevance.signals,
          });
        }
        const orderable = candidates.filter(candidate => candidate.total <= threshold);
        if (orderable.length > 1 && strategicOrderingGate.shouldEvaluate()) {
          board.metrics.strategicOrderingEvaluations++;
          const baseline = [...orderable].sort((left, right) =>
            left.total - right.total || left.baseScore - right.baseScore);
          const packingWeight = ["milestone", "detour"].includes(profile) ? 1 : 0.8;
          const doorwayWeight = payload.doorwayFlowWeight ?? 0.25;
          for (const candidate of orderable) {
            const candidateState = {...candidate.state, path: candidate.path};
            const doorway = typedDoorwayFlow(candidate.state.boxes, board);
            const packing = goalPackingBonus(candidate.state.boxes, board, {
              doorway,
              supportDependency: dependencyGraph,
              localAnalyses: localRooms,
              transition: candidateState,
            });
            candidate.score += 0.2 * doorwayWeight * doorway.penalty - packingWeight * packing;
          }
          const enriched = [...orderable].sort((left, right) =>
            left.total - right.total || left.score - right.score);
          const changed = baseline.some((candidate, index) => candidate !== enriched[index]);
          if (changed) {
            board.metrics.strategicOrderingChanges++;
            const changedIndex = enriched.findIndex(
              (candidate, index) => candidate !== baseline[index]);
            enriched[changedIndex].orderingProbe = {baselineBest: bestEstimate};
          } else {
            strategicOrderingGate.observe({changed: false, useful: false});
          }
        } else if (orderable.length > 1) {
          board.metrics.strategicOrderingSkips++;
        }
        candidates.sort((left, right) => left.total - right.total || left.score - right.score);
        frame.candidates = candidates;
        if (visited >= pauseAt) {
          cutoff = true;
          break;
        }
      }
      if (visited - reported >= progressInterval) emitProgress(cost, true);
      let descended = false;
      while (frame.nextIndex < frame.candidates.length) {
        const candidate = frame.candidates[frame.nextIndex++];
        if (candidate.total > threshold) {
          thresholdPrunes++;
          nextThresholdCandidate = Math.min(nextThresholdCandidate, candidate.total);
          continue;
        }
        stack.push({
          state: candidate.state,
          cost: candidate.cost,
          accepted: frame.accepted,
          entered: false,
          identity: null,
          candidates: null,
          nextIndex: 0,
          pathFromParent: candidate.path,
          orderingProbe: candidate.orderingProbe || null,
        });
        descended = true;
        break;
      }
      if (descended) continue;
      if (frame.orderingProbe) {
        const useful = bestEstimate < frame.orderingProbe.baselineBest;
        strategicOrderingGate.observe({changed: true, useful});
        if (useful) board.metrics.strategicOrderingUseful++;
        if (strategicOrderingGate.snapshot().cooldownRemaining) {
          board.metrics.strategicOrderingCooldowns++;
        }
      }
      activePath.delete(frame.identity);
      stack.pop();
    }
    if (cutoff || solution) break;
    transpositionEvictions += transpositions.evictions;
    maxTranspositions = Math.max(maxTranspositions, transpositions.size);
    stack = [];
    if (!Number.isFinite(nextThresholdCandidate)) break;
    threshold = nextThresholdCandidate <= threshold ? threshold + 1 : nextThresholdCandidate;
  }
  const paused = cutoff && visited >= pauseAt && visited < maxVisited;
  return {
    path: solution,
    visited,
    cutoff,
    terminationReason: solution ? "solution" : paused ? "checkpoint-yield" :
      cutoff ? "budget" : "bound-exhausted",
    exactCheckpoint: paused ? makeCheckpoint() : undefined,
    bestEstimate,
    bestPushes,
    threshold,
    bound: upperBound,
    trackedThrough,
    exactShard,
    generated,
    thresholdPrunes,
    upperBoundPrunes,
    corralPrunes,
    cyclePrunes,
    transpositionPrunes,
    shardRejected: shardRejections,
    shardAccepted: shardAcceptances,
    transpositionEvictions: transpositionEvictions + transpositions.evictions,
    maxTranspositions: Math.max(maxTranspositions, transpositions.size),
    maxDepth,
    nextThreshold: Number.isFinite(nextThresholdCandidate) ? nextThresholdCandidate : undefined,
  };
}

function moveBridgeAStarSearch(payload) {
  const board = parse(payload.state);
  const initial = {
    robot: payload.state.robot,
    boxes: payload.state.boxes.map(([position, label]) => [
      ...position.split(",").map(Number), label,
    ]),
    cost: 0,
    pushes: 0,
  };
  const targetBoxes = payload.targetState.boxes.map(([position, label]) => [
    ...position.split(",").map(Number), label,
  ]);
  const targetRobot = payload.targetState.robot;
  const targetLayout = boxSignature(targetBoxes, board);
  const heuristicMemo = new Map();
  const frontier = new Heap(), bestCost = new Map(), cameFrom = new Map();
  const maxVisited = payload.maxVisited || 1500;
  const moveUpperBound = payload.moveUpperBound ?? Infinity;
  const pushUpperBound = payload.pushUpperBound ?? Infinity;
  let visited = 0, order = 0, peakFrontier = 1;

  initial.signature = exactPushIdentity(initial, board);
  initial.estimate = targetLayoutHeuristic(initial.boxes, targetBoxes, board, heuristicMemo);
  if (!Number.isFinite(initial.estimate) ||
      initial.cost + initial.estimate >= moveUpperBound) {
    return {path: null, visited: 0, cutoff: false,
      terminationReason: "target-incompatible"};
  }
  bestCost.set(initial.signature, 0);
  frontier.push([initial.estimate, order++, initial]);

  while (frontier.length && visited < maxVisited) {
    const current = frontier.pop()[2];
    if (bestCost.get(current.signature) !== current.cost) continue;
    visited++;
    if (boxSignature(current.boxes, board) === targetLayout) {
      const reachable = reachablePaths(current, board);
      const targetPosition = pkey(targetRobot[0], targetRobot[1]);
      if (reachable.has(targetPosition)) {
        const walking = reachable.get(targetPosition);
        if (current.cost + walking.length < moveUpperBound) {
          return {
            path: [...reconstructPath(cameFrom, current.signature), ...walking],
            visited,
            bestMoves: current.cost + walking.length,
            bestPushes: current.pushes,
            peakFrontier,
            terminationReason: "target-reached",
          };
        }
      }
    }
    const reachable = reachablePaths(current, board);
    for (const next of pushNeighbors(current, board, reachable)) {
      const child = {
        robot: next.robot,
        boxes: next.boxes,
        cost: current.cost + next.path.length,
        pushes: current.pushes + 1,
      };
      if (child.cost >= moveUpperBound || child.pushes > pushUpperBound) continue;
      child.estimate = targetLayoutHeuristic(
        child.boxes, targetBoxes, board, heuristicMemo);
      if (!Number.isFinite(child.estimate) ||
          child.cost + child.estimate >= moveUpperBound) continue;
      child.signature = exactPushIdentity(child, board);
      if (child.cost >= (bestCost.get(child.signature) ?? Infinity)) continue;
      bestCost.set(child.signature, child.cost);
      cameFrom.set(child.signature, {parent: current.signature, segment: next.path});
      frontier.push([child.cost + child.estimate, order++, child]);
    }
    peakFrontier = Math.max(peakFrontier, frontier.length);
  }
  return {
    path: null,
    visited,
    cutoff: frontier.length > 0,
    peakFrontier,
    terminationReason: frontier.length ? "budget" : "frontier-exhausted",
  };
}

function bridgeAStarSearch(payload) {
  if (payload.costMode === "moves") return moveBridgeAStarSearch(payload);
  const board = parse(payload.state);
  const initial = {
    robot: payload.state.robot,
    boxes: payload.state.boxes.map(([position, label]) => [
      ...position.split(",").map(Number), label,
    ]),
    cost: 0,
  };
  const targetBoxes = payload.targetState.boxes.map(([position, label]) => [
    ...position.split(",").map(Number), label,
  ]);
  const targetState = {robot: payload.targetState.robot, boxes: targetBoxes};
  const targetReachable = reachablePaths(targetState, board);
  const targetKey = payload.targetId || pushKey(targetState, targetReachable);
  const heuristicMemo = new Map();
  const frontier = new Heap(), bestCost = new Map(), closed = new Set();
  let cameFrom = new Map();
  const weight = payload.weight ?? 1.4;
  const maxVisited = payload.maxVisited || 100000;
  const frontierLimit = payload.frontierLimit || 4000;
  let visited = 0, order = 0, bestEstimate = Infinity, bestCheckpoint = null;
  let compactions = 0, peakFrontier = 0;

  initial.reachable = reachablePaths(initial, board);
  initial.signature = pushKey(initial, initial.reachable);
  initial.estimate = targetLayoutHeuristic(initial.boxes, targetBoxes, board, heuristicMemo);
  const initialEstimate = initial.estimate;
  if (!Number.isFinite(initial.estimate)) {
    return {path: null, visited, cutoff: false,
      terminationReason: "target-incompatible", bestEstimate: initial.estimate};
  }
  delete initial.reachable;
  bestCost.set(initial.signature, 0);
  frontier.push([weight * initial.estimate, order++, initial]);

  while (frontier.length) {
    const current = frontier.pop()[2];
    if (bestCost.get(current.signature) !== current.cost || closed.has(current.signature)) continue;
    bestCost.delete(current.signature);
    closed.add(current.signature);
    visited++;
    if (current.signature === targetKey) {
      return {
        path: reconstructPath(cameFrom, current.signature),
        visited,
        terminationReason: "target-reached",
        initialEstimate,
        bestEstimate: 0,
        bestPushes: current.cost,
        peakFrontier,
        compactions,
        finalState: {
          rows: board.rows,
          robot: current.robot,
          boxes: current.boxes.map(([y, x, label]) => [pkey(y, x), label]),
        },
      };
    }
    if (visited >= maxVisited) break;
    const currentReachable = reachablePaths(current, board);
    for (const rawNext of pushNeighbors(current, board, currentReachable)) {
      const next = expandPushMacro(rawNext, board, payload.forcedMacros !== false);
      if (!next) continue;
      const child = {
        robot: next.robot,
        boxes: next.boxes,
        cost: current.cost + next.pushes,
      };
      if (payload.upperBound && child.cost > payload.upperBound) continue;
      child.reachable = reachablePaths(child, board);
      child.signature = pushKey(child, child.reachable);
      delete child.reachable;
      if (closed.has(child.signature) ||
          child.cost >= (bestCost.get(child.signature) ?? Infinity)) continue;
      child.estimate = targetLayoutHeuristic(child.boxes, targetBoxes, board, heuristicMemo);
      if (!Number.isFinite(child.estimate) ||
          (payload.upperBound && child.cost + child.estimate > payload.upperBound)) continue;
      if (child.estimate < bestEstimate) {
        bestEstimate = child.estimate;
        bestCheckpoint = {
          state: {
            rows: board.rows,
            robot: child.robot,
            boxes: child.boxes.map(([y, x, label]) => [pkey(y, x), label]),
          },
          cost: child.cost,
          estimate: child.estimate,
          signature: child.signature,
        };
      }
      bestCost.set(child.signature, child.cost);
      cameFrom.set(child.signature, {parent: current.signature, segment: next.path});
      frontier.push([child.cost + weight * child.estimate, order++, child]);
    }
    peakFrontier = Math.max(peakFrontier, frontier.length);
    if (frontier.length > frontierLimit * 2) {
      frontier.retainBest(frontierLimit);
      const retainedCosts = new Map();
      const ancestry = new Set([initial.signature]);
      const pending = [];
      for (const [, , state] of frontier.items) {
        const previous = retainedCosts.get(state.signature) ?? Infinity;
        if (state.cost < previous) retainedCosts.set(state.signature, state.cost);
        pending.push(state.signature);
      }
      if (bestCheckpoint?.signature) pending.push(bestCheckpoint.signature);
      while (pending.length) {
        const signature = pending.pop();
        if (ancestry.has(signature)) continue;
        ancestry.add(signature);
        const record = cameFrom.get(signature);
        if (record?.parent) pending.push(record.parent);
      }
      cameFrom = new Map([...cameFrom].filter(([signature]) => ancestry.has(signature)));
      bestCost.clear();
      retainedCosts.forEach((cost, signature) => bestCost.set(signature, cost));
      compactions++;
    }
    if (visited % 5000 === 0) postMessage({type: "progress", visited,
      bestEstimate, bestPushes: bestCheckpoint?.cost, frontier: frontier.length,
      retained: bestCost.size, peakFrontier, compactions,
      performance: performanceSnapshot(board.metrics)});
  }
  const cutoff = visited >= maxVisited;
  const checkpoint = bestCheckpoint && {
    state: bestCheckpoint.state,
    path: reconstructPath(cameFrom, bestCheckpoint.signature),
    cost: bestCheckpoint.cost,
    estimate: bestCheckpoint.estimate,
  };
  return {path: null, visited, cutoff,
    terminationReason: cutoff ? "budget" : "frontier-exhausted",
    initialEstimate, bestEstimate, bestPushes: bestCheckpoint?.cost,
    frontier: frontier.length, retained: bestCost.size, peakFrontier, compactions,
    checkpoint};
}

function bidirectionalSide(payload) {
  validatePuzzleRows(payload.state.rows);
  const board = parse(payload.state);
  const initialBoxes = payload.state.boxes.map(([p, label]) => [...p.split(",").map(Number), label]);
  const initialTargets = targetMapFromBoxes(initialBoxes, board);
  const forward = payload.mode === "bidir-forward";
  const frontier = new Heap(), closed = new Set(), records = [];
  let bestCost = new Map();
  const frontierLimit = payload.frontierLimit || 40000;
  let order = 0, visited = 0, reported = 0, bestLandmarkEstimate = Infinity;
  let generated = 0, peakFrontier = 0, compactions = 0;
  const compactFrontier = () => {
    peakFrontier = Math.max(peakFrontier, frontier.length);
    if (frontier.length <= frontierLimit * 2) return;
    frontier.retainBest(frontierLimit);
    const retainedCosts = new Map();
    for (const [, , state] of frontier.items) {
      const previous = retainedCosts.get(state.exactIdentity) ?? Infinity;
      if (state.cost < previous) retainedCosts.set(state.exactIdentity, state.cost);
    }
    bestCost = retainedCosts;
    compactions++;
  };
  const landmarkCandidates = new Map();
  const emitLandmarks = () => {
    if (forward || !landmarkCandidates.size) return;
    const landmarks = stratifiedCheckpoints([...landmarkCandidates.values()])
      .slice(0, payload.landmarkLimit || 64)
      .map(({checkpointBand: _band, checkpointClass: _class, ...landmark}) => landmark);
    postMessage({type: "landmarks", landmarks});
  };
  const starts = forward
    ? [{robot: payload.state.robot, boxes: initialBoxes, cost: 0, path: []}]
    : reverseStartStates(
      board,
      initialBoxes,
      payload.reverseShard || {index: 0, count: 1},
      initialTargets,
    );
  if (!forward) postMessage({
    type: "reverse-starts",
    shard: payload.reverseShard || {index: 0, count: 1},
    ...starts.portfolioStats,
  });
  starts.forEach(state => {
    state.exactIdentity = exactPushIdentity(state, board);
    const estimate = forward
      ? heuristic(state.boxes, board)
      : homeHeuristic(state.boxes, initialTargets);
    if (!Number.isFinite(estimate) || bestCost.has(state.exactIdentity)) return;
    if (payload.upperBound && state.cost + estimate > payload.upperBound) return;
    bestCost.set(state.exactIdentity, state.cost);
    const topology = forward ? 0.2 * topologyPenalty(state.boxes, board) : 0;
    frontier.push([state.cost + estimate + topology, order++, state]);
  });
  compactFrontier();

  while (frontier.length) {
    const current = frontier.pop()[2];
    if (bestCost.get(current.exactIdentity) !== current.cost) continue;
    bestCost.delete(current.exactIdentity);
    const reachable = reachablePaths(current, board);
    if (forward && createsSealedCorralDeadlock(current, board, reachable)) continue;
    const identity = pushIdentity(current, reachable);
    if (closed.has(identity)) continue;
    closed.add(identity); visited++;
    const signature = pushKey(current, reachable);
    records.push({
      id: signature,
      parent: current.parent ?? null,
      segment: encodeMoves(current.segment || []),
      robot: current.robot,
    });
    const landmarkEstimate = forward
      ? heuristic(current.boxes, board)
      : homeHeuristic(current.boxes, initialTargets);
    if (landmarkEstimate < bestLandmarkEstimate) {
      bestLandmarkEstimate = landmarkEstimate;
      postMessage({
        type: "landmark",
        id: signature,
        estimate: landmarkEstimate,
        cost: current.cost,
        state: {
          rows: board.rows,
          robot: current.robot,
          boxes: current.boxes.map(([y, x, label]) => [pkey(y, x), label]),
        },
      });
    }
    if (!forward) {
      const solvedGoals = current.boxes
        .filter(([y, x, label]) => board.goals.get(pkey(y, x)) === label)
        .map(([y, x, label]) => `${y},${x},${label}`)
        .sort()
        .join(";");
      const checkpointBand = Math.floor(landmarkEstimate / 10);
      const checkpointClass =
        `${checkpointBand}|${roomFlowSignature(current.boxes, board)}|${solvedGoals}`;
      const existing = landmarkCandidates.get(checkpointClass);
      if (!existing || landmarkEstimate < existing.estimate ||
          (landmarkEstimate === existing.estimate && current.cost < existing.cost)) {
        landmarkCandidates.set(checkpointClass, {
          id: signature,
          estimate: landmarkEstimate,
          cost: current.cost,
          checkpointBand,
          checkpointClass,
          state: {
            rows: board.rows,
            robot: current.robot,
            boxes: current.boxes.map(([y, x, label]) => [pkey(y, x), label]),
          },
        });
      }
    }

    if (records.length >= 500) {
      flushRecords(records, {
        visited,
        generated,
        frontier: frontier.length,
        retained: closed.size + bestCost.size,
        peakFrontier,
      });
    }
    if (payload.maxVisited && visited >= payload.maxVisited) {
      flushRecords(records, {
        visited,
        generated,
        frontier: frontier.length,
        retained: closed.size + bestCost.size,
        peakFrontier,
      });
      emitLandmarks();
      postMessage({type: "progress", visited, delta: visited - reported,
        bestEstimate: bestLandmarkEstimate, frontier: frontier.length,
        retained: closed.size + bestCost.size, generated, peakFrontier, compactions,
        performance: performanceSnapshot(board.metrics)});
      postMessage({type: "done", visited, cutoff: true, terminationReason: "budget",
        bestEstimate: bestLandmarkEstimate, generated, peakFrontier, compactions,
        frontier: frontier.length, retained: closed.size + bestCost.size,
        performance: performanceSnapshot(board.metrics)});
      return;
    }
    let nextStates = forward
      ? pushNeighbors(current, board, reachable).map(next => ({
          robot: next.robot,
          boxes: next.boxes,
          cost: current.cost + 1,
          parent: signature,
          segment: next.path,
        }))
      : reversePullNeighbors(current, board, reachable).map(next => ({
          ...next,
          parent: signature,
        }));
    if (!forward && current.cost === 0 && payload.reverseShard?.count > 1) {
      nextStates = nextStates.filter(next =>
        reverseShardOwns(exactPushIdentity(next, board), payload.reverseShard));
    }
    for (const next of nextStates) {
      next.exactIdentity = exactPushIdentity(next, board);
      if (next.cost >= (bestCost.get(next.exactIdentity) ?? Infinity)) continue;
      const estimate = forward
        ? heuristic(next.boxes, board)
        : homeHeuristic(next.boxes, initialTargets);
      if (!Number.isFinite(estimate)) continue;
      if (payload.upperBound && next.cost + estimate > payload.upperBound) continue;
      bestCost.set(next.exactIdentity, next.cost);
      generated++;
      const weightedEstimate = (forward ? 1.4 : 1.2) * estimate;
      const topology = forward ? 0.2 * topologyPenalty(next.boxes, board) : 0;
      frontier.push([next.cost + weightedEstimate + topology, order++, next]);
    }
    compactFrontier();
    if (visited % 1000 === 0) {
      postMessage({type: "progress", visited, delta: visited - reported,
        bestEstimate: bestLandmarkEstimate, frontier: frontier.length,
        retained: closed.size + bestCost.size, generated, peakFrontier, compactions,
        performance: performanceSnapshot(board.metrics)});
      reported = visited;
    }
  }
  flushRecords(records, {
    visited,
    generated,
    frontier: frontier.length,
    retained: closed.size + bestCost.size,
    peakFrontier,
  });
  emitLandmarks();
  postMessage({type: "progress", visited, delta: visited - reported,
    bestEstimate: bestLandmarkEstimate, frontier: frontier.length,
    retained: closed.size + bestCost.size, generated, peakFrontier, compactions,
    performance: performanceSnapshot(board.metrics)});
  postMessage({type: "done", visited, cutoff: false, terminationReason: "exhausted",
    bestEstimate: bestLandmarkEstimate, generated, peakFrontier, compactions,
    frontier: frontier.length, retained: closed.size + bestCost.size,
    performance: performanceSnapshot(board.metrics)});
}

function goalCutComponentSolved(boxes, board, domain) {
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  return [...domain].every(position => {
    const goalLabel = board.goals.get(position);
    const boxLabel = occupied.get(position);
    return goalLabel ? boxLabel === goalLabel : !boxLabel;
  });
}

function replaySearchPath(state, board, path) {
  let replay = state;
  for (const move of path) {
    const next = neighbors(replay, board, false).find(candidate => candidate.move === move);
    if (!next) return null;
    replay = {robot: next.robot, boxes: next.boxes, cost: replay.cost + 1};
  }
  return replay;
}

function initialReplayState(payload) {
  return {
    robot: payload.state.robot,
    boxes: payload.state.boxes.map(([position, label]) => [
      ...position.split(",").map(Number), label,
    ]),
    cost: 0,
  };
}

function eraseSolutionLoops(payload, path, board) {
  let replay = initialReplayState(payload);
  const moves = [], states = [replay];
  const signatures = [exactPushIdentity(replay, board)];
  const positions = new Map([[signatures[0], 0]]);
  for (const move of path) {
    const next = neighbors(replay, board, false)
      .find(candidate => candidate.move === move);
    if (!next) return null;
    replay = {robot: next.robot, boxes: next.boxes, cost: replay.cost + 1};
    moves.push(move);
    const signature = exactPushIdentity(replay, board);
    const repeatedAt = positions.get(signature);
    if (repeatedAt !== undefined) {
      for (let index = signatures.length - 1; index > repeatedAt; index--) {
        positions.delete(signatures[index]);
      }
      moves.length = repeatedAt;
      states.length = repeatedAt + 1;
      signatures.length = repeatedAt + 1;
      replay = states[repeatedAt];
    } else {
      states.push(replay);
      signatures.push(signature);
      positions.set(signature, moves.length);
    }
    if (goal(replay.boxes, board.goals)) break;
  }
  return moves;
}

function normalizeSolutionWalks(payload, path, board) {
  let original = initialReplayState(payload);
  let replay = initialReplayState(payload);
  const normalized = [];
  for (const move of path) {
    const originalNext = neighbors(original, board, false)
      .find(candidate => candidate.move === move);
    if (!originalNext) return null;
    const pushed = originalNext.boxes !== original.boxes;
    if (pushed) {
      const support = pkey(original.robot[0], original.robot[1]);
      const reachable = reachablePaths(replay, board);
      if (!reachable.has(support)) return null;
      const walking = reachable.get(support);
      replay = replaySearchPath(replay, board, walking);
      if (!replay) return null;
      const pushedNext = neighbors(replay, board, false)
        .find(candidate => candidate.move === move);
      if (!pushedNext || pushedNext.boxes === replay.boxes) return null;
      normalized.push(...walking, move);
      replay = {
        robot: pushedNext.robot,
        boxes: pushedNext.boxes,
        cost: replay.cost + walking.length + 1,
      };
      if (goal(replay.boxes, board.goals)) return normalized;
    }
    original = {
      robot: originalNext.robot,
      boxes: originalNext.boxes,
      cost: original.cost + 1,
    };
  }
  return goal(replay.boxes, board.goals) ? normalized : null;
}

function canonicalizeSolutionPath(payload, path, board = parse(payload.state)) {
  const withoutLoops = eraseSolutionLoops(payload, path, board);
  if (!withoutLoops) return null;
  const normalized = normalizeSolutionWalks(payload, withoutLoops, board);
  if (!normalized) return null;
  return eraseSolutionLoops(payload, normalized, board);
}

function replaySolutionDetails(payload, path, board = parse(payload.state)) {
  let replay = initialReplayState(payload);
  const boundaries = [{moveIndex: 0, pushes: 0, state: replay}];
  let pushes = 0;
  for (let index = 0; index < path.length; index++) {
    const next = neighbors(replay, board, false)
      .find(candidate => candidate.move === path[index]);
    if (!next) return null;
    const pushed = next.boxes !== replay.boxes;
    replay = {robot: next.robot, boxes: next.boxes, cost: replay.cost + 1};
    if (pushed) {
      pushes++;
      boundaries.push({moveIndex: index + 1, pushes, state: replay});
    }
  }
  return {state: replay, pushes, moves: path.length, boundaries};
}

function serializedSearchState(state, rows) {
  return {
    rows,
    robot: state.robot,
    boxes: state.boxes.map(([y, x, label]) => [pkey(y, x), label]),
  };
}

function solutionPushChains(payload, path, board) {
  let state = initialReplayState(payload);
  const chains = state.boxes.map(() => []);
  for (const move of path) {
    const next = neighbors(state, board, false)
      .find(candidate => candidate.move === move);
    if (!next) return null;
    if (next.boxes !== state.boxes) {
      const boxIndex = state.boxes.findIndex((box, index) =>
        box[0] !== next.boxes[index][0] || box[1] !== next.boxes[index][1]);
      if (boxIndex < 0) return null;
      const [fromY, fromX, label] = state.boxes[boxIndex];
      const [toY, toX] = next.boxes[boxIndex];
      chains[boxIndex].push({
        boxIndex,
        label,
        from: pkey(fromY, fromX),
        to: pkey(toY, toX),
        move,
      });
    }
    state = {robot: next.robot, boxes: next.boxes, cost: state.cost + 1};
    if (goal(state.boxes, board.goals)) break;
  }
  return chains;
}

function pushPermutationSearch(payload, path, board, maxVisited = 10000) {
  const chains = solutionPushChains(payload, path, board);
  if (!chains) return {path: null, visited: 0};
  const totalPushes = chains.reduce((sum, chain) => sum + chain.length, 0);
  const initial = {
    ...initialReplayState(payload),
    progress: new Uint16Array(chains.length),
    pushes: 0,
    moves: 0,
    node: null,
  };
  const frontier = new Heap(), bestCost = new Map();
  let order = 0, visited = 0, generated = 0, peakFrontier = 1;
  const upperBound = path.length;
  const identity = state =>
    `${exactPushIdentity(state, board)}|${state.progress.join(".")}`;
  const initialIdentity = identity(initial);
  bestCost.set(initialIdentity, 0);
  frontier.push([totalPushes, order++, initial]);

  while (frontier.length && visited < maxVisited) {
    const state = frontier.pop()[2];
    const stateIdentity = identity(state);
    if (state.moves !== bestCost.get(stateIdentity)) continue;
    visited++;
    if (state.pushes === totalPushes) {
      const candidate = reconstructNodePath(state.node);
      return candidate.length < upperBound
        ? {path: candidate, visited, generated, peakFrontier}
        : {path: null, visited, generated, peakFrontier};
    }
    const reachable = reachablePaths(state, board);
    const occupied = denseBoxLayout(state.boxes, board).indexByCell;
    for (let boxIndex = 0; boxIndex < chains.length; boxIndex++) {
      const action = chains[boxIndex][state.progress[boxIndex]];
      if (!action) continue;
      const [boxY, boxX, label] = state.boxes[boxIndex];
      if (label !== action.label || pkey(boxY, boxX) !== action.from) continue;
      const [dy, dx] = DIRS[action.move];
      const destinationId = board.dense.idByKey.get(action.to);
      const support = pkey(boxY - dy, boxX - dx);
      if (destinationId === undefined || occupied[destinationId] >= 0 ||
          !reachable.has(support)) continue;
      const walking = reachable.get(support);
      const segment = [...walking, action.move];
      const next = replaySearchPath(state, board, segment);
      if (!next || pkey(next.boxes[boxIndex][0], next.boxes[boxIndex][1]) !== action.to) {
        continue;
      }
      const moves = state.moves + segment.length;
      if (moves >= upperBound) continue;
      const progress = state.progress.slice();
      progress[boxIndex]++;
      const child = {
        robot: next.robot,
        boxes: next.boxes,
        progress,
        pushes: state.pushes + 1,
        moves,
        node: {parent: state.node, segment},
      };
      const childIdentity = identity(child);
      if ((bestCost.get(childIdentity) ?? Infinity) <= moves) continue;
      bestCost.set(childIdentity, moves);
      const remaining = totalPushes - child.pushes;
      frontier.push([moves + remaining, order++, child]);
      generated++;
    }
    peakFrontier = Math.max(peakFrontier, frontier.length);
  }
  return {path: null, visited, generated, peakFrontier, cutoff: visited >= maxVisited};
}

function solutionWindowRewriteSearch(payload) {
  const board = parse(payload.state);
  let path = [...(payload.solutionPath || [])];
  let details = replaySolutionDetails(payload, path, board);
  if (!details || !goal(details.state.boxes, board.goals)) {
    return {path: null, visited: 0, failed: true,
      terminationReason: "invalid-rewrite-incumbent"};
  }
  const initialQuality = {pushes: details.pushes, moves: details.moves};
  const canonical = canonicalizeSolutionPath(payload, path, board);
  if (!canonical) {
    return {path: null, visited: 0, failed: true,
      terminationReason: "invalid-rewrite-incumbent"};
  }
  path = canonical;
  details = replaySolutionDetails(payload, path, board);
  const maximumVisited = payload.maxVisited || 300000;
  const permutationBudget = Math.min(
    payload.permutationVisited || 0,
    maximumVisited,
  );
  const permutationSizes = payload.permutationWindowPushes || [8, 16, 32];
  const perPermutationWindow = payload.perPermutationWindowVisited || 1000;
  let permutationVisited = 0, permutationGenerated = 0;
  let permutationImprovements = 0, permutationWindows = 0;
  for (const windowPushes of permutationSizes) {
    const stride = Math.max(1, Math.floor(windowPushes / 2));
    for (let startPush = 0;
      startPush + windowPushes <= details.pushes &&
        permutationVisited < permutationBudget;
      startPush += stride) {
      const start = details.boundaries[startPush];
      const target = details.boundaries[startPush + windowPushes];
      if (!start || !target) continue;
      const segment = path.slice(start.moveIndex, target.moveIndex);
      const budget = Math.min(
        perPermutationWindow,
        permutationBudget - permutationVisited,
      );
      const permutation = pushPermutationSearch({
        ...payload,
        state: serializedSearchState(start.state, board.rows),
      }, segment, board, budget);
      permutationVisited += permutation.visited || 0;
      permutationGenerated += permutation.generated || 0;
      permutationWindows++;
      if (!permutation.path) continue;
      const rewrittenEnd = replaySearchPath(start.state, board, permutation.path);
      const walking = rewrittenEnd
        ? reachablePaths(rewrittenEnd, board)
          .get(pkey(target.state.robot[0], target.state.robot[1]))
        : null;
      if (!walking) continue;
      const candidate = [
        ...path.slice(0, start.moveIndex),
        ...permutation.path,
        ...walking,
        ...path.slice(target.moveIndex),
      ];
      const candidateDetails = replaySolutionDetails(payload, candidate, board);
      if (candidateDetails &&
          goal(candidateDetails.state.boxes, board.goals) &&
          candidateDetails.pushes === details.pushes &&
          candidateDetails.moves < details.moves) {
        path = candidate;
        details = candidateDetails;
        permutationImprovements++;
      }
    }
  }
  const windowSizes = payload.windowPushes || [8, 16, 32];
  const perWindowVisited = payload.windowVisited || 20000;
  let visited = permutationVisited, windows = 0;
  const pushWindowLimit = Math.min(
    maximumVisited,
    permutationVisited +
      (payload.windowTotalVisited ?? maximumVisited),
  );
  let improvements = details.moves < initialQuality.moves ? 1 : 0;

  for (const windowPushes of windowSizes) {
    let startPush = Math.max(0, details.pushes - windowPushes);
    while (startPush >= 0 && visited < pushWindowLimit) {
      const endPush = Math.min(details.pushes, startPush + windowPushes);
      if (endPush <= startPush) break;
      const start = details.boundaries[startPush];
      const target = details.boundaries[endPush];
      if (!start || !target) break;
      const originalSegmentPushes = endPush - startPush;
      const budget = Math.min(perWindowVisited, pushWindowLimit - visited);
      const result = bridgeAStarSearch({
        algorithm: "bridge-astar",
        state: serializedSearchState(start.state, board.rows),
        targetState: serializedSearchState(target.state, board.rows),
        upperBound: originalSegmentPushes,
        maxVisited: budget,
        frontierLimit: payload.frontierLimit || 12000,
        forcedMacros: false,
        weight: 1,
      });
      visited += result.visited || 0;
      windows++;
      if (result.path) {
        const rewrittenEnd = replaySearchPath(start.state, board, result.path);
        const walking = rewrittenEnd
          ? reachablePaths(rewrittenEnd, board)
            .get(pkey(target.state.robot[0], target.state.robot[1]))
          : null;
        if (walking) {
          const candidate = [
            ...path.slice(0, start.moveIndex),
            ...result.path,
            ...walking,
            ...path.slice(target.moveIndex),
          ];
          const candidateDetails = replaySolutionDetails(payload, candidate, board);
          const improves = candidateDetails &&
            goal(candidateDetails.state.boxes, board.goals) &&
            candidateDetails.moves < details.moves;
          if (improves) {
            path = candidate;
            details = candidateDetails;
            improvements++;
            startPush = Math.max(0, Math.min(
              startPush + Math.floor(windowPushes / 2),
              details.pushes - windowPushes,
            ));
            continue;
          }
        }
      }
      if (startPush === 0) break;
      startPush = Math.max(0, startPush - Math.max(1, Math.floor(windowPushes / 2)));
    }
  }
  const moveWindowBudget = Math.min(
    payload.moveWindowVisited || 0,
    Math.max(0, maximumVisited - visited),
  );
  const moveWindowSizes = payload.moveWindowPushes || [1, 2, 4];
  const moveWindowAttempts = payload.moveWindowAttempts ?? 6;
  const attemptedMoveWindows = new Set();
  let moveVisited = 0, moveImprovements = 0;
  for (let attempt = 0;
    attempt < moveWindowAttempts && moveVisited < moveWindowBudget;
    attempt++) {
    const rankedWindows = [];
    for (const windowPushes of moveWindowSizes) {
      for (let startPush = 0;
        startPush + windowPushes <= details.pushes;
        startPush++) {
        const start = details.boundaries[startPush];
        const target = details.boundaries[startPush + windowPushes];
        if (!start || !target) continue;
        const segmentMoves = target.moveIndex - start.moveIndex;
        const overhead = segmentMoves - windowPushes;
        if (overhead < (payload.moveWindowMinimumOverhead ?? 6)) continue;
        const key = `${exactPushIdentity(start.state, board)}>` +
          `${exactPushIdentity(target.state, board)}>${windowPushes}`;
        if (attemptedMoveWindows.has(key)) continue;
        rankedWindows.push({start, target, windowPushes, segmentMoves, overhead, key});
      }
    }
    rankedWindows.sort((left, right) =>
      right.overhead - left.overhead ||
      left.segmentMoves - right.segmentMoves ||
      left.start.moveIndex - right.start.moveIndex);
    const window = rankedWindows[0];
    if (!window) break;
    attemptedMoveWindows.add(window.key);
    const budget = Math.min(
      payload.perMoveWindowVisited || 1000,
      moveWindowBudget - moveVisited,
    );
    const result = bridgeAStarSearch({
      algorithm: "bridge-astar",
      costMode: "moves",
      state: serializedSearchState(window.start.state, board.rows),
      targetState: serializedSearchState(window.target.state, board.rows),
      moveUpperBound: window.segmentMoves,
      pushUpperBound: window.windowPushes + (payload.moveWindowExtraPushes ?? 4),
      maxVisited: budget,
    });
    moveVisited += result.visited || 0;
    visited += result.visited || 0;
    windows++;
    if (!result.path) continue;
    const candidate = [
      ...path.slice(0, window.start.moveIndex),
      ...result.path,
      ...path.slice(window.target.moveIndex),
    ];
    const candidateDetails = replaySolutionDetails(payload, candidate, board);
    if (candidateDetails && goal(candidateDetails.state.boxes, board.goals) &&
        candidateDetails.moves < details.moves) {
      path = candidate;
      details = candidateDetails;
      improvements++;
      moveImprovements++;
    }
  }
  return {
    path,
    visited,
    windows,
    improvements,
    moveVisited,
    moveImprovements,
    permutationVisited,
    permutationGenerated,
    permutationImprovements,
    permutationWindows,
    initialPushes: initialQuality.pushes,
    initialMoves: initialQuality.moves,
    bestPushes: details.pushes,
    bestMoves: details.moves,
    terminationReason: improvements ? "rewrite-improved" : "rewrite-fixed-point",
  };
}

function solveGoalCutComponents(payload, board, initial, certificate) {
  let current = initial, visited = 0;
  const path = [];
  const robotPosition = pkey(initial.robot[0], initial.robot[1]);
  const ordered = [...certificate.components].sort((left, right) =>
    Number(right.has(robotPosition)) - Number(left.has(robotPosition)));
  for (const domain of ordered) {
    if (goalCutComponentSolved(current.boxes, board, domain)) continue;
    const remainingBudget = payload.maxVisited
      ? Math.max(1, payload.maxVisited - visited)
      : undefined;
    const result = searchCore({
      ...payload,
      state: {
        rows: board.rows,
        robot: current.robot,
        boxes: current.boxes.map(([y, x, label]) => [pkey(y, x), label]),
      },
      maxVisited: remainingBudget,
      _goalCutDomain: domain,
      _skipGoalCut: true,
    });
    visited += result.visited || 0;
    if (!result.path) return null;
    current = replaySearchPath(current, board, result.path);
    if (!current) return null;
    path.push(...result.path);
  }
  return goal(current.boxes, board.goals)
    ? {path, visited, decompositionComponents: ordered.length,
      decompositionCut: certificate.cut}
    : null;
}

function searchCore(payload) {
  if (payload.algorithm === "analyze-puzzle") {
    return {path: null, visited: 0, analysis: analyzePuzzleForSearch(payload.state)};
  }
  if (payload.algorithm === "bridge-astar") return bridgeAStarSearch(payload);
  if (payload.algorithm === "solution-window-rewrite") {
    return solutionWindowRewriteSearch(payload);
  }
  if (payload.algorithm === "fess") return canonicalFessSearch(payload);
  if (payload.algorithm === "plan-macro-beam") return canonicalPlanMacroBeamSearch(payload);
  if (payload.algorithm === "push-beam") return beamSearch(payload);
  if (payload.algorithm === "push-beam-restarts") return beamRestartSearch(payload);
  if (payload.algorithm === "bounded-push-dfs") return boundedPushDepthFirstSearch(payload);
  if (payload.algorithm === "push-ida-star") return pushIterativeDeepeningAStar(payload);
  if (["ultimate", "portfolio", "fast"].includes(payload.algorithm)) {
    const plans = [
      ["push-beam", "Push Beam", 0.4],
      ["push-greedy", "Push Greedy", 0.2],
      ["weighted-push-astar", "Weighted Push A*", 0.1],
      ["push-astar", "Push A*", 0],
    ];
    const maximumVisited = payload.maxVisited ?? Infinity;
    const maximumGenerated = payload.maxGenerated ?? Infinity;
    let visited = 0, generated = 0, retained = 0, peakFrontier = 0;
    let transpositionEvictions = 0, anyCutoff = false, lastResult = null;
    for (const [algorithm, label, futureReserveFraction] of plans) {
      const remainingVisited = maximumVisited - visited;
      const remainingGenerated = maximumGenerated - generated;
      if (remainingVisited <= 0 || remainingGenerated <= 0) {
        anyCutoff = true;
        break;
      }
      const visitReserve = Number.isFinite(maximumVisited)
        ? Math.min(
            Math.max(0, remainingVisited - 1),
            Math.floor(maximumVisited * futureReserveFraction),
          )
        : 0;
      const generatedReserve = Number.isFinite(maximumGenerated)
        ? Math.min(
            Math.max(0, remainingGenerated - 1),
            Math.floor(maximumGenerated * futureReserveFraction),
          )
        : 0;
      const lanePayload = {
        ...payload,
        algorithm,
        maxVisited: Number.isFinite(remainingVisited)
          ? Math.max(1, remainingVisited - visitReserve)
          : undefined,
        maxGenerated: Number.isFinite(remainingGenerated)
          ? Math.max(1, remainingGenerated - generatedReserve)
          : undefined,
      };
      const generatedBefore = activePerformance?.pushCandidates || 0;
      const result = algorithm === "push-beam"
        ? beamSearch(lanePayload)
        : searchCore(lanePayload);
      const generatedAfter = activePerformance?.pushCandidates || generatedBefore;
      const laneVisited = result.visited || 0;
      const laneGenerated = result.generated ??
        Math.max(laneVisited, generatedAfter - generatedBefore);
      visited += laneVisited;
      generated += laneGenerated;
      retained = Math.max(retained, result.retained || 0);
      peakFrontier = Math.max(peakFrontier, result.peakFrontier || 0);
      transpositionEvictions += result.transpositionEvictions || 0;
      anyCutoff ||= Boolean(result.cutoff);
      lastResult = result;
      if (result.path) {
        return {
          ...result,
          strategy: label,
          visited,
          generated,
          retained: Math.max(retained, result.retained || 0),
          peakFrontier,
          transpositionEvictions,
        };
      }
    }
    return {
      ...(lastResult || {}),
      path: null,
      visited,
      generated,
      retained,
      peakFrontier,
      transpositionEvictions,
      cutoff: anyCutoff ||
        visited >= maximumVisited ||
        generated >= maximumGenerated,
      terminationReason:
        visited >= maximumVisited ? "state-budget" :
        generated >= maximumGenerated ? "generated-budget" :
        "portfolio-exhausted",
    };
  }
  const board = parse(payload.state), initial = {
    robot: payload.state.robot,
    boxes: payload.state.boxes.map(([p, label]) => [...p.split(",").map(Number), label]),
    cost: 0,
    parent: null,
    segment: [],
  };
  if (!payload._skipGoalCut && !payload.maxVisited &&
      payload.algorithm === "push-astar") {
    const certificate = goalCutDecomposition(initial.boxes, board);
    if (certificate) {
      const decomposed = solveGoalCutComponents(payload, board, initial, certificate);
      if (decomposed) return decomposed;
    }
  }
  const algorithm = payload.algorithm, frontier = new Heap(), seen = new Map(), cameFrom = new Map();
  const bestCost = new Map(), closed = new Set();
  const pushMacro = ["push-astar", "push-greedy", "weighted-push-astar"].includes(algorithm);
  const weight = algorithm === "weighted-push-astar" ? 1.6 : 1;
  const maxVisited = payload.maxVisited ?? Infinity;
  const maxGenerated = payload.maxGenerated ?? Infinity;
  let order = 0, visited = 0, generated = 0;
  const score = (s) => algorithm === "bfs" ? s.cost :
    algorithm === "dfs" ? -s.cost :
    ["greedy", "push-greedy"].includes(algorithm)
      ? heuristic(s.boxes, board) + 0.3 * topologyPenalty(s.boxes, board) :
    s.cost + weight * heuristic(s.boxes, board) +
      (algorithm === "weighted-push-astar" ? 0.15 * topologyPenalty(s.boxes, board) : 0);
  if (pushMacro) {
    initial.exactIdentity = exactPushIdentity(initial, board);
    bestCost.set(initial.exactIdentity, 0);
  }
  const initialScore = score(initial);
  if (!Number.isFinite(initialScore)) return {path: null, visited: 0};
  frontier.push([initialScore, order++, initial]);
  while (frontier.length) {
    const current = frontier.pop()[2];
    if (pushMacro && bestCost.get(current.exactIdentity) !== current.cost) continue;
    const reachable = pushMacro ? reachablePaths(current, board) : null;
    const identity = pushMacro ? pushIdentity(current, reachable) : exactPushIdentity(current, board);
    if (pushMacro) {
      if (closed.has(identity)) continue;
      closed.add(identity);
    } else {
      if (seen.has(identity) && seen.get(identity) <= current.cost) continue;
      seen.set(identity, current.cost);
    }
    visited++;
    if (current.parent !== null) {
      cameFrom.set(identity, {parent: current.parent, segment: current.segment});
    }
    if (payload._goalCutDomain
      ? goalCutComponentSolved(current.boxes, board, payload._goalCutDomain)
      : goal(current.boxes, board.goals)) {
      return {path: reconstructPath(cameFrom, identity), visited, generated};
    }
    if (pushMacro && createsSealedCorralDeadlock(current, board, reachable)) continue;
    if (visited >= maxVisited) {
      return {path: null, visited, generated, cutoff: true,
        terminationReason: "state-budget"};
    }
    let nextStates = pushMacro ? pushNeighbors(current, board, reachable)
      .map(next => expandPushMacro(next, board, payload.forcedMacros !== false))
      .filter(Boolean) :
      neighbors(current, board).map(n => ({robot: n.robot, boxes: n.boxes, path: [n.move]}));
    if (payload._goalCutDomain && pushMacro) {
      nextStates = nextStates.filter(next =>
        payload._goalCutDomain.has(next.pushedFrom) &&
        payload._goalCutDomain.has(next.pushedTo));
    }
    for (const next of nextStates) {
      const child = {robot: next.robot, boxes: next.boxes,
        cost: current.cost + (pushMacro ? next.pushes : next.path.length),
        parent: identity, segment: next.path};
      if (pushMacro) {
        child.exactIdentity = exactPushIdentity(child, board);
        if (child.cost >= (bestCost.get(child.exactIdentity) ?? Infinity)) continue;
        const childScore = score(child);
        if (!Number.isFinite(childScore)) continue;
        if (payload.upperBound && child.cost + heuristic(child.boxes, board) > payload.upperBound) continue;
        bestCost.set(child.exactIdentity, child.cost);
        frontier.push([childScore, order++, child]);
        generated++;
      } else {
        frontier.push([score(child), order++, child]);
        generated++;
      }
      if (generated >= maxGenerated) {
        return {path: null, visited, generated, cutoff: true,
          terminationReason: "generated-budget"};
      }
    }
    if (visited % 10000 === 0) postMessage({type: "progress", visited,
      frontier: frontier.length,
      retained: seen.size + bestCost.size + closed.size,
      performance: performanceSnapshot(board.metrics)});
  }
  return {path: null, visited, generated};
}

const TERMINAL_STATUS = Object.freeze({
  SOLVED: "solved",
  PROVEN_UNSOLVABLE: "proven-unsolvable",
  CUTOFF: "cutoff",
  CANCELLED: "cancelled",
  FAILED: "failed",
});

function validateSearchSolution(payload, candidatePath) {
  if (!Array.isArray(candidatePath)) {
    return {valid: false, reason: "missing-solution-path", path: null};
  }
  const board = parse(payload.state);
  const canonical = canonicalizeSolutionPath(payload, candidatePath, board);
  if (!canonical) {
    return {valid: false, reason: "illegal-solution-path", path: null};
  }
  let replay = initialReplayState(payload);
  const validated = [];
  if (goal(replay.boxes, board.goals)) {
    return {valid: true, reason: "solution", path: [], originalMoves: candidatePath.length};
  }
  for (const move of canonical) {
    const next = neighbors(replay, board, false).find(candidate => candidate.move === move);
    if (!next) return {valid: false, reason: "illegal-solution-path", path: null};
    replay = {robot: next.robot, boxes: next.boxes, cost: replay.cost + 1};
    validated.push(move);
    if (goal(replay.boxes, board.goals)) {
      return {
        valid: true,
        reason: "solution",
        path: validated,
        originalMoves: candidatePath.length,
      };
    }
  }
  return {valid: false, reason: "incomplete-solution-path", path: null};
}

function terminalSearchResult(payload, result) {
  if (payload.algorithm === "bridge-astar" || payload.algorithm === "analyze-puzzle") {
    return result;
  }
  if (result.path !== null && result.path !== undefined) {
    const validation = validateSearchSolution(payload, result.path);
    if (!validation.valid) {
      return {...result, path: null, status: TERMINAL_STATUS.FAILED,
        terminationReason: validation.reason};
    }
    const details = replaySolutionDetails(payload, validation.path);
    return {...result, path: validation.path, status: TERMINAL_STATUS.SOLVED,
      terminationReason: "solution",
      bestMoves: details?.moves ?? validation.path.length,
      bestPushes: details?.pushes ?? result.bestPushes,
      pathMovesRemoved: Math.max(
        0, (validation.originalMoves ?? validation.path.length) - validation.path.length),
    };
  }
  if (result.cancelled || result.terminationReason === "user-stop") {
    return {...result, status: TERMINAL_STATUS.CANCELLED,
      terminationReason: result.terminationReason || "user-stop"};
  }
  if (result.failed) {
    return {...result, status: TERMINAL_STATUS.FAILED,
      terminationReason: result.terminationReason || "search-failed"};
  }
  const exactAlgorithms = new Set(["push-ida-star", "push-astar", "astar", "bfs", "dfs"]);
  const effectiveBound = payload.algorithm === "push-ida-star"
    ? (payload.upperBound ?? payload.pushBound ?? 300)
    : (payload.upperBound ?? payload.pushBound);
  const finiteBound = Number.isFinite(effectiveBound);
  if (exactAlgorithms.has(payload.algorithm) && finiteBound && !result.cutoff) {
    return {...result, status: TERMINAL_STATUS.CUTOFF, cutoff: false,
      terminationReason: "bound-exhausted"};
  }
  const proofComplete = exactAlgorithms.has(payload.algorithm) && !result.cutoff &&
    (!finiteBound || result.terminationReason === "infeasible-root");
  if (proofComplete) {
    return {...result, status: TERMINAL_STATUS.PROVEN_UNSOLVABLE,
      terminationReason: result.terminationReason || "frontier-exhausted"};
  }
  return {...result, status: TERMINAL_STATUS.CUTOFF,
    cutoff: true, terminationReason: result.terminationReason || "search-incomplete"};
}

function search(payload) {
  const parentPerformance = activePerformance;
  const metrics = parentPerformance || createPerformanceMetrics();
  const rootSearch = parentPerformance === null;
  const started = now();
  activePerformance = metrics;
  try {
    if (payload.state?.rows) validatePuzzleRows(payload.state.rows);
    const result = searchCore(payload);
    if (rootSearch) {
      metrics.totalMs = now() - started;
      metrics._startedAt = null;
    }
    const performance = performanceSnapshot(metrics);
    return terminalSearchResult(payload, {
      ...result,
      generated:
        result.generated ??
        Math.max(result.visited || 0, performance.pushCandidates || 0),
      retained: result.retained ?? result.visited ?? 0,
      peakFrontier:
        result.peakFrontier ?? result.frontier ?? (result.visited ? 1 : 0),
      transpositionEvictions: result.transpositionEvictions ?? 0,
      performance,
    });
  } finally {
    activePerformance = parentPerformance;
  }
}

export { bidirectionalSide, search };
