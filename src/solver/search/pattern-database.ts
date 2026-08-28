import type { CompiledSearchBoard } from "./compiled-board.ts";
import { throwIfSolverCancelled } from "../cancellation.ts";
import { delayForEventLoop } from "./scheduling.ts";
import {
  checkExactPreprocessingBudget,
  type ExactPreprocessingBudget,
} from "./preprocessing-budget.ts";

export interface PatternDatabaseConfig {
  readonly goalCells: readonly number[];
  readonly labelIds: readonly string[];
  readonly regionCells: readonly number[];
}

export interface PatternDatabase {
  readonly k: number;
  readonly tableSize: number;
  readonly goalCells: readonly number[];
  readonly regionCells: readonly number[];
  readonly estimatedRetainedBytes: number;
  lookup(boxCells: readonly number[]): number;
}

const UNSOLVED = 0xffff;
const MAX_K = 6;
const MAX_PDB_TABLE_BYTES = 512 * 1024 * 1024;
const MAX_PDB_TABLE_ENTRIES = Math.floor(
  MAX_PDB_TABLE_BYTES / Uint16Array.BYTES_PER_ELEMENT,
);

function estimatePdbRetainedBytes(
  boardCellCount: number,
  regionCount: number,
  k: number,
  tableSize: number,
): number {
  return 256 +
    boardCellCount * Int32Array.BYTES_PER_ELEMENT +
    (regionCount + 1) * (k + 1) * Float64Array.BYTES_PER_ELEMENT +
    tableSize * Uint16Array.BYTES_PER_ELEMENT +
    regionCount * 8 +
    k * 8;
}

// ---------------------------------------------------------------------------
// Combinadic encoding: map k sorted positions from a set of n to a contiguous
// index in [0, C(n,k)).
// ---------------------------------------------------------------------------

function buildBinomials(maxN: number, maxK: number): Float64Array[] {
  const table: Float64Array[] = new Array(maxN + 1);
  for (let n = 0; n <= maxN; n++) {
    table[n] = new Float64Array(maxK + 1);
    table[n][0] = 1;
    for (let k = 1; k <= Math.min(n, maxK); k++) {
      const value = table[n - 1][k - 1] + table[n - 1][k];
      table[n][k] = Number.isSafeInteger(value)
        ? value
        : Number.MAX_SAFE_INTEGER;
    }
  }
  return table;
}

function combinadicEncode(
  positions: readonly number[],
  binom: Float64Array[],
): number {
  let index = 0;
  for (let i = 0; i < positions.length; i++) {
    index += binom[positions[i]][i + 1];
  }
  return index;
}

function combinadicDecode(
  index: number,
  k: number,
  n: number,
  binom: Float64Array[],
): number[] {
  const result = new Array<number>(k);
  let remaining = index;
  let ceiling = n;
  for (let i = k; i >= 1; i--) {
    let v = i - 1;
    while (v < ceiling && binom[v + 1][i] <= remaining) {
      v++;
    }
    result[i - 1] = v;
    remaining -= binom[v][i];
    ceiling = v;
  }
  return result;
}

function disabledPatternDatabase(
  k: number,
  goalCells: readonly number[],
  regionCells: readonly number[],
): PatternDatabase {
  return {
    k,
    tableSize: 0,
    goalCells: [...goalCells],
    regionCells: [...regionCells],
    estimatedRetainedBytes: 0,
    lookup: () => UNSOLVED,
  };
}

function canAllocatePatternDatabase(tableSize: number): boolean {
  return Number.isSafeInteger(tableSize) &&
    tableSize > 0 &&
    tableSize <= MAX_PDB_TABLE_ENTRIES;
}

// ---------------------------------------------------------------------------
// PDB construction via reverse-push BFS
// ---------------------------------------------------------------------------

