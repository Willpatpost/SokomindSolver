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
if (typeof globalThis !== "undefined") globalThis.SokomindBoard = SokomindBoard;
if (typeof module === "object" && module.exports) module.exports = SokomindBoard;
