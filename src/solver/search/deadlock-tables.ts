import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";
import { throwIfSolverCancelled } from "../cancellation.ts";
import { delayForEventLoop } from "./scheduling.ts";
import {
  checkExactPreprocessingBudget,
  isExactPreprocessingLimitError,
  type ExactPreprocessingBudget,
} from "./preprocessing-budget.ts";

const MAX_REGION_CELLS = 9;
const MAX_BOX_COUNT = 3;
const MIN_BOX_COUNT = 2;
const BFS_STATE_LIMIT = 5000;
// Dequeued region-BFS states one build may spend. Work, not wall time, so the
// table is the same on every machine; the preprocessing deadline only aborts.
// About 2 s on a c4-standard-32 core; no benchmark fixture's complete table
// needs more than 1.2 million.
const MAX_TABLE_WORK = 2_000_000;
// Dequeued states between event-loop yields in the async build.
const YIELD_WORK = 1024;
// Class shared by every label with no goal in a region. No goal cell carries
// it, so a box of this class is never solved inside the region.
const OTHER_LABELS = "\u0000";

export interface DeadlockTableStats {
  readonly regionCount: number;
  // Deadlocked label assignments covered; one stored class pattern can stand
  // for several of them.
  readonly patternCount: number;
  readonly buildTimeMs: number;
  readonly estimatedRetainedBytes: number;
  // Dequeued region-BFS states.
  readonly workUnits: number;
  // The work cap or a preprocessing limit stopped the build early.
  readonly truncated: boolean;
}

export interface DeadlockTableOptions {
  readonly maxWorkUnits?: number;
}

// A label with a goal in the region is its own class. The region BFS treats
// every other label alike, so they share OTHER_LABELS. Patterns are stored per
// region because the classes differ between regions.
interface Region {
  readonly cells: readonly number[];
  readonly cellSet: ReadonlySet<number>;
  readonly goalLabels: ReadonlySet<string>;
  readonly deadlocks: Set<string>;
}

interface LabelClass {
  readonly key: string;
  // Board labels the class stands for.
  readonly size: number;
}

interface TableBuild {
  readonly labels: ReadonlySet<string>;
  readonly cellToRegions: Map<number, Region[]>;
  readonly maxWorkUnits: number;
  workUnits: number;
  workSinceYield: number;
  regionCount: number;
  regionBytes: number;
  patternCount: number;
  storedPatterns: number;
  truncated: boolean;
}

type RegionBfsOutcome = "deadlocked" | "free" | "cut";

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

function regionRetainedBytes(region: Region): number {
  return 128 + region.cells.length * 24 + region.goalLabels.size * 48;
}

function estimateDeadlockTableBytes(
  regionBytes: number,
  storedPatterns: number,
): number {
  return 512 + regionBytes + storedPatterns * 128;
}

function labelClasses(
  region: Region,
  labels: ReadonlySet<string>,
): LabelClass[] {
  const classes: LabelClass[] = [];
  let otherCount = 0;
  for (const label of labels) {
    if (region.goalLabels.has(label)) classes.push({ key: label, size: 1 });
    else otherCount++;
  }
  if (otherCount > 0) classes.push({ key: OTHER_LABELS, size: otherCount });
  return classes;
}

function findWallAdjacentRegions(
  board: CompiledSearchBoard,
  budget?: ExactPreprocessingBudget,
): Region[] {
  const regions: Region[] = [];
  const seen = new Set<string>();
  let regionBytes = 0;

  for (let cell = 0; cell < board.cellCount; cell++) {
    if ((cell & 31) === 0) {
      checkExactPreprocessingBudget(
        budget,
        estimateDeadlockTableBytes(regionBytes, 0),
      );
    }
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

    const goalLabels = new Set<string>();
    for (const regionCell of sorted) {
      const label = board.goalLabelByCell[regionCell];
      if (label !== null) goalLabels.add(label);
    }
    const region: Region = {
      cells: sorted,
      cellSet: regionCells,
      goalLabels,
      deadlocks: new Set(),
    };
    regions.push(region);
    regionBytes += regionRetainedBytes(region);
  }

  return regions;
}

