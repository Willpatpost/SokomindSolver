import type { CompiledSearchBoard } from "./compiled-board.ts";
import { throwIfSolverCancelled } from "../cancellation.ts";
import { delayForEventLoop } from "./engine.ts";

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
  lookup(boxCells: readonly number[]): number;
}

const UNSOLVED = 0xffff;
const MAX_K = 6;

// ---------------------------------------------------------------------------
// Combinadic encoding: map k sorted positions from a set of n to a contiguous
// index in [0, C(n,k)).
// ---------------------------------------------------------------------------

function buildBinomials(maxN: number, maxK: number): Uint32Array[] {
  const table: Uint32Array[] = new Array(maxN + 1);
  for (let n = 0; n <= maxN; n++) {
    table[n] = new Uint32Array(maxK + 1);
    table[n][0] = 1;
    for (let k = 1; k <= Math.min(n, maxK); k++) {
      table[n][k] = table[n - 1][k - 1] + table[n - 1][k];
    }
  }
  return table;
}

function combinadicEncode(
  positions: readonly number[],
  binom: Uint32Array[],
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
  binom: Uint32Array[],
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
    return { k: 0, tableSize: 0, goalCells, regionCells, lookup: () => 0 };
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

  if (tableSize === 0) {
    return { k, tableSize: 0, goalCells, regionCells, lookup: () => UNSOLVED };
  }

  const table = new Uint16Array(tableSize);
  table.fill(UNSOLVED);

  const solvedRegionPositions = goalCells
    .map((gc) => cellToRegionIndex[gc])
    .sort((a, b) => a - b);

  if (solvedRegionPositions.some((p) => p < 0)) {
    return { k, tableSize, goalCells, regionCells, lookup: () => UNSOLVED };
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
): Promise<PatternDatabase> {
  const { goalCells, regionCells } = config;
  const k = goalCells.length;

  if (k === 0) {
    return { k: 0, tableSize: 0, goalCells, regionCells, lookup: () => 0 };
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

  if (tableSize === 0) {
    return { k, tableSize: 0, goalCells, regionCells, lookup: () => UNSOLVED };
  }

  const table = new Uint16Array(tableSize);
  table.fill(UNSOLVED);

  const solvedRegionPositions = goalCells
    .map((gc) => cellToRegionIndex[gc])
    .sort((a, b) => a - b);

  if (solvedRegionPositions.some((p) => p < 0)) {
    return { k, tableSize, goalCells, regionCells, lookup: () => UNSOLVED };
  }

  const solvedIndex = combinadicEncode(solvedRegionPositions, binom);
  table[solvedIndex] = 0;

  interface BfsState {
    regionPositions: number[];
  }

  const queue: BfsState[] = [{ regionPositions: [...solvedRegionPositions] }];
  let head = 0;
  let itersSinceYield = 0;

  while (head < queue.length) {
    if (++itersSinceYield >= PDB_BFS_YIELD_INTERVAL) {
      itersSinceYield = 0;
      throwIfSolverCancelled(signal);
      await delayForEventLoop();
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

export { combinadicEncode, combinadicDecode, buildBinomials, UNSOLVED, PDB_BFS_YIELD_INTERVAL };
