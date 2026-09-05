// Board parsing, dense board compilation, push distances, single-box graphs, and goal push tables.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

const PREPARED_BOARD_SCHEMA = 3;
const boardContentKey = rows => rows.join("\n");
const ESTIMATED_MAP_ENTRY_BYTES = 96;
const ESTIMATED_CACHE_ENTRY_BYTES = 320;

class DenseDistanceTable {
  constructor(dense, serialized = null, maximumDistance = Infinity) {
    this._idByKey = dense.idByKey;
    const values = serialized?.values ?? serialized?._values;
    if (ArrayBuffer.isView(values)) {
      this._values = values;
    } else if (maximumDistance <= 0xfe) {
      this._values = new Uint8Array(dense.keys.length);
    } else if (maximumDistance <= 0xfffe) {
      this._values = new Uint16Array(dense.keys.length);
    } else {
      this._values = new Int32Array(dense.keys.length);
    }
    this._sentinel = serialized?.sentinel ?? serialized?._sentinel ??
      (this._values instanceof Uint8Array ? 0xff :
        this._values instanceof Uint16Array ? 0xffff : -1);
    if (!values) this._values.fill(this._sentinel);
    this._size = serialized?.size ?? serialized?._size ?? 0;
  }
  get(key) {
    const cell = this._idByKey.get(key);
    if (cell === undefined) return undefined;
    const value = this._values[cell];
    return value !== this._sentinel ? value : undefined;
  }
  has(key) {
    const cell = this._idByKey.get(key);
    return cell !== undefined && this._values[cell] !== this._sentinel;
  }
  set(key, value) {
    const cell = this._idByKey.get(key);
    if (cell === undefined) return this;
    if (this._values[cell] === this._sentinel) this._size++;
    this._values[cell] = value;
    return this;
  }
  get size() { return this._size; }
  get byteLength() { return this._values.byteLength; }
  serializable() {
    return {
      kind: "dense-distance-v1",
      values: this._values,
      sentinel: this._sentinel,
      size: this._size,
    };
  }
}

function hydrateDistanceTable(table, dense, maximumDistance = Infinity) {
  if (table instanceof DenseDistanceTable) return table;
  if (table instanceof Map) {
    const hydrated = new DenseDistanceTable(dense, null, maximumDistance);
    for (const [key, value] of table) hydrated.set(key, value);
    return hydrated;
  }
  return new DenseDistanceTable(dense, table);
}

function serializeDistanceTable(table) {
  return table instanceof DenseDistanceTable ? table.serializable() : table;
}

function serializeGoalPushTables(tables) {
  const byGoal = new Map([...tables.byGoal]
    .map(([goal, distances]) => [goal, serializeDistanceTable(distances)]));
  const byLabel = new Map([...tables.byLabel].map(([label, entries]) => [
    label,
    entries.map(({goal}) => ({goal, distances: byGoal.get(goal)})),
  ]));
  return {byGoal, byLabel};
}

function hydrateGoalPushTables(tables, dense, maximumDistance = Infinity) {
  const byGoal = new Map([...tables.byGoal]
    .map(([goal, distances]) => [
      goal,
      hydrateDistanceTable(distances, dense, maximumDistance),
    ]));
  const byLabel = new Map([...tables.byLabel].map(([label, entries]) => [
    label,
    entries.map(({goal}) => ({goal, distances: byGoal.get(goal)})),
  ]));
  return {byGoal, byLabel};
}

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

const BOARD_CLOCK_CACHE_PROFILES = Object.freeze([
  Object.freeze({name: "heuristicMemo", maximum: HEURISTIC_MEMO_LIMIT, weight: 0.45}),
  Object.freeze({name: "deadlockMemo", maximum: DEADLOCK_MEMO_LIMIT, weight: 0.23}),
  Object.freeze({name: "patternDeadlockMemo", maximum: PATTERN_DEADLOCK_MEMO_LIMIT, weight: 0.23}),
  Object.freeze({name: "pushTransitionMemo", maximum: PUSH_TRANSITION_MEMO_LIMIT, weight: 0.09}),
]);

