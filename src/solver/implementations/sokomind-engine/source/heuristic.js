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
    labels.set(label, {
      boxIndices: entries.map(entry => entry.index),
      targets,
      costs,
      assignment,
    });
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

function perfectMatchingDomains(labelDetail) {
  if (labelDetail.matchingDomains) return labelDetail.matchingDomains;
  const {boxIndices, targets, costs, assignment} = labelDetail;
  const size = boxIndices.length;
  const finiteColumns = Array.from({length: size}, (_, row) => {
    const columns = [];
    for (let column = 0; column < (costs[row]?.length || 0); column++) {
      if (Number.isFinite(costs[row][column])) columns.push(column);
    }
    return columns;
  });
  const finiteEdges = finiteColumns.reduce((sum, columns) => sum + columns.length, 0);
  const cache = (complete, allowedColumnsByRow, reason = null) => {
    const matchingDomains = {
      method: "allowed-perfect-matching-edges",
      complete,
      reason,
      allowedColumnsByRow,
      finiteEdges,
      allowedEdges: allowedColumnsByRow.reduce((sum, columns) => sum + columns.length, 0),
    };
    labelDetail.matchingDomains = matchingDomains;
    return matchingDomains;
  };
  const failOpen = reason => cache(false, finiteColumns, reason);
  if (targets.length !== size || costs.length !== size ||
      costs.some(row => !Array.isArray(row) || row.length !== size)) {
    return failOpen("unbalanced-domain");
  }
  if (!Number.isFinite(assignment?.cost) || assignment.matching?.length !== size + 1) {
    return failOpen("infeasible-assignment");
  }

  const matchedColumnByRow = Array(size).fill(-1);
  for (let column = 0; column < size; column++) {
    const row = assignment.matching[column + 1] - 1;
    if (!Number.isInteger(row) || row < 0 || row >= size ||
        matchedColumnByRow[row] !== -1 || !Number.isFinite(costs[row][column])) {
      return failOpen("invalid-matching-witness");
    }
    matchedColumnByRow[row] = column;
  }

  // Contract every matched box-goal edge. A non-matching edge belongs to some
  // perfect matching exactly when its endpoints lie on an alternating cycle.
  const adjacency = Array.from({length: size}, () => []);
  for (let row = 0; row < size; row++) {
    for (const column of finiteColumns[row]) {
      if (column === matchedColumnByRow[row]) continue;
      adjacency[row].push(assignment.matching[column + 1] - 1);
    }
  }
  const reaches = adjacency.map((_, origin) => {
    const seen = Array(size).fill(false);
    const stack = [origin];
    seen[origin] = true;
    while (stack.length) {
      const row = stack.pop();
      for (let index = adjacency[row].length - 1; index >= 0; index--) {
        const next = adjacency[row][index];
        if (seen[next]) continue;
        seen[next] = true;
        stack.push(next);
      }
    }
    return seen;
  });
  const allowedColumnsByRow = finiteColumns.map((columns, row) =>
    columns.filter(column => {
      if (column === matchedColumnByRow[row]) return true;
      const matchedRow = assignment.matching[column + 1] - 1;
      return reaches[row][matchedRow] && reaches[matchedRow][row];
    }));
  return cache(true, allowedColumnsByRow);
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
  const positions = boxes.map(([y, x]) => pkey(y, x));
  const occupied = new Set(positions);
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
  const positions = boxes.map(([y, x]) => pkey(y, x));
  const occupied = new Set(positions);
  const domainsByBoxIndex = new Map();
  const labelDomains = [];
  let finiteEdges = 0, allowedEdges = 0;
  for (const [label, detail] of assignment.labels) {
    const domains = perfectMatchingDomains(detail);
    finiteEdges += domains.finiteEdges;
    allowedEdges += domains.allowedEdges;
    labelDomains.push({
      label,
      complete: domains.complete,
      reason: domains.reason,
      boxes: detail.boxIndices.length,
      finiteEdges: domains.finiteEdges,
      allowedEdges: domains.allowedEdges,
    });
    detail.boxIndices.forEach((boxIndex, row) => {
      domainsByBoxIndex.set(boxIndex, {
        complete: domains.complete,
        targets: domains.allowedColumnsByRow[row].map(column => detail.targets[column]),
      });
    });
  }
  const tasks = [];
  let optionalCrossings = 0, stationaryRelations = 0, unclassifiedRelations = 0;
  let classificationComplete = true;
  for (let roomIndex = 0; roomIndex < board.topology.rooms.length; roomIndex++) {
    const room = board.topology.rooms[roomIndex];
    boxes.forEach(([y, x, label], boxIndex) => {
      const box = pkey(y, x), target = assignment.assignedTargets.get(boxIndex);
      const domain = domainsByBoxIndex.get(boxIndex);
      if (!domain?.complete || !domain.targets.length || !target ||
          !domain.targets.includes(target)) {
        classificationComplete = false;
        unclassifiedRelations++;
        return;
      }
      const inside = room.cells.has(box);
      let hasInsideTarget = false, hasOutsideTarget = false;
      for (const allowedTarget of domain.targets) {
        if (room.cells.has(allowedTarget)) hasInsideTarget = true;
        else hasOutsideTarget = true;
      }
      if (hasInsideTarget && hasOutsideTarget) {
        optionalCrossings++;
        return;
      }
      const direction = inside && hasOutsideTarget
        ? "export" : !inside && hasInsideTarget ? "import" : null;
      if (direction) {
        tasks.push({
          box,
          boxIndex,
          label,
          target,
          allowedTargets: [...domain.targets],
          direction,
          roomIndex,
          gate: room.gate,
        });
      } else stationaryRelations++;
    });
  }
  let penalty = tasks.length;
  for (const room of board.topology.rooms) {
    const crossings = tasks.filter(task => task.gate === room.gate).length;
    if (crossings && occupied.has(room.gate)) penalty += 2 * crossings;
  }
  assignment.doorwayPlan = {
    tasks,
    penalty,
    proof: {
      method: "allowed-perfect-matching-edges",
      complete: classificationComplete && labelDomains.every(domain => domain.complete),
      labelDomains,
      boxDomains: boxes.map(([y, x, label], boxIndex) => {
        const domain = domainsByBoxIndex.get(boxIndex);
        return {
          box: pkey(y, x),
          boxIndex,
          label,
          complete: domain?.complete === true,
          allowedTargets: [...(domain?.targets || [])],
        };
      }),
      finiteEdges,
      allowedEdges,
      eliminatedEdges: finiteEdges - allowedEdges,
      mandatoryCrossings: tasks.length,
      optionalCrossings,
      stationaryRelations,
      unclassifiedRelations,
    },
  };
  return assignment.doorwayPlan;
}

