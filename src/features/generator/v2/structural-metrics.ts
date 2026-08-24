import type { StructuralBlueprint } from "./blueprint-types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectedRegion {
  readonly gate: number;
  readonly cells: ReadonlySet<number>;
  readonly size: number;
  readonly isTerminal: boolean;
}

export interface StructuralMetrics {
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly totalCells: number;
  readonly totalFloor: number;

  readonly floorUtilization: number;
  readonly openAreaRatio: number;

  readonly articulationPoints: ReadonlySet<number>;
  readonly articulationCount: number;

  readonly regions: readonly DetectedRegion[];
  readonly regionCount: number;
  readonly regionSizes: readonly number[];
  readonly largestRegionSize: number;
  readonly largestRegionRatio: number;
  readonly terminalRegionCount: number;

  readonly tunnelCells: ReadonlySet<number>;
  readonly tunnelCount: number;

  readonly chokepoints: ReadonlySet<number>;
  readonly chokepointCount: number;

  readonly maxDegree: number;
  readonly degreeDistribution: readonly number[];
  readonly hasCycle: boolean;
  readonly connectedComponents: number;
}

export interface BlueprintFidelity {
  readonly intendedRoomCount: number;
  readonly detectedRegionCount: number;
  readonly roomCountMatch: boolean;
  readonly intendedPassageCount: number;
  readonly detectedChokepointCount: number;
  readonly mergedRooms: number;
  readonly unintendedShortcuts: number;
  readonly passageLengths: readonly number[];
  readonly meanPassageLength: number;
}

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------

function encode(row: number, col: number, width: number): number {
  return row * width + col;
}

function isFloor(grid: readonly (readonly string[])[], r: number, c: number): boolean {
  const cell = grid[r][c];
  return cell !== "O";
}

const DR = [-1, 1, 0, 0];
const DC = [0, 0, -1, 1];