function estimateRetainedBytes(value, seen = new Set(), depth = 0) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return 16 + value.length * 2;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return 32 + value.byteLength;
  if (value instanceof ArrayBuffer) return 32 + value.byteLength;
  if (value instanceof DenseDistanceTable) return 64 + value.byteLength;
  if (value instanceof ClockCache) return value.estimatedMemoryBytes();
  if (depth >= 4) return 64;
  if (value instanceof Map) {
    let bytes = 64 + value.size * ESTIMATED_MAP_ENTRY_BYTES;
    for (const [key, entry] of value) {
      bytes += estimateRetainedBytes(key, seen, depth + 1);
      bytes += estimateRetainedBytes(entry, seen, depth + 1);
    }
    return bytes;
  }
  if (value instanceof Set) {
    let bytes = 64 + value.size * 56;
    for (const entry of value) bytes += estimateRetainedBytes(entry, seen, depth + 1);
    return bytes;
  }
  if (Array.isArray(value)) {
    let bytes = 32 + value.length * 8;
    for (const entry of value) bytes += estimateRetainedBytes(entry, seen, depth + 1);
    return bytes;
  }
  let bytes = 64;
  for (const entry of Object.values(value)) {
    bytes += estimateRetainedBytes(entry, seen, depth + 1);
  }
  return bytes;
}

function estimatePreparedBoardBytes(board) {
  // Keep immutable board accounting separate from search caches. Shared table
  // objects are counted once, including every typed-array backing store.
  const seen = new Set();
  return [
    board.rows,
    board.floor,
    board.walls,
    board.goals,
    board.goalsByLabel,
    board.pushDistances,
    board.goalPressure,
    board.topology,
    board.singleBoxGraph,
    board.goalPushTables,
    board.dense,
    board.patternEligibility,
  ].reduce((sum, value) => sum + estimateRetainedBytes(value, seen), 0);
}

function estimatePreparedBoardSeedBytes(seed) {
  // A prepared seed intentionally carries selected warmed search tables in
  // addition to the immutable board. Estimate the object that is actually
  // cloned to workers with one shared `seen` set so shared graph/table values
  // are counted once. Keep this separate from estimatePreparedBoardBytes():
  // hydrated boards report these warmed tables as caches, not static memory.
  const seen = new Set();
  return Object.entries(seed).reduce((sum, [name, value]) =>
    name === "estimatedBytes"
      ? sum
      : sum + estimateRetainedBytes(value, seen, 0), 0);
}

function cacheMemoryBytes(cache, seen, name = "") {
  if (!cache) return 0;
  if (cache instanceof ClockCache) {
    const samples = Math.min(16, cache.size);
    let sampledBytes = 0;
    for (let index = 0; index < samples; index++) {
      sampledBytes += estimateRetainedBytes(cache._keys[index], seen, 1);
      sampledBytes += estimateRetainedBytes(cache._values[index], seen, 1);
    }
    return cache.estimatedMemoryBytes() +
      (samples ? Math.round(sampledBytes * cache.size / samples) : 0);
  }
  if (name === "playerPushDistances" && cache instanceof Map) {
    let bytes = 64 + cache.size * ESTIMATED_MAP_ENTRY_BYTES;
    for (const distances of cache.values()) {
      bytes += distances instanceof DenseDistanceTable
        ? 64 + distances.byteLength
        : 64 + (distances?.size || 0) * ESTIMATED_MAP_ENTRY_BYTES;
    }
    return bytes;
  }
  if (!(cache instanceof Map)) return estimateRetainedBytes(cache, seen, 1);
  const samples = Math.min(16, cache.size);
  let sampledBytes = 0, sampled = 0;
  for (const [key, value] of cache) {
    sampledBytes += estimateRetainedBytes(key, seen, 1);
    sampledBytes += estimateRetainedBytes(value, seen, 1);
    if (++sampled >= samples) break;
  }
  return 64 + cache.size * ESTIMATED_MAP_ENTRY_BYTES +
    (samples ? Math.round(sampledBytes * cache.size / samples) : 0);
}