// Pushes boxes inside the region with the robot anywhere and every other box
// removed; a box pushed out of the region leaves the problem. "deadlocked"
// means no push sequence solves or empties the region, which is proven only
// when the search ran to exhaustion.
function* regionBfs(
  board: CompiledSearchBoard,
  region: Region,
  initialCells: readonly number[],
  labels: readonly string[],
  build: TableBuild,
  budget: ExactPreprocessingBudget | undefined,
  retainedBytes: number,
): Generator<void, RegionBfsOutcome, void> {
  const goalSolved = (cells: readonly number[], lbls: readonly string[]): boolean => {
    for (let i = 0; i < cells.length; i++) {
      if (board.goalLabelByCell[cells[i]] !== lbls[i]) return false;
    }
    return true;
  };

  if (goalSolved(initialCells, labels)) return "free";

  const seen = new Set<string>();
  const queue: { cells: number[]; labels: string[] }[] = [];
  const initSig = configKey(initialCells, labels);
  seen.add(initSig);
  queue.push({ cells: [...initialCells], labels: [...labels] });

  let head = 0;
  while (head < queue.length) {
    if (seen.size > BFS_STATE_LIMIT) return "free";
    if (build.workUnits >= build.maxWorkUnits) return "cut";
    if ((head & 63) === 0) {
      checkExactPreprocessingBudget(
        budget,
        retainedBytes + seen.size * (64 + initialCells.length * 16),
      );
    }
    build.workUnits++;
    if (++build.workSinceYield >= YIELD_WORK) {
      build.workSinceYield = 0;
      yield;
    }

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
          return "free";
        }

        const sig = configKey(newCells, newLabels);
        if (seen.has(sig)) continue;
        seen.add(sig);
        queue.push({ cells: newCells, labels: newLabels });
      }
    }
  }

  return "deadlocked";
}

function* buildRegion(
  board: CompiledSearchBoard,
  region: Region,
  build: TableBuild,
  budget: ExactPreprocessingBudget | undefined,
): Generator<void, void, void> {
  const classes = labelClasses(region, build.labels);
  for (let boxCount = MIN_BOX_COUNT; boxCount <= Math.min(MAX_BOX_COUNT, region.cells.length); boxCount++) {
    const indices = new Array<number>(boxCount);
    for (let j = 0; j < boxCount; j++) indices[j] = j;

    while (true) {
      const cells = indices.map((i) => region.cells[i]);
      const classIndices = new Array<number>(boxCount).fill(0);

      while (true) {
        const keys = classIndices.map((i) => classes[i].key);
        const outcome = yield* regionBfs(
          board,
          region,
          cells,
          keys,
          build,
          budget,
          estimateDeadlockTableBytes(build.regionBytes, build.storedPatterns),
        );
        if (outcome === "cut") {
          build.truncated = true;
          return;
        }
        if (outcome === "deadlocked") {
          checkExactPreprocessingBudget(
            budget,
            estimateDeadlockTableBytes(build.regionBytes, build.storedPatterns + 1),
          );
          if (region.deadlocks.size === 0) {
            for (const cell of region.cells) {
              const existing = build.cellToRegions.get(cell) ?? [];
              existing.push(region);
              build.cellToRegions.set(cell, existing);
            }
          }
          region.deadlocks.add(configKey(cells, keys));
          build.storedPatterns++;
          let covered = 1;
          for (const i of classIndices) covered *= classes[i].size;
          build.patternCount += covered;
        }

        let k = boxCount - 1;
        while (k >= 0 && classIndices[k] === classes.length - 1) {
          classIndices[k] = 0;
          k--;
        }
        if (k < 0) break;
        classIndices[k]++;
      }

      let j = boxCount - 1;
      while (j >= 0 && indices[j] === region.cells.length - boxCount + j) j--;
      if (j < 0) break;
      indices[j]++;
      for (let m = j + 1; m < boxCount; m++) indices[m] = indices[m - 1] + 1;
    }
  }
}

