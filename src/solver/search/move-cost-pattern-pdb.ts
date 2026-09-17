import type { CompiledSearchBoard } from "./compiled-board.ts";
import { SEARCH_DIRECTION_COUNT } from "./compiled-board.ts";
import {
  checkExactPreprocessingBudget,
  type ExactPreprocessingBudget,
} from "./preprocessing-budget.ts";
import type { DenseBox } from "./model.ts";

const OPPOSITE_DIRECTION = [1, 0, 3, 2] as const;

// ---------------------------------------------------------------------------
// Open-addressing hash table with typed arrays
// ---------------------------------------------------------------------------

const EMPTY_SLOT = 0xFFFF_FFFF;
const DIST_SENTINEL = 0xFFFF;
const STATUS_EMPTY = 0;
const STATUS_TENTATIVE = 1;
const STATUS_SETTLED = 2;
const BYTES_PER_ENTRY = 4 + 4 + 2 + 1;

function nextPowerOfTwo(n: number): number {
  let v = n - 1;
  v |= v >>> 1; v |= v >>> 2; v |= v >>> 4;
  v |= v >>> 8; v |= v >>> 16;
  return v + 1;
}

function hashMix(keyLow: number, keyHigh: number, mask: number): number {
  let h = Math.imul(keyLow, 0x9E3779B9) ^ Math.imul(keyHigh, 0x517CC1B7);
  h = (h ^ (h >>> 16)) & mask;
  return h;
}

function splitKey(rank: number): [number, number] {
  const lo = rank >>> 0;
  const hi = (rank - lo) / 0x1_0000_0000;
  return [lo, hi >>> 0];
}

class SparseDistanceTable {
  readonly capacity: number;
  private readonly mask: number;
  private readonly keyLow: Uint32Array;
  private readonly keyHigh: Uint32Array;
  private readonly dist: Uint16Array;
  private readonly status: Uint8Array;
  private _size = 0;
  private _settled = 0;

  constructor(maxEntries: number) {
    this.capacity = nextPowerOfTwo(Math.max(16, Math.ceil(maxEntries / 0.65)));
    this.mask = this.capacity - 1;
    this.keyLow = new Uint32Array(this.capacity).fill(EMPTY_SLOT);
    this.keyHigh = new Uint32Array(this.capacity);
    this.dist = new Uint16Array(this.capacity).fill(DIST_SENTINEL);
    this.status = new Uint8Array(this.capacity);
    this._size = 0;
    this._settled = 0;
  }

  get size(): number { return this._size; }
  get settledCount(): number { return this._settled; }
  get estimatedBytes(): number { return this.capacity * BYTES_PER_ENTRY + 64; }

  private probe(lo: number, hi: number): number {
    let idx = hashMix(lo, hi, this.mask);
    while (true) {
      const sl = this.keyLow[idx];
      if (sl === EMPTY_SLOT && this.status[idx] === STATUS_EMPTY) return ~idx;
      if (sl === lo && this.keyHigh[idx] === hi) return idx;
      idx = (idx + 1) & this.mask;
    }
  }

  has(rank: number): boolean {
    const [lo, hi] = splitKey(rank);
    return this.probe(lo, hi) >= 0;
  }

  get(rank: number): number | undefined {
    const [lo, hi] = splitKey(rank);
    const idx = this.probe(lo, hi);
    if (idx < 0) return undefined;
    return this.dist[idx];
  }

  getStatus(rank: number): number {
    const [lo, hi] = splitKey(rank);
    const idx = this.probe(lo, hi);
    if (idx < 0) return STATUS_EMPTY;
    return this.status[idx];
  }

  isSettled(rank: number): boolean {
    const [lo, hi] = splitKey(rank);
    const idx = this.probe(lo, hi);
    return idx >= 0 && this.status[idx] === STATUS_SETTLED;
  }

  set(rank: number, distance: number): boolean {
    const [lo, hi] = splitKey(rank);
    let idx = this.probe(lo, hi);
    if (idx >= 0) {
      if (distance < this.dist[idx]) {
        this.dist[idx] = distance;
        return true;
      }
      return false;
    }
    idx = ~idx;
    if (this._size >= this.capacity * 0.9) return false;
    this.keyLow[idx] = lo;
    this.keyHigh[idx] = hi;
    this.dist[idx] = distance;
    this.status[idx] = STATUS_TENTATIVE;
    this._size++;
    return true;
  }

  settle(rank: number): void {
    const [lo, hi] = splitKey(rank);
    const idx = this.probe(lo, hi);
    if (idx >= 0 && this.status[idx] !== STATUS_SETTLED) {
      this.status[idx] = STATUS_SETTLED;
      this._settled++;
    }
  }

