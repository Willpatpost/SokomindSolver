import type { CompiledSearchBoard } from "./compiled-board.ts";
import { partitionGoals, type GoalPartition } from "./goal-partitioning.ts";
import type { DenseBox } from "./model.ts";
import {
  buildPatternDatabase,
  buildPatternDatabaseAsync,
  disabledPatternDatabase,
  UNSOLVED as PDB_UNSOLVED,
  type PatternDatabase,
  type PdbLookupStats,
} from "./pattern-database.ts";
import { isExactPreprocessingLimitError, type ExactPreprocessingBudget } from "./preprocessing-budget.ts";

/** Reusable buffers for minSubsetLookup. */
interface SubsetScratch {
  readonly cells: number[];
  readonly distances: number[];
  readonly picks: number[];
  readonly sums: number[];
  readonly subset: number[];
}

function createSubsetScratch(): SubsetScratch {
  return { cells: [], distances: [], picks: [], sums: [], subset: [] };
}

/**
 * The minimum lookup over the k-box subsets of `cells`, by branch and bound.
 * Boxes are sorted by goal distance and subsets are built in that order. A
 * partial subset is dropped once min(its distance sum plus the next sorted
 * distances, undiscovered), a floor under every lookup that completes it
 * (PdbSubsetBound), cannot beat the best value so far; so are the later
 * choices at its level, whose floors are no lower. The result equals the
 * minimum over every subset; only the number of lookups falls.
 */
export function minSubsetLookup(
  pdb: PatternDatabase,
  cells: readonly number[],
  k: number,
  scratch: SubsetScratch = createSubsetScratch(),
): number {
  const n = cells.length;
  if (n === k) return pdb.lookup(cells);
  const { subset } = scratch;
  subset.length = k;
  const bound = pdb.subsetBound;
  if (bound === null) {
    for (let j = 0; j < k; j++) subset[j] = cells[j];
    return pdb.lookup(subset);
  }

  // Insertion sort; a box with no route to a goal counts as unbounded.
  const { goalDistance, undiscovered } = bound;
  const { cells: sorted, distances, picks, sums } = scratch;
  sorted.length = n;
  distances.length = n;
  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const distance = goalDistance[cell] < 0 ? Infinity : goalDistance[cell];
    let j = i - 1;
    while (j >= 0 && distances[j] > distance) {
      distances[j + 1] = distances[j];
      sorted[j + 1] = sorted[j];
      j--;
    }
    distances[j + 1] = distance;
    sorted[j + 1] = cell;
  }

  // picks[level] is the sorted index chosen at that level and sums[level]
  // the distance sum of the picks before it.
  let best = PDB_UNSOLVED;
  picks.length = k;
  sums.length = k;
  picks[0] = 0;
  sums[0] = 0;
  let level = 0;
  while (level >= 0) {
    const pick = picks[level];
    const remaining = k - level;
    let floor = sums[level];
    if (pick <= n - remaining) {
      for (let i = pick; i < pick + remaining; i++) floor += distances[i];
    }
    if (pick > n - remaining || Math.min(floor, undiscovered) >= best) {
      level--;
      if (level >= 0) picks[level]++;
      continue;
    }
    if (remaining === 1) {
      for (let j = 0; j < k; j++) subset[j] = sorted[picks[j]];
      const value = pdb.lookup(subset);
      if (value < best) best = value;
      picks[level]++;
    } else {
      sums[level + 1] = sums[level] + distances[pick];
      picks[level + 1] = pick + 1;
      level++;
    }
  }
  return best;
}

const SURPLUS_CACHE_CAP = 50_000;
const NO_SURPLUS_PARTS: readonly number[] = [];

