import type { CompiledSearchBoard } from "./compiled-board.ts";
import { throwIfSolverCancelled } from "../cancellation.ts";
import { delayForEventLoop } from "./scheduling.ts";
import {
  checkExactPreprocessingBudget,
  isExactPreprocessingLimitError,
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
// PDB construction via reverse-push BFS (level-based packed ranks)
// ---------------------------------------------------------------------------

function makePdbLookup(
  cellToRegionIndex: Int32Array,
  binom: Float64Array[],
  tableSize: number,
  table: Uint16Array,
): PatternDatabase["lookup"] {
  return (boxCells: readonly number[]): number => {
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
  };
}

interface PdbBfsContext {
  readonly board: CompiledSearchBoard;
  readonly regionCells: readonly number[];
  readonly regionSet: Set<number>;
  readonly regionCount: number;
  readonly cellToRegionIndex: Int32Array;
  readonly binom: Float64Array[];
  readonly table: Uint16Array;
  readonly k: number;
}

function expandPdbLevel(
  ctx: PdbBfsContext,
  currentLevel: Uint32Array,
  dist: number,
  nextLevel: number[],
  positions: number[],
  occupiedRegion: Uint8Array,
  newPositions: number[],
): void {
  const { board, regionCells, regionSet, regionCount, cellToRegionIndex, binom, table, k } = ctx;
  for (let ci = 0; ci < currentLevel.length; ci++) {
    const rank = currentLevel[ci];
    combinadicDecode(rank, k, regionCount, binom).forEach((v, i) => { positions[i] = v; });

    occupiedRegion.fill(0);
    for (let i = 0; i < k; i++) occupiedRegion[positions[i]] = 1;

    for (let bi = 0; bi < k; bi++) {
      const boardCell = regionCells[positions[bi]];
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

        for (let i = 0; i < k; i++) newPositions[i] = positions[i];
        newPositions[bi] = destRegion;
        newPositions.sort((a, b) => a - b);

        const newIndex = combinadicEncode(newPositions, binom);
        if (table[newIndex] !== UNSOLVED) continue;

        table[newIndex] = dist;
        nextLevel.push(newIndex);
      }
    }
  }
}

function preparePdbBfs(
  board: CompiledSearchBoard,
  config: PatternDatabaseConfig,
): { ctx: PdbBfsContext; solvedRank: number; retainedBytes: number } | PatternDatabase {
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

  const retainedBytes = estimatePdbRetainedBytes(board.cellCount, regionCount, k, tableSize);
  const table = new Uint16Array(tableSize);
  table.fill(UNSOLVED);

  const solvedPositions = goalCells.map((gc) => cellToRegionIndex[gc]).sort((a, b) => a - b);
  if (solvedPositions.some((p) => p < 0)) {
    return { k, tableSize, goalCells: [...goalCells], regionCells: [...regionCells], estimatedRetainedBytes: retainedBytes, lookup: () => UNSOLVED };
  }

  const solvedRank = combinadicEncode(solvedPositions, binom);
  table[solvedRank] = 0;

  return {
    ctx: { board, regionCells, regionSet, regionCount, cellToRegionIndex, binom, table, k },
    solvedRank,
    retainedBytes,
  };
}

function finishPdb(ctx: PdbBfsContext, retainedBytes: number, goalCells: readonly number[]): PatternDatabase {
  return {
    k: ctx.k,
    tableSize: ctx.table.length,
    goalCells: [...goalCells],
    regionCells: [...ctx.regionCells],
    estimatedRetainedBytes: retainedBytes,
    lookup: makePdbLookup(ctx.cellToRegionIndex, ctx.binom, ctx.table.length, ctx.table),
  };
}

