import type { CompiledSearchBoard } from "./compiled-board.ts";

export interface Room {
  readonly gate: number;
  readonly cells: ReadonlySet<number>;
  readonly goals: readonly number[];
}

export interface BoardTopology {
  readonly articulations: ReadonlySet<number>;
  readonly rooms: readonly Room[];
  readonly tunnels: ReadonlySet<number>;
}

const MAX_ROOM_FRACTION = 0.72;

export function analyzeTopology(board: CompiledSearchBoard): BoardTopology {
  const articulations = findArticulationPoints(board);
  const rooms = findRooms(board, articulations);
  const tunnels = findTunnels(board);
  return { articulations, rooms, tunnels };
}

function findArticulationPoints(board: CompiledSearchBoard): ReadonlySet<number> {
  const n = board.cellCount;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const parent = new Int32Array(n).fill(-1);
  const result = new Set<number>();
  let time = 0;

  // Iterative Tarjan's to avoid stack overflow on large boards.
  // Each stack frame tracks: cell, which neighbor index to visit next, child count.
  const stack: { cell: number; neighborIdx: number; children: number }[] = [];

  for (let start = 0; start < n; start++) {
    if (disc[start] >= 0) continue;

    disc[start] = low[start] = time++;
    stack.push({ cell: start, neighborIdx: 0, children: 0 });

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = board.neighbors[frame.cell];
      let pushed = false;

      while (frame.neighborIdx < neighbors.length) {
        const next = neighbors[frame.neighborIdx];
        frame.neighborIdx++;
        if (next < 0) continue;

        if (disc[next] < 0) {
          parent[next] = frame.cell;
          disc[next] = low[next] = time++;
          frame.children++;
          stack.push({ cell: next, neighborIdx: 0, children: 0 });
          pushed = true;
          break;
        } else if (next !== parent[frame.cell]) {
          if (disc[next] < low[frame.cell]) {
            low[frame.cell] = disc[next];
          }
        }
      }

      if (!pushed) {
        stack.pop();
        if (stack.length > 0) {
          const parentFrame = stack[stack.length - 1];
          if (low[frame.cell] < low[parentFrame.cell]) {
            low[parentFrame.cell] = low[frame.cell];
          }
          const isRoot = parent[parentFrame.cell] < 0;
          if (isRoot) {
            if (parentFrame.children > 1) result.add(parentFrame.cell);
          } else if (low[frame.cell] >= disc[parentFrame.cell]) {
            result.add(parentFrame.cell);
          }
        }
      }
    }
  }

  return result;
}

function findRooms(
  board: CompiledSearchBoard,
  articulations: ReadonlySet<number>,
): readonly Room[] {
  const n = board.cellCount;
  const maxCells = Math.floor(n * MAX_ROOM_FRACTION);
  const visited = new Uint8Array(n);
  const candidates: Room[] = [];

  for (const gate of articulations) {
    visited.fill(0);
    visited[gate] = 1;

    for (let seed = 0; seed < board.neighbors[gate].length; seed++) {
      const seedCell = board.neighbors[gate][seed];
      if (seedCell < 0 || visited[seedCell]) continue;

      const cells = new Set<number>();
      const queue = [seedCell];
      visited[seedCell] = 1;
      cells.add(seedCell);

      for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        const neighbors = board.neighbors[current];
        for (let d = 0; d < neighbors.length; d++) {
          const next = neighbors[d];
          if (next < 0 || visited[next]) continue;
          visited[next] = 1;
          cells.add(next);
          queue.push(next);
        }
      }

      if (cells.size < 2 || cells.size > maxCells) continue;

      const goals: number[] = [];
      for (const cell of cells) {
        if (board.goalLabelByCell[cell] !== null) goals.push(cell);
      }
      if (goals.length === 0) continue;

      candidates.push({ gate, cells, goals: goals.sort((a, b) => a - b) });
    }
  }

  candidates.sort((a, b) => b.cells.size - a.cells.size);

  const rooms: Room[] = [];
  for (const candidate of candidates) {
    const isSubset = rooms.some((room) => {
      if (candidate.cells.size > room.cells.size) return false;
      for (const cell of candidate.cells) {
        if (!room.cells.has(cell)) return false;
      }
      return true;
    });
    if (!isSubset) rooms.push(candidate);
  }

  return rooms;
}

function findTunnels(board: CompiledSearchBoard): ReadonlySet<number> {
  const tunnels = new Set<number>();
  for (let cell = 0; cell < board.cellCount; cell++) {
    const neighbors = board.neighbors[cell];
    let floorCount = 0;
    const floorDirs: number[] = [];
    for (let d = 0; d < neighbors.length; d++) {
      if (neighbors[d] >= 0) {
        floorCount++;
        floorDirs.push(d);
      }
    }
    if (floorCount !== 2) continue;
    // Collinear: both neighbors on same axis (up/down = 0,1 or left/right = 2,3)
    const [d0, d1] = floorDirs;
    if ((d0 === 0 && d1 === 1) || (d0 === 2 && d1 === 3)) {
      tunnels.add(cell);
    }
  }
  return tunnels;
}