const DOORWAY_TASK_PARTITION_MEMO = new WeakMap();
const ROOM_INTERFACE_POLICY_MEMO = new WeakMap();

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

function doorwayTaskTargets(task) {
  return task.allowedTargets?.length ? task.allowedTargets : task.target ? [task.target] : [];
}

function preferredDoorwayTaskTarget(task, position, board) {
  const targets = doorwayTaskTargets(task);
  let preferred = null, bestDistance = Infinity;
  for (const target of targets) {
    const distance = compiledGoalPushDistance(board, position, target);
    if (distance < bestDistance ||
        (distance === bestDistance && target === task.target)) {
      preferred = target;
      bestDistance = distance;
    }
  }
  return {target: preferred, distance: bestDistance};
}

function doorwayClearanceRequirement(exports, imports, room) {
  if (!exports.length || !imports.length) {
    return Object.freeze({
      minimumExportsBeforeFirstImport: 0,
      lateralExportCounts: Object.freeze([0, 0]),
      method: "no-mixed-flow",
      hardPruning: false,
    });
  }
  const baseline = Math.min(
    exports.length,
    Math.max(1, exports.length - imports.length + 1),
  );
  const lane = room.doorwayLanes.find(candidate =>
    candidate.importPossible && candidate.exportPossible) || room.doorwayLanes[0];
  if (!lane) {
    return Object.freeze({
      minimumExportsBeforeFirstImport: baseline,
      lateralExportCounts: Object.freeze([0, 0]),
      method: "flow-balance",
      hardPruning: false,
    });
  }
  const [gateY, gateX] = room.gate.split(",").map(Number);
  const [insideY, insideX] = lane.inside.split(",").map(Number);
  const vertical = insideY !== gateY;
  const inwardY = insideY - gateY, inwardX = insideX - gateX;
  // Room graph depth can route around the edge of a packed row and make its
  // centre look artificially deeper. For doorway clearance, use the axial
  // layer measured from the inside landing cell so a full cross-door barrier
  // (such as Grand Hall's six-box row) is recognized as one layer.
  const depths = exports.map(task => {
    const [y, x] = task.box.split(",").map(Number);
    const axialDepth = (y - insideY) * inwardY + (x - insideX) * inwardX;
    return axialDepth >= 0 ? axialDepth : Infinity;
  });
  const barrierDepth = Math.min(...depths);
  const barrier = exports.filter((task, index) => depths[index] === barrierDepth);
  let negative = 0, positive = 0;
  for (const task of barrier) {
    const [y, x] = task.box.split(",").map(Number);
    const offset = vertical ? x - insideX : y - insideY;
    if (offset < 0) negative++;
    else if (offset > 0) positive++;
  }
  // A shallow barrier on both sides of a one-cell doorway needs one side
  // cleared plus one box on the other side before an imported box can be
  // staged without sealing the keeper away from the packing side. This is an
  // ordering recommendation only: irregular room geometry is deliberately
  // allowed to prove it unnecessary during the real search.
  const barrierRecommendation = negative && positive
    ? Math.min(exports.length, Math.min(negative, positive) + 1)
    : 0;
  return Object.freeze({
    minimumExportsBeforeFirstImport: Math.max(baseline, barrierRecommendation),
    lateralExportCounts: Object.freeze([negative, positive]),
    barrierDepth: Number.isFinite(barrierDepth) ? barrierDepth : null,
    method: barrierRecommendation > baseline
      ? "shallow-two-sided-barrier" : "flow-balance",
    hardPruning: false,
  });
}