export function buildPatternDatabase(
  board: CompiledSearchBoard,
  config: PatternDatabaseConfig,
): PatternDatabase {
  const prepared = preparePdbBfs(board, config);
  if ("lookup" in prepared) return prepared;
  const { ctx, solvedRank, retainedBytes } = prepared;

  const positions = new Array<number>(ctx.k);
  const newPositions = new Array<number>(ctx.k);
  const occupiedRegion = new Uint8Array(ctx.regionCount);

  let currentLevel = Uint32Array.from([solvedRank]);
  let dist = 1;

  while (currentLevel.length > 0) {
    const nextLevel: number[] = [];
    expandPdbLevel(ctx, currentLevel, dist, nextLevel, positions, occupiedRegion, newPositions);
    currentLevel = Uint32Array.from(nextLevel);
    dist++;
  }

  return finishPdb(ctx, retainedBytes, config.goalCells);
}

const PDB_BFS_YIELD_INTERVAL = 4096;

export async function buildPatternDatabaseAsync(
  board: CompiledSearchBoard,
  config: PatternDatabaseConfig,
  signal: AbortSignal,
  budget?: ExactPreprocessingBudget,
): Promise<PatternDatabase> {
  checkExactPreprocessingBudget(budget);
  const prepared = preparePdbBfs(board, config);
  if ("lookup" in prepared) return prepared;
  const { ctx, solvedRank, retainedBytes } = prepared;

  checkExactPreprocessingBudget(budget, retainedBytes);

  const positions = new Array<number>(ctx.k);
  const newPositions = new Array<number>(ctx.k);
  const occupiedRegion = new Uint8Array(ctx.regionCount);

  let currentLevel = Uint32Array.from([solvedRank]);
  let dist = 1;
  let totalSettled = 1;

  throwIfSolverCancelled(signal);

  try {
    while (currentLevel.length > 0) {
      const nextLevel: number[] = [];
      for (let ci = 0; ci < currentLevel.length; ci++) {
        if ((ci & 255) === 0) {
          checkExactPreprocessingBudget(budget, retainedBytes + totalSettled * 4);
        }
        if (ci > 0 && (ci % PDB_BFS_YIELD_INTERVAL) === 0) {
          await delayForEventLoop();
          throwIfSolverCancelled(signal);
          checkExactPreprocessingBudget(budget, retainedBytes + totalSettled * 4);
        }

        const rank = currentLevel[ci];
        combinadicDecode(rank, ctx.k, ctx.regionCount, ctx.binom).forEach((v, i) => { positions[i] = v; });

        occupiedRegion.fill(0);
        for (let i = 0; i < ctx.k; i++) occupiedRegion[positions[i]] = 1;

        for (let bi = 0; bi < ctx.k; bi++) {
          const boardCell = ctx.regionCells[positions[bi]];
          const neighbors = ctx.board.neighbors[boardCell];

          for (let d = 0; d < 4; d++) {
            const destCell = neighbors[d];
            if (destCell < 0) continue;
            const destRegion = ctx.cellToRegionIndex[destCell];
            if (destRegion < 0) continue;
            if (occupiedRegion[destRegion]) continue;

            const supportCell = ctx.board.neighbors[destCell]?.[d] ?? -1;
            if (supportCell < 0) continue;
            if (!ctx.regionSet.has(supportCell) && ctx.board.neighbors[supportCell] === undefined) continue;
            if (ctx.board.positions[supportCell] === undefined) continue;

            for (let i = 0; i < ctx.k; i++) newPositions[i] = positions[i];
            newPositions[bi] = destRegion;
            newPositions.sort((a, b) => a - b);

            const newIndex = combinadicEncode(newPositions, ctx.binom);
            if (ctx.table[newIndex] !== UNSOLVED) continue;

            ctx.table[newIndex] = dist;
            nextLevel.push(newIndex);
          }
        }
      }
      totalSettled += nextLevel.length;
      currentLevel = Uint32Array.from(nextLevel);
      dist++;
    }
  } catch (err) {
    if (!isExactPreprocessingLimitError(err) || err.reason !== "elapsed") throw err;
  }

  return finishPdb(ctx, retainedBytes, config.goalCells);
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
