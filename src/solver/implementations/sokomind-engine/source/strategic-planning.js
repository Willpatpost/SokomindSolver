// Bounded full-board simulation of transport tasks before discovery search.
// All non-participating boxes remain obstacles. A failed task is inconclusive.
function strategicSnapshotKey(data) {
  return JSON.stringify([data.rows, data.robot, data.boxes]);
}

function strategicLimit(value, fallback, maximum) {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : fallback;
}

function strategicTasks(state, board, doorwayTasks, transit) {
  const tasks = [];
  const positions = state.boxes.map(([y, x]) => pkey(y, x));
  for (const commitment of transit.commitments) {
    for (const prerequisite of commitment.prerequisites) {
      if (prerequisite.releaseCells.includes(positions[prerequisite.boxIndex])) continue;
      tasks.push({
        id: `release:${prerequisite.boxIndex}:${commitment.boxIndex}`,
        kind: "release",
        boxIndex: prerequisite.boxIndex,
        participants: [prerequisite.boxIndex, commitment.boxIndex],
        destinations: new Set(prerequisite.releaseCells),
      });
    }
  }
  for (const task of doorwayTasks) {
    const room = board.topology.rooms[task.roomIndex];
    if (task.direction !== "export" ||
        (!room.cells.has(positions[task.boxIndex]) && positions[task.boxIndex] !== room.gate)) continue;
    tasks.push({
      id: `export:${task.boxIndex}:${task.roomIndex}`,
      kind: "export", boxIndex: task.boxIndex, participants: [task.boxIndex],
      destinations: new Set([...board.floor].filter(cell =>
        cell !== room.gate && !room.cells.has(cell))),
    });
  }
  const assignment = cacheDiscoveryAssignmentDetail(state.boxes, board).assignedTargets;
  for (let index = 0; index < state.boxes.length; index++) {
    const target = assignment.get(index);
    if (!target || positions[index] === target) continue;
    if (tasks.some(task => task.kind === "export" && task.boxIndex === index)) continue;
    if (transit.commitments.some(commitment => commitment.boxIndex === index &&
        commitment.target === target && commitment.prerequisites.some(prerequisite =>
          !prerequisite.releaseCells.includes(positions[prerequisite.boxIndex])))) continue;
    tasks.push({id: `deliver:${index}:${target}`, kind: "deliver", boxIndex: index,
      participants: [index], destinations: new Set([target])});
  }
  return tasks;
}

function strategicTaskDistances(task, board, budget) {
  // Multi-source relaxed push distances guide local simulation toward the task
  // boundary. Uniform move-cost exploration spends its budget on nearby walks.
  const cached = budget.distanceTables.get(task.id);
  if (cached) { budget.distanceCacheHits++; return cached; }
  const distances = new Map([...task.destinations].map(cell => [cell, 0]));
  const queue = [...task.destinations];
  for (let head = 0; head < queue.length; head++) {
    if (head % 64 === 0 && now() >= budget.deadline) return null;
    const cell = queue[head], [y, x] = cell.split(",").map(Number);
    for (const [, [dy, dx]] of DIRECTION_ENTRIES) {
      const previous = pkey(y - dy, x - dx);
      if (distances.has(previous) || !board.floor.has(previous) ||
          !board.floor.has(pkey(y - 2 * dy, x - 2 * dx))) continue;
      distances.set(previous, distances.get(cell) + 1);
      queue.push(previous);
    }
  }
  // Task IDs encode their fixed destination domain. Tables never cross a
  // planning request and are independent of temporary box occupancy.
  if (budget.distanceTables.size < 64) {
    budget.distanceTables.set(task.id, distances);
    budget.distanceEntries += distances.size;
  }
  return distances;
}

