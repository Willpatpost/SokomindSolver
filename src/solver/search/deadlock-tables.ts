import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";
import { throwIfSolverCancelled } from "../cancellation.ts";
import { delayForEventLoop } from "./engine.ts";

const MAX_REGION_CELLS = 9;
const MAX_BOX_COUNT = 3;
const MIN_BOX_COUNT = 2;
const BFS_STATE_LIMIT = 5000;
const TIME_BUDGET_MS = 2000;

export interface DeadlockTableStats {
  readonly regionCount: number;
  readonly patternCount: number;
  readonly buildTimeMs: number;
}

interface SubGrid {
  readonly cells: readonly number[];
  readonly cellSet: ReadonlySet<number>;
}

function configKey(
  boxCells: readonly number[],
  labels: readonly string[],
): string {
  const parts: string[] = [];
  for (let i = 0; i < boxCells.length; i++) {
    parts.push(`${boxCells[i]}:${labels[i]}`);
  }
  parts.sort();
  return parts.join(";");
}

function findWallAdjacentRegions(board: CompiledSearchBoard): SubGrid[] {
  const regions: SubGrid[] = [];
  const seen = new Set<string>();

  for (let cell = 0; cell < board.cellCount; cell++) {
    const neighbors = board.neighbors[cell];
    let hasWall = false;
    for (let d = 0; d < 4; d++) {
      if (neighbors[d] < 0) { hasWall = true; break; }
    }
    if (!hasWall) continue;

    const regionCells = new Set<number>();
    regionCells.add(cell);
    const queue = [cell];
    for (let head = 0; head < queue.length && regionCells.size < MAX_REGION_CELLS; head++) {
      const current = queue[head];
      const currentNeighbors = board.neighbors[current];
      for (let d = 0; d < 4; d++) {
        const next = currentNeighbors[d];
        if (next < 0) continue;
        if (regionCells.has(next)) continue;
        if (regionCells.size >= MAX_REGION_CELLS) break;
        const nextNeighbors = board.neighbors[next];
        let nextHasWall = false;
        for (let dd = 0; dd < 4; dd++) {
          if (nextNeighbors[dd] < 0) { nextHasWall = true; break; }
        }
        if (!nextHasWall) continue;
        regionCells.add(next);
        queue.push(next);
      }
    }

    if (regionCells.size < MIN_BOX_COUNT) continue;

    const sorted = [...regionCells].sort((a, b) => a - b);
    const key = sorted.join(",");
    if (seen.has(key)) continue;
    seen.add(key);

    regions.push({ cells: sorted, cellSet: regionCells });
  }

  return regions;
}

function isDeadlockedBFS(
  board: CompiledSearchBoard,
  region: SubGrid,
  initialCells: readonly number[],
  labels: readonly string[],
): boolean {
  const goalSolved = (cells: readonly number[], lbls: readonly string[]): boolean => {
    for (let i = 0; i < cells.length; i++) {
      if (board.goalLabelByCell[cells[i]] !== lbls[i]) return false;
    }
    return true;
  };

  if (goalSolved(initialCells, labels)) return false;

  const seen = new Set<string>();
  const queue: { cells: number[]; labels: string[] }[] = [];
  const initSig = configKey(initialCells, labels);
  seen.add(initSig);
  queue.push({ cells: [...initialCells], labels: [...labels] });

  let head = 0;
  while (head < queue.length) {
    if (seen.size > BFS_STATE_LIMIT) return false;

    const current = queue[head++];
    const occupiedSet = new Set(current.cells);

    for (let bi = 0; bi < current.cells.length; bi++) {
      const boxCell = current.cells[bi];
      const neighbors = board.neighbors[boxCell];

      for (let d = 0; d < 4; d++) {
        const dest = neighbors[d];
        if (dest < 0) continue;
        if (occupiedSet.has(dest)) continue;

        const opposite = [1, 0, 3, 2][d];
        const support = neighbors[opposite];
        if (support < 0) continue;
        if (occupiedSet.has(support)) continue;

        const newCells = [...current.cells];
        const newLabels = [...current.labels];

        if (region.cellSet.has(dest)) {
          newCells[bi] = dest;
        } else {
          newCells.splice(bi, 1);
          newLabels.splice(bi, 1);
        }

        if (newCells.length === 0 || goalSolved(newCells, newLabels)) {
          return false;
        }

        const sig = configKey(newCells, newLabels);
        if (seen.has(sig)) continue;
        seen.add(sig);
        queue.push({ cells: newCells, labels: newLabels });
      }
    }
  }

  return true;
}

export class DeadlockTableLookup {
  readonly #deadlockSets: ReadonlyMap<number, Set<string>>;
  readonly #cellToRegions: ReadonlyMap<number, readonly SubGrid[]>;
  readonly #stats: DeadlockTableStats;

  constructor(
    deadlockSets: Map<number, Set<string>>,
    cellToRegions: Map<number, SubGrid[]>,
    stats: DeadlockTableStats,
  ) {
    this.#deadlockSets = deadlockSets;
    this.#cellToRegions = cellToRegions;
    this.#stats = stats;
  }

  get stats(): DeadlockTableStats {
    return this.#stats;
  }

