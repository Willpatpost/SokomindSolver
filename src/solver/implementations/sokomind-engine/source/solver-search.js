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
