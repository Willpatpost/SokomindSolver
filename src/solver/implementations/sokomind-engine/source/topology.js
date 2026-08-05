// Heap data structure, floor graph analysis, articulation points, and room topology.
// Part of the Sokomind solver engine. Functions are bare globals for
// cross-module compatibility. The namespace object is registered for new usage.

class Heap {
  constructor() { this.items = []; }
  push(item) {
    const a = this.items; a.push(item); let i = a.length - 1;
    while (i) { const p = (i - 1) >> 1; if (a[p][0] <= item[0]) break; a[i] = a[p]; i = p; }
    a[i] = item;
  }
  pop() {
    const a = this.items, root = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      while (true) {
        let c = i * 2 + 1; if (c >= a.length) break;
        if (c + 1 < a.length && a[c + 1][0] < a[c][0]) c++;
        if (a[c][0] >= last[0]) break; a[i] = a[c]; i = c;
      }
      a[i] = last;
    }
    return root;
  }
  retainBest(limit) {
    if (this.items.length <= limit) return;
    const kept = this.items
      .sort((left, right) => left[0] - right[0] || left[1] - right[1])
      .slice(0, limit);
    this.items = [];
    kept.forEach(item => this.push(item));
  }
  get length() { return this.items.length; }
}

function floorNeighbors(position, floor) {
  const [y, x] = position.split(",").map(Number);
  return Object.values(DIRS).map(([dy, dx]) => pkey(y + dy, x + dx))
    .filter(next => floor.has(next));
}

function floorComponents(floor, blocked = null) {
  const remaining = new Set(floor);
  if (blocked) remaining.delete(blocked);
  const components = [];
  while (remaining.size) {
    const start = remaining.values().next().value;
    const component = new Set([start]), queue = [start];
    remaining.delete(start);
    for (let head = 0; head < queue.length; head++) {
      for (const next of floorNeighbors(queue[head], floor)) {
        if (next === blocked || !remaining.has(next)) continue;
        remaining.delete(next);
        component.add(next);
        queue.push(next);
      }
    }
    components.push(component);
  }
  return components;
}

function articulationPoints(floor) {
  const discovered = new Map(), low = new Map(), parent = new Map(), result = new Set();
  let time = 0;
  const visit = position => {
    discovered.set(position, ++time);
    low.set(position, time);
    let children = 0;
    for (const next of floorNeighbors(position, floor)) {
      if (!discovered.has(next)) {
        parent.set(next, position);
        children++;
        visit(next);
        low.set(position, Math.min(low.get(position), low.get(next)));
        if (!parent.has(position) && children > 1) result.add(position);
        if (parent.has(position) && low.get(next) >= discovered.get(position)) result.add(position);
      } else if (next !== parent.get(position)) {
        low.set(position, Math.min(low.get(position), discovered.get(next)));
      }
    }
  };
  for (const position of floor) if (!discovered.has(position)) visit(position);
  return result;
}