function doorwayAllowedImports(
  exportCount,
  importCount,
  completedExports,
  minimumExportsBeforeFirstImport,
) {
  if (!importCount || completedExports < minimumExportsBeforeFirstImport) return 0;
  if (completedExports >= exportCount) return importCount;
  const permanentSurplus = Math.max(0, exportCount - importCount);
  return Math.min(importCount, Math.max(0, completedExports - permanentSurplus));
}

function roomInterfacePolicyTables(tasks, board) {
  const cached = ROOM_INTERFACE_POLICY_MEMO.get(tasks);
  if (cached?.length === board.topology.rooms.length) return cached;
  const partitions = doorwayTaskPartitions(tasks, board.topology.rooms.length);
  const tables = partitions.map(({exports, imports}, roomIndex) => {
    const room = board.topology.rooms[roomIndex];
    const clearance = doorwayClearanceRequirement(
      exports,
      imports,
      room,
    );
    const targetLabels = new Map();
    room.goals.forEach(goal => {
      const label = board.goals.get(goal);
      targetLabels.set(label, (targetLabels.get(label) || 0) + 1);
    });
    const states = new Map();
    for (let pendingExports = 0; pendingExports <= exports.length; pendingExports++) {
      for (let remainingImports = 0; remainingImports <= imports.length; remainingImports++) {
        for (const keeperSide of ["inside", "outside"]) {
          const actions = [];
          const completedExports = exports.length - pendingExports;
          const imported = imports.length - remainingImports;
          const allowedImports = doorwayAllowedImports(
            exports.length,
            imports.length,
            completedExports,
            clearance.minimumExportsBeforeFirstImport,
          );
          const importsUnlocked = imported < allowedImports;
          if (pendingExports > 0) actions.push("export");
          if (remainingImports > 0 && importsUnlocked) actions.push("import");
          if (!pendingExports && !remainingImports) actions.push("pack");
          states.set(
            `${pendingExports}|${remainingImports}|${keeperSide}`,
            Object.freeze({
              pendingExports,
              remainingImports,
              keeperSide,
              minimumCrossings: pendingExports + remainingImports,
              allowedImports,
              preferredAction: remainingImports > 0 && importsUnlocked
                ? "import" : pendingExports > 0 ? "export" : "pack",
              actions: Object.freeze(actions),
            }),
          );
        }
      }
    }
    return Object.freeze({
      maximumExports: exports.length,
      maximumImports: imports.length,
      targetLabels,
      ...clearance,
      proofScope: "permissive-boundary-overapproximation",
      hardPruning: false,
      states,
    });
  });
  ROOM_INTERFACE_POLICY_MEMO.set(tasks, tables);
  return tables;
}