  getSettledDistance(rank: number): number {
    const [lo, hi] = splitKey(rank);
    const idx = this.probe(lo, hi);
    if (idx < 0 || this.status[idx] !== STATUS_SETTLED) return -1;
    return this.dist[idx];
  }
}

// ---------------------------------------------------------------------------
// Pattern definition
// ---------------------------------------------------------------------------

export interface MoveCostPattern {
  readonly id: number;
  readonly label: string;
  readonly goalCells: readonly number[];
  readonly boxCount: number;
  readonly boxRegionCells: readonly number[];
  readonly boxRegionSet: ReadonlySet<number>;
}

// ---------------------------------------------------------------------------
// Combinatorial ranking
// ---------------------------------------------------------------------------

function precomputeBinomials(n: number, k: number): Float64Array[] {
  const table: Float64Array[] = [];
  for (let i = 0; i <= n; i++) {
    table[i] = new Float64Array(k + 1);
    table[i][0] = 1;
    for (let j = 1; j <= Math.min(i, k); j++) {
      table[i][j] = table[i - 1][j - 1] + table[i - 1][j];
    }
  }
  return table;
}

function rankCombination(
  sortedIndices: ArrayLike<number>,
  k: number,
  binom: Float64Array[],
): number {
  let rank = 0;
  for (let i = 0; i < k; i++) {
    const idx = sortedIndices[i];
    rank += binom[idx][i + 1];
  }
  return rank;
}