// Shared by both builders: yields at every region and every YIELD_WORK work
// units so the async builder can give the event loop a turn. A preprocessing
// limit keeps the patterns proven so far; cancellation still throws.
function* buildTables(
  board: CompiledSearchBoard,
  build: TableBuild,
  budget: ExactPreprocessingBudget | undefined,
): Generator<void, void, void> {
  if (build.labels.size === 0) return;
  try {
    const regions = findWallAdjacentRegions(board, budget);
    checkExactPreprocessingBudget(budget);
    for (const region of regions) {
      yield;
      checkExactPreprocessingBudget(
        budget,
        estimateDeadlockTableBytes(build.regionBytes, build.storedPatterns),
      );
      build.regionCount++;
      build.regionBytes += regionRetainedBytes(region);
      yield* buildRegion(board, region, build, budget);
      if (build.truncated) return;
    }
  } catch (error) {
    if (!isExactPreprocessingLimitError(error)) throw error;
    build.truncated = true;
  }
}

function startTableBuild(
  board: CompiledSearchBoard,
  options: DeadlockTableOptions | undefined,
): TableBuild {
  return {
    labels: new Set(board.goalCellsByLabel.keys()),
    cellToRegions: new Map(),
    maxWorkUnits: options?.maxWorkUnits ?? MAX_TABLE_WORK,
    workUnits: 0,
    workSinceYield: 0,
    regionCount: 0,
    regionBytes: 0,
    patternCount: 0,
    storedPatterns: 0,
    truncated: false,
  };
}

function finishTableBuild(
  build: TableBuild,
  startTime: number,
): DeadlockTableLookup {
  return new DeadlockTableLookup(build.labels, build.cellToRegions, {
    regionCount: build.regionCount,
    patternCount: build.patternCount,
    buildTimeMs: Date.now() - startTime,
    estimatedRetainedBytes: build.labels.size === 0
      ? 0
      : estimateDeadlockTableBytes(build.regionBytes, build.storedPatterns),
    workUnits: build.workUnits,
    truncated: build.truncated,
  });
}

export class DeadlockTableLookup {
  readonly #labels: ReadonlySet<string>;
  readonly #cellToRegions: ReadonlyMap<number, readonly Region[]>;
  readonly #stats: DeadlockTableStats;

  constructor(
    labels: ReadonlySet<string>,
    cellToRegions: Map<number, Region[]>,
    stats: DeadlockTableStats,
  ) {
    this.#labels = labels;
    this.#cellToRegions = cellToRegions;
    this.#stats = stats;
  }

  get stats(): DeadlockTableStats {
    return this.#stats;
  }

  get estimatedRetainedBytes(): number {
    return this.#stats.estimatedRetainedBytes;
  }

  check(
    boxes: readonly DenseBox[],
    movedCell: number,
  ): boolean {
    const regions = this.#cellToRegions.get(movedCell);
    if (!regions) return false;

    for (const region of regions) {
      const regionBoxCells: number[] = [];
      const regionBoxClasses: string[] = [];
      let knownLabels = true;
      for (const box of boxes) {
        if (!region.cellSet.has(box.cell)) continue;
        // The build only enumerated goal labels; a box without one matches
        // no pattern, as before label classes.
        if (!this.#labels.has(box.label)) {
          knownLabels = false;
          break;
        }
        regionBoxCells.push(box.cell);
        regionBoxClasses.push(
          region.goalLabels.has(box.label) ? box.label : OTHER_LABELS,
        );
      }

      if (!knownLabels) continue;
      if (regionBoxCells.length < MIN_BOX_COUNT || regionBoxCells.length > MAX_BOX_COUNT) continue;

      if (region.deadlocks.has(configKey(regionBoxCells, regionBoxClasses))) return true;
    }

    return false;
  }
}

export function buildDeadlockTables(
  board: CompiledSearchBoard,
  options?: DeadlockTableOptions,
): DeadlockTableLookup {
  const startTime = Date.now();
  const build = startTableBuild(board, options);
  const steps = buildTables(board, build, undefined);
  while (!steps.next().done) { /* the sync build ignores yields */ }
  return finishTableBuild(build, startTime);
}

export async function buildDeadlockTablesAsync(
  board: CompiledSearchBoard,
  signal: AbortSignal,
  budget?: ExactPreprocessingBudget,
  options?: DeadlockTableOptions,
): Promise<DeadlockTableLookup> {
  throwIfSolverCancelled(signal);
  const startTime = Date.now();
  const build = startTableBuild(board, options);
  const steps = buildTables(board, build, budget);
  while (!steps.next().done) {
    await delayForEventLoop();
    throwIfSolverCancelled(signal);
  }
  return finishTableBuild(build, startTime);
}
