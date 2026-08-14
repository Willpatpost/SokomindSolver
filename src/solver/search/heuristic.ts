import {
  minimumAssignmentWithState,
  repairAssignment,
  type AssignmentState,
} from "./assignment.ts";
import type {
  CompiledSearchBoard,
} from "./compiled-board.ts";
import { partitionGoals, type GoalPartition } from "./goal-partitioning.ts";
import { computeLinearConflict } from "./linear-conflict.ts";
import {
  canonicalBoxSignature,
  type DenseBox,
} from "./model.ts";
import {
  buildPatternDatabase,
  buildPatternDatabaseAsync,
  UNSOLVED as PDB_UNSOLVED,
  type PatternDatabase,
} from "./pattern-database.ts";
import type { ExactPreprocessingBudget } from "./preprocessing-budget.ts";

const INCREMENTAL_ASSIGNMENT_CROSSOVER = 3;

export interface AssignmentHeuristicOptions {
  readonly maxCacheEntries?: number;
  readonly packBoxKey?: (boxes: readonly DenseBox[]) => bigint;
}

export interface AssignmentHeuristicStats {
  readonly calls: number;
  readonly cacheHits: number;
  readonly cacheEntries: number;
  readonly incrementalRepairs: number;
}

interface LabelAssignmentState {
  readonly cost: number;
  readonly columns: readonly number[];
  readonly rowPotentials: Float64Array;
  readonly columnPotentials: Float64Array;
  readonly boxCells: readonly number[];
  readonly goalCells: readonly number[];
}

interface AssignmentCacheEntry {
  readonly totalCost: number;
  readonly labelStates: ReadonlyMap<string, LabelAssignmentState>;
}

function boxesByLabel(
  boxes: readonly DenseBox[],
): ReadonlyMap<string, readonly number[]> {
  const grouped = new Map<string, number[]>();
  for (const box of boxes) {
    const cells = grouped.get(box.label) ?? [];
    cells.push(box.cell);
    grouped.set(box.label, cells);
  }
  for (const cells of grouped.values()) {
    cells.sort((left, right) => left - right);
  }
  return grouped;
}

function buildCostMatrix(
  board: CompiledSearchBoard,
  boxCells: readonly number[],
  goalCells: readonly number[],
): number[][] {
  return boxCells.map((boxCell) =>
    goalCells.map((goalCell) => {
      const distance = board.reversePushDistancesByGoal.get(goalCell)?.[boxCell] ?? -1;
      return distance < 0 ? Number.POSITIVE_INFINITY : distance;
    }),
  );
}

interface FullAssignmentResult {
  readonly totalCost: number;
  readonly labelStates: ReadonlyMap<string, LabelAssignmentState>;
}

function fullAssignmentWithState(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
): FullAssignmentResult {
  const groupedBoxes = boxesByLabel(boxes);
  const labels = new Set([
    ...groupedBoxes.keys(),
    ...board.goalCellsByLabel.keys(),
  ]);
  let total = 0;
  const labelStates = new Map<string, LabelAssignmentState>();

  for (const label of [...labels].sort((left, right) => left.localeCompare(right))) {
    const boxCells = groupedBoxes.get(label) ?? [];
    const goalCells = board.goalCellsByLabel.get(label) ?? [];
    if (boxCells.length !== goalCells.length) {
      return { totalCost: Number.POSITIVE_INFINITY, labelStates };
    }
    if (boxCells.length === 0) continue;

    const costs = buildCostMatrix(board, boxCells, goalCells);
    const state = minimumAssignmentWithState(costs);
    if (!Number.isFinite(state.cost)) {
      return { totalCost: Number.POSITIVE_INFINITY, labelStates };
    }
    total += state.cost;
    labelStates.set(label, {
      cost: state.cost,
      columns: state.columns,
      rowPotentials: state.rowPotentials,
      columnPotentials: state.columnPotentials,
      boxCells: [...boxCells],
      goalCells: [...goalCells],
    });
  }

  return { totalCost: total, labelStates };
}

/**
 * Label-aware minimum assignment of boxes to goals using relaxed push distance.
 *
 * P(state) is admissible: each matrix entry is the shortest number of pushes
 * for one box on the wall geometry after removing every other box, and the
 * assignment enforces distinct matching goals. Real solutions cannot require
 * fewer pushes than this relaxation.
 */
