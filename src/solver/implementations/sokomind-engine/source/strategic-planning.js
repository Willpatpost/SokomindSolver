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
        id: `release:${prerequisite.boxIndex}:${commitment.boxIndex}:${commitment.target}`,
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
  const distanceKey = JSON.stringify([task.id, [...task.destinations].sort()]);
  const cached = budget.distanceTables.get(distanceKey);
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
  // Clearance destinations can change with the current box position. Include
  // the domain in the key; tables never cross a planning request.
  if (budget.distanceTables.size < 64) {
    budget.distanceTables.set(distanceKey, distances);
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
  if (!endpoints.length && obstructions.size) {
    const blocker = [...obstructions].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    budget.taskObstructions.set(task.id, {boxIndex: blocker,
      cell: pkey(start.boxes[blocker][0], start.boxes[blocker][1])});
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
    maxMs: strategicLimit(config.maxMs, 250, 60000),
    maxExpanded: strategicLimit(config.maxExpanded, 4000, 1000000),
    maxGenerated: strategicLimit(config.maxGenerated, 48000, 5000000),
    taskExpanded: strategicLimit(config.taskExpanded, 64, 2000),
    taskPushes: strategicLimit(config.taskPushes, 20, 80),
    taskResults: strategicLimit(config.taskResults, 2, 4),
    width: strategicLimit(config.width, 4, 16),
    layers: strategicLimit(config.layers, 6, 128),
    pathLimit: strategicLimit(config.pathLimit, 512, 4096),
    inferenceWork: strategicLimit(config.inferenceWork, 2048, 20000),
  };
  const canonical = canonicalPlanTransform(data);
  const state = {rows: canonical.rows, robot: canonical.robot, boxes: canonical.boxes};
  const plan = {schemaVersion: 2, tasks: [], resources: [],
    hypotheses: [{id: "root", taskIds: [], assumption: "root-assignment-and-transit"}],
    snapshotKey: strategicSnapshotKey(state),
    orientation: "canonical", candidates: [], options,
    statistics: {elapsedMs: 0, expanded: 0, generated: 0, tasksAttempted: 0, completedLayers: 0},
    status: "partial"};
  const budget = {expanded: 0, generated: 0, groupWidenings: 0, deadline: started + options.maxMs,
    distanceTables: new Map(), distanceEntries: 0, distanceCacheHits: 0, taskObstructions: new Map()};
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
  const registerTask = task => {
    if (plan.tasks.some(existing => existing.id === task.id) || plan.tasks.length >= 128) return;
    plan.tasks.push({id: task.id, kind: task.kind === "deliver" ? "commit-goal" : task.kind,
      boxIndex: task.boxIndex, requires: [],
      ...(task.forTaskId ? {forTaskId: task.forTaskId} : {}),
      completesWhen: {kind: "box-at-cells", boxIndex: task.boxIndex, cells: [...task.destinations]},
      dependsOn: [], evidence: {strength: "heuristic", scope: "hypothesis", hypothesisId: "root",
        snapshotKey: plan.snapshotKey, rule: "root-assignment-and-transit", sourceIds: []}});
    plan.hypotheses[0].taskIds.push(task.id);
  };
  for (const task of strategicTasks(initial, board, doorway.tasks, transit)) registerTask(task);
  for (const [boxIndex, target] of cacheDiscoveryAssignmentDetail(initial.boxes, board).assignedTargets) {
    registerTask({id: `deliver:${boxIndex}:${target}`, kind: "deliver", boxIndex, destinations: new Set([target])});
  }
  for (const commitment of transit.commitments) {
    const consumer = plan.tasks.find(task => task.id === `deliver:${commitment.boxIndex}:${commitment.target}`);
    if (!consumer) continue;
    for (const prerequisite of commitment.prerequisites) {
      const release = plan.tasks.find(task => task.id === `release:${prerequisite.boxIndex}:${commitment.boxIndex}:${commitment.target}`);
      if (!release) continue;
      consumer.dependsOn.push(release.id);
      plan.resources.push({id: `transit:${release.id}`, cells: [commitment.target],
        consumerTaskId: release.id, availableFrom: "task-enabled", availableUntil: "task-complete"});
    }
    consumer.evidence.sourceIds = [...consumer.dependsOn];
  }
  for (const task of plan.tasks.filter(task => task.kind === "export")) {
    const consumer = plan.tasks.find(candidate => candidate.kind === "commit-goal" && candidate.boxIndex === task.boxIndex);
    if (consumer && !consumer.dependsOn.includes(task.id)) {
      consumer.dependsOn.push(task.id); consumer.evidence.sourceIds.push(task.id);
    }
  }
  if (options.inferenceWork) inferStrategicDependencies(plan, initial, board, options.inferenceWork);
  let beam = [{...initial, path: [], pushes: 0, tasks: [], staging: []}];
  const retained = new Map();
  // Repeated parking/clearing cycles are the same physical plan state, not new
  // progress. New clearance evidence starts a fresh epoch so a previously failed
  // state can benefit from deductions learned by another candidate.
  const scheduleArrivals = new ClockCache(20000);
  const arrivalKey = child => JSON.stringify([plan.resources.length, child.robot, child.boxes]);
  scheduleArrivals.set(arrivalKey(initial), 0);
  for (let layer = 0; layer < options.layers && now() < budget.deadline &&
      budget.expanded < options.maxExpanded && budget.generated < options.maxGenerated; layer++) {
    const candidates = [];
    for (const current of beam) {
      if (options.inferenceWork) scheduleArrivals.set(arrivalKey(current), current.path.length);
      const tasks = options.inferenceWork ? strategicExecutionAgenda(current, plan, board)
        : strategicTasks(current, board, doorway.tasks, transit);
      for (const task of tasks) {
        if (now() >= budget.deadline || budget.expanded >= options.maxExpanded ||
            budget.generated >= options.maxGenerated) break;
        registerTask(task);
        if (!plan.tasks.some(existing => existing.id === task.id)) continue;
        plan.statistics.tasksAttempted++;
        budget.taskObstructions.delete(task.id);
        const endpoints = simulateStrategicTask(current, task, board, budget, options);
        const obstruction = budget.taskObstructions.get(task.id);
        if (options.inferenceWork && !endpoints.length && obstruction && plan.resources.length < 128) {
          const id = `obstruction:${plan.resources.length}`;
          if (!plan.resources.some(resource => resource.consumerTaskId === task.id &&
              resource.cells.length === 1 && resource.cells[0] === obstruction.cell)) {
            plan.resources.push({id, cells: [obstruction.cell], consumerTaskId: task.id,
              availableFrom: "task-enabled", availableUntil: "task-complete"});
            plan.statistics.obstructionClearances = (plan.statistics.obstructionClearances || 0) + 1;
          }
        }
        for (const endpoint of endpoints) {
          const path = [...current.path, ...endpoint.path];
          if (path.length > options.pathLimit) continue;
          const child = {...endpoint, path, pushes: current.pushes + endpoint.pushes,
            tasks: [...current.tasks, task.id], staging: [...current.staging]};
          endpoint.boxes.forEach((box, index) => {
            const position = pkey(box[0], box[1]);
            if (index !== task.boxIndex && position !== pkey(current.boxes[index][0], current.boxes[index][1]) &&
                board.goals.get(position) !== box[2]) {
              child.staging.push({boxIndex: index, position, beforeTaskId: task.id});
            }
          });
          const remaining = discoveryHeuristic(child.boxes, board);
          child.estimatedRemainingPushes = remaining;
          const schedule = doorwayScheduleState(child.boxes, board, doorway.tasks);
          child.score = path.length + remaining + 4 * schedule.penalty +
            4 * goalAccessAnalysis(child.boxes, board).penalty +
            (options.inferenceWork ? 16 * strategicCommitmentRisk(child, plan) : 0);
          if (!Number.isFinite(child.score)) continue;
          if (options.inferenceWork) {
            const key = arrivalKey(child);
            if ((scheduleArrivals.get(key) ?? Infinity) <= path.length) {
              plan.statistics.scheduleDuplicates = (plan.statistics.scheduleDuplicates || 0) + 1;
              continue;
            }
          }
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
    (options.inferenceWork ? a.estimatedRemainingPushes - b.estimatedRemainingPushes : b.tasks.length - a.tasks.length) || a.score - b.score)) {
    if (!schedules.has(candidate.tasks[0])) schedules.set(candidate.tasks[0], candidate);
  }
  // Keep one witnessed parking hypothesis, not incompatible staging choices.
  const staged = new Set();
  for (const stage of [...schedules.values()][0]?.staging || []) {
    if (staged.has(stage.boxIndex) || plan.tasks.length >= 128) continue;
    staged.add(stage.boxIndex);
    const id = `stage:${stage.boxIndex}:${stage.position}`;
    registerTask({id, kind: "stage", boxIndex: stage.boxIndex, destinations: new Set([stage.position]),
      ...(options.inferenceWork ? {forTaskId: stage.beforeTaskId} : {})});
    const consumer = plan.tasks.find(task => task.id === stage.beforeTaskId);
    if (!options.inferenceWork && consumer && !consumer.dependsOn.includes(id)) {
      consumer.dependsOn.push(id); consumer.evidence.sourceIds.push(id);
    }
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
  if (!validateStrategicPlanContract(plan) || plan.orientation !== "canonical" ||
      plan.snapshotKey !== strategicSnapshotKey(payload.state) ||
      !Array.isArray(plan.candidates)) return [];
  const seeds = new Map();
  for (const candidate of plan.candidates.slice(0, 16)) {
    if (!Array.isArray(candidate?.path) || !candidate.path.length || candidate.path.length > 4096) continue;
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