function analyzeTopology(floor, goals) {
  const articulations = articulationPoints(floor);
  const tunnels = new Set([...floor].filter(position => {
    const neighbors = floorNeighbors(position, floor);
    if (neighbors.length !== 2) return false;
    const coordinates = neighbors.map(next => next.split(",").map(Number));
    return coordinates[0][0] === coordinates[1][0] || coordinates[0][1] === coordinates[1][1];
  }));
  const candidates = [];
  for (const gate of articulations) {
    const components = floorComponents(floor, gate).sort((left, right) => right.size - left.size);
    for (const cells of components) {
      if (cells.size < 2 || cells.size > floor.size * 0.72) continue;
      const roomGoals = [...goals.keys()].filter(goal => cells.has(goal));
      if (!roomGoals.length) continue;
      const depths = new Map(), queue = [];
      for (const neighbor of floorNeighbors(gate, floor)) {
        if (!cells.has(neighbor)) continue;
        depths.set(neighbor, 1);
        queue.push(neighbor);
      }
      for (let head = 0; head < queue.length; head++) {
        const position = queue[head], distance = depths.get(position);
        for (const next of floorNeighbors(position, floor)) {
          if (!cells.has(next) || depths.has(next)) continue;
          depths.set(next, distance + 1);
          queue.push(next);
        }
      }
      const traffic = new Map([...cells].map(cell => [cell, 0]));
      for (const goal of roomGoals) {
        const goalDistances = new Map([[goal, 0]]), goalQueue = [goal];
        for (let head = 0; head < goalQueue.length; head++) {
          const position = goalQueue[head], distance = goalDistances.get(position);
          for (const next of floorNeighbors(position, floor)) {
            if (!cells.has(next) || goalDistances.has(next)) continue;
            goalDistances.set(next, distance + 1);
            goalQueue.push(next);
          }
        }
        const goalDepth = depths.get(goal);
        for (const cell of cells) {
          if ((depths.get(cell) ?? Infinity) + (goalDistances.get(cell) ?? Infinity) === goalDepth) {
            traffic.set(cell, traffic.get(cell) + 1);
          }
        }
      }
      const dependencies = [];
      for (const blocker of roomGoals) {
        const reducedFloor = new Set(floor);
        reducedFloor.delete(blocker);
        for (const target of roomGoals) {
          if (target === blocker) continue;
          const normallyReachable = reversePushDistances(floor, target).has(gate);
          const blockedReachable = reversePushDistances(reducedFloor, target).has(gate);
          if (normallyReachable && !blockedReachable) dependencies.push([blocker, target]);
        }
      }
      const approach = new Map(), approachQueue = [];
      for (const neighbor of floorNeighbors(gate, floor)) {
        if (cells.has(neighbor)) continue;
        approach.set(neighbor, 1);
        approachQueue.push(neighbor);
      }
      for (let head = 0; head < approachQueue.length; head++) {
        const position = approachQueue[head], distance = approach.get(position);
        if (distance >= 3) continue;
        for (const next of floorNeighbors(position, floor)) {
          if (next === gate || cells.has(next) || approach.has(next)) continue;
          approach.set(next, distance + 1);
          approachQueue.push(next);
        }
      }
      const [gateY, gateX] = gate.split(",").map(Number);
      const doorwayLanes = floorNeighbors(gate, floor)
        .filter(inside => cells.has(inside))
        .map(inside => {
          const [insideY, insideX] = inside.split(",").map(Number);
          const dy = insideY - gateY, dx = insideX - gateX;
          const outside = pkey(gateY - dy, gateX - dx);
          const importSupport = pkey(gateY - 2 * dy, gateX - 2 * dx);
          const exportSupport = pkey(gateY + 2 * dy, gateX + 2 * dx);
          return {
            inside,
            outside,
            importSupport,
            exportSupport,
            importPossible: floor.has(outside) && floor.has(importSupport),
            exportPossible: floor.has(outside) && floor.has(exportSupport),
          };
        });
      const interiorStaging = new Set([...cells].filter(cell => (depths.get(cell) || 0) <= 2));
      const exteriorStaging = new Set([...approach]
        .filter(([, distance]) => distance <= 2)
        .map(([position]) => position));
      candidates.push({
        gate,
        cells,
        goals: roomGoals,
        depths,
        traffic,
        dependencies,
        approach,
        doorwayLanes,
        interiorStaging,
        exteriorStaging,
      });
    }
  }
  candidates.sort((left, right) => right.cells.size - left.cells.size);
  const rooms = [];
  for (const candidate of candidates) {
    if (rooms.some(room => [...candidate.cells].every(cell => room.cells.has(cell)))) continue;
    rooms.push(candidate);
  }
  const goalAccess = [...goals].map(([goal, label]) => {
    const [y, x] = goal.split(",").map(Number);
    const lanes = DIRECTION_ENTRIES.flatMap(([, [dy, dx]]) => {
      const source = pkey(y - dy, x - dx);
      const support = pkey(y - 2 * dy, x - 2 * dx);
      if (!floor.has(source) || !floor.has(support)) return [];
      return [{
        source,
        support,
        blockingGoals: [source, support].filter(position => goals.has(position)),
      }];
    });
    return {goal, label, lanes};
  });
  // Compile maximal tunnel segments from individual tunnel cells
  const tunnelSegments = compileTunnelSegments(tunnels, floor, goals);

  return {articulations, rooms, tunnels, tunnelSegments, goalAccess};
}