function roomInterfaceStates(boxes, board, tasks, robot = null) {
  const occupied = new Set(boxes.map(([y, x]) => pkey(y, x)));
  const partitions = doorwayTaskPartitions(tasks, board.topology.rooms.length);
  const tables = roomInterfacePolicyTables(tasks, board);
  return board.topology.rooms.map((room, roomIndex) => {
    const {exports, imports} = partitions[roomIndex];
    const pendingExports = exports.filter(task => {
      const [y, x] = boxes[task.boxIndex];
      const position = pkey(y, x);
      return room.cells.has(position) || position === room.gate;
    }).length;
    const remainingImports = imports.filter(task => {
      const [y, x] = boxes[task.boxIndex];
      return !room.cells.has(pkey(y, x));
    }).length;
    const keeperPosition = robot ? pkey(robot[0], robot[1]) : null;
    const keeperSide = keeperPosition && room.cells.has(keeperPosition)
      ? "inside" : "outside";
    const policy = tables[roomIndex].states.get(
      `${pendingExports}|${remainingImports}|${keeperSide}`,
    );
    const stagingOccupied = [...room.exteriorStaging]
      .filter(position => occupied.has(position)).length;
    return Object.freeze({
      roomIndex,
      gate: room.gate,
      keeperSide,
      gateOccupied: occupied.has(room.gate),
      stagingOccupied,
      stagingCapacity: room.exteriorStaging.size,
      pendingExports,
      remainingImports,
      minimumExportsBeforeFirstImport:
        tables[roomIndex].minimumExportsBeforeFirstImport,
      clearanceMethod: tables[roomIndex].method,
      lateralExportCounts: tables[roomIndex].lateralExportCounts,
      minimumCrossings: policy?.minimumCrossings ?? pendingExports + remainingImports,
      allowedImports: policy?.allowedImports ?? 0,
      preferredAction: policy?.preferredAction ?? "pack",
      availableActions: policy?.actions ?? Object.freeze([]),
      proofScope: tables[roomIndex].proofScope,
      hardPruning: false,
    });
  });
}

function doorwayCrossingReachable(board, geometry, indexByCell) {
  const start = indexByCell[geometry.gateId] < 0
    ? geometry.gateId
    : geometry.cellIds.find(cell => indexByCell[cell] < 0);
  const accessible = new Set(start !== undefined ? [board.dense.keys[start]] : []);
  const queue = start !== undefined ? [start] : [];
  for (let head = 0; head < queue.length; head++) {
    for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
      const cell = board.dense.neighbors[queue[head] * DIRECTION_ENTRIES.length + direction];
      if (cell < 0 || indexByCell[cell] >= 0) continue;
      const next = board.dense.keys[cell];
      if (accessible.has(next)) continue;
      accessible.add(next);
      queue.push(cell);
    }
  }
  return accessible;
}