function simulateStrategicTask(start, task, board, budget, options) {
  if (!options.taskExpanded || !options.taskPushes || !options.taskResults) return [];
  const distances = strategicTaskDistances(task, board, budget);
  if (!distances) return [];
  const priority = state => {
    const box = state.boxes[task.boxIndex];
    return state.path.length + 3 * (distances.get(pkey(box[0], box[1])) ?? 10000);
  };
  const open = new Heap();
  const root = {...start, path: [], pushes: 0};
  open.push([priority(root), root]);
  const seen = new Map([[JSON.stringify([root.robot, root.boxes]), 0]]);
  const endpoints = [];
  const obstructions = new Map();
  let expanded = 0;
  while (open.length && expanded < options.taskExpanded &&
      budget.expanded < options.maxExpanded && budget.generated < options.maxGenerated && now() < budget.deadline) {
    const current = open.pop()[1];
    const identity = JSON.stringify([current.robot, current.boxes]);
    if (seen.get(identity) !== current.path.length) continue;
    expanded++;
    budget.expanded++;
    const box = current.boxes[task.boxIndex];
    if (current.path.length && task.destinations.has(pkey(box[0], box[1]))) {
      endpoints.push(current);
      if (endpoints.length >= options.taskResults) break;
      continue;
    }
    if (current.pushes >= options.taskPushes) continue;
    const reachable = reachablePaths(current, board);
    const activeBox = current.boxes[task.boxIndex];
    const activeId = board.dense.idByKey.get(pkey(activeBox[0], activeBox[1]));
    for (let direction = 0; direction < DIRECTION_ENTRIES.length; direction++) {
      const destination = board.dense.neighbors[activeId * 4 + direction];
      if (destination < 0 || (distances.get(board.dense.keys[destination]) ?? Infinity) >=
          (distances.get(pkey(activeBox[0], activeBox[1])) ?? Infinity)) continue;
      const support = board.dense.neighbors[activeId * 4 + OPPOSITE_DIRECTION_INDEX[direction]];
      for (const cell of [destination, support]) {
        const blocker = cell < 0 ? -1 : reachable.occupied[cell];
        if (blocker >= 0 && !task.participants.includes(blocker)) {
          obstructions.set(blocker, (obstructions.get(blocker) || 0) + 1);
        }
      }
    }
    for (const index of task.participants) {
      if (now() >= budget.deadline) break;
      const [y, x] = current.boxes[index];
      for (const next of pushBoxNeighbors(current, board, pkey(y, x), reachable, {lockProven: false})) {
        if (budget.generated >= options.maxGenerated) break;
        const path = [...current.path, ...next.path];
        if (path.length > options.pathLimit) continue;
        const key = JSON.stringify([next.robot, next.boxes]);
        if ((seen.get(key) ?? Infinity) <= path.length) continue;
        seen.set(key, path.length);
        budget.generated++;
        const child = {robot: next.robot, boxes: next.boxes, path, pushes: current.pushes + 1};
        open.push([priority(child), child]);
      }
    }
  }
  if (!endpoints.length && task.participants.length < 3 && obstructions.size &&
      budget.expanded < options.maxExpanded && budget.generated < options.maxGenerated && now() < budget.deadline) {
    const blocker = [...obstructions].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    budget.groupWidenings++;
    return simulateStrategicTask(start, {...task, participants: [...task.participants, blocker]},
      board, budget, options);
  }
  return endpoints;
}