  check(
    boxes: readonly DenseBox[],
    movedCell: number,
  ): boolean {
    const regions = this.#cellToRegions.get(movedCell);
    if (!regions) return false;

    for (const region of regions) {
      const regionBoxCells: number[] = [];
      const regionBoxLabels: string[] = [];
      for (const box of boxes) {
        if (region.cellSet.has(box.cell)) {
          regionBoxCells.push(box.cell);
          regionBoxLabels.push(box.label);
        }
      }

      if (regionBoxCells.length < MIN_BOX_COUNT || regionBoxCells.length > MAX_BOX_COUNT) continue;

      const key = configKey(regionBoxCells, regionBoxLabels);
      const regionId = region.cells[0];
      const deadlockSet = this.#deadlockSets.get(regionId);
      if (!deadlockSet) continue;

      if (deadlockSet.has(key)) return true;
    }

    return false;
  }
}

export function buildDeadlockTables(
  board: CompiledSearchBoard,
): DeadlockTableLookup {
  const startTime = Date.now();
  const regions = findWallAdjacentRegions(board);

  const deadlockSets = new Map<number, Set<string>>();
  const cellToRegions = new Map<number, SubGrid[]>();
  let patternCount = 0;

  const allLabels = [...board.goalCellsByLabel.keys()];
  if (allLabels.length === 0) {
    return new DeadlockTableLookup(deadlockSets, cellToRegions, {
      regionCount: 0,
      patternCount: 0,
      buildTimeMs: Date.now() - startTime,
    });
  }

  for (const region of regions) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;

    const regionId = region.cells[0];
    const deadlocks = new Set<string>();

    for (let boxCount = MIN_BOX_COUNT; boxCount <= Math.min(MAX_BOX_COUNT, region.cells.length); boxCount++) {
      if (Date.now() - startTime > TIME_BUDGET_MS) break;

      const indices = new Array<number>(boxCount);
      for (let j = 0; j < boxCount; j++) indices[j] = j;

      while (true) {
        if (Date.now() - startTime > TIME_BUDGET_MS) break;

        const cells = indices.map((i) => region.cells[i]);

        for (const label of allLabels) {
          const labels = new Array<string>(boxCount).fill(label);
          if (isDeadlockedBFS(board, region, cells, labels)) {
            const key = configKey(cells, labels);
            deadlocks.add(key);
            patternCount++;
          }
        }

        let j = boxCount - 1;
        while (j >= 0 && indices[j] === region.cells.length - boxCount + j) j--;
        if (j < 0) break;
        indices[j]++;
        for (let m = j + 1; m < boxCount; m++) indices[m] = indices[m - 1] + 1;
      }
    }

    if (deadlocks.size > 0) {
      deadlockSets.set(regionId, deadlocks);
    }

    for (const cell of region.cells) {
      const existing = cellToRegions.get(cell) ?? [];
      existing.push(region);
      cellToRegions.set(cell, existing);
    }
  }

  return new DeadlockTableLookup(deadlockSets, cellToRegions, {
    regionCount: regions.length,
    patternCount,
    buildTimeMs: Date.now() - startTime,
  });
}

export async function buildDeadlockTablesAsync(
  board: CompiledSearchBoard,
  signal: AbortSignal,
): Promise<DeadlockTableLookup> {
  const startTime = Date.now();
  const regions = findWallAdjacentRegions(board);

  const deadlockSets = new Map<number, Set<string>>();
  const cellToRegions = new Map<number, SubGrid[]>();
  let patternCount = 0;

  const allLabels = [...board.goalCellsByLabel.keys()];
  if (allLabels.length === 0) {
    return new DeadlockTableLookup(deadlockSets, cellToRegions, {
      regionCount: 0,
      patternCount: 0,
      buildTimeMs: Date.now() - startTime,
    });
  }

  for (const region of regions) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    throwIfSolverCancelled(signal);
    await delayForEventLoop();

    const regionId = region.cells[0];
    const deadlocks = new Set<string>();

    for (let boxCount = MIN_BOX_COUNT; boxCount <= Math.min(MAX_BOX_COUNT, region.cells.length); boxCount++) {
      if (Date.now() - startTime > TIME_BUDGET_MS) break;

      const indices = new Array<number>(boxCount);
      for (let j = 0; j < boxCount; j++) indices[j] = j;

      while (true) {
        if (Date.now() - startTime > TIME_BUDGET_MS) break;

        const cells = indices.map((i) => region.cells[i]);

        for (const label of allLabels) {
          const labels = new Array<string>(boxCount).fill(label);
          if (isDeadlockedBFS(board, region, cells, labels)) {
            const key = configKey(cells, labels);
            deadlocks.add(key);
            patternCount++;
          }
        }

        let j = boxCount - 1;
        while (j >= 0 && indices[j] === region.cells.length - boxCount + j) j--;
        if (j < 0) break;
        indices[j]++;
        for (let m = j + 1; m < boxCount; m++) indices[m] = indices[m - 1] + 1;
      }
    }

    if (deadlocks.size > 0) {
      deadlockSets.set(regionId, deadlocks);
    }

    for (const cell of region.cells) {
      const existing = cellToRegions.get(cell) ?? [];
      existing.push(region);
      cellToRegions.set(cell, existing);
    }
  }

  return new DeadlockTableLookup(deadlockSets, cellToRegions, {
    regionCount: regions.length,
    patternCount,
    buildTimeMs: Date.now() - startTime,
  });
}
