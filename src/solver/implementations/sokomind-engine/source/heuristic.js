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
if (typeof globalThis !== "undefined") globalThis.SokomindHeuristic = SokomindHeuristic;
if (typeof module === "object" && module.exports) module.exports = SokomindHeuristic;
