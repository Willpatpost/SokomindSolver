// Move-optimal repair for one box with every other box's push sequence fixed.
// This is a restricted optimization, not a proof of global Sokoban optimality.
function fixedOrderBoxReschedule(board, initial, events, selected, targetCell, upperBound, budget) {
  const cells = [...board.floor], ids = new Map(cells.map((cell, index) => [cell, index]));
  const size = cells.length;
  const fixed = events.filter(event => event.boxIndex !== selected);
  // Bound temporary occupancy tables independently of the search frontier.
  if ((fixed.length + 1) * size > 4000000 || now() >= budget.deadline) return null;
  // Occupancy and support-distance tables plus scratch arrays and replay nodes.
  const tableBytes = (fixed.length + 1) * (size * 5 + 192) + size * 128;
  const generatedAtStart = budget.generated;
  const hasMemory = () => {
    const retained = budget.generated - generatedAtStart + 1;
    const estimatedBytes = budget.baseMemoryBytes + tableBytes + retained * 768;
    budget.peakRetained = Math.max(budget.peakRetained, retained);
    budget.peakEstimatedBytes = Math.max(budget.peakEstimatedBytes, estimatedBytes);
    if (estimatedBytes >= budget.maxMemoryBytes) budget.memoryExhausted = true;
    return !budget.memoryExhausted;
  };
  if (!hasMemory()) return null;
  const edges = cells.map(cell => {
    const [y, x] = cell.split(",").map(Number);
    return DIRECTION_ENTRIES.map(([, [dy, dx]]) => ids.get(pkey(y + dy, x + dx)) ?? -1);
  });
  const target = ids.get(targetCell);
  const steps = fixed.map(event => {
    const from = ids.get(event.from), to = ids.get(event.to), direction = edges[from].indexOf(to);
    return {boxIndex: event.boxIndex, from, to, direction, support: edges[from][OPPOSITE_DIRECTION_INDEX[direction]]};
  });
  const positions = new Map(initial.boxes.flatMap((box, index) => index === selected ? [] :
    [[index, ids.get(pkey(box[0], box[1]))]]));
  const masks = [];
  for (let phase = 0; phase <= steps.length; phase++) {
    if (now() >= budget.deadline) return null;
    const mask = new Uint8Array(size);
    for (const cell of positions.values()) mask[cell] = 1;
    masks.push(mask);
    if (phase < steps.length) positions.set(steps[phase].boxIndex, steps[phase].to);
  }
  function walk(start, phase, box = -1, keepParents = false) {
    const distances = new Int32Array(size).fill(-1);
    const parents = keepParents ? new Int32Array(size).fill(-1) : null;
    const queue = new Int32Array(size); let count = 1;
    queue[0] = start; distances[start] = 0;
    for (let i = 0; i < count; i++) for (const next of edges[queue[i]]) {
      if (next < 0 || distances[next] >= 0 || next === box || masks[phase][next]) continue;
      distances[next] = distances[queue[i]] + 1;
      if (parents) parents[next] = queue[i];
      queue[count++] = next;
    }
    return {distances, parents};
  }
  const boxDistance = new Int32Array(size).fill(-1), queue = [target];
  boxDistance[target] = 0;
  for (let i = 0; i < queue.length; i++) for (let dir = 0; dir < 4; dir++) {
    const previous = edges[queue[i]][dir];
    if (previous < 0 || edges[previous][dir] < 0 || boxDistance[previous] >= 0) continue;
    boxDistance[previous] = boxDistance[queue[i]] + 1; queue.push(previous);
  }
  const remaining = new Float64Array(steps.length + 1), supportDistances = [];
  for (let phase = 0; phase < steps.length; phase++) {
    if (now() >= budget.deadline) return null;
    supportDistances.push(walk(steps[phase].support, phase).distances);
  }
  for (let phase = steps.length - 1; phase >= 1; phase--) {
    const distance = supportDistances[phase][steps[phase - 1].from];
    if (distance < 0) return null;
    remaining[phase] = 1 + distance + remaining[phase + 1];
  }
  const heuristic = node => {
    if (boxDistance[node.box] < 0) return Infinity;
    const pushes = steps.length - node.phase + boxDistance[node.box];
    if (node.phase === steps.length) return pushes;
    const distance = supportDistances[node.phase][node.robot];
    // Selected-box pushes can also advance the keeper toward the next fixed
    // push. Taking the max avoids counting those moves twice.
    return distance < 0 ? Infinity : Math.max(pushes, distance + 1 + remaining[node.phase + 1]);
  };
  const heap = [];
  const put = node => {
    let index = heap.length; heap.push(node);
    while (index) {
      const parent = (index - 1) >> 1;
      if (heap[parent].f <= node.f) break;
      heap[index] = heap[parent]; index = parent;
    }
    heap[index] = node;
  };
  const pop = () => {
    const first = heap[0], last = heap.pop();
    if (heap.length) {
      let index = 0;
      while (2 * index + 1 < heap.length) {
        let child = 2 * index + 1;
        if (child + 1 < heap.length && heap[child + 1].f < heap[child].f) child++;
        if (heap[child].f >= last.f) break;
        heap[index] = heap[child]; index = child;
      }
      heap[index] = last;
    }
    return first;
  };
  const identity = node => (node.phase * size + node.box) * size + node.robot;
  const selectedBox = initial.boxes[selected];
  const root = {phase: 0, box: ids.get(pkey(selectedBox[0], selectedBox[1])),
    robot: ids.get(pkey(...initial.robot)), g: 0, parent: null};
  root.f = heuristic(root); put(root);
  const best = new Map([[identity(root), 0]]);
  while (heap.length && budget.expanded < budget.maxExpanded &&
      budget.generated < budget.maxGenerated && !budget.memoryExhausted && now() < budget.deadline) {
    const node = pop();
    if (best.get(identity(node)) !== node.g) continue;
    if (node.f >= upperBound) break;
    if (node.phase === steps.length && node.box === target) {
      const chain = [], path = [];
      for (let current = node; current.parent; current = current.parent) chain.push(current);
      for (const child of chain.reverse()) {
        const parent = child.parent, tree = walk(parent.robot, parent.phase, parent.box, true).parents;
        const moves = [];
        for (let cell = child.support; cell !== parent.robot; cell = tree[cell]) {
          if (tree[cell] < 0) return null;
          moves.push(DIRECTION_ENTRIES[edges[tree[cell]].indexOf(cell)][0]);
        }
        path.push(...moves.reverse(), DIRECTION_ENTRIES[child.direction][0]);
      }
      return path;
    }
    budget.expanded++;
    const reachable = walk(node.robot, node.phase, node.box).distances;
    const add = (phase, box, robot, support, direction) => {
      if (support < 0 || reachable[support] < 0 || budget.generated >= budget.maxGenerated || !hasMemory()) return;
      const child = {phase, box, robot, g: node.g + reachable[support] + 1, parent: node, support, direction};
      const id = identity(child);
      if ((best.get(id) ?? Infinity) <= child.g) return;
      child.f = child.g + heuristic(child);
      if (child.f >= upperBound) return;
      best.set(id, child.g); put(child); budget.generated++;
    };
    if (node.phase < steps.length) {
      const step = steps[node.phase];
      if (node.box !== step.to && !masks[node.phase][step.to]) {
        add(node.phase + 1, node.box, step.from, step.support, step.direction);
      }
    }
    for (let dir = 0; dir < 4; dir++) {
      const to = edges[node.box][dir], support = edges[node.box][OPPOSITE_DIRECTION_INDEX[dir]];
      if (to >= 0 && !masks[node.phase][to]) add(node.phase, to, node.box, support, dir);
    }
    budget.peak = Math.max(budget.peak, heap.length);
    if (budget.expanded % 256 === 0) budget.report(heap.length);
  }
  return null;
}