function unrankCombination(
  rank: number,
  _m: number,
  k: number,
  binom: Float64Array[],
  out: Uint16Array,
): void {
  let r = rank;
  for (let i = k - 1; i >= 0; i--) {
    for (let c = i; ; c++) {
      const b = binom[c][i + 1];
      if (b > r) {
        out[i] = c - 1;
        r -= binom[c - 1][i + 1];
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Boundary state encoding
// ---------------------------------------------------------------------------

export interface MoveCostPatternContext {
  readonly pattern: MoveCostPattern;
  readonly cellToRegionIndex: Int32Array;
  readonly regionIndexToCell: Uint16Array;
  readonly regionSize: number;
  readonly binom: Float64Array[];
  readonly boxCombinations: number;
  readonly maxStateRank: number;
  readonly sortedGoalCells: Uint16Array;
}

function createPatternContext(
  board: CompiledSearchBoard,
  pattern: MoveCostPattern,
): MoveCostPatternContext {
  const regionCells = [...pattern.boxRegionCells].sort((a, b) => a - b);
  const regionSize = regionCells.length;

  const cellToRegionIndex = new Int32Array(board.cellCount).fill(-1);
  const regionIndexToCell = new Uint16Array(regionSize);
  for (let i = 0; i < regionSize; i++) {
    cellToRegionIndex[regionCells[i]] = i;
    regionIndexToCell[i] = regionCells[i];
  }

  const binom = precomputeBinomials(regionSize, pattern.boxCount);
  const boxCombinations = binom[regionSize][pattern.boxCount];

  if (!Number.isSafeInteger(boxCombinations) || boxCombinations <= 0) {
    throw new Error(
      `MC-PDB: C(${regionSize}, ${pattern.boxCount}) is not a safe integer.`,
    );
  }

  const maxStateRank = boxCombinations * regionSize;
  if (!Number.isSafeInteger(maxStateRank)) {
    throw new Error("MC-PDB: state rank space exceeds Number.MAX_SAFE_INTEGER.");
  }

  const sortedGoalCells = Uint16Array.from(
    [...pattern.goalCells].sort((a, b) => a - b),
  );

  return {
    pattern,
    cellToRegionIndex,
    regionIndexToCell,
    regionSize,
    binom,
    boxCombinations,
    maxStateRank,
    sortedGoalCells,
  };
}

function encodeBoundaryState(
  ctx: MoveCostPatternContext,
  sortedRegionIndices: ArrayLike<number>,
  playerRegionIndex: number,
): number {
  const boxRank = rankCombination(sortedRegionIndices, ctx.pattern.boxCount, ctx.binom);
  return boxRank * ctx.regionSize + playerRegionIndex;
}

// ---------------------------------------------------------------------------
// Walk BFS workspace (reusable, epoch-based)
// ---------------------------------------------------------------------------

class PatternWalkWorkspace {
  readonly distance: Int32Array;
  readonly queue: Int32Array;
  readonly occupancy: Uint8Array;
  private readonly seenEpoch: Uint32Array;
  private epoch = 0;

  constructor(cellCount: number) {
    this.distance = new Int32Array(cellCount);
    this.queue = new Int32Array(cellCount);
    this.occupancy = new Uint8Array(cellCount);
    this.seenEpoch = new Uint32Array(cellCount);
  }

  setOccupancy(
    boxCells: ArrayLike<number>,
    boxCount: number,
  ): void {
    this.occupancy.fill(0);
    for (let i = 0; i < boxCount; i++) {
      this.occupancy[boxCells[i]] = 1;
    }
  }

  flood(
    board: CompiledSearchBoard,
    startCell: number,
  ): void {
    this.epoch = (this.epoch + 1) >>> 0;
    if (this.epoch === 0) {
      this.seenEpoch.fill(0);
      this.epoch = 1;
    }
    const epoch = this.epoch;
    const distance = this.distance;
    const queue = this.queue;
    const occupancy = this.occupancy;

    let head = 0;
    let tail = 0;
    this.seenEpoch[startCell] = epoch;
    distance[startCell] = 0;
    queue[tail++] = startCell;

    while (head < tail) {
      const cell = queue[head++];
      const nbrs = board.neighbors[cell];
      const d = distance[cell] + 1;
      for (let dir = 0; dir < 4; dir++) {
        const next = nbrs[dir];
        if (next < 0 || occupancy[next] !== 0 || this.seenEpoch[next] === epoch) {
          continue;
        }
        this.seenEpoch[next] = epoch;
        distance[next] = d;
        queue[tail++] = next;
      }
    }
  }

  distanceTo(cell: number): number {
    return this.seenEpoch[cell] === this.epoch ? this.distance[cell] : -1;
  }

  isReachable(cell: number): boolean {
    return this.seenEpoch[cell] === this.epoch;
  }
}

// ---------------------------------------------------------------------------
// MC-PDB table
// ---------------------------------------------------------------------------

export interface MoveCostPatternPdbStats {
  settledStates: number;
  tentativeStates: number;
  buildTimeMs: number;
  retainedBytes: number;
  peakBuildBytes: number;
  completedRadius: number;
  maxSettledDistance: number;
  complete: boolean;

  queries: number;
  boundaryHits: number;
  radiusFallbacks: number;
  boundaryMisses: number;
  walkFloods: number;
}

export interface MoveCostPatternPdb {
  readonly ctx: MoveCostPatternContext;
  readonly stats: MoveCostPatternPdbStats;
  readonly estimatedRetainedBytes: number;
  lowerBoundBoundary(
    sortedBoxCells: ArrayLike<number>,
    postPushPlayerCell: number,
  ): number;
}

// ---------------------------------------------------------------------------
// Reverse MC-PDB builder (Dijkstra with integer bucket queue)
// ---------------------------------------------------------------------------

export interface MoveCostPatternPdbBuildOptions {
  readonly maxSettledStates: number;
  readonly maxBuildMs: number;
  readonly maxUsefulDistance: number;
}

const DEFAULT_BUILD_OPTIONS: MoveCostPatternPdbBuildOptions = {
  maxSettledStates: 2_000_000,
  maxBuildMs: 15_000,
  maxUsefulDistance: 600,
};

export function buildMoveCostPatternPdb(
  board: CompiledSearchBoard,
  pattern: MoveCostPattern,
  options: Partial<MoveCostPatternPdbBuildOptions> = {},
  budget?: ExactPreprocessingBudget,
  now: () => number = () => performance.now(),
): MoveCostPatternPdb {
  const buildStart = now();
  const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };

  const ctx = createPatternContext(board, pattern);
  const { regionSize, cellToRegionIndex, regionIndexToCell, binom } = ctx;
  const k = pattern.boxCount;

  const tableCapacity = Math.max(opts.maxSettledStates * 3, regionSize * 2);
  const table = new SparseDistanceTable(tableCapacity);

  const maxBuckets = opts.maxUsefulDistance + 2;
  const buckets: number[][] = new Array(maxBuckets);
  for (let i = 0; i < maxBuckets; i++) buckets[i] = [];

  let completedRadius = -1;
  let maxSettledDistance = 0;

  const goalRegionIndices = new Uint16Array(k);
  const sortedGoalCells = [...pattern.goalCells].sort((a, b) => a - b);
  for (let i = 0; i < k; i++) {
    const ri = cellToRegionIndex[sortedGoalCells[i]];
    if (ri < 0) throw new Error("MC-PDB: goal cell not in pattern region.");
    goalRegionIndices[i] = ri;
  }

  const workspace = new PatternWalkWorkspace(board.cellCount);
  const scratchBoxRegion = new Uint16Array(k);
  const scratchBoxCells = new Uint16Array(k);
  const childRegion = new Uint16Array(k);

  for (let ri = 0; ri < regionSize; ri++) {
    let isGoal = false;
    for (let g = 0; g < k; g++) {
      if (goalRegionIndices[g] === ri) { isGoal = true; break; }
    }
    if (isGoal) continue;

    const stateRank = encodeBoundaryState(ctx, goalRegionIndices, ri);
    if (!table.has(stateRank)) {
      table.set(stateRank, 0);
      buckets[0].push(stateRank);
    }
  }

  let settledCount = 0;
  let currentBucket = 0;

  const buildDeadline = buildStart + opts.maxBuildMs;

  while (currentBucket < maxBuckets) {
    if (buckets[currentBucket].length === 0) {
      if (currentBucket > completedRadius && settledCount > 0) {
        completedRadius = currentBucket;
      }
      currentBucket++;
      continue;
    }

    if (settledCount >= opts.maxSettledStates) break;
    if (now() >= buildDeadline) break;
    if (budget) {
      checkExactPreprocessingBudget(budget, table.estimatedBytes);
    }

    const bucket = buckets[currentBucket];
    const bucketDist = currentBucket;

    while (bucket.length > 0) {
      if (settledCount >= opts.maxSettledStates) break;
      if (now() >= buildDeadline) break;

      const stateRank = bucket.pop()!;

      if (table.isSettled(stateRank)) continue;
      const tentDist = table.get(stateRank);
      if (tentDist === undefined || tentDist !== bucketDist) continue;

      table.settle(stateRank);
      settledCount++;
      if (bucketDist > maxSettledDistance) maxSettledDistance = bucketDist;

      const boxRank = (stateRank / regionSize) | 0;
      const playerRI = stateRank % regionSize;
      unrankCombination(boxRank, regionSize, k, binom, scratchBoxRegion);
      const playerCell = regionIndexToCell[playerRI];

      for (let i = 0; i < k; i++) {
        scratchBoxCells[i] = regionIndexToCell[scratchBoxRegion[i]];
      }

      for (let b = 0; b < k; b++) {
        const boxCell = scratchBoxCells[b];
        const nbrs = board.neighbors[boxCell];
        if (!nbrs) continue;

        for (let d = 0; d < SEARCH_DIRECTION_COUNT; d++) {
          const prevCell = nbrs[OPPOSITE_DIRECTION[d]];
          if (prevCell < 0) continue;
          const prevRI = cellToRegionIndex[prevCell];
          if (prevRI < 0) continue;

          const prevNbrs = board.neighbors[prevCell];
          if (!prevNbrs) continue;
          const supportCell = prevNbrs[OPPOSITE_DIRECTION[d]];
          if (supportCell < 0) continue;

          let prevOccupied = false;
          let supportOccupied = false;
          for (let j = 0; j < k; j++) {
            if (j === b) continue;
            if (scratchBoxCells[j] === prevCell) prevOccupied = true;
            if (scratchBoxCells[j] === supportCell) supportOccupied = true;
            if (prevOccupied || supportOccupied) break;
          }
          if (prevOccupied || supportOccupied) continue;

          for (let i = 0; i < k; i++) {
            childRegion[i] = i === b ? prevRI : scratchBoxRegion[i];
          }
          childRegion.sort();

          const childCells = new Uint16Array(k);
          for (let i = 0; i < k; i++) {
            childCells[i] = regionIndexToCell[childRegion[i]];
          }
          workspace.occupancy.fill(0);
          for (let i = 0; i < k; i++) {
            workspace.occupancy[childCells[i]] = 1;
          }

          workspace.flood(board, supportCell);

          const walkToPlayer = workspace.distanceTo(playerCell);
          if (walkToPlayer < 0) continue;

          const edgeCost = walkToPlayer + 1;
          const newDist = bucketDist + edgeCost;

          if (newDist > opts.maxUsefulDistance) continue;

          for (let ri = 0; ri < regionSize; ri++) {
            const qCell = regionIndexToCell[ri];
            if (workspace.occupancy[qCell] !== 0) continue;
            const walkFromQ = workspace.distanceTo(qCell);
            if (walkFromQ < 0) continue;

            const predDist = bucketDist + walkFromQ + 1;
            if (predDist > opts.maxUsefulDistance) continue;

            const predRank = encodeBoundaryState(ctx, childRegion, ri);
            const existing = table.get(predRank);
            if (existing !== undefined && existing <= predDist) continue;

            table.set(predRank, predDist);
            if (predDist < maxBuckets) {
              buckets[predDist].push(predRank);
            }
          }
        }
      }
    }

    if (bucket.length === 0 && bucketDist >= 0) {
      completedRadius = bucketDist;
    }
  }

  const complete = currentBucket >= maxBuckets ||
    (buckets.every(b => b.length === 0) && table.settledCount === table.size);

  const retainedBytes = table.estimatedBytes;

  const stats: MoveCostPatternPdbStats = {
    settledStates: settledCount,
    tentativeStates: table.size - settledCount,
    buildTimeMs: Math.max(0, now() - buildStart),
    retainedBytes,
    peakBuildBytes: retainedBytes,
    completedRadius: Math.max(completedRadius, -1),
    maxSettledDistance,
    complete,
    queries: 0,
    boundaryHits: 0,
    radiusFallbacks: 0,
    boundaryMisses: 0,
    walkFloods: 0,
  };

  const finalCompletedRadius = stats.completedRadius;

  const queryBoxRI = new Uint16Array(k);

  return {
    ctx,
    stats,
    estimatedRetainedBytes: retainedBytes,
    lowerBoundBoundary(
      sortedBoxCells: ArrayLike<number>,
      postPushPlayerCell: number,
    ): number {
      stats.queries++;

      for (let i = 0; i < k; i++) {
        const ri = cellToRegionIndex[sortedBoxCells[i]];
        if (ri < 0) {
          stats.boundaryMisses++;
          return 0;
        }
        queryBoxRI[i] = ri;
      }

      const playerRI = cellToRegionIndex[postPushPlayerCell];
      if (playerRI < 0) {
        stats.boundaryMisses++;
        return 0;
      }

      const stateRank = encodeBoundaryState(ctx, queryBoxRI, playerRI);
      const settledDist = table.getSettledDistance(stateRank);
      if (settledDist >= 0) {
        stats.boundaryHits++;
        return settledDist;
      }

      if (!complete && finalCompletedRadius >= 0) {
        stats.radiusFallbacks++;
        return finalCompletedRadius + 1;
      }

      stats.boundaryMisses++;
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Forward-state pattern evaluation
// ---------------------------------------------------------------------------

export function evaluateMoveCostPattern(
  board: CompiledSearchBoard,
  pdb: MoveCostPatternPdb,
  selectedBoxCells: ArrayLike<number>,
  playerCell: number,
  workspace: PatternWalkWorkspace,
  scratchSelected?: Uint16Array,
  scratchChild?: Uint16Array,
): number {
  const { ctx, stats } = pdb;
  const k = ctx.pattern.boxCount;

  if (selectedBoxCells.length !== k) return 0;
  const sortedSelected = scratchSelected ?? new Uint16Array(k);
  for (let i = 0; i < k; i++) sortedSelected[i] = selectedBoxCells[i];
  sortedSelected.sort();

  let allOnGoal = true;
  for (let i = 0; i < k; i++) {
    if (sortedSelected[i] !== ctx.sortedGoalCells[i]) { allOnGoal = false; break; }
  }
  if (allOnGoal) return 0;

  workspace.setOccupancy(sortedSelected, k);
  workspace.flood(board, playerCell);
  stats.walkFloods++;

  const childBoxes = scratchChild ?? new Uint16Array(k);
  let best = Infinity;

  for (let b = 0; b < k; b++) {
    const boxCell = sortedSelected[b];
    const nbrs = board.neighbors[boxCell];
    if (!nbrs) continue;

    for (let d = 0; d < SEARCH_DIRECTION_COUNT; d++) {
      const support = nbrs[OPPOSITE_DIRECTION[d]];
      if (support < 0) continue;
      const dest = nbrs[d];
      if (dest < 0) continue;

      let destOccupied = false;
      for (let j = 0; j < k; j++) {
        if (j !== b && sortedSelected[j] === dest) { destOccupied = true; break; }
      }
      if (destOccupied) continue;

      if (workspace.occupancy[support] !== 0) continue;
      const walkDist = workspace.distanceTo(support);
      if (walkDist < 0) continue;

      let ins = 0;
      for (let j = 0; j < k; j++) {
        if (j === b) continue;
        childBoxes[ins++] = sortedSelected[j];
      }
      childBoxes[ins] = dest;
      resortUint16(childBoxes, k);

      const tail = pdb.lowerBoundBoundary(childBoxes, boxCell);
      const candidate = walkDist + 1 + tail;
      if (candidate < best) best = candidate;
    }
  }

  return best === Infinity ? 0 : best;
}

function resortUint16(arr: Uint16Array, len: number): void {
  for (let i = 1; i < len; i++) {
    const val = arr[i];
    let j = i - 1;
    while (j >= 0 && arr[j] > val) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = val;
  }
}

// ---------------------------------------------------------------------------
// Subset evaluator (minimum over compatible k-subsets)
// ---------------------------------------------------------------------------

export function evaluateMoveCostPatternWithSubsets(
  board: CompiledSearchBoard,
  pdb: MoveCostPatternPdb,
  allBoxes: readonly DenseBox[],
  playerCell: number,
  workspace?: PatternWalkWorkspace,
): number {
  const { ctx } = pdb;
  const k = ctx.pattern.boxCount;
  const label = ctx.pattern.label;

  const candidates: number[] = [];
  for (const box of allBoxes) {
    if (box.label !== label) continue;
    if (!ctx.pattern.boxRegionSet.has(box.cell)) continue;

    let canReachAnyGoal = false;
    for (const goalCell of ctx.pattern.goalCells) {
      const dist = board.reversePushDistancesByGoal.get(goalCell);
      if (dist && dist[box.cell] >= 0) {
        canReachAnyGoal = true;
        break;
      }
    }
    if (canReachAnyGoal) candidates.push(box.cell);
  }

  if (candidates.length < k) return 0;

  const ws = workspace ?? new PatternWalkWorkspace(board.cellCount);
  const scratchSelected = new Uint16Array(k);
  const scratchChild = new Uint16Array(k);

  if (candidates.length === k) {
    for (let i = 0; i < k; i++) scratchSelected[i] = candidates[i];
    return evaluateMoveCostPattern(board, pdb, scratchSelected, playerCell, ws, scratchSelected, scratchChild);
  }

  let best = Infinity;
  const subset = new Uint16Array(k);

  function enumerate(start: number, depth: number): void {
    if (depth === k) {
      for (let i = 0; i < k; i++) scratchSelected[i] = subset[i];
      const value = evaluateMoveCostPattern(board, pdb, scratchSelected, playerCell, ws, scratchSelected, scratchChild);
      if (value < best) best = value;
      return;
    }
    const remaining = k - depth;
    for (let i = start; i <= candidates.length - remaining; i++) {
      subset[depth] = candidates[i];
      enumerate(i + 1, depth + 1);
      if (best === 0) return;
    }
  }

  enumerate(0, 0);
  return best === Infinity ? 0 : best;
}

// ---------------------------------------------------------------------------
// Collection (multiple patterns combined with max)
// ---------------------------------------------------------------------------

export interface MoveCostPatternCollection {
  readonly patterns: readonly MoveCostPatternPdb[];
  readonly estimatedRetainedBytes: number;
  evaluate(allBoxes: readonly DenseBox[], playerCell: number): number;
}

export function createMoveCostPatternCollection(
  board: CompiledSearchBoard,
  pdbs: readonly MoveCostPatternPdb[],
): MoveCostPatternCollection {
  let totalRetained = 0;
  for (const pdb of pdbs) totalRetained += pdb.estimatedRetainedBytes;
  const workspace = new PatternWalkWorkspace(board.cellCount);

  return {
    patterns: pdbs,
    estimatedRetainedBytes: totalRetained,
    evaluate(allBoxes: readonly DenseBox[], playerCell: number): number {
      let best = 0;
      for (const pdb of pdbs) {
        const value = evaluateMoveCostPatternWithSubsets(
          board, pdb, allBoxes, playerCell, workspace,
        );
        if (value > best) best = value;
      }
      return best;
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern selection helpers
// ---------------------------------------------------------------------------

export function selectGoalPatterns(
  board: CompiledSearchBoard,
): MoveCostPattern[] {
  const patterns: MoveCostPattern[] = [];
  let nextId = 0;

  for (const [label, goalCells] of board.goalCellsByLabel) {
    if (goalCells.length < 2) continue;

    const regionSet = new Set<number>();
    for (const goalCell of goalCells) {
      const dist = board.reversePushDistancesByGoal.get(goalCell);
      if (!dist) continue;
      for (let c = 0; c < board.cellCount; c++) {
        if (dist[c] >= 0) regionSet.add(c);
      }
    }

    const regionCells = [...regionSet].sort((a, b) => a - b);

    patterns.push({
      id: nextId++,
      label,
      goalCells: [...goalCells].sort((a, b) => a - b),
      boxCount: goalCells.length,
      boxRegionCells: regionCells,
      boxRegionSet: regionSet,
    });
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Phase 3: Candidate generation, probing, and selection
// ---------------------------------------------------------------------------

export interface PatternProbeResult {
  readonly pattern: MoveCostPattern;
  readonly pdb: MoveCostPatternPdb;
  readonly completedRadius: number;
  readonly settledStates: number;
  readonly buildTimeMs: number;
  readonly retainedBytes: number;
  readonly rootValue: number;
  readonly score: number;
}

export interface PatternSelectionTelemetry {
  candidatesGenerated: number;
  candidatesProbed: number;
  candidatesSelected: number;
  probeTotalMs: number;
  buildTotalMs: number;
  totalRetainedBytes: number;
  totalSettledStates: number;
  probes: readonly PatternProbeResult[];
}

export interface PatternSelectionOptions {
  readonly maxK: number;
  readonly minK: number;
  readonly probeStates: number;
  readonly probeTimeMs: number;
  readonly maxCandidates: number;
  readonly fullBuildStates: number;
  readonly fullBuildTimeMs: number;
  readonly maxSelectedPatterns: number;
  readonly incumbentCost?: number;
}

const DEFAULT_SELECTION_OPTIONS: PatternSelectionOptions = {
  maxK: 7,
  minK: 2,
  probeStates: 50_000,
  probeTimeMs: 2_000,
  maxCandidates: 10,
  fullBuildStates: 500_000,
  fullBuildTimeMs: 10_000,
  maxSelectedPatterns: 2,
};

function buildBoxRegion(
  board: CompiledSearchBoard,
  goalCells: readonly number[],
): { regionCells: number[]; regionSet: Set<number> } {
  const regionSet = new Set<number>();
  for (const goalCell of goalCells) {
    const dist = board.reversePushDistancesByGoal.get(goalCell);
    if (!dist) continue;
    for (let c = 0; c < board.cellCount; c++) {
      if (dist[c] >= 0) regionSet.add(c);
    }
  }
  return { regionCells: [...regionSet].sort((a, b) => a - b), regionSet };
}

function makePatternFromGoals(
  board: CompiledSearchBoard,
  id: number,
  label: string,
  goalCells: number[],
): MoveCostPattern {
  const sorted = [...goalCells].sort((a, b) => a - b);
  const { regionCells, regionSet } = buildBoxRegion(board, sorted);
  return {
    id,
    label,
    goalCells: sorted,
    boxCount: sorted.length,
    boxRegionCells: regionCells,
    boxRegionSet: regionSet,
  };
}

export function generateCandidatePatterns(
  board: CompiledSearchBoard,
  options: Partial<PatternSelectionOptions> = {},
): MoveCostPattern[] {
  const { maxK, minK, maxCandidates } = { ...DEFAULT_SELECTION_OPTIONS, ...options };
  const candidates: MoveCostPattern[] = [];
  let nextId = 0;
  const seen = new Set<string>();

  function addCandidate(label: string, goalCells: number[]): void {
    if (goalCells.length < minK) return;
    if (candidates.length >= maxCandidates) return;
    const key = `${label}:${[...goalCells].sort((a, b) => a - b).join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(makePatternFromGoals(board, nextId++, label, goalCells));
  }

  for (const [label, allGoals] of board.goalCellsByLabel) {
    if (allGoals.length < minK) continue;

    if (allGoals.length <= maxK) {
      addCandidate(label, [...allGoals]);
    }

    if (allGoals.length > maxK) {
      clusterGoalsByProximity(board, label, allGoals, maxK, minK, addCandidate);
    }

    if (allGoals.length > minK && allGoals.length > maxK) {
      splitGoalsByMedian(board, label, allGoals, minK, maxK, addCandidate);
    }
  }

  return candidates;
}

function clusterGoalsByProximity(
  board: CompiledSearchBoard,
  label: string,
  goals: readonly number[],
  maxK: number,
  minK: number,
  emit: (label: string, goalCells: number[]) => void,
): void {
  const n = goals.length;
  const positions = goals.map(c => board.positions[c]);

  const dist = (i: number, j: number) =>
    Math.abs(positions[i].row - positions[j].row) +
    Math.abs(positions[i].column - positions[j].column);

  for (let seed = 0; seed < n; seed++) {
    const ranked: Array<{ idx: number; d: number }> = [];
    for (let j = 0; j < n; j++) {
      if (j === seed) continue;
      ranked.push({ idx: j, d: dist(seed, j) });
    }
    ranked.sort((a, b) => a.d - b.d);

    const cluster = [goals[seed]];
    for (const { idx } of ranked) {
      if (cluster.length >= maxK) break;
      cluster.push(goals[idx]);
    }

    if (cluster.length >= minK) {
      emit(label, cluster);
    }

    if (cluster.length > minK + 1) {
      const mid = Math.min(maxK, Math.ceil(cluster.length / 2));
      if (mid >= minK) {
        emit(label, cluster.slice(0, mid));
      }
      const small = Math.max(minK, Math.min(3, mid - 1));
      if (small < mid && small <= cluster.length) {
        emit(label, cluster.slice(0, small));
      }
    }
  }
}

function splitGoalsByMedian(
  board: CompiledSearchBoard,
  label: string,
  goals: readonly number[],
  minK: number,
  maxK: number,
  emit: (label: string, goalCells: number[]) => void,
): void {
  const positions = goals.map((c, i) => ({ cell: goals[i], pos: board.positions[c] }));

  const rowRange = Math.max(...positions.map(p => p.pos.row)) - Math.min(...positions.map(p => p.pos.row));
  const colRange = Math.max(...positions.map(p => p.pos.column)) - Math.min(...positions.map(p => p.pos.column));

  const sorted = [...positions];
  if (rowRange >= colRange) {
    sorted.sort((a, b) => a.pos.row - b.pos.row || a.pos.column - b.pos.column);
  } else {
    sorted.sort((a, b) => a.pos.column - b.pos.column || a.pos.row - b.pos.row);
  }

  const mid = Math.floor(sorted.length / 2);
  const left = sorted.slice(0, mid).map(p => p.cell);
  const right = sorted.slice(mid).map(p => p.cell);

  if (left.length >= minK && left.length <= maxK) emit(label, left);
  if (right.length >= minK && right.length <= maxK) emit(label, right);
}

function scoreProbe(probe: PatternProbeResult): number {
  if (probe.settledStates <= 0) return 0;

  if (probe.pdb.stats.complete) {
    return probe.rootValue * probe.pattern.boxCount;
  }

  const logStates = Math.log2(Math.max(2, probe.settledStates));
  const radiusPerLogStates = probe.completedRadius / logStates;

  const rootOrFallback = Math.max(probe.rootValue, probe.completedRadius + 1);
  return rootOrFallback * radiusPerLogStates * probe.pattern.boxCount;
}

export function probeAndSelectPatterns(
  board: CompiledSearchBoard,
  budget?: ExactPreprocessingBudget,
  now: () => number = () => performance.now(),
  options: Partial<PatternSelectionOptions> = {},
  initialBoxes?: readonly DenseBox[],
  initialRobotCell?: number,
): { collection: MoveCostPatternCollection; telemetry: PatternSelectionTelemetry } {
  const opts = { ...DEFAULT_SELECTION_OPTIONS, ...options };
  const distanceCap = opts.incumbentCost !== undefined
    ? Math.max(1, opts.incumbentCost - 1)
    : 600;
  const candidates = generateCandidatePatterns(board, opts);
  const probeStart = now();

  const probes: PatternProbeResult[] = [];
  for (const pattern of candidates) {
    const pdb = buildMoveCostPatternPdb(board, pattern, {
      maxSettledStates: opts.probeStates,
      maxBuildMs: opts.probeTimeMs,
      maxUsefulDistance: distanceCap,
    }, budget, now);

    let rootValue = 0;
    if (initialBoxes !== undefined && initialRobotCell !== undefined) {
      rootValue = evaluateMoveCostPatternWithSubsets(
        board, pdb, initialBoxes, initialRobotCell,
      );
    }

    const probe: PatternProbeResult = {
      pattern,
      pdb,
      completedRadius: pdb.stats.completedRadius,
      settledStates: pdb.stats.settledStates,
      buildTimeMs: pdb.stats.buildTimeMs,
      retainedBytes: pdb.estimatedRetainedBytes,
      rootValue,
      score: 0,
    };
    (probe as { score: number }).score = scoreProbe(probe);
    probes.push(probe);
  }
  const probeTotalMs = now() - probeStart;

  probes.sort((a, b) => b.score - a.score);
  const selected = probes.slice(0, opts.maxSelectedPatterns);

  const fullPdbs: MoveCostPatternPdb[] = [];
  const buildStart = now();
  for (const sel of selected) {
    if (sel.pdb.stats.complete) {
      fullPdbs.push(sel.pdb);
      continue;
    }
    const fullPdb = buildMoveCostPatternPdb(board, sel.pattern, {
      maxSettledStates: opts.fullBuildStates,
      maxBuildMs: opts.fullBuildTimeMs,
      maxUsefulDistance: distanceCap,
    }, budget, now);

    if (initialBoxes !== undefined && initialRobotCell !== undefined && !fullPdb.stats.complete) {
      fullPdbs.push(fullPdb);
    } else if (initialBoxes !== undefined && initialRobotCell !== undefined) {
      const fullRoot = evaluateMoveCostPatternWithSubsets(
        board, fullPdb, initialBoxes, initialRobotCell,
      );
      if (fullRoot >= sel.rootValue) {
        fullPdbs.push(fullPdb);
      } else {
        fullPdbs.push(sel.pdb);
      }
    } else {
      fullPdbs.push(fullPdb);
    }
  }
  const buildTotalMs = now() - buildStart;

  const collection = createMoveCostPatternCollection(board, fullPdbs);

  let totalSettled = 0;
  for (const pdb of fullPdbs) totalSettled += pdb.stats.settledStates;

  return {
    collection,
    telemetry: {
      candidatesGenerated: candidates.length,
      candidatesProbed: probes.length,
      candidatesSelected: selected.length,
      probeTotalMs,
      buildTotalMs,
      totalRetainedBytes: collection.estimatedRetainedBytes,
      totalSettledStates: totalSettled,
      probes,
    },
  };
}

// ---------------------------------------------------------------------------
// Re-export workspace for tests
// ---------------------------------------------------------------------------

export { PatternWalkWorkspace, precomputeBinomials, rankCombination, unrankCombination };