function doorwayScheduleState(boxes, board, tasks, preparedLayout = null) {
  const started = now();
  board.metrics.doorwayScheduleCalls++;
  let penalty = 0, pendingExports = 0, remainingImports = 0;
  let prematureImports = 0, gateBlockers = 0, crossingConflicts = 0;
  let crossingDistance = 0, packingDistance = 0, unpackedImports = 0;
  let stagingBlockers = 0, strandedExports = 0, blockedImportAccess = 0;
  let packingOrderViolations = 0;
  let evacuationPenalty = 0;
  const positions = boxes.map(([y, x]) => pkey(y, x));
  const layout = preparedLayout || denseBoxLayout(boxes, board);
  const indexByCell = ensureIndexByCell(layout, board);
  const occupiedIndex = position => {
    const cell = board.dense.idByKey.get(position);
    return cell === undefined ? -1 : indexByCell[cell];
  };
  const isOccupied = position => occupiedIndex(position) >= 0;
  const occupiedLabel = position => {
    const index = occupiedIndex(position);
    return index < 0 ? undefined : boxes[index][2];
  };
  const partitions = doorwayTaskPartitions(tasks, board.topology.rooms.length);
  const interfaceTables = roomInterfacePolicyTables(tasks, board);
  for (let roomIndex = 0; roomIndex < board.topology.rooms.length; roomIndex++) {
    const room = board.topology.rooms[roomIndex];
    const geometry = board.topology.transportGeometry[roomIndex];
    const {exports, imports} = partitions[roomIndex];
    const insideRoomIndices = [];
    for (let boxIndex = 0; boxIndex < boxes.length; boxIndex++) {
      if (geometry.inside[layout.cells[boxIndex]]) insideRoomIndices.push(boxIndex);
    }
    const currentLabels = new Map();
    const targetLabels = interfaceTables[roomIndex].targetLabels;
    insideRoomIndices.forEach(boxIndex => {
      const label = boxes[boxIndex][2];
      currentLabels.set(label, (currentLabels.get(label) || 0) + 1);
    });
    let roomSurplus = 0;
    currentLabels.forEach((count, label) => {
      roomSurplus += Math.max(0, count - (targetLabels.get(label) || 0));
    });
    if (roomSurplus) {
      evacuationPenalty += 20 * insideRoomIndices.length + 8 * roomSurplus;
      for (const [position, distance] of room.approach) {
        if (isOccupied(position)) evacuationPenalty += 3 * (4 - distance);
      }
    }
    const pending = exports.filter(task => {
      const cell = layout.cells[task.boxIndex];
      return geometry.inside[cell] || cell === geometry.gateId;
    });
    const pendingSet = new Set(pending);
    const imported = imports.filter(task => {
      return geometry.inside[layout.cells[task.boxIndex]];
    });
    const unpacked = imported.filter(task => {
      const targets = doorwayTaskTargets(task);
      return targets.length > 0 && !targets.includes(positions[task.boxIndex]);
    });
    const blocking = imports.filter(task => {
      return positions[task.boxIndex] === room.gate;
    });
    const completedExports = exports.length - pending.length;
    const requiredExportLead = interfaceTables[roomIndex]
      .minimumExportsBeforeFirstImport;
    const allowedImports = doorwayAllowedImports(
      exports.length,
      imports.length,
      completedExports,
      requiredExportLead,
    );
    const importSlots = Math.max(
      0,
      Math.min(
        imports.length - imported.length,
        allowedImports - imported.length,
      ),
    );
    const excessImports = Math.max(0, imported.length - allowedImports);
    const blockedImports = blocking.length && imported.length >= allowedImports
      ? blocking.length : 0;
    const conflicts = isOccupied(room.gate)
      ? room.doorwayLanes.filter(lane =>
        isOccupied(lane.inside) || isOccupied(lane.outside)).length
      : 0;
    const exportedInApproach = exports.filter(task => {
      return !pendingSet.has(task) && room.exteriorStaging.has(positions[task.boxIndex]);
    });
    const blockedStaging = pending.length && exportedInApproach.length
      ? [...room.exteriorStaging].filter(position =>
        isOccupied(position)).length
      : !pending.length && imported.length < imports.length
        ? exportedInApproach.length
        : 0;
    let accessible = null;
    const crossingAccessible = () => {
      accessible ??= doorwayCrossingReachable(board, geometry, indexByCell);
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
          return board.floor.has(destination) && !isOccupied(destination) &&
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
          return board.floor.has(destination) && !isOccupied(destination) &&
            reached.has(support) && nextDistance < currentDistance &&
            !staticDead(y + dy, x + dx, board, task.label) &&
            !createsDynamicDeadlock(candidateBoxes, board, [y + dy, x + dx]);
        });
      }).length;
    }
    const packingViolations = room.dependencies.filter(([blocker, prerequisite]) =>
      occupiedLabel(blocker) === board.goals.get(blocker) &&
      occupiedLabel(prerequisite) !== board.goals.get(prerequisite),
    ).length;
    if (importSlots > 0) {
      const waitingImportCount = imports.length - imported.length;
      if (importSlots === 1) {
        let minimumDistance = Infinity;
        for (const task of imports) {
          if (room.cells.has(positions[task.boxIndex])) continue;
          minimumDistance = Math.min(
            minimumDistance,
            playerAwarePushDistances(
              board,
              positions[task.boxIndex],
            ).get(room.gate) ?? Infinity,
          );
        }
        crossingDistance += Number.isFinite(minimumDistance)
          ? Math.min(12, minimumDistance + 1) : 12;
      } else if (importSlots >= waitingImportCount) {
        for (const task of imports) {
          if (room.cells.has(positions[task.boxIndex])) continue;
          const distance = playerAwarePushDistances(
            board,
            positions[task.boxIndex],
          ).get(room.gate);
          crossingDistance += Number.isFinite(distance)
            ? Math.min(12, distance + 1) : 12;
        }
      } else {
        const waitingImportDistances = [];
        for (const task of imports) {
          if (room.cells.has(positions[task.boxIndex])) continue;
          waitingImportDistances.push(playerAwarePushDistances(
            board,
            positions[task.boxIndex],
          ).get(room.gate) ?? Infinity);
        }
        waitingImportDistances.sort((left, right) => left - right);
        for (let index = 0; index < importSlots; index++) {
          const distance = waitingImportDistances[index];
          crossingDistance += Number.isFinite(distance)
            ? Math.min(12, distance + 1) : 12;
        }
      }
    } else {
      for (const task of pending) {
        const distance = playerAwarePushDistances(
          board,
          positions[task.boxIndex],
        ).get(room.gate);
        crossingDistance += Number.isFinite(distance)
          ? Math.min(12, distance + 1) : 12;
      }
    }
    for (const task of unpacked) {
      const {distance} = preferredDoorwayTaskTarget(
        task,
        positions[task.boxIndex],
        board,
      );
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
    evacuationPenalty,
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

function evaluateGoalAccessSummary(goalAccess, occupied) {
  let penalty = 0;
  const blockedGoals = [];
  for (const entry of goalAccess) {
    const solved = occupied.get(entry.goal) === entry.label;
    let openLanes = 0;
    for (const lane of entry.lanes) {
      const sourceLabel = occupied.get(lane.source);
      const supportLabel = occupied.get(lane.support);
      if (supportLabel === undefined &&
          (sourceLabel === undefined || sourceLabel === entry.label)) openLanes++;
    }
    if (!solved && entry.lanes.length) {
      penalty += (entry.lanes.length - openLanes) / entry.lanes.length;
      if (!openLanes) penalty += 4;
      else if (openLanes === 1 && entry.lanes.length > 1) penalty += 0.5;
    }
    if (!solved && !openLanes) blockedGoals.push({goal: entry.goal});
  }
  return {penalty, blockedGoals};
}

function ensureGoalAccessPackingRisk(result, boxes, board) {
  if (result.packingRisk instanceof Map) return result.packingRisk;
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const packingRisk = new Map(), safeGoals = new Set();
  for (const goal of result.goals) {
    if (goal.solved) continue;
    let risk = 5;
    if (!occupied.has(goal.goal)) {
      const packed = new Map(occupied);
      packed.set(goal.goal, goal.label);
      risk = evaluateGoalAccess(board.topology.goalAccess, packed).penalty - result.penalty;
    }
    packingRisk.set(goal.goal, risk);
    if (risk <= 0) safeGoals.add(goal.goal);
  }
  result.packingRisk = packingRisk;
  result.safeGoals = safeGoals;
  return packingRisk;
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
  // Packing risk is only consumed by relevance ordering in the ordinary beam
  // lanes. The structural planner needs penalty/blockedGoals only, so avoid
  // reevaluating every goal lane for its thousands of transient candidates.
  result.packingRisk = null;
  result.safeGoals = null;
  metrics.goalAccessBlockedGoals += result.blockedGoals.length;
  metrics.goalAccessMs += now() - started;
  return memoizeBounded(
    board.goalAccessMemo,
    signature,
    result,
    GOAL_ACCESS_MEMO_LIMIT,
  );
}

function goalAccessSummary(boxes, board) {
  const metrics = board.metrics;
  metrics.goalAccessCalls++;
  const started = now();
  const occupied = new Map(boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const result = evaluateGoalAccessSummary(board.topology.goalAccess, occupied);
  metrics.goalAccessBlockedGoals += result.blockedGoals.length;
  metrics.goalAccessMs += now() - started;
  return result;
}

function goalAccessDelta(analysis, state, next, board) {
  const occupied = new Map(state.boxes.map(([y, x, label]) => [pkey(y, x), label]));
  const label = occupied.get(next.pushedFrom);
  if (label === undefined) return 0;
  occupied.delete(next.pushedFrom);
  occupied.set(next.pushedTo, label);
  const result = analysis.goals
    ? evaluateGoalAccess(board.topology.goalAccess, occupied)
    : evaluateGoalAccessSummary(board.topology.goalAccess, occupied);
  return result.penalty - analysis.penalty;
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
  const packingRisk = goalAccess
    ? ensureGoalAccessPackingRisk(goalAccess, state.boxes, board)
    : null;
  const targetPackingRisk = target && packingRisk?.get(target) || 0;
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
  perfectMatchingDomains,
  assignmentDoorwayPlan,
  DOORWAY_TASK_PARTITION_MEMO,
  doorwayTaskPartitions,
  ROOM_INTERFACE_POLICY_MEMO,
  roomInterfacePolicyTables,
  roomInterfaceStates,
  doorwayTaskTargets,
  preferredDoorwayTaskTarget,
  doorwayClearanceRequirement,
  doorwayAllowedImports,
  doorwayScheduleState,
  ensureGoalAccessPackingRisk,
  typedDoorwayFlow,
  doorwayFlowDelta,
  evaluateGoalAccess,
  evaluateGoalAccessSummary,
  goalAccessAnalysis,
  goalAccessSummary,
  goalAccessDelta,
  relevanceOrderingScore,
  recordRelevanceOrdering,
  roomFlowSignature,
  roomTransitionEvent,
};
if (typeof globalThis !== "undefined") globalThis.SokomindHeuristic = SokomindHeuristic;
if (typeof module === "object" && module.exports) module.exports = SokomindHeuristic;