function boxReschedulingTrace(payload, path, board) {
  const details = replaySolutionDetails(payload, path, board);
  if (!details || !goal(details.state.boxes, board.goals)) return null;
  const events = [];
  for (let i = 1; i < details.boundaries.length; i++) {
    const before = details.boundaries[i - 1].state.boxes, after = details.boundaries[i].state.boxes;
    const boxIndex = before.findIndex((box, index) => box[0] !== after[index][0] || box[1] !== after[index][1]);
    events.push({boxIndex, from: pkey(before[boxIndex][0], before[boxIndex][1]), to: pkey(after[boxIndex][0], after[boxIndex][1])});
  }
  return {events, details};
}

function solutionBoxRescheduleSearch(payload) {
  const startedAt = now();
  const board = prepareSearchBoard(payload), initial = initialReplayState(payload);
  const validation = validateSearchSolution(payload, payload.solutionPath);
  if (!validation.valid) return {path: null, failed: true, terminationReason: "invalid-rescheduling-incumbent", visited: 0};
  let path = validation.path, trace = boxReschedulingTrace(payload, path, board);
  const boardMemory = boardCacheMemorySnapshot(board);
  const budget = {expanded: 0, generated: 0, peak: 0, peakRetained: 0, peakEstimatedBytes: 0, memoryExhausted: false,
    baseMemoryBytes: 16 * 1024 * 1024 + boardMemory.boardBytes + boardMemory.cacheBytes +
      path.length * (256 + initial.boxes.length * 64),
    maxMemoryBytes: Number.isFinite(payload.maxMemoryBytes) ? Math.max(0, payload.maxMemoryBytes) : Infinity,
    maxExpanded: strategicLimit(payload.maxVisited, 300000, 1000000),
    maxGenerated: strategicLimit(payload.maxGenerated, 2000000, 5000000),
    deadline: startedAt + strategicLimit(payload.rescheduleMaxMs, 10000, 120000)};
  let lastReportAt = startedAt;
  budget.report = (frontier, force = false, incumbent = null) => {
    if (!force && now() - lastReportAt < 250) return;
    lastReportAt = now();
    if (typeof postMessage === "function") postMessage({type: "progress", visited: budget.expanded,
      generated: budget.generated, frontier, peakFrontier: budget.peak, retained: budget.peakRetained,
      ...(incumbent ? {path: incumbent} : {}),
      performance: performanceSnapshot(board.metrics)});
  };
  const labels = new Map();
  initial.boxes.forEach((box, index) => labels.set(box[2], [...(labels.get(box[2]) || []), index]));
  const eligible = [...labels]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, indices]) => indices);
  const requested = payload.rescheduleBoxIndices;
  const selected = Array.isArray(requested) ? eligible.filter(index => requested.includes(index)) : eligible;
  const attempts = [];
  const attempt = boxIndex => {
    if (budget.expanded >= budget.maxExpanded || budget.generated >= budget.maxGenerated || budget.memoryExhausted || now() >= budget.deadline) return;
    const beforeMoves = path.length, expanded = budget.expanded, generated = budget.generated;
    const target = trace.details.state.boxes[boxIndex];
    const candidate = fixedOrderBoxReschedule(board, initial, trace.events, boxIndex, pkey(target[0], target[1]), path.length, budget);
    if (candidate && candidate.length < path.length) {
      const replayed = boxReschedulingTrace(payload, candidate, board);
      const fixed = events => events.filter(event => event.boxIndex !== boxIndex);
      if (replayed && JSON.stringify(fixed(replayed.events)) === JSON.stringify(fixed(trace.events))) {
        path = candidate; trace = replayed;
        // Publish verified improvements before later work can exhaust the shared
        // request budget and cause the coordinator to terminate this worker.
        budget.report(0, true, path);
      }
    }
    attempts.push({boxIndex, label: initial.boxes[boxIndex][2], beforeMoves, afterMoves: path.length,
      expanded: budget.expanded - expanded, generated: budget.generated - generated});
    budget.report(0, true);
  };
  // Start with the largest observed push detour, then revisit every eligible box.
  // No puzzle name, box label, or reference-derived order enters this policy.
  const detour = index => {
    const box = initial.boxes[index], target = trace.details.state.boxes[index];
    const distance = playerAwarePushDistances(board, pkey(box[0], box[1])).get(pkey(target[0], target[1])) ?? Infinity;
    return trace.events.filter(event => event.boxIndex === index).length - distance;
  };
  const rounds = strategicLimit(payload.rescheduleRounds, 2, 8);
  if (rounds && selected.length && !Array.isArray(requested)) attempt([...selected].sort((a, b) => detour(b) - detour(a))[0]);
  for (let round = 0; round < rounds; round++) {
    const before = path.length;
    for (const index of selected) attempt(index);
    if (before === path.length) break;
  }
  return {path, visited: budget.expanded, generated: budget.generated, peakFrontier: budget.peak,
    retained: budget.peakRetained, frontier: 0,
    improvements: attempts.filter(attempt => attempt.afterMoves < attempt.beforeMoves).length,
    boxRescheduling: {attempts, originalMoves: validation.path.length, finalMoves: path.length,
      peakEstimatedBytes: budget.peakEstimatedBytes, memoryExhausted: budget.memoryExhausted,
      budgetExhausted: budget.memoryExhausted || budget.expanded >= budget.maxExpanded || budget.generated >= budget.maxGenerated || now() >= budget.deadline}};
}
