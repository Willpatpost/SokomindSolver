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
  result: number[] = new Array<number>(k),
): number[] {
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
// PDB construction via reverse-push BFS (chunked packed ranks)
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

const PDB_QUEUE_CHUNK_SIZE = 4096;

/** FIFO ranks; consumed chunks are released rather than retained by the queue. */
class PackedRankQueue {
  readonly #chunks = new Map<number, Uint32Array>();
  #head = 0;
  #tail = 0;

  get size(): number { return this.#tail - this.#head; }
  get retainedBytes(): number {
    return this.#chunks.size * (PDB_QUEUE_CHUNK_SIZE * Uint32Array.BYTES_PER_ELEMENT + 64);
  }

  push(rank: number, checkAllocation?: (additionalBytes: number) => void): void {
    const chunkId = Math.floor(this.#tail / PDB_QUEUE_CHUNK_SIZE);
    let chunk = this.#chunks.get(chunkId);
    if (!chunk) {
      checkAllocation?.(PDB_QUEUE_CHUNK_SIZE * Uint32Array.BYTES_PER_ELEMENT + 64);
      chunk = new Uint32Array(PDB_QUEUE_CHUNK_SIZE);
      this.#chunks.set(chunkId, chunk);
    }
    chunk[this.#tail % PDB_QUEUE_CHUNK_SIZE] = rank;
    this.#tail++;
  }

  shift(): number {
    const chunkId = Math.floor(this.#head / PDB_QUEUE_CHUNK_SIZE);
    const rank = this.#chunks.get(chunkId)![this.#head % PDB_QUEUE_CHUNK_SIZE];
    this.#head++;
    if (this.#head % PDB_QUEUE_CHUNK_SIZE === 0) this.#chunks.delete(chunkId);
    return rank;
  }
}

function expandPdbState(
  ctx: PdbBfsContext,
  rank: number,
  dist: number,
  queue: PackedRankQueue,
  positions: number[],
  occupiedRegion: Uint8Array,
  newPositions: number[],
  checkAllocation?: (additionalBytes: number) => void,
): void {
  const { board, regionCells, regionSet, regionCount, cellToRegionIndex, binom, table, k } = ctx;
  combinadicDecode(rank, k, regionCount, binom, positions);

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

      queue.push(newIndex, checkAllocation);
      table[newIndex] = dist;
    }
  }
}

function preparePdbBfs(
  board: CompiledSearchBoard,
  config: PatternDatabaseConfig,
  budget?: ExactPreprocessingBudget,
): { ctx: PdbBfsContext; solvedRank: number; retainedBytes: number } | PatternDatabase {
  const { goalCells, regionCells } = config;
  const k = goalCells.length;

  if (k === 0) {
    return { k: 0, tableSize: 0, goalCells, regionCells, estimatedRetainedBytes: 0, lookup: () => 0 };
  }
  if (k > MAX_K) {
    throw new RangeError(`PDB k=${k} exceeds maximum ${MAX_K}`);
  }

  const regionCount = regionCells.length;
  checkExactPreprocessingBudget(budget, estimatePdbRetainedBytes(board.cellCount, regionCount, k, 0));
  const regionSet = new Set(regionCells);
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
  checkExactPreprocessingBudget(budget, retainedBytes);
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

  const queue = new PackedRankQueue();
  queue.push(solvedRank);

  while (queue.size > 0) {
    const rank = queue.shift();
    const dist = ctx.table[rank];
    if (dist >= UNSOLVED - 1) continue;
    expandPdbState(ctx, rank, dist + 1, queue, positions, occupiedRegion, newPositions);
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
  throwIfSolverCancelled(signal);
  const prepared = preparePdbBfs(board, config, budget);
  if ("lookup" in prepared) return prepared;
  const { ctx, solvedRank, retainedBytes } = prepared;

  const workspaceBytes = ctx.regionCount + ctx.k * 16;
  checkExactPreprocessingBudget(budget, retainedBytes + workspaceBytes);

  const positions = new Array<number>(ctx.k);
  const newPositions = new Array<number>(ctx.k);
  const occupiedRegion = new Uint8Array(ctx.regionCount);

  const queue = new PackedRankQueue();
  const checkQueueAllocation = (additionalBytes = 0) => {
    throwIfSolverCancelled(signal);
    checkExactPreprocessingBudget(budget, retainedBytes + workspaceBytes + queue.retainedBytes + additionalBytes);
  };
  let processed = 0;

  try {
    queue.push(solvedRank, checkQueueAllocation);
    while (queue.size > 0) {
      if ((processed & 255) === 0) checkQueueAllocation();
      if (processed > 0 && (processed % PDB_BFS_YIELD_INTERVAL) === 0) {
        await delayForEventLoop();
        checkQueueAllocation();
      }
      const rank = queue.shift();
      processed++;
      const dist = ctx.table[rank];
      if (dist >= UNSOLVED - 1) continue;
      expandPdbState(ctx, rank, dist + 1, queue, positions, occupiedRegion, newPositions, checkQueueAllocation);
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