export function assignmentLowerBound(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
): number {
  return fullAssignmentWithState(board, boxes).totalCost;
}

/**
 * Safe admissible walk lower bound that considers ALL boxes, including
 * those already on matching goals.
 *
 * Unlike a simpler variant that skips goal-placed boxes, this considers
 * boxes on their matching goal were skipped. An optimal solution can
 * require moving a correctly placed box first (e.g., to make room for
 * another box to pass through).
 *
 * For each box (regardless of goal status), considers each direction
 * where both the support cell and destination cell exist as floor.
 * Optionally rejects a destination currently occupied by another box.
 *
 * Returns zero for a solved state. Returns zero rather than an unsafe
 * positive value when uncertain.
 */
export function minimumManhattanWalkToPotentialPush(
  board: CompiledSearchBoard,
  playerCell: number,
  boxes: readonly DenseBox[],
  occupancy?: ArrayLike<number>,
): number {
  if (boxes.every((box) => board.goalLabelByCell[box.cell] === box.label)) {
    return 0;
  }
  const playerPos = board.positions[playerCell];
  if (!playerPos) return 0;

  let minDist = Number.POSITIVE_INFINITY;

  for (const box of boxes) {
    const neighbors = board.neighbors[box.cell];
    if (!neighbors) continue;

    for (let d = 0; d < 4; d++) {
      const supportCell = neighbors[d];
      if (supportCell === undefined || supportCell < 0) continue;

      const oppositeD = d ^ 1;
      const destCell = neighbors[oppositeD];
      if (destCell === undefined || destCell < 0) continue;

      if (occupancy && occupancy[destCell] !== 0) continue;

      const supportPos = board.positions[supportCell];
      if (!supportPos) continue;

      const manhattan =
        Math.abs(playerPos.row - supportPos.row) +
        Math.abs(playerPos.column - supportPos.column);
      if (manhattan < minDist) {
        minDist = manhattan;
        if (manhattan === 0) return 0;
      }
    }
  }

  return Number.isFinite(minDist) ? minDist : 0;
}

/**
 * Exact walk lower bound using keeper BFS reachability.
 *
 * Considers every legal push (including pushes of boxes currently on
 * matching goals). Returns the minimum exact keeper distance to a legal
 * push support cell.
 *
 * Returns Infinity when the state is unsolved and has no legal push.
 * Must not perform a second keeper flood — reuses the one already
 * calculated for node expansion.
 */
export function minimumReachableWalkToLegalPush(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  occupancy: ArrayLike<number>,
  reachability: { distanceTo(cell: number): number; isReachable(cell: number): boolean },
): number {
  if (boxes.every((box) => board.goalLabelByCell[box.cell] === box.label)) {
    return 0;
  }

  let minDist = Number.POSITIVE_INFINITY;

  for (const box of boxes) {
    const neighbors = board.neighbors[box.cell];
    if (!neighbors) continue;

    for (let d = 0; d < 4; d++) {
      const supportCell = neighbors[d];
      if (supportCell === undefined || supportCell < 0) continue;

      const oppositeD = d ^ 1;
      const destCell = neighbors[oppositeD];
      if (destCell === undefined || destCell < 0) continue;

      if (occupancy[destCell] !== 0) continue;

      if (!reachability.isReachable(supportCell)) continue;

      const dist = reachability.distanceTo(supportCell);
      if (dist >= 0 && dist < minDist) {
        minDist = dist;
        if (dist === 0) return 0;
      }
    }
  }

  return minDist;
}

/**
 * Bounded LRU wrapper around the admissible assignment lower bound.
 *
 * When a `packBoxKey` function is provided, the cache uses collision-free
 * BigInt keys and stores per-label assignment state for incremental repair.
 * Otherwise falls back to full-recompute-only mode (used by engine.ts
 * non-proof paths that don't have an ExactStateCodec).
 */
export class AssignmentHeuristic {
  readonly #board: CompiledSearchBoard;
  readonly #maxCacheEntries: number;
  readonly #packBoxKey: ((boxes: readonly DenseBox[]) => bigint) | null;
  readonly #cache = new Map<bigint, AssignmentCacheEntry>();
  readonly #fallbackCache = new Map<string, number>();
  #calls = 0;
  #cacheHits = 0;
  #incrementalRepairs = 0;
  #lastLabelStates: ReadonlyMap<string, LabelAssignmentState> | null = null;