function floorNeighbors(
  grid: readonly (readonly string[])[],
  r: number,
  c: number,
  height: number,
  width: number,
): number[] {
  const result: number[] = [];
  for (let d = 0; d < 4; d++) {
    const nr = r + DR[d];
    const nc = c + DC[d];
    if (nr >= 0 && nr < height && nc >= 0 && nc < width && isFloor(grid, nr, nc)) {
      result.push(encode(nr, nc, width));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

export function analyzeGrid(grid: readonly (readonly string[])[]): StructuralMetrics {
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;
  const totalCells = height * width;

  const floorCells: number[] = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (isFloor(grid, r, c)) {
        floorCells.push(encode(r, c, width));
      }
    }
  }
  const totalFloor = floorCells.length;
  const floorUtilization = totalCells > 0 ? totalFloor / totalCells : 0;

  const neighborCache = new Map<number, number[]>();
  for (const idx of floorCells) {
    const r = Math.floor(idx / width);
    const c = idx % width;
    neighborCache.set(idx, floorNeighbors(grid, r, c, height, width));
  }

  const degreeDistribution = new Array<number>(5).fill(0);
  let maxDegree = 0;
  for (const idx of floorCells) {
    const deg = neighborCache.get(idx)!.length;
    if (deg > maxDegree) maxDegree = deg;
    if (deg < degreeDistribution.length) {
      degreeDistribution[deg]++;
    }
  }

  const { articulations, components } = findArticulationPoints(
    floorCells,
    neighborCache,
  );

  const regions = findRegions(floorCells, neighborCache, articulations, totalFloor);

  const tunnelCells = findTunnels(floorCells, neighborCache);

  const chokepoints = findChokepoints(floorCells, neighborCache, articulations);

  const openAreaRatio = computeOpenAreaRatio(floorCells, neighborCache);

  const regionSizes = regions.map((r) => r.size);
  const largestRegionSize = regionSizes.length > 0 ? Math.max(...regionSizes) : 0;
  const largestRegionRatio = totalFloor > 0 ? largestRegionSize / totalFloor : 0;
  const terminalRegionCount = regions.filter((r) => r.isTerminal).length;

  const hasCycle = detectCycle(floorCells, neighborCache);

  return {
    boardWidth: width,
    boardHeight: height,
    totalCells,
    totalFloor,
    floorUtilization,
    openAreaRatio,
    articulationPoints: articulations,
    articulationCount: articulations.size,
    regions,
    regionCount: regions.length,
    regionSizes,
    largestRegionSize,
    largestRegionRatio,
    terminalRegionCount,
    tunnelCells,
    tunnelCount: tunnelCells.size,
    chokepoints,
    chokepointCount: chokepoints.size,
    maxDegree,
    degreeDistribution,
    hasCycle,
    connectedComponents: components,
  };
}

// ---------------------------------------------------------------------------
// Articulation points — iterative Tarjan's on floor graph
// ---------------------------------------------------------------------------

function findArticulationPoints(
  floorCells: number[],
  neighborCache: Map<number, number[]>,
): { articulations: Set<number>; components: number } {
  const disc = new Map<number, number>();
  const low = new Map<number, number>();
  const parent = new Map<number, number>();
  const result = new Set<number>();
  let time = 0;
  let components = 0;

  for (const start of floorCells) {
    if (disc.has(start)) continue;
    components++;

    disc.set(start, time);
    low.set(start, time);
    time++;

    const stack: { cell: number; neighborIdx: number; children: number }[] = [
      { cell: start, neighborIdx: 0, children: 0 },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = neighborCache.get(frame.cell)!;
      let pushed = false;

      while (frame.neighborIdx < neighbors.length) {
        const next = neighbors[frame.neighborIdx];
        frame.neighborIdx++;

        if (!disc.has(next)) {
          parent.set(next, frame.cell);
          disc.set(next, time);
          low.set(next, time);
          time++;
          frame.children++;
          stack.push({ cell: next, neighborIdx: 0, children: 0 });
          pushed = true;
          break;
        } else if (next !== parent.get(frame.cell)) {
          const nextDisc = disc.get(next)!;
          if (nextDisc < low.get(frame.cell)!) {
            low.set(frame.cell, nextDisc);
          }
        }
      }

      if (!pushed) {
        stack.pop();
        if (stack.length > 0) {
          const parentFrame = stack[stack.length - 1];
          const frameLow = low.get(frame.cell)!;
          if (frameLow < low.get(parentFrame.cell)!) {
            low.set(parentFrame.cell, frameLow);
          }
          const isRoot = !parent.has(parentFrame.cell);
          if (isRoot) {
            if (parentFrame.children > 1) result.add(parentFrame.cell);
          } else if (low.get(frame.cell)! >= disc.get(parentFrame.cell)!) {
            result.add(parentFrame.cell);
          }
        }
      }
    }
  }

  return { articulations: result, components };
}

// ---------------------------------------------------------------------------
// Region detection — BFS from articulation point gates
// ---------------------------------------------------------------------------

function findRegions(
  floorCells: number[],
  neighborCache: Map<number, number[]>,
  articulations: ReadonlySet<number>,
  totalFloor: number,
): DetectedRegion[] {
  if (articulations.size === 0) return [];

  const maxCells = Math.floor(totalFloor * 0.72);
  const candidates: DetectedRegion[] = [];

  for (const gate of articulations) {
    const gateNeighbors = neighborCache.get(gate)!;
    const visited = new Set<number>();
    visited.add(gate);

    for (const seedCell of gateNeighbors) {
      if (visited.has(seedCell)) continue;

      const cells = new Set<number>();
      const queue: number[] = [seedCell];
      visited.add(seedCell);
      cells.add(seedCell);

      for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        for (const next of neighborCache.get(current)!) {
          if (visited.has(next)) continue;
          visited.add(next);
          cells.add(next);
          queue.push(next);
        }
      }

      if (cells.size < 2 || cells.size > maxCells) continue;

      let exitCount = 0;
      for (const art of articulations) {
        if (art === gate) continue;
        for (const artNeighbor of neighborCache.get(art)!) {
          if (cells.has(artNeighbor)) {
            exitCount++;
            break;
          }
        }
      }
      if (cells.has(gate)) exitCount++;

      const isTerminal = exitCount === 0;

      candidates.push({ gate, cells, size: cells.size, isTerminal });
    }
  }

  candidates.sort((a, b) => b.size - a.size);

  const regions: DetectedRegion[] = [];
  for (const candidate of candidates) {
    const isSubset = regions.some((region) => {
      if (candidate.size > region.size) return false;
      for (const cell of candidate.cells) {
        if (!region.cells.has(cell)) return false;
      }
      return true;
    });
    if (!isSubset) regions.push(candidate);
  }

  return regions;
}

// ---------------------------------------------------------------------------
// Tunnel detection — collinear 2-neighbor cells
// ---------------------------------------------------------------------------