export function buildPatternDatabase(
  board: CompiledSearchBoard,
  config: PatternDatabaseConfig,
): PatternDatabase {
  const { goalCells, regionCells } = config;
  const k = goalCells.length;

  if (k === 0) {
    return { k: 0, tableSize: 0, goalCells, regionCells, estimatedRetainedBytes: 0, lookup: () => 0 };
  }
  if (k > MAX_K) {
    throw new RangeError(`PDB k=${k} exceeds maximum ${MAX_K}`);
  }

  const regionSet = new Set(regionCells);
  const regionCount = regionCells.length;

  const cellToRegionIndex = new Int32Array(board.cellCount).fill(-1);
  for (let i = 0; i < regionCells.length; i++) {
    cellToRegionIndex[regionCells[i]] = i;
  }

  const binom = buildBinomials(regionCount, k);
  const tableSize = binom[regionCount][k];

  if (!canAllocatePatternDatabase(tableSize)) {
    return disabledPatternDatabase(k, goalCells, regionCells);
  }

  const table = new Uint16Array(tableSize);
  table.fill(UNSOLVED);

  const solvedRegionPositions = goalCells
    .map((gc) => cellToRegionIndex[gc])
    .sort((a, b) => a - b);

  if (solvedRegionPositions.some((p) => p < 0)) {
    return {
      k,
      tableSize,
      goalCells,
      regionCells,
      estimatedRetainedBytes: estimatePdbRetainedBytes(
        board.cellCount, regionCount, k, tableSize,
      ),
      lookup: () => UNSOLVED,
    };
  }

  const solvedIndex = combinadicEncode(solvedRegionPositions, binom);
  table[solvedIndex] = 0;

  interface BfsState {
    regionPositions: number[];
  }

  const queue: BfsState[] = [{ regionPositions: [...solvedRegionPositions] }];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    const currentIndex = combinadicEncode(current.regionPositions, binom);
    const currentDist = table[currentIndex];

    if (currentDist >= UNSOLVED - 1) continue;

    const occupiedRegion = new Uint8Array(regionCount);
    for (const rp of current.regionPositions) {
      occupiedRegion[rp] = 1;
    }

    for (let bi = 0; bi < k; bi++) {
      const regionPos = current.regionPositions[bi];
      const boardCell = regionCells[regionPos];
      const neighbors = board.neighbors[boardCell];

      for (let d = 0; d < 4; d++) {
        const destCell = neighbors[d];
        if (destCell < 0) continue;

        const destRegion = cellToRegionIndex[destCell];
        if (destRegion < 0) continue;
        if (occupiedRegion[destRegion]) continue;

        const supportCell = board.neighbors[destCell]?.[d] ?? -1;
        if (supportCell < 0) continue;
        if (!regionSet.has(supportCell) && board.neighbors[supportCell] === undefined) continue;
        if (board.positions[supportCell] === undefined) continue;

        const newPositions = [...current.regionPositions];
        newPositions[bi] = destRegion;
        newPositions.sort((a, b) => a - b);

        const newIndex = combinadicEncode(newPositions, binom);
        if (table[newIndex] !== UNSOLVED) continue;

        table[newIndex] = currentDist + 1;
        queue.push({ regionPositions: newPositions });
      }
    }
  }

  return {
    k,
    tableSize,
    goalCells: [...goalCells],
    regionCells: [...regionCells],
    estimatedRetainedBytes: estimatePdbRetainedBytes(
      board.cellCount, regionCount, k, tableSize,
    ),
    lookup(boxCells: readonly number[]): number {
      const regionPositions: number[] = [];
      for (const cell of boxCells) {
        const rp = cellToRegionIndex[cell];
        if (rp < 0) return UNSOLVED;
        regionPositions.push(rp);
      }
      regionPositions.sort((a, b) => a - b);
      const index = combinadicEncode(regionPositions, binom);
      if (index >= tableSize) return UNSOLVED;
      return table[index];
    },
  };
}

const PDB_BFS_YIELD_INTERVAL = 4096;