function compileTunnelSegments(tunnels, floor, goals) {
  const visited = new Set();
  const segments = [];
  for (const cell of tunnels) {
    if (visited.has(cell)) continue;
    // Extend in both directions along the tunnel
    const neighbors = floorNeighbors(cell, floor);
    if (neighbors.length !== 2) continue;
    const [n0, n1] = neighbors;
    const [n0y, n0x] = n0.split(",").map(Number);
    const [n1y, n1x] = n1.split(",").map(Number);
    // Determine direction: horizontal or vertical
    const [cy, cx] = cell.split(",").map(Number);
    const dy = n1y - n0y === 0 ? 0 : (n1y > n0y ? 1 : -1);
    const dx = n1x - n0x === 0 ? 0 : (n1x > n0x ? 1 : -1);
    // Normalize direction: extend the segment in both directions
    const cellsInSegment = [cell];
    visited.add(cell);
    // Extend forward (toward n1)
    let current = cell;
    while (true) {
      const [y, x] = current.split(",").map(Number);
      const next = pkey(y + dy, x + dx);
      if (!tunnels.has(next) || visited.has(next)) {
        break;
      }
      visited.add(next);
      cellsInSegment.push(next);
      current = next;
    }
    // Extend backward (toward n0)
    current = cell;
    while (true) {
      const [y, x] = current.split(",").map(Number);
      const next = pkey(y - dy, x - dx);
      if (!tunnels.has(next) || visited.has(next)) {
        break;
      }
      visited.add(next);
      cellsInSegment.unshift(next);
      current = next;
    }
    if (cellsInSegment.length < 1) continue;
    // Determine entry and exit: the cells just beyond the segment ends
    const first = cellsInSegment[0];
    const last = cellsInSegment[cellsInSegment.length - 1];
    const [fy, fx] = first.split(",").map(Number);
    const [ly, lx] = last.split(",").map(Number);
    const entryNeighbor = pkey(fy - dy, fx - dx);
    const exitNeighbor = pkey(ly + dy, lx + dx);
    // Check if ends are dead-ends (wall) or open
    const entryIsDeadEnd = !floor.has(entryNeighbor);
    const exitIsDeadEnd = !floor.has(exitNeighbor);
    // One-way tunnel: one end is a dead-end
    const oneWay = entryIsDeadEnd || exitIsDeadEnd;
    // Goals within the tunnel
    const segmentGoals = cellsInSegment.filter(c => goals.has(c));
    segments.push({
      cells: cellsInSegment,
      entry: entryIsDeadEnd ? exitNeighbor : entryNeighbor,
      exit: entryIsDeadEnd ? entryNeighbor : exitNeighbor,
      entryEnd: entryIsDeadEnd ? first : last,
      exitEnd: entryIsDeadEnd ? last : first,
      goals: segmentGoals,
      length: cellsInSegment.length,
      oneWay,
      deadEnd: entryIsDeadEnd ? entryNeighbor : (exitIsDeadEnd ? exitNeighbor : null),
    });
  }
  return segments;
}

// --- Module registration ---
const SokomindTopology = {
  Heap,
  floorNeighbors,
  floorComponents,
  articulationPoints,
  analyzeTopology,
  compileTunnelSegments,
};
if (typeof globalThis !== "undefined") globalThis.SokomindTopology = SokomindTopology;
if (typeof module === "object" && module.exports) module.exports = SokomindTopology;