function boardCacheMemorySnapshot(board) {
  const seen = new Set();
  let cacheEntries = 0, cacheBytes = 0;
  const cacheBreakdownBytes = {};
  for (const name of BOARD_CACHE_MAPS) {
    const cache = board[name];
    cacheEntries += cache?.size || 0;
    const bytes = cacheMemoryBytes(cache, seen, name);
    cacheBreakdownBytes[name] = bytes;
    cacheBytes += bytes;
  }
  for (const name of BOARD_TABLE_MAPS) {
    const tables = board[name];
    if (!tables?.values) continue;
    cacheEntries += tables.size || 0;
    for (const table of tables.values()) cacheEntries += table?.states?.size || 0;
    const nestedEntries = [...tables.values()]
      .reduce((sum, table) => sum + (table?.states?.size || 0), 0);
    const bytes = 64 + tables.size * ESTIMATED_MAP_ENTRY_BYTES +
      nestedEntries * ESTIMATED_CACHE_ENTRY_BYTES;
    cacheBreakdownBytes[name] = bytes;
    cacheBytes += bytes;
  }
  for (const [name, cache] of board._engineMemoryCaches || []) {
    cacheEntries += cache?.size || 0;
    const bytes = cacheMemoryBytes(cache, seen, name);
    cacheBreakdownBytes[name] = bytes;
    cacheBytes += bytes;
  }
  return {
    boardBytes: board._estimatedStaticBytes || 0,
    cacheEntries,
    cacheBytes,
    cacheBreakdownBytes,
  };
}

function registerBoardMemoryCache(board, name, cache) {
  if (!board._engineMemoryCaches) {
    Object.defineProperty(board, "_engineMemoryCaches", {
      value: new Map(),
      enumerable: false,
    });
  }
  board._engineMemoryCaches.set(name, cache);
  return cache;
}

function attachBoardMemorySampler(board) {
  if (board._engineMemoryCaches) board._engineMemoryCaches.clear();
  else {
    Object.defineProperty(board, "_engineMemoryCaches", {
      value: new Map(),
      enumerable: false,
    });
  }
  board._estimatedStaticBytes = Math.max(0, estimatePreparedBoardBytes(board));
  board.metrics._engineMemorySampler = () => boardCacheMemorySnapshot(board);
  return board;
}

function configureBoardCaches(board, maxMemoryBytes, fraction = 0.2) {
  if (!Number.isFinite(maxMemoryBytes) || maxMemoryBytes <= 0) return null;
  const staticBytes = board._estimatedStaticBytes || estimatePreparedBoardBytes(board);
  const remainingBytes = Math.max(0, Math.floor(maxMemoryBytes) - staticBytes);
  const requestedFraction = Number.isFinite(fraction)
    ? Math.max(0, Math.min(1, fraction))
    : 0.2;
  const cacheBudgetBytes = Math.min(
    96 * 1024 * 1024,
    Math.floor(remainingBytes * requestedFraction),
  );
  const totalEntries = Math.max(1, Math.floor(
    cacheBudgetBytes / ESTIMATED_CACHE_ENTRY_BYTES,
  ));
  const capacities = {};
  for (const profile of BOARD_CLOCK_CACHE_PROFILES) {
    const capacity = Math.max(1, Math.min(
      profile.maximum,
      Math.floor(totalEntries * profile.weight),
    ));
    capacities[profile.name] = capacity;
    const current = board[profile.name];
    if (current?.size && current.capacity === capacity) {
      board.metrics.cacheConfigurationSkips++;
      continue;
    }
    board[profile.name] = new ClockCache(capacity);
  }
  board.metrics.cacheBudgetBytes = cacheBudgetBytes;
  board.metrics.cacheCapacityEntries = Object.values(capacities)
    .reduce((sum, capacity) => sum + capacity, 0);
  return {cacheBudgetBytes, capacities};
}

