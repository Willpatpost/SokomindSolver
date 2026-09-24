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

/** Lookup counters of one pattern database, for measurement only. */
export interface PdbLookupStats {
  lookups: number;
  /** Finite table values lowered to the exit bound. */
  exitCapTrims: number;
  /** Sum of the reductions counted by `exitCapTrims`. */
  exitCapTrimTotal: number;
  /** Lookups with a box outside the region, answered by the exit bound. */
  outsideRegionLookups: number;
}

/**
 * Relaxed push lower bound for boxes to reach the partition goals: the robot
 * teleports and a push needs only a floor support cell.
 *
 * The reverse BFS moves boxes only onto region cells, so a table value bounds
 * only plans that keep every box inside the region. When the region does not
 * cover the board, `lookup` returns min(table value, exit bound). A plan in
 * which some box leaves the region costs at least
 * sum of d(b) + min over boxes of (out(b) - d(b)), where d is the full-board
 * single-box push distance to the nearest partition goal and out(b) the same
 * distance for routes through an outside cell. A box outside the region is
 * answered by the exit bound alone. Entries a build deadline left missing are
 * bounded by the BFS frontier depth.
 *
 * UNSOLVED means no bound. It is returned when the boxes cannot all reach
 * partition goals, or for every lookup when the table was too large to build,
 * so a minimum over box subsets may skip it.
 */
export interface PatternDatabase {
  readonly k: number;
  readonly tableSize: number;
  readonly goalCells: readonly number[];
  readonly regionCells: readonly number[];
  readonly estimatedRetainedBytes: number;
  readonly lookupStats: PdbLookupStats;
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
    k * 8 +
    // Exit-bound distance and slack arrays, only when the region is partial.
    (regionCount < boardCellCount ? 2 * boardCellCount * Int32Array.BYTES_PER_ELEMENT : 0);
}

function createPdbLookupStats(): PdbLookupStats {
  return { lookups: 0, exitCapTrims: 0, exitCapTrimTotal: 0, outsideRegionLookups: 0 };
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
    lookupStats: createPdbLookupStats(),
    lookup: () => UNSOLVED,
  };
}

function canAllocatePatternDatabase(tableSize: number): boolean {
  return Number.isSafeInteger(tableSize) &&
    tableSize > 0 &&
    tableSize <= MAX_PDB_TABLE_ENTRIES;
}

// ---------------------------------------------------------------------------
// Exit bound: full-board single-box push distances for boxes whose relaxed
// route leaves the region.
// ---------------------------------------------------------------------------

/** Per-cell terms of the exit bound; -1 means none. */
interface PdbExitCap {
  /** d(c): relaxed push distance to the nearest partition goal. */
  readonly goalDistance: Int32Array;
  /** out(c) - d(c): extra pushes of the cheapest route through an outside cell. */
  readonly exitSlack: Int32Array;
}

/**
 * Settles each unsettled cell from which a push (with a floor support cell)
 * moves a box onto `cell`, at `cost`, and queues it. Returns the new tail.
 */
function relaxReversePushes(
  board: CompiledSearchBoard,
  cell: number,
  cost: number,
  distances: Int32Array,
  queue: Int32Array,
  tail: number,
): number {
  const neighbors = board.neighbors[cell];
  for (let d = 0; d < 4; d++) {
    const previous = neighbors[d];
    if (previous < 0 || distances[previous] >= 0) continue;
    if (board.neighbors[previous][d] < 0) continue;
    distances[previous] = cost;
    queue[tail++] = previous;
  }
  return tail;
}

function buildPdbExitCap(
  board: CompiledSearchBoard,
  goalCells: readonly number[],
  cellToRegionIndex: Int32Array,
): PdbExitCap {
  const cellCount = board.cellCount;
  const queue = new Int32Array(cellCount);
  const goalDistance = new Int32Array(cellCount).fill(-1);
  let head = 0;
  let tail = 0;
  for (const goal of goalCells) {
    if (goalDistance[goal] >= 0) continue;
    goalDistance[goal] = 0;
    queue[tail++] = goal;
  }
  while (head < tail) {
    const cell = queue[head++];
    tail = relaxReversePushes(board, cell, goalDistance[cell] + 1, goalDistance, queue, tail);
  }

  // out(c) = min over outside cells o of push(c -> o) + d(o). Holds out()
  // until the final pass turns it into slack. An outside cell's out(o) is its
  // own d(o) (triangle inequality), so those sources are settled up front and
  // merged in cost order with the unit-cost FIFO queue.
  const exitSlack = new Int32Array(cellCount).fill(-1);
  const sources: number[] = [];
  for (let cell = 0; cell < cellCount; cell++) {
    if (cellToRegionIndex[cell] >= 0 || goalDistance[cell] < 0) continue;
    exitSlack[cell] = goalDistance[cell];
    sources.push(cell);
  }
  sources.sort((a, b) => goalDistance[a] - goalDistance[b]);
  head = 0;
  tail = 0;
  let nextSource = 0;
  while (nextSource < sources.length || head < tail) {
    const cell = nextSource < sources.length &&
        (head === tail || exitSlack[sources[nextSource]] <= exitSlack[queue[head]])
      ? sources[nextSource++]
      : queue[head++];
    tail = relaxReversePushes(board, cell, exitSlack[cell] + 1, exitSlack, queue, tail);
  }
  // A cell that reaches an outside cell also reaches a goal, so d(c) >= 0.
  for (let cell = 0; cell < cellCount; cell++) {
    if (exitSlack[cell] >= 0) exitSlack[cell] -= goalDistance[cell];
  }
  return { goalDistance, exitSlack };
}