  constructor(
    board: CompiledSearchBoard,
    options: AssignmentHeuristicOptions = {},
  ) {
    const maxCacheEntries = options.maxCacheEntries ?? 50_000;
    if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 0) {
      throw new RangeError("maxCacheEntries must be a non-negative integer.");
    }
    this.#board = board;
    this.#maxCacheEntries = maxCacheEntries;
    this.#packBoxKey = options.packBoxKey ?? null;
  }

  get stats(): AssignmentHeuristicStats {
    return Object.freeze({
      calls: this.#calls,
      cacheHits: this.#cacheHits,
      cacheEntries: this.#cache.size + this.#fallbackCache.size,
      incrementalRepairs: this.#incrementalRepairs,
    });
  }

  get lastLabelCosts(): ReadonlyMap<string, number> | null {
    if (!this.#lastLabelStates) return null;
    const costs = new Map<string, number>();
    for (const [label, state] of this.#lastLabelStates) {
      costs.set(label, state.cost);
    }
    return costs;
  }

  lastLinearConflict(boxes: readonly DenseBox[]): number {
    if (!this.#lastLabelStates) return 0;
    return computeLinearConflict(this.#board, boxes, this.#lastLabelStates);
  }

  #evictIfNeeded(): void {
    while (this.#cache.size >= this.#maxCacheEntries) {
      const oldest = this.#cache.keys().next().value as bigint | undefined;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }

  #storeEntry(key: bigint, entry: AssignmentCacheEntry): void {
    if (this.#maxCacheEntries > 0) {
      this.#evictIfNeeded();
      this.#cache.set(key, entry);
    }
  }

  #fullEvaluateAndStore(boxes: readonly DenseBox[], key: bigint): number {
    const result = fullAssignmentWithState(this.#board, boxes);
    this.#storeEntry(key, result);
    this.#lastLabelStates = result.labelStates;
    return result.totalCost;
  }

  evaluate(boxes: readonly DenseBox[]): number {
    this.#calls += 1;
    if (this.#packBoxKey === null) {
      return this.#evaluateFallback(boxes);
    }
    const key = this.#packBoxKey(boxes);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#cacheHits += 1;
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      this.#lastLabelStates = cached.labelStates;
      return cached.totalCost;
    }
    return this.#fullEvaluateAndStore(boxes, key);
  }

  #evaluateFallback(boxes: readonly DenseBox[]): number {
    const signature = canonicalBoxSignature(boxes);
    const cached = this.#fallbackCache.get(signature);
    if (cached !== undefined) {
      this.#cacheHits += 1;
      this.#fallbackCache.delete(signature);
      this.#fallbackCache.set(signature, cached);
      return cached;
    }
    const result = fullAssignmentWithState(this.#board, boxes);
    this.#lastLabelStates = result.labelStates;
    if (this.#maxCacheEntries > 0) {
      while (this.#fallbackCache.size >= this.#maxCacheEntries) {
        const oldest = this.#fallbackCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#fallbackCache.delete(oldest);
      }
      this.#fallbackCache.set(signature, result.totalCost);
    }
    return result.totalCost;
  }

  evaluateIncremental(
    boxes: readonly DenseBox[],
    childBoxKey: bigint,
    parentBoxKey: bigint,
    movedLabel: string,
  ): number {
    this.#calls += 1;

    const childCached = this.#cache.get(childBoxKey);
    if (childCached !== undefined) {
      this.#cacheHits += 1;
      this.#cache.delete(childBoxKey);
      this.#cache.set(childBoxKey, childCached);
      this.#lastLabelStates = childCached.labelStates;
      return childCached.totalCost;
    }

    const parentEntry = this.#cache.get(parentBoxKey);
    if (parentEntry === undefined) {
      return this.#fullEvaluateAndStore(boxes, childBoxKey);
    }

    const groupedBoxes = boxesByLabel(boxes);
    const labels = new Set([
      ...groupedBoxes.keys(),
      ...this.#board.goalCellsByLabel.keys(),
    ]);
    let total = 0;
    const labelStates = new Map<string, LabelAssignmentState>();

    for (const label of [...labels].sort((a, b) => a.localeCompare(b))) {
      const boxCells = groupedBoxes.get(label) ?? [];
      const goalCells = this.#board.goalCellsByLabel.get(label) ?? [];
      if (boxCells.length !== goalCells.length) {
        this.#storeEntry(childBoxKey, {
          totalCost: Number.POSITIVE_INFINITY,
          labelStates,
        });
        return Number.POSITIVE_INFINITY;
      }
      if (boxCells.length === 0) continue;

      if (label !== movedLabel) {
        const parentLabelState = parentEntry.labelStates.get(label);
        if (parentLabelState !== undefined) {
          total += parentLabelState.cost;
          labelStates.set(label, parentLabelState);
          continue;
        }
      }

      if (label === movedLabel && boxCells.length >= INCREMENTAL_ASSIGNMENT_CROSSOVER) {
        const parentLabelState = parentEntry.labelStates.get(label);
        if (parentLabelState !== undefined) {
          const parentCells = parentLabelState.boxCells;
          const n = boxCells.length;

          let removedCell = -1;
          let addedCell = -1;
          let pi = 0;
          let ci = 0;
          while (pi < n && ci < n) {
            if (parentCells[pi] === boxCells[ci]) {
              pi++;
              ci++;
            } else if (parentCells[pi] < boxCells[ci]) {
              if (removedCell >= 0) { removedCell = -2; break; }
              removedCell = parentCells[pi];
              pi++;
            } else {
              if (addedCell >= 0) { addedCell = -2; break; }
              addedCell = boxCells[ci];
              ci++;
            }
          }
          while (pi < n) {
            if (removedCell >= 0) { removedCell = -2; break; }
            removedCell = parentCells[pi++];
          }
          while (ci < n) {
            if (addedCell >= 0) { addedCell = -2; break; }
            addedCell = boxCells[ci++];
          }

          if (removedCell >= 0 && addedCell >= 0) {
            const parentCellToIdx = new Map<number, number>();
            for (let i = 0; i < n; i++) parentCellToIdx.set(parentCells[i], i);

            const remappedColumns = new Array<number>(n);
            const remappedRowPotentials = new Float64Array(n);
            let childChangedRow = -1;

            for (let i = 0; i < n; i++) {
              const pIdx = parentCellToIdx.get(boxCells[i]);
              if (pIdx !== undefined) {
                remappedColumns[i] = parentLabelState.columns[pIdx];
                remappedRowPotentials[i] = parentLabelState.rowPotentials[pIdx];
              } else {
                childChangedRow = i;
                remappedColumns[i] = -1;
                remappedRowPotentials[i] = 0;
              }
            }

            if (childChangedRow >= 0) {
              const costs = buildCostMatrix(this.#board, boxCells, goalCells);
              const prevState: AssignmentState = {
                cost: parentLabelState.cost,
                columns: remappedColumns,
                rowPotentials: remappedRowPotentials,
                columnPotentials: parentLabelState.columnPotentials,
              };
              const repaired = repairAssignment(costs, prevState, childChangedRow);
              if (!Number.isFinite(repaired.cost)) {
                this.#storeEntry(childBoxKey, {
                  totalCost: Number.POSITIVE_INFINITY,
                  labelStates,
                });
                return Number.POSITIVE_INFINITY;
              }
              total += repaired.cost;
              labelStates.set(label, {
                cost: repaired.cost,
                columns: repaired.columns,
                rowPotentials: repaired.rowPotentials,
                columnPotentials: repaired.columnPotentials,
                boxCells: [...boxCells],
                goalCells: [...goalCells],
              });
              this.#incrementalRepairs += 1;
              continue;
            }
          }
        }
      }

      const costs = buildCostMatrix(this.#board, boxCells, goalCells);
      const state = minimumAssignmentWithState(costs);
      if (!Number.isFinite(state.cost)) {
        this.#storeEntry(childBoxKey, {
          totalCost: Number.POSITIVE_INFINITY,
          labelStates,
        });
        return Number.POSITIVE_INFINITY;
      }
      total += state.cost;
      labelStates.set(label, {
        cost: state.cost,
        columns: state.columns,
        rowPotentials: state.rowPotentials,
        columnPotentials: state.columnPotentials,
        boxCells: [...boxCells],
        goalCells: [...goalCells],
      });
    }

    this.#storeEntry(childBoxKey, { totalCost: total, labelStates });
    this.#lastLabelStates = labelStates;
    return total;
  }

  clearCache(): void {
    this.#cache.clear();
    this.#fallbackCache.clear();
  }

  resetStats(): void {
    this.#calls = 0;
    this.#cacheHits = 0;
    this.#incrementalRepairs = 0;
  }
}

