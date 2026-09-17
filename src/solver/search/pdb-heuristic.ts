import type { CompiledSearchBoard } from "./compiled-board.ts";
import { partitionGoals, type GoalPartition } from "./goal-partitioning.ts";
import type { DenseBox } from "./model.ts";
import {
  buildPatternDatabase,
  buildPatternDatabaseAsync,
  UNSOLVED as PDB_UNSOLVED,
  type PatternDatabase,
} from "./pattern-database.ts";
import { isExactPreprocessingLimitError, type ExactPreprocessingBudget } from "./preprocessing-budget.ts";

function minSubsetLookup(
  pdb: PatternDatabase,
  cells: readonly number[],
  k: number,
  indices: number[],
  subset: number[],
): number {
  const n = cells.length;
  if (n === k) return pdb.lookup(cells);

  let minValue = PDB_UNSOLVED;
  indices.length = k;
  subset.length = k;
  for (let j = 0; j < k; j++) indices[j] = j;

  while (true) {
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

const SURPLUS_CACHE_CAP = 50_000;

/** Pattern-database evaluator with reusable hot-path buffers. */
export class PdbHeuristicEvaluator {
  readonly #pdbs: readonly PatternDatabase[];
  readonly #partitions: readonly GoalPartition[];
  readonly #labelSlots = new Map<string, number>();
  readonly #cellsByLabel: number[][] = [];
  readonly #subsetIndices: number[] = [];
  readonly #subsetCells: number[] = [];
  readonly #surplusCache = new Map<bigint, number>();
  #cacheHits = 0;
  #cacheMisses = 0;

  constructor(board: CompiledSearchBoard);
  constructor(partitions: readonly GoalPartition[], pdbs: readonly PatternDatabase[]);
  constructor(boardOrPartitions: CompiledSearchBoard | readonly GoalPartition[], pdbs?: readonly PatternDatabase[]) {
    if (pdbs !== undefined) {
      this.#partitions = boardOrPartitions as readonly GoalPartition[];
      this.#pdbs = pdbs;
    } else {
      const board = boardOrPartitions as CompiledSearchBoard;
      this.#partitions = partitionGoals(board);
      this.#pdbs = this.#partitions.map((partition) => buildPatternDatabase(board, {
        goalCells: partition.goalCells,
        labelIds: partition.labels,
        regionCells: partition.regionCells,
      }));
    }
    for (const partition of this.#partitions) {
      const label = partition.labels[0];
      if (!this.#labelSlots.has(label)) {
        this.#labelSlots.set(label, this.#cellsByLabel.length);
        this.#cellsByLabel.push([]);
      }
    }
  }

  static async createAsync(board: CompiledSearchBoard, signal: AbortSignal, budget?: ExactPreprocessingBudget): Promise<PdbHeuristicEvaluator> {
    const partitions = partitionGoals(board);
    const pdbs: PatternDatabase[] = [];
    try {
      for (const partition of partitions) {
        const retainedBytes = pdbs.reduce((sum, pdb) => sum + pdb.estimatedRetainedBytes, 0);
        pdbs.push(await buildPatternDatabaseAsync(board, {
          goalCells: partition.goalCells,
          labelIds: partition.labels,
          regionCells: partition.regionCells,
        }, signal, budget ? { ...budget, baseMemoryBytes: budget.baseMemoryBytes + retainedBytes } : undefined));
      }
    } catch (err) {
      if (!isExactPreprocessingLimitError(err) || err.reason !== "elapsed") throw err;
    }
    return new PdbHeuristicEvaluator(partitions.slice(0, pdbs.length), pdbs);
  }

  get partitionCount(): number { return this.#partitions.length; }
  get totalTableEntries(): number { return this.#pdbs.reduce((sum, pdb) => sum + pdb.tableSize, 0); }
  get estimatedRetainedBytes(): number {
    return this.#pdbs.reduce((sum, pdb) => sum + pdb.estimatedRetainedBytes, 0);
  }
  get surplusCacheStats(): { hits: number; misses: number; size: number } {
    return { hits: this.#cacheHits, misses: this.#cacheMisses, size: this.#surplusCache.size };
  }

  evaluate(boxes: readonly DenseBox[]): number {
    if (this.#pdbs.length === 0) return 0;
    for (const cells of this.#cellsByLabel) cells.length = 0;
    for (const box of boxes) {
      const slot = this.#labelSlots.get(box.label);
      if (slot !== undefined) this.#cellsByLabel[slot].push(box.cell);
    }

    let total = 0;
    for (let i = 0; i < this.#partitions.length; i++) {
      const pdb = this.#pdbs[i];
      const k = pdb.k;
      if (k === 0) continue;
      const slot = this.#labelSlots.get(this.#partitions[i].labels[0]);
      const boxCells = slot === undefined ? undefined : this.#cellsByLabel[slot];
      if (!boxCells || boxCells.length < k) continue;
      const value = boxCells.length === k
        ? pdb.lookup(boxCells)
        : minSubsetLookup(pdb, boxCells, k, this.#subsetIndices, this.#subsetCells);
      if (value !== PDB_UNSOLVED) total += value;
    }
    return total;
  }

  evaluateWithSurplus(
    boxes: readonly DenseBox[],
    assignmentLabelCosts: ReadonlyMap<string, number>,
    boxKey?: bigint,
  ): number {
    if (this.#pdbs.length === 0) return 0;

    if (boxKey !== undefined) {
      const cached = this.#surplusCache.get(boxKey);
      if (cached !== undefined) {
        this.#cacheHits++;
        return cached;
      }
    }
    this.#cacheMisses++;

    for (const cells of this.#cellsByLabel) cells.length = 0;
    for (const box of boxes) {
      const slot = this.#labelSlots.get(box.label);
      if (slot !== undefined) this.#cellsByLabel[slot].push(box.cell);
    }

    const labelPdbTotals = new Map<string, number>();
    for (let i = 0; i < this.#partitions.length; i++) {
      const pdb = this.#pdbs[i];
      const k = pdb.k;
      if (k === 0) continue;
      const label = this.#partitions[i].labels[0];
      const slot = this.#labelSlots.get(label);
      const boxCells = slot === undefined ? undefined : this.#cellsByLabel[slot];
      if (!boxCells || boxCells.length < k) continue;
      const value = boxCells.length === k
        ? pdb.lookup(boxCells)
        : minSubsetLookup(pdb, boxCells, k, this.#subsetIndices, this.#subsetCells);
      if (value !== PDB_UNSOLVED) {
        labelPdbTotals.set(label, (labelPdbTotals.get(label) ?? 0) + value);
      }
    }

    let surplus = 0;
    for (const [label, pdbValue] of labelPdbTotals) {
      const assignmentCost = assignmentLabelCosts.get(label) ?? 0;
      const diff = pdbValue - assignmentCost;
      if (diff > 0) surplus += diff;
    }

    if (boxKey !== undefined) {
      this.#surplusCache.set(boxKey, surplus);
      if (this.#surplusCache.size > SURPLUS_CACHE_CAP) {
        const firstKey = this.#surplusCache.keys().next().value;
        if (firstKey !== undefined) this.#surplusCache.delete(firstKey);
      }
    }

    return surplus;
  }
}