function findTunnels(
  floorCells: number[],
  neighborCache: Map<number, number[]>,
): Set<number> {
  const tunnels = new Set<number>();
  for (const idx of floorCells) {
    const neighbors = neighborCache.get(idx)!;
    if (neighbors.length !== 2) continue;

    const [a, b] = neighbors;
    const width = neighborCache.size > 0 ? computeWidth(neighborCache) : 1;

    const rA = Math.floor(a / width);
    const cA = a % width;
    const rB = Math.floor(b / width);
    const cB = b % width;

    if (rA === rB || cA === cB) {
      tunnels.add(idx);
    }
  }
  return tunnels;
}

function computeWidth(neighborCache: Map<number, number[]>): number {
  let maxIdx = 0;
  let minRow = Infinity;
  for (const idx of neighborCache.keys()) {
    if (idx > maxIdx) maxIdx = idx;
  }
  for (const idx of neighborCache.keys()) {
    if (idx < minRow) minRow = idx;
  }
  for (const [idx, neighbors] of neighborCache) {
    for (const n of neighbors) {
      const diff = Math.abs(n - idx);
      if (diff > 1) return diff;
    }
  }
  return Math.floor(Math.sqrt(maxIdx)) + 1;
}

// ---------------------------------------------------------------------------
// Chokepoint detection — articulation points that are also tunnels or
// have exactly 2 floor neighbors
// ---------------------------------------------------------------------------

function findChokepoints(
  floorCells: number[],
  neighborCache: Map<number, number[]>,
  articulations: ReadonlySet<number>,
): Set<number> {
  const chokepoints = new Set<number>();
  for (const art of articulations) {
    const neighbors = neighborCache.get(art);
    if (!neighbors) continue;
    if (neighbors.length <= 2) {
      chokepoints.add(art);
    }
  }
  return chokepoints;
}

// ---------------------------------------------------------------------------
// Open area ratio — fraction of floor cells with degree 4
// (fully surrounded by floor on all cardinal sides)
// ---------------------------------------------------------------------------

function computeOpenAreaRatio(
  floorCells: number[],
  neighborCache: Map<number, number[]>,
): number {
  if (floorCells.length === 0) return 0;
  let openCount = 0;
  for (const idx of floorCells) {
    if (neighborCache.get(idx)!.length === 4) openCount++;
  }
  return openCount / floorCells.length;
}

// ---------------------------------------------------------------------------
// Cycle detection — DFS on the floor graph
// ---------------------------------------------------------------------------

function detectCycle(
  floorCells: number[],
  neighborCache: Map<number, number[]>,
): boolean {
  const visited = new Set<number>();
  const parent = new Map<number, number>();

  for (const start of floorCells) {
    if (visited.has(start)) continue;

    const stack: number[] = [start];
    visited.add(start);

    while (stack.length > 0) {
      const cell = stack.pop()!;
      for (const next of neighborCache.get(cell)!) {
        if (!visited.has(next)) {
          visited.add(next);
          parent.set(next, cell);
          stack.push(next);
        } else if (next !== parent.get(cell)) {
          return true;
        }
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Blueprint fidelity — compare intended blueprint vs detected grid topology
// ---------------------------------------------------------------------------

export function analyzeBlueprintFidelity(
  blueprint: StructuralBlueprint,
  metrics: StructuralMetrics,
): BlueprintFidelity {
  const passageLengths = blueprint.passages.map((p) => p.cells.length);
  const meanPassageLength =
    passageLengths.length > 0
      ? passageLengths.reduce((a, b) => a + b, 0) / passageLengths.length
      : 0;

  const intendedRoomCount = blueprint.rooms.length;
  const detectedRegionCount = metrics.regionCount;
  const roomCountMatch = detectedRegionCount >= intendedRoomCount;

  const mergedRooms = Math.max(0, intendedRoomCount - detectedRegionCount);

  let unintendedShortcuts = 0;
  if (metrics.hasCycle) {
    const intendedEdgeCount = blueprint.passages.length;
    const minEdgesForCycle = blueprint.rooms.length;
    if (intendedEdgeCount < minEdgesForCycle) {
      unintendedShortcuts = 1;
    }
  }

  return {
    intendedRoomCount,
    detectedRegionCount,
    roomCountMatch,
    intendedPassageCount: blueprint.passages.length,
    detectedChokepointCount: metrics.chokepointCount,
    mergedRooms,
    unintendedShortcuts,
    passageLengths,
    meanPassageLength,
  };
}

// ---------------------------------------------------------------------------
// Convenience: parse puzzle rows into grid for analysis
// ---------------------------------------------------------------------------

export function parseRowsToGrid(rows: readonly string[]): readonly (readonly string[])[] {
  return rows.map((row) => [...row]);
}
