// Connected, hypothesis-scoped deductions. No rule here authorizes hard pruning.
function inferStrategicDependencies(plan, initial, board, maxWork) {
  const stats = {inferenceWork: 0, inferenceRounds: 0, matchingEdges: 0,
    supportedMatchingEdges: 0, supportOrderings: 0, deferredOrderingCycles: 0};
  const domains = new Map();
  for (const detail of cacheDiscoveryAssignmentDetail(initial.boxes, board).labels.values()) {
    const support = perfectMatchingDomains(detail);
    stats.matchingEdges += support.finiteEdges;
    stats.supportedMatchingEdges += support.allowedEdges;
    detail.boxIndices.forEach((boxIndex, row) => domains.set(boxIndex,
      support.allowedColumnsByRow[row].map(column => detail.targets[column])));
  }
  const commits = plan.tasks.filter(task => task.kind === "commit-goal" &&
    task.completesWhen.cells.length === 1);
  const byId = new Map(plan.tasks.map(task => [task.id, task]));
  const precedes = (task, ancestor, seen = new Set()) => {
    if (task.id === ancestor) return true;
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return task.dependsOn.some(id => precedes(byId.get(id), ancestor, seen));
  };
  const approaches = new Map();
  for (const task of commits) {
    if (stats.inferenceWork >= maxWork) break;
    stats.inferenceWork++;
    const target = task.completesWhen.cells[0];
    if (!domains.get(task.boxIndex)?.includes(target)) continue;
    const owners = [...domains].filter(([, goals]) => goals.includes(target)).map(([index]) => index);
    task.boxCandidates = owners;
    task.completesWhen = {kind: "goal-filled", cells: [target], label: initial.boxes[task.boxIndex][2]};
    const reachable = owners.map(index => {
      const box = initial.boxes[index];
      return playerAwarePushDistances(board, pkey(box[0], box[1]));
    });
    const [y, x] = target.split(",").map(Number);
    const alternatives = DIRECTION_ENTRIES.flatMap(([, [dy, dx]]) => {
      const predecessor = pkey(y - dy, x - dx), support = pkey(y - 2 * dy, x - 2 * dx);
      return board.floor.has(predecessor) && board.floor.has(support) && reachable.some(table => table.has(predecessor))
        ? [[predecessor, support]] : [];
    });
    if (!alternatives.length) continue;
    approaches.set(task.id, alternatives);
    if (plan.resources.length < 128) plan.resources.push({id: `support:${task.id}`,
      cells: [...new Set(alternatives.flat())], alternatives, consumerTaskId: task.id,
      availableFrom: "task-enabled", availableUntil: "task-complete"});
  }
  // Newly established orders feed later cycle/closure checks. Keep iterations
  // bounded and retain the original graph if a conditional cycle is discovered.
  let changed = true;
  const rejected = new Set();
  while (changed && stats.inferenceWork < maxWork) {
    changed = false; stats.inferenceRounds++;
    for (const consumer of commits) {
      const alternatives = approaches.get(consumer.id);
      if (!alternatives) continue;
      for (const closing of commits) {
        if (stats.inferenceWork >= maxWork) break;
        stats.inferenceWork++;
        if (consumer.id === closing.id || closing.dependsOn.includes(consumer.id)) continue;
        const occupiedGoal = closing.completesWhen.cells[0];
        if (!alternatives.every(route => route.includes(occupiedGoal))) continue;
        const key = `${consumer.id}>${closing.id}`;
        if (rejected.has(key)) continue;
        if (precedes(consumer, closing.id)) {
          rejected.add(key); stats.deferredOrderingCycles++; continue;
        }
        closing.dependsOn.push(consumer.id);
        closing.evidence.sourceIds.push(consumer.id);
        closing.evidence.rule = "matching-supported-final-push-order";
        stats.supportOrderings++; changed = true;
      }
    }
  }
  Object.assign(plan.statistics, stats, {inferenceTruncated: stats.inferenceWork >= maxWork});
}

function strategicResourceAvailable(resource, state, plan, owner) {
  const consumer = plan.tasks.find(task => task.id === resource.consumerTaskId);
  const occupied = new Set(state.boxes.flatMap((box, index) =>
    index === (owner ?? consumer.boxIndex) ? [] : [pkey(box[0], box[1])]));
  return (resource.alternatives || [resource.cells]).some(route => route.every(cell => !occupied.has(cell)));
}