function createPreparedBoardSeed(board) {
  const seed = {
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
    goalPushTables: serializeGoalPushTables(board.goalPushTables),
    playerPushDistances: new Map([...board.playerPushDistances]
      .map(([start, distances]) => [start, serializeDistanceTable(distances)])),
    dense: board.dense,
    patternEligibility: board.patternEligibility,
    patternEligibleCount: board.patternEligibleCount,
    goalRoomPackingTables: board.goalRoomPackingTables,
    roomPatternTables: board.roomPatternTables,
    pairConflictTables: board.pairConflictTables,
    capacityPatternTables: board.capacityPatternTables,
    graphNodes: board.metrics.graphNodes,
    graphEdges: board.metrics.graphEdges,
  };
  const estimatedBytes = estimatePreparedBoardSeedBytes(seed);
  board.metrics.preparedSeedBytes = estimatedBytes;
  board.metrics.preparedPlayerDistanceTables = board.playerPushDistances.size;
  return {...seed, estimatedBytes};
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
  const maximumPushDistance = seed.singleBoxGraph.nodes.size;
  const goalPushTables = hydrateGoalPushTables(
    seed.goalPushTables,
    seed.dense,
    maximumPushDistance,
  );
  const playerPushDistances = new Map([...seed.playerPushDistances || []]
    .map(([start, distances]) => [
      start,
      hydrateDistanceTable(distances, seed.dense, maximumPushDistance),
    ]));
  const patternEligibility = seed.patternEligibility instanceof Uint8Array
    ? seed.patternEligibility
    : compilePatternEligibility(seed.dense, metrics);
  const patternEligibleCount = seed.patternEligibleCount ??
    patternEligibility.reduce((sum, eligible) => sum + eligible, 0);
  metrics.goalTableBuilds = goalPushTables.byGoal.size;
  metrics.goalTableStates = [...seed.goalPushTables.byGoal.values()]
    .reduce((sum, distances) => sum + distances.size, 0);
  metrics.denseDistanceTables += goalPushTables.byGoal.size + playerPushDistances.size;
  metrics.denseDistanceCells +=
    (goalPushTables.byGoal.size + playerPushDistances.size) * seed.dense.keys.length;
  metrics.denseDistanceBytes += [...goalPushTables.byGoal.values(), ...playerPushDistances.values()]
    .reduce((sum, distances) => sum + distances.byteLength, 0);
  metrics.patternEligibleCells = patternEligibleCount;
  metrics.patternIneligibleCells = seed.dense.keys.length - metrics.patternEligibleCells;
  const board = {
    rows: data.rows,
    floor: seed.floor,
    walls: seed.walls,
    goals: seed.goals,
    goalsByLabel: seed.goalsByLabel,
    pushDistances: seed.pushDistances,
    goalPressure: seed.goalPressure,
    topology: {
      ...seed.topology,
      transportGeometry: seed.topology.transportGeometry ||
        compileRoomTransportGeometry(seed.topology, seed.dense),
    },
    singleBoxGraph: seed.singleBoxGraph,
    goalPushTables,
    dense: seed.dense,
    patternEligibility,
    patternEligibleCount,
    heuristicMemo: new ClockCache(HEURISTIC_MEMO_LIMIT),
    discoveryHeuristicMemo: new Map(),
    assignmentMemo: new WeakMap(),
    discoveryAssignmentMemo: new WeakMap(),
    assignmentParentMemo: new WeakMap(),
    playerPushDistances,
    deadlockMemo: new ClockCache(DEADLOCK_MEMO_LIMIT),
    patternDeadlockMemo: new ClockCache(PATTERN_DEADLOCK_MEMO_LIMIT),
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
    pushTransitionMemo: new ClockCache(PUSH_TRANSITION_MEMO_LIMIT),
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
  const goalPushTables = compileGoalPushTables(singleBoxGraph, goals, metrics, dense);
  const patternEligibility = compilePatternEligibility(dense, metrics);
  const patternEligibleCount = patternEligibility.reduce((sum, eligible) => sum + eligible, 0);
  const topology = analyzeTopology(floor, goals);
  topology.transportGeometry = compileRoomTransportGeometry(topology, dense);
  metrics.parseMs += now() - parseStarted;
  return attachBoardMemorySampler({
    rows: data.rows, floor, walls, goals, goalsByLabel, pushDistances, goalPressure,
    topology, heuristicMemo: new ClockCache(HEURISTIC_MEMO_LIMIT), discoveryHeuristicMemo: new Map(),
    assignmentMemo: new WeakMap(), discoveryAssignmentMemo: new WeakMap(),
    assignmentParentMemo: new WeakMap(), playerPushDistances: new Map(),
    deadlockMemo: new ClockCache(DEADLOCK_MEMO_LIMIT), commitmentMemo: new Map(), stateCommitmentMemo: new Map(),
    patternDeadlockMemo: new ClockCache(PATTERN_DEADLOCK_MEMO_LIMIT),
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
    pushTransitionMemo: new ClockCache(PUSH_TRANSITION_MEMO_LIMIT),
    boxSignatureMemo: new WeakMap(),
    boxIdentityMemo: new WeakMap(),
    singleBoxGraph, goalPushTables, dense, patternEligibility, patternEligibleCount, metrics,
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

function compilePatternEligibility(dense, metrics = createPerformanceMetrics()) {
  const eligible = new Uint8Array(dense.keys.length);
  const degree = new Uint8Array(dense.keys.length);
  for (let cell = 0; cell < dense.keys.length; cell++) {
    let count = 0;
    for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
      if (dense.neighbors[cell * DIRECTION_ENTRIES.length + direction] >= 0) count++;
    }
    degree[cell] = count;
  }
  for (let center = 0; center < dense.keys.length; center++) {
    let floorCount = 0, branched = false;
    scanWindow: for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const cell = cellId(dense.y[center] + dy, dense.x[center] + dx, dense);
        if (cell < 0) continue;
        floorCount++;
        if (degree[cell] > 2) branched = true;
        if (floorCount > PATTERN_FLOOR_LIMIT && branched) break scanWindow;
      }
    }
    if (floorCount <= PATTERN_FLOOR_LIMIT && !branched) eligible[center] = 1;
  }
  metrics.patternEligibleCells = eligible.reduce((sum, value) => sum + value, 0);
  metrics.patternIneligibleCells = dense.keys.length - metrics.patternEligibleCells;
  return eligible;
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

function compileGoalPushTables(
  singleBoxGraph,
  goals,
  metrics = createPerformanceMetrics(),
  dense = null,
) {
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
    const distances = dense
      ? new DenseDistanceTable(dense, null, singleBoxGraph.nodes.size)
      : new Map();
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
    if (dense) {
      metrics.denseDistanceTables++;
      metrics.denseDistanceCells += dense.keys.length;
      metrics.denseDistanceBytes += distances.byteLength;
    }
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
  const distances = new DenseDistanceTable(
    board.dense,
    null,
    board.singleBoxGraph.nodes.size,
  );
  distances.set(startKey, 0);
  const seen = new Set(), queue = [];
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
  metrics.denseDistanceTables++;
  metrics.denseDistanceCells += board.dense.keys.length;
  metrics.denseDistanceBytes += distances.byteLength;
  metrics.pushDistanceMs += now() - started;
  return distances;
}

// --- Module registration ---
const SokomindBoard = {
  PREPARED_BOARD_SCHEMA,
  boardContentKey,
  estimatePreparedBoardBytes,
  estimatePreparedBoardSeedBytes,
  boardCacheMemorySnapshot,
  registerBoardMemoryCache,
  attachBoardMemorySampler,
  configureBoardCaches,
  createPreparedBoardSeed,
  preparedBoardMatches,
  hydratePreparedBoard,
  validatePuzzleRows,
  parse,
  compileDenseBoard,
  compilePatternEligibility,
  DenseDistanceTable,
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
if (typeof globalThis !== "undefined") globalThis.SokomindBoard = SokomindBoard;
if (typeof module === "object" && module.exports) module.exports = SokomindBoard;
