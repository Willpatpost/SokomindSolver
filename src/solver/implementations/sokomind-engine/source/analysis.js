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
if (typeof globalThis !== "undefined") globalThis.SokomindAnalysis = SokomindAnalysis;
globalThis.SokomindHardPruningRules = HARD_PRUNING_RULES;
if (typeof module === "object" && module.exports) module.exports = SokomindAnalysis;