function strategicCommitmentRisk(state, plan) {
  const occupied = new Map(state.boxes.map(box => [pkey(box[0], box[1]), box[2]]));
  const commitments = plan.tasks.filter(task => task.kind === "commit-goal");
  const filled = new Set(commitments.filter(task => occupied.get(task.completesWhen.cells[0]) ===
    (task.completesWhen.label ?? state.boxes[task.boxIndex][2])).map(task => task.id));
  const committedCells = new Set(commitments.filter(task => filled.has(task.id))
    .map(task => task.completesWhen.cells[0]));
  // Several individually harmless goal placements can jointly close every
  // approach. Treat this as a predicted unfill/clearance cost, never a deadlock.
  return plan.resources.filter(resource => resource.alternatives && !filled.has(resource.consumerTaskId) &&
    resource.alternatives.every(route => route.some(cell => committedCells.has(cell)))).length;
}

function strategicExecutionAgenda(state, plan, board) {
  const progress = evaluateStrategicPlanState(state, plan);
  const enabled = new Set(progress.enabled);
  const assignment = cacheDiscoveryAssignmentDetail(state.boxes, board).assignedTargets;
  const ownerOf = task => task.completesWhen.kind === "goal-filled"
    ? [...assignment].find(([index, goal]) => goal === task.completesWhen.cells[0] &&
        task.boxCandidates?.includes(index))?.[0] ?? task.boxIndex : task.boxIndex;
  // A witnessed parking position is one realization, not a standing obligation
  // to return a box there after its consumer has moved on.
  const risk = strategicCommitmentRisk(state, plan);
  const agenda = plan.tasks.filter(task => enabled.has(task.id) && task.kind !== "stage").filter(task => {
    if (task.kind !== "commit-goal") return true;
    const owner = ownerOf(task), boxes = state.boxes.slice();
    boxes[owner] = [...task.completesWhen.cells[0].split(",").map(Number), boxes[owner][2]];
    return strategicCommitmentRisk({...state, boxes}, plan) <= risk;
  }).map(task => ({
    id: task.id, kind: task.kind, boxIndex: ownerOf(task),
    participants: [ownerOf(task)], destinations: new Set(task.completesWhen.cells),
  }));
  const clearance = new Set();
  for (const resource of plan.resources) {
    const consumer = plan.tasks.find(task => task.id === resource.consumerTaskId);
    const owner = ownerOf(consumer);
    if (!enabled.has(resource.consumerTaskId) || strategicResourceAvailable(resource, state, plan, owner)) continue;
    // Offer clearance for each blocked alternative instead of requiring every
    // final-push approach to be empty simultaneously.
    for (const route of resource.alternatives || [resource.cells]) {
      state.boxes.forEach((box, boxIndex) => {
        const clearanceKey = JSON.stringify([boxIndex, route]);
        if (boxIndex === owner || !route.includes(pkey(box[0], box[1])) ||
            clearance.has(clearanceKey) || clearance.size >= 8) return;
        const reachable = playerAwarePushDistances(board, pkey(box[0], box[1]));
        const destinations = new Set([...board.floor].filter(cell => reachable.has(cell) &&
          !route.includes(cell) && !staticDead(...cell.split(",").map(Number), board, box[2])));
        if (!destinations.size) return;
        clearance.add(clearanceKey);
        agenda.unshift({id: `clear:${boxIndex}:${resource.id}:${route.join(";")}`, kind: "stage", boxIndex, forTaskId: consumer.id,
          participants: [boxIndex, owner], destinations});
      });
    }
  }
  return agenda;
}

function strategicMacroObjective(boxIndex, agenda, board, tables) {
  const priority = {release: 0, stage: 1, export: 2, "commit-goal": 3};
  const task = agenda.filter(task => task.boxIndex === boxIndex)
    .sort((a, b) => priority[a.kind] - priority[b.kind])[0];
  if (!task) return null;
  const signature = JSON.stringify([task.boxIndex, [...task.destinations].sort()]);
  let distances = tables.get(signature);
  if (!distances) {
    distances = new Map([...task.destinations].map(cell => [cell, 0]));
    const queue = [...task.destinations];
    for (let head = 0; head < queue.length; head++) {
      const [y, x] = queue[head].split(",").map(Number);
      for (const [, [dy, dx]] of DIRECTION_ENTRIES) {
        const previous = pkey(y - dy, x - dx);
        if (distances.has(previous) || !board.floor.has(previous) || !board.floor.has(pkey(y - 2 * dy, x - 2 * dx))) continue;
        distances.set(previous, distances.get(queue[head]) + 1); queue.push(previous);
      }
    }
    if (tables.size < 128) tables.set(signature, distances);
  }
  return {taskId: task.id, kind: task.kind, targetDistances: distances};
}