// ---------------------------------------------------------------------------
// PDB construction via reverse-push BFS (chunked packed ranks)
// ---------------------------------------------------------------------------

/**
 * `undiscovered` answers in-region entries the BFS never reached: UNSOLVED
 * after a complete build, the frontier depth after a deadline.
 */
function makePdbLookup(
  cellToRegionIndex: Int32Array,
  binom: Float64Array[],
  table: Uint16Array,
  undiscovered: number,
  exitCap: PdbExitCap | null,
  stats: PdbLookupStats,
): PatternDatabase["lookup"] {
  const tableSize = table.length;
  return (boxCells: readonly number[]): number => {
    stats.lookups++;
    const regionPositions: number[] = [];
    let distanceSum = 0;
    let minSlack = -1;
    let outside = false;
    for (const cell of boxCells) {
      if (exitCap !== null) {
        const distance = exitCap.goalDistance[cell];
        if (distance < 0) return UNSOLVED;
        distanceSum += distance;
        const slack = exitCap.exitSlack[cell];
        if (slack >= 0 && (minSlack < 0 || slack < minSlack)) minSlack = slack;
      }
      const rp = cellToRegionIndex[cell];
      if (rp < 0) outside = true;
      else regionPositions.push(rp);
    }
    const exitBound = minSlack < 0 ? UNSOLVED : Math.min(UNSOLVED, distanceSum + minSlack);
    if (outside) {
      stats.outsideRegionLookups++;
      return exitBound;
    }
    regionPositions.sort((a, b) => a - b);
    const index = combinadicEncode(regionPositions, binom);
    if (index >= tableSize) return UNSOLVED;
    const stored = table[index];
    if (stored === UNSOLVED) return Math.min(undiscovered, exitBound);
    if (exitBound < stored) {
      stats.exitCapTrims++;
      stats.exitCapTrimTotal += stored - exitBound;
      return exitBound;
    }
    return stored;
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
  /** Null when the region covers every floor cell. */
  readonly exitCap: PdbExitCap | null;
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
    return {
      k: 0, tableSize: 0, goalCells, regionCells, estimatedRetainedBytes: 0,
      lookupStats: createPdbLookupStats(), lookup: () => 0,
    };
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
    return {
      k, tableSize, goalCells: [...goalCells], regionCells: [...regionCells],
      estimatedRetainedBytes: retainedBytes, lookupStats: createPdbLookupStats(), lookup: () => UNSOLVED,
    };
  }

  const solvedRank = combinadicEncode(solvedPositions, binom);
  table[solvedRank] = 0;
  const exitCap = regionCount < board.cellCount
    ? buildPdbExitCap(board, goalCells, cellToRegionIndex)
    : null;

  return {
    ctx: { board, regionCells, regionSet, regionCount, cellToRegionIndex, binom, table, k, exitCap },
    solvedRank,
    retainedBytes,
  };
}

function finishPdb(
  ctx: PdbBfsContext,
  retainedBytes: number,
  goalCells: readonly number[],
  undiscovered: number,
): PatternDatabase {
  const lookupStats = createPdbLookupStats();
  return {
    k: ctx.k,
    tableSize: ctx.table.length,
    goalCells: [...goalCells],
    regionCells: [...ctx.regionCells],
    estimatedRetainedBytes: retainedBytes,
    lookupStats,
    lookup: makePdbLookup(ctx.cellToRegionIndex, ctx.binom, ctx.table, undiscovered, ctx.exitCap, lookupStats),
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

  return finishPdb(ctx, retainedBytes, config.goalCells, UNSOLVED);
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
  // Depth of the last dequeued state. FIFO order had already expanded every
  // shallower state, so every state this close to the goals was discovered.
  let frontierDepth = 0;

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
      frontierDepth = dist;
      expandPdbState(ctx, rank, dist + 1, queue, positions, occupiedRegion, newPositions, checkQueueAllocation);
    }
  } catch (err) {
    if (!isExactPreprocessingLimitError(err) || err.reason !== "elapsed") throw err;
    // Missing entries are at least one push deeper than the frontier; a
    // subset minimum needs that bound rather than UNSOLVED to stay sound.
    return finishPdb(ctx, retainedBytes, config.goalCells, frontierDepth + 1);
  }

  return finishPdb(ctx, retainedBytes, config.goalCells, UNSOLVED);
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