/** Pattern-database evaluator with reusable hot-path buffers. */
export class PdbHeuristicEvaluator {
  readonly #pdbs: readonly PatternDatabase[];
  readonly #partitions: readonly GoalPartition[];
  readonly #labelSlots = new Map<string, number>();
  readonly #cellsByLabel: number[][] = [];
  // Per label slot: its label, and the PDB total and first-touch order
  // evaluateWithSurplus() fills; partition i reads slot #partitionSlots[i].
  readonly #slotLabels: string[] = [];
  readonly #partitionSlots: Int32Array;
  readonly #slotTotals: Float64Array;
  readonly #slotTouched: Uint8Array;
  readonly #touchedSlots: Int32Array;
  readonly #subsetScratch = createSubsetScratch();
  // Keyed by box key alone, but the surplus also depends on the assignment
  // label costs, so evaluateWithSurplus() reads and writes it only when the
  // caller vouches that the label costs belong to that box key. Values are
  // surplus parts, as lastSurplusParts describes.
  readonly #surplusCache = new Map<bigint, readonly number[]>();
  #lastSurplusParts: readonly number[] = NO_SURPLUS_PARTS;
  #cacheHits = 0;
  #cacheMisses = 0;
  #surplusCacheBytes = 0;
  #cacheMemoryBudget: ((additionalBytes: number) => boolean) | undefined;
  // Partitions the build deadline left without any table.
  #droppedPartitions = 0;

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
    this.#partitionSlots = new Int32Array(this.#partitions.length);
    for (let i = 0; i < this.#partitions.length; i++) {
      const label = this.#partitions[i].labels[0];
      let slot = this.#labelSlots.get(label);
      if (slot === undefined) {
        slot = this.#cellsByLabel.length;
        this.#labelSlots.set(label, slot);
        this.#cellsByLabel.push([]);
        this.#slotLabels.push(label);
      }
      this.#partitionSlots[i] = slot;
    }
    this.#slotTotals = new Float64Array(this.#slotLabels.length);
    this.#slotTouched = new Uint8Array(this.#slotLabels.length);
    this.#touchedSlots = new Int32Array(this.#slotLabels.length);
  }

  static async createAsync(board: CompiledSearchBoard, signal: AbortSignal, budget?: ExactPreprocessingBudget): Promise<PdbHeuristicEvaluator> {
    const partitions = partitionGoals(board);
    const pdbs: PatternDatabase[] = [];
    try {
      for (const partition of partitions) {
        const retainedBytes = pdbs.reduce((sum, pdb) => sum + pdb.estimatedRetainedBytes, 0);
        try {
          pdbs.push(await buildPatternDatabaseAsync(board, {
            goalCells: partition.goalCells,
            labelIds: partition.labels,
            regionCells: partition.regionCells,
          }, signal, budget ? { ...budget, baseMemoryBytes: budget.baseMemoryBytes + retainedBytes } : undefined));
        } catch (err) {
          if (!isExactPreprocessingLimitError(err) || err.reason !== "memory") throw err;
          // The table did not fit before allocation. A disabled table holds
          // no bytes and adds nothing to h, and a smaller later partition
          // may still fit.
          pdbs.push(disabledPatternDatabase(
            partition.goalCells.length, partition.goalCells, partition.regionCells, "memory",
          ));
        }
      }
    } catch (err) {
      if (!isExactPreprocessingLimitError(err) || err.reason !== "elapsed") throw err;
    }
    const evaluator = new PdbHeuristicEvaluator(partitions.slice(0, pdbs.length), pdbs);
    evaluator.#droppedPartitions = partitions.length - pdbs.length;
    return evaluator;
  }

  /** An evaluator over the same tables, with fresh counters and an empty surplus cache. */
  view(): PdbHeuristicEvaluator {
    const view = new PdbHeuristicEvaluator(this.#partitions, this.#pdbs.map((pdb) => pdb.view()));
    view.#droppedPartitions = this.#droppedPartitions;
    return view;
  }

  /**
   * The build deadline cut a table short or dropped a partition. Such tables
   * depend on the machine and the deadline; every other build gives the same
   * tables for the same board, features and memory limit.
   */
  get deadlineLimited(): boolean {
    return this.#droppedPartitions > 0 ||
      this.#pdbs.some((pdb) => pdb.truncatedBy === "elapsed");
  }

  get partitionCount(): number { return this.#partitions.length; }
  /** Partitions a build limit (deadline or memory) left with a partial or disabled table. */
  get degradedPartitionCount(): number {
    return this.#pdbs.filter((pdb) => pdb.truncatedBy !== undefined).length;
  }
  /** Degraded partitions stopped by the memory limit; these used to abort the run. */
  get memoryFallbackCount(): number {
    return this.#pdbs.filter((pdb) => pdb.truncatedBy === "memory").length;
  }
  get totalTableEntries(): number { return this.#pdbs.reduce((sum, pdb) => sum + pdb.tableSize, 0); }
  get estimatedRetainedBytes(): number {
    return this.preprocessingRetainedBytes + this.searchCacheRetainedBytes;
  }
  get preprocessingRetainedBytes(): number {
    return this.#pdbs.reduce((sum, pdb) => sum + pdb.estimatedRetainedBytes, 0);
  }
  get searchCacheRetainedBytes(): number { return this.#surplusCacheBytes; }
  setSearchCacheMemoryBudget(budget: (additionalBytes: number) => boolean): void {
    this.#cacheMemoryBudget = budget;
  }
  /**
   * The positive per-label terms of the last evaluateWithSurplus() result,
   * flat as [slot, surplus, ...]; slotLabel() names each slot's label. A
   * label's term is its PDB total less its assignment cost, and is at most
   * that label's pushes beyond its assignment cost.
   */
  get lastSurplusParts(): readonly number[] { return this.#lastSurplusParts; }
  slotLabel(slot: number): string { return this.#slotLabels[slot]; }
  get surplusCacheStats(): { hits: number; misses: number; size: number } {
    return { hits: this.#cacheHits, misses: this.#cacheMisses, size: this.#surplusCache.size };
  }
  /** Lookup counters summed over the partition databases. */
  get lookupStats(): PdbLookupStats {
    const total: PdbLookupStats = { lookups: 0, exitCapTrims: 0, exitCapTrimTotal: 0, outsideRegionLookups: 0 };
    for (const { lookupStats } of this.#pdbs) {
      total.lookups += lookupStats.lookups;
      total.exitCapTrims += lookupStats.exitCapTrims;
      total.exitCapTrimTotal += lookupStats.exitCapTrimTotal;
      total.outsideRegionLookups += lookupStats.outsideRegionLookups;
    }
    return total;
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
      const boxCells = this.#cellsByLabel[this.#partitionSlots[i]];
      if (boxCells.length < k) continue;
      const value = boxCells.length === k
        ? pdb.lookup(boxCells)
        : minSubsetLookup(pdb, boxCells, k, this.#subsetScratch);
      if (value !== PDB_UNSOLVED) total += value;
    }
    return total;
  }

  /**
   * PDB surplus over the assignment label costs for `boxes`. `boxKey`
   * identifies the box layout and `labelCostsBoxKey` the layout the label
   * costs were computed for (the assignment heuristic's `lastBoxKey`). The
   * cache is used only when both are given and equal; otherwise the surplus
   * is computed and not stored.
   */
  evaluateWithSurplus(
    boxes: readonly DenseBox[],
    assignmentLabelCosts: ReadonlyMap<string, number>,
    boxKey?: bigint,
    labelCostsBoxKey?: bigint,
  ): number {
    if (this.#pdbs.length === 0) {
      this.#lastSurplusParts = NO_SURPLUS_PARTS;
      return 0;
    }

    const cacheKey = boxKey !== undefined && boxKey === labelCostsBoxKey
      ? boxKey
      : undefined;
    if (cacheKey !== undefined) {
      const cached = this.#surplusCache.get(cacheKey);
      if (cached !== undefined) {
        this.#cacheHits++;
        this.#lastSurplusParts = cached;
        let total = 0;
        for (let i = 1; i < cached.length; i += 2) total += cached[i];
        return total;
      }
    }
    this.#cacheMisses++;

    for (const cells of this.#cellsByLabel) cells.length = 0;
    for (const box of boxes) {
      const slot = this.#labelSlots.get(box.label);
      if (slot !== undefined) this.#cellsByLabel[slot].push(box.cell);
    }

    const totals = this.#slotTotals;
    const touched = this.#slotTouched;
    const order = this.#touchedSlots;
    let touchedCount = 0;
    for (let i = 0; i < this.#partitions.length; i++) {
      const pdb = this.#pdbs[i];
      const k = pdb.k;
      if (k === 0) continue;
      const slot = this.#partitionSlots[i];
      const boxCells = this.#cellsByLabel[slot];
      if (boxCells.length < k) continue;
      const value = boxCells.length === k
        ? pdb.lookup(boxCells)
        : minSubsetLookup(pdb, boxCells, k, this.#subsetScratch);
      if (value === PDB_UNSOLVED) continue;
      if (touched[slot] === 0) {
        touched[slot] = 1;
        order[touchedCount++] = slot;
        totals[slot] = value;
      } else {
        totals[slot] += value;
      }
    }

    // Labels in the order their first table answered.
    let surplus = 0;
    let parts: number[] | null = null;
    for (let t = 0; t < touchedCount; t++) {
      const slot = order[t];
      touched[slot] = 0;
      const assignmentCost = assignmentLabelCosts.get(this.#slotLabels[slot]) ?? 0;
      const diff = totals[slot] - assignmentCost;
      if (diff > 0) {
        surplus += diff;
        (parts ??= []).push(slot, diff);
      }
    }
    const surplusParts = parts ?? NO_SURPLUS_PARTS;
    this.#lastSurplusParts = surplusParts;

    if (cacheKey !== undefined) {
      if (this.#surplusCache.size >= SURPLUS_CACHE_CAP) {
        const firstKey = this.#surplusCache.keys().next().value;
        if (firstKey !== undefined) {
          this.#surplusCacheBytes -= this.#cacheEntryBytes(firstKey, this.#surplusCache.get(firstKey)!);
          this.#surplusCache.delete(firstKey);
        }
      }
      const additionalBytes = this.#cacheEntryBytes(cacheKey, surplusParts);
      if (this.#cacheMemoryBudget?.(additionalBytes) !== false) {
        this.#surplusCache.set(cacheKey, surplusParts);
        this.#surplusCacheBytes += additionalBytes;
      }
    }

    return surplus;
  }

  #cacheEntryBytes(key: bigint, parts: readonly number[]): number {
    // Map entry, exact BigInt key payload and any parts array (conservative estimate).
    return 96 + Math.ceil(key.toString(16).length / 2) +
      (parts.length > 0 ? 32 + 8 * parts.length : 0);
  }
}