function buildStrategicPlan(data, config = {}, prepared = undefined) {
  const started = now();
  const options = {
    maxMs: strategicLimit(config.maxMs, 250, 10000),
    maxExpanded: strategicLimit(config.maxExpanded, 4000, 20000),
    maxGenerated: strategicLimit(config.maxGenerated, 48000, 200000),
    taskExpanded: strategicLimit(config.taskExpanded, 64, 2000),
    taskPushes: strategicLimit(config.taskPushes, 20, 80),
    taskResults: strategicLimit(config.taskResults, 2, 4),
    width: strategicLimit(config.width, 4, 16),
    layers: strategicLimit(config.layers, 6, 12),
    pathLimit: 512,
  };
  const canonical = canonicalPlanTransform(data);
  const state = {rows: canonical.rows, robot: canonical.robot, boxes: canonical.boxes};
  const plan = {schemaVersion: 1, snapshotKey: strategicSnapshotKey(state),
    orientation: "canonical", candidates: [], options,
    statistics: {elapsedMs: 0, expanded: 0, generated: 0, tasksAttempted: 0, completedLayers: 0},
    status: "partial"};
  const budget = {expanded: 0, generated: 0, groupWidenings: 0, deadline: started + options.maxMs,
    distanceTables: new Map(), distanceEntries: 0, distanceCacheHits: 0};
  if (!options.maxMs || !options.maxExpanded || !options.maxGenerated || !options.width || !options.layers) {
    plan.statistics.elapsedMs = now() - started;
    return plan;
  }
  const reusable = canonical.transform.id === "identity" ? prepared : undefined;
  const board = reusable?.board || parse(state);
  const initial = {robot: state.robot, boxes: state.boxes.map(([cell, label]) =>
    [...cell.split(",").map(Number), label])};
  const doorway = reusable?.doorway || assignmentDoorwayPlan(initial.boxes, board, true);
  const transit = reusable?.transit || analyzeGoalTransitPrerequisites(initial, board, doorway);
  let beam = [{...initial, path: [], pushes: 0, tasks: []}];
  const retained = new Map();
  for (let layer = 0; layer < options.layers && now() < budget.deadline &&
      budget.expanded < options.maxExpanded && budget.generated < options.maxGenerated; layer++) {
    const candidates = [];
    for (const current of beam) {
      const tasks = strategicTasks(current, board, doorway.tasks, transit);
      for (const task of tasks) {
        if (now() >= budget.deadline || budget.expanded >= options.maxExpanded ||
            budget.generated >= options.maxGenerated) break;
        plan.statistics.tasksAttempted++;
        const endpoints = simulateStrategicTask(current, task, board, budget, options);
        for (const endpoint of endpoints) {
          const path = [...current.path, ...endpoint.path];
          if (path.length > options.pathLimit) continue;
          const child = {...endpoint, path, pushes: current.pushes + endpoint.pushes,
            tasks: [...current.tasks, task.id]};
          const remaining = discoveryHeuristic(child.boxes, board);
          child.estimatedRemainingPushes = remaining;
          const schedule = doorwayScheduleState(child.boxes, board, doorway.tasks);
          child.score = path.length + remaining + 4 * schedule.penalty +
            4 * goalAccessAnalysis(child.boxes, board).penalty;
          if (!Number.isFinite(child.score)) continue;
          candidates.push(child);
        }
      }
    }
    if (!candidates.length) break;
    candidates.sort((a, b) => a.score - b.score);
    beam = [];
    const represented = new Set();
    const taskKinds = new Set();
    for (const child of candidates) {
      const kind = child.tasks[0].split(":")[0];
      if (taskKinds.has(kind)) continue;
      taskKinds.add(kind);
      represented.add(child.tasks[0]);
      beam.push(child);
      if (beam.length >= options.width) break;
    }
    for (const child of candidates) {
      if (beam.length >= options.width) break;
      // Keep distinct first tasks before spending slots on similar schedules.
      if (represented.has(child.tasks[0])) continue;
      represented.add(child.tasks[0]);
      beam.push(child);
      if (beam.length >= options.width) break;
    }
    for (const child of beam) {
      const key = JSON.stringify([child.robot, child.boxes]);
      const previous = retained.get(key);
      if (!previous || child.path.length < previous.path.length) retained.set(key, child);
    }
    plan.statistics.completedLayers++;
  }
  const schedules = new Map();
  for (const candidate of [...retained.values()].sort((a, b) =>
    b.tasks.length - a.tasks.length || a.score - b.score)) {
    if (!schedules.has(candidate.tasks[0])) schedules.set(candidate.tasks[0], candidate);
  }
  plan.candidates = [...schedules.values()].slice(0, options.width).map(candidate => ({path: candidate.path,
      moves: candidate.path.length, pushes: candidate.pushes, tasks: candidate.tasks,
      endpoint: {robot: candidate.robot, boxes: candidate.boxes},
      solved: goal(candidate.boxes, board.goals),
      estimatedRemainingPushes: candidate.estimatedRemainingPushes}));
  if (plan.candidates.some(candidate => candidate.solved)) plan.status = "solved";
  plan.statistics.expanded = budget.expanded;
  plan.statistics.generated = budget.generated;
  plan.statistics.groupWidenings = budget.groupWidenings;
  plan.statistics.distanceCacheHits = budget.distanceCacheHits;
  plan.statistics.distanceEntries = budget.distanceEntries;
  plan.statistics.elapsedMs = now() - started;
  plan.statistics.budgetExhausted = budget.expanded >= options.maxExpanded ||
    budget.generated >= options.maxGenerated || now() >= budget.deadline;
  return plan;
}

function preparedStrategicSeeds(payload, initial, board) {
  const plan = payload.strategicPlan;
  if (plan?.schemaVersion !== 1 || plan.orientation !== "canonical" ||
      plan.snapshotKey !== strategicSnapshotKey(payload.state) ||
      !Array.isArray(plan.candidates)) return [];
  const seeds = new Map();
  for (const candidate of plan.candidates.slice(0, 16)) {
    if (!Array.isArray(candidate?.path) || !candidate.path.length || candidate.path.length > 512) continue;
    let state = initial, pushes = 0;
    for (const move of candidate.path) {
      const next = neighbors(state, board, false).find(next => next.move === move);
      if (!next) { state = null; break; }
      if (next.boxes !== state.boxes) pushes++;
      state = next;
    }
    if (!state || pushes > (payload.maxDepth || 320)) continue;
    const identity = JSON.stringify([state.robot, state.boxes]);
    if ((seeds.get(identity)?.moves ?? Infinity) <= candidate.path.length) continue;
    seeds.set(identity, {robot: state.robot, boxes: state.boxes, cost: pushes,
      moves: candidate.path.length, node: {parent: null, segment: [...candidate.path]}});
  }
  return [...seeds.values()];
}