export async function buildPatternDatabaseAsync(
  board: CompiledSearchBoard,
  config: PatternDatabaseConfig,
  signal: AbortSignal,
  budget?: ExactPreprocessingBudget,
): Promise<PatternDatabase> {
  const { goalCells, regionCells } = config;
  const k = goalCells.length;
  checkExactPreprocessingBudget(budget);

  if (k === 0) {
    return { k: 0, tableSize: 0, goalCells, regionCells, estimatedRetainedBytes: 0, lookup: () => 0 };
  }
  if (k > MAX_K) {
    throw new RangeError(`PDB k=${k} exceeds maximum ${MAX_K}`);
  }

  const regionSet = new Set(regionCells);
  const regionCount = regionCells.length;

  const cellToRegionIndex = new Int32Array(board.cellCount).fill(-1);
  for (let i = 0; i < regionCells.length; i++) {
    cellToRegionIndex[regionCells[i]] = i;
  }

  const binom = buildBinomials(regionCount, k);
  const tableSize = binom[regionCount][k];
  if (!canAllocatePatternDatabase(tableSize)) {
    return disabledPatternDatabase(k, goalCells, regionCells);
  }
  const retainedBytes = estimatePdbRetainedBytes(
    board.cellCount, regionCount, k, tableSize,
  );
  checkExactPreprocessingBudget(budget, retainedBytes);

  const table = new Uint16Array(tableSize);
  table.fill(UNSOLVED);

  const solvedRegionPositions = goalCells
    .map((gc) => cellToRegionIndex[gc])
    .sort((a, b) => a - b);

  if (solvedRegionPositions.some((p) => p < 0)) {
    return { k, tableSize, goalCells, regionCells, estimatedRetainedBytes: retainedBytes, lookup: () => UNSOLVED };
  }

  const solvedIndex = combinadicEncode(solvedRegionPositions, binom);
  table[solvedIndex] = 0;

  interface BfsState {
    regionPositions: number[];
  }

  const queue: BfsState[] = [{ regionPositions: [...solvedRegionPositions] }];
  let head = 0;
  let itersSinceYield = 0;

  throwIfSolverCancelled(signal);
  checkExactPreprocessingBudget(budget, retainedBytes + 64 + k * 8);

  while (head < queue.length) {
    if ((head & 255) === 0) {
      checkExactPreprocessingBudget(
        budget,
        retainedBytes + queue.length * (32 + k * 8),
      );
    }
    if (++itersSinceYield >= PDB_BFS_YIELD_INTERVAL) {
      itersSinceYield = 0;
      await delayForEventLoop();
      throwIfSolverCancelled(signal);
      checkExactPreprocessingBudget(
        budget,
        retainedBytes + queue.length * (32 + k * 8),
      );
    }

    const current = queue[head++];
    const currentIndex = combinadicEncode(current.regionPositions, binom);
    const currentDist = table[currentIndex];

    if (currentDist >= UNSOLVED - 1) continue;

    const occupiedRegion = new Uint8Array(regionCount);
    for (const rp of current.regionPositions) {
      occupiedRegion[rp] = 1;
    }

    for (let bi = 0; bi < k; bi++) {
      const regionPos = current.regionPositions[bi];
      const boardCell = regionCells[regionPos];
      const neighbors = board.neighbors[boardCell];

      for (let d = 0; d < 4; d++) {
        const destCell = neighbors[d];
        if (destCell < 0) continue;

        const destRegion = cellToRegionIndex[destCell];
        if (destRegion < 0) continue;
        if (occupiedRegion[destRegion]) continue;

        const supportCell = board.neighbors[destCell]?.[d] ?? -1;
        if (supportCell < 0) continue;
        if (!regionSet.has(supportCell) && board.neighbors[supportCell] === undefined) continue;
        if (board.positions[supportCell] === undefined) continue;

        const newPositions = [...current.regionPositions];
        newPositions[bi] = destRegion;
        newPositions.sort((a, b) => a - b);

        const newIndex = combinadicEncode(newPositions, binom);
        if (table[newIndex] !== UNSOLVED) continue;

        table[newIndex] = currentDist + 1;
        queue.push({ regionPositions: newPositions });
      }
    }
  }

  return {
    k,
    tableSize,
    goalCells: [...goalCells],
    regionCells: [...regionCells],
    estimatedRetainedBytes: retainedBytes,
    lookup(boxCells: readonly number[]): number {
      const regionPositions: number[] = [];
      for (const cell of boxCells) {
        const rp = cellToRegionIndex[cell];
        if (rp < 0) return UNSOLVED;
        regionPositions.push(rp);
      }
      regionPositions.sort((a, b) => a - b);
      const index = combinadicEncode(regionPositions, binom);
      if (index >= tableSize) return UNSOLVED;
      return table[index];
    },
  };
}

export function buildGoalRegion(
  board: CompiledSearchBoard,
  goalCells: readonly number[],
  maxDistance: number = 8,
): number[] {
  const region = new Set<number>();
  const dist = new Int32Array(board.cellCount).fill(-1);
  const queue: number[] = [];

  for (const gc of goalCells) {
    if (dist[gc] < 0) {
      dist[gc] = 0;
      queue.push(gc);
      region.add(gc);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const cell = queue[head++];
    if (dist[cell] >= maxDistance) continue;

    const neighbors = board.neighbors[cell];
    for (let d = 0; d < 4; d++) {
      const next = neighbors[d];
      if (next < 0 || dist[next] >= 0) continue;
      dist[next] = dist[cell] + 1;
      region.add(next);
      queue.push(next);
    }
  }

  return [...region].sort((a, b) => a - b);
}

export {
  combinadicEncode,
  combinadicDecode,
  buildBinomials,
  UNSOLVED,
  PDB_BFS_YIELD_INTERVAL,
  MAX_PDB_TABLE_ENTRIES,
};