function minSubsetLookup(
  pdb: PatternDatabase,
  cells: readonly number[],
  k: number,
): number {
  const n = cells.length;
  if (n === k) return pdb.lookup(cells);

  let minValue = PDB_UNSOLVED;
  const indices = new Array<number>(k);
  for (let j = 0; j < k; j++) indices[j] = j;

  while (true) {
    const subset: number[] = new Array(k);
    for (let j = 0; j < k; j++) subset[j] = cells[indices[j]];

    const value = pdb.lookup(subset);
    if (value < minValue) {
      minValue = value;
      if (value === 0) break;
    }

    let j = k - 1;
    while (j >= 0 && indices[j] === n - k + j) j--;
    if (j < 0) break;
    indices[j]++;
    for (let m = j + 1; m < k; m++) indices[m] = indices[m - 1] + 1;
  }

  return minValue;
}

export class PdbHeuristicEvaluator {
  readonly #pdbs: readonly PatternDatabase[];
  readonly #partitions: readonly GoalPartition[];

  constructor(board: CompiledSearchBoard);
  constructor(partitions: readonly GoalPartition[], pdbs: readonly PatternDatabase[]);
  constructor(
    boardOrPartitions: CompiledSearchBoard | readonly GoalPartition[],
    pdbs?: readonly PatternDatabase[],
  ) {
    if (pdbs !== undefined) {
      this.#partitions = boardOrPartitions as readonly GoalPartition[];
      this.#pdbs = pdbs;
    } else {
      const board = boardOrPartitions as CompiledSearchBoard;
      this.#partitions = partitionGoals(board);
      this.#pdbs = this.#partitions.map((partition) =>
        buildPatternDatabase(board, {
          goalCells: partition.goalCells,
          labelIds: partition.labels,
          regionCells: partition.regionCells,
        }),
      );
    }
  }

  static async createAsync(
    board: CompiledSearchBoard,
    signal: AbortSignal,
    budget?: ExactPreprocessingBudget,
  ): Promise<PdbHeuristicEvaluator> {
    const partitions = partitionGoals(board);
    const pdbs: PatternDatabase[] = [];
    for (const partition of partitions) {
      const retainedBytes = pdbs.reduce(
        (sum, pdb) => sum + pdb.estimatedRetainedBytes,
        0,
      );
      pdbs.push(
        await buildPatternDatabaseAsync(board, {
          goalCells: partition.goalCells,
          labelIds: partition.labels,
          regionCells: partition.regionCells,
        }, signal, budget
          ? { ...budget, baseMemoryBytes: budget.baseMemoryBytes + retainedBytes }
          : undefined),
      );
    }
    return new PdbHeuristicEvaluator(partitions, pdbs);
  }

  get partitionCount(): number {
    return this.#partitions.length;
  }

  get totalTableEntries(): number {
    return this.#pdbs.reduce((sum, pdb) => sum + pdb.tableSize, 0);
  }

  get estimatedRetainedBytes(): number {
    return this.#pdbs.reduce(
      (sum, pdb) => sum + pdb.estimatedRetainedBytes,
      0,
    );
  }

  evaluate(boxes: readonly DenseBox[]): number {
    if (this.#pdbs.length === 0) return 0;

    const cellsByLabel = new Map<string, number[]>();
    for (const box of boxes) {
      const cells = cellsByLabel.get(box.label) ?? [];
      cells.push(box.cell);
      cellsByLabel.set(box.label, cells);
    }

    let total = 0;
    for (let i = 0; i < this.#partitions.length; i++) {
      const partition = this.#partitions[i];
      const pdb = this.#pdbs[i];
      const k = pdb.k;
      if (k === 0) continue;

      const label = partition.labels[0];
      const boxCells = cellsByLabel.get(label);
      if (!boxCells || boxCells.length < k) continue;

      let value: number;
      if (boxCells.length === k) {
        value = pdb.lookup(boxCells);
      } else {
        value = minSubsetLookup(pdb, boxCells, k);
      }
      if (value !== PDB_UNSOLVED) total += value;
    }

    return total;
  }
}
