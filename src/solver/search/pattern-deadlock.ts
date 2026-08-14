import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";

const DEFAULT_STATE_LIMIT = 512;
const DEFAULT_FLOOR_LIMIT = 18;
const DEFAULT_BOX_LIMIT = 4;
const DEFAULT_CACHE_LIMIT = 50_000;
const CHEBYSHEV_RADIUS = 4;
const MIN_BOX_COUNT = 2;

export interface PatternDeadlockOptions {
  readonly stateLimit?: number;
  readonly floorLimit?: number;
  readonly boxLimit?: number;
  readonly cacheLimit?: number;
}

export interface PatternDeadlockStats {
  readonly checks: number;
  readonly cacheHits: number;
  readonly deadlocks: number;
}

interface WindowInfo {
  readonly cells: readonly number[];
  readonly eligible: boolean;
}

interface LocalBox {
  readonly cell: number;
  readonly label: string;
  readonly row: number;
  readonly col: number;
}

type Transform = (r: number, c: number) => [number, number];

const TRANSFORMS: readonly Transform[] = [
  (r, c) => [r, c],
  (r, c) => [c, -r],
  (r, c) => [-r, -c],
  (r, c) => [-c, r],
  (r, c) => [-r, c],
  (r, c) => [r, -c],
  (r, c) => [c, r],
  (r, c) => [-c, -r],
];

function canonicalPatternKey(
  floorPositions: readonly { row: number; col: number }[],
  boxes: readonly LocalBox[],
  goalsByCell: ReadonlyMap<number, string>,
  board: CompiledSearchBoard,
): string {
  let best = "";

  for (const transform of TRANSFORMS) {
    const transformed: { row: number; col: number }[] = [];
    for (const pos of floorPositions) {
      const [tr, tc] = transform(pos.row, pos.col);
      transformed.push({ row: tr, col: tc });
    }

    let minR = Infinity;
    let minC = Infinity;
    for (const p of transformed) {
      if (p.row < minR) minR = p.row;
      if (p.col < minC) minC = p.col;
    }

    const floorParts: string[] = [];
    for (const p of transformed) {
      floorParts.push(`${p.row - minR},${p.col - minC}`);
    }
    floorParts.sort();

    const goalParts: string[] = [];
    for (let i = 0; i < floorPositions.length; i++) {
      const origPos = floorPositions[i];
      const cell = board.cellAt(origPos.row, origPos.col);
      const goalLabel = goalsByCell.get(cell);
      if (goalLabel !== undefined) {
        const t = transformed[i];
        goalParts.push(`${t.row - minR},${t.col - minC}:${goalLabel}`);
      }
    }
    goalParts.sort();

    const boxParts: string[] = [];
    for (const box of boxes) {
      const [tr, tc] = transform(box.row, box.col);
      boxParts.push(`${tr - minR},${tc - minC}:${box.label}`);
    }
    boxParts.sort();

    const key = `${floorParts.join(";")}|${goalParts.join(";")}|${boxParts.join(";")}`;
    if (best === "" || key < best) {
      best = key;
    }
  }

  return best;
}

function boxSignature(localBoxes: readonly LocalBox[]): string {
  const parts: string[] = [];
  for (const box of localBoxes) {
    parts.push(`${box.cell}:${box.label}`);
  }
  parts.sort();
  return parts.join(";");
}

function binomial(n: number, k: number): number {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  if (k > n - k) k = n - k;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
    if (result > 1e9) return Infinity;
  }
  return Math.floor(result);
}

export class PatternDeadlockCache {
  readonly #stateLimit: number;
  readonly #floorLimit: number;
  readonly #boxLimit: number;
  readonly #cacheLimit: number;
  readonly #windowCache = new Map<number, WindowInfo>();
  readonly #patternCache = new Map<string, boolean>();
  #checks = 0;
  #cacheHits = 0;
  #deadlocks = 0;

  constructor(options?: PatternDeadlockOptions) {
    this.#stateLimit = options?.stateLimit ?? DEFAULT_STATE_LIMIT;
    this.#floorLimit = options?.floorLimit ?? DEFAULT_FLOOR_LIMIT;
    this.#boxLimit = options?.boxLimit ?? DEFAULT_BOX_LIMIT;
    this.#cacheLimit = options?.cacheLimit ?? DEFAULT_CACHE_LIMIT;
  }

  get stats(): PatternDeadlockStats {
    return {
      checks: this.#checks,
      cacheHits: this.#cacheHits,
      deadlocks: this.#deadlocks,
    };
  }

  clear(): void {
    this.#windowCache.clear();
    this.#patternCache.clear();
  }

  /**
   * Reports whether this board has any destination for which the bounded
   * pattern search can run. This is a static geometry check: when it is false,
   * every call to {@link check} would return before inspecting the boxes.
   */
  hasEligibleWindow(board: CompiledSearchBoard): boolean {
    for (let cell = 0; cell < board.cellCount; cell++) {
      if (this.#getWindowInfo(board, cell).eligible) return true;
    }
    return false;
  }

  #getWindowInfo(board: CompiledSearchBoard, centerCell: number): WindowInfo {
    const cached = this.#windowCache.get(centerCell);
    if (cached !== undefined) return cached;

    const centerPos = board.positions[centerCell];
    if (!centerPos) {
      const info: WindowInfo = { cells: [], eligible: false };
      this.#windowCache.set(centerCell, info);
      return info;
    }

    const cells: number[] = [];
    let eligible = true;

    for (
      let r = centerPos.row - CHEBYSHEV_RADIUS;
      r <= centerPos.row + CHEBYSHEV_RADIUS;
      r++
    ) {
      for (
        let c = centerPos.column - CHEBYSHEV_RADIUS;
        c <= centerPos.column + CHEBYSHEV_RADIUS;
        c++
      ) {
        const cell = board.cellAt(r, c);
        if (cell >= 0) {
          cells.push(cell);
        }
      }
    }

    if (cells.length > this.#floorLimit) {
      eligible = false;
    } else {
      for (const cell of cells) {
        const neighbors = board.neighbors[cell];
        let floorNeighborCount = 0;
        for (let d = 0; d < 4; d++) {
          if (neighbors[d] >= 0) floorNeighborCount++;
        }
        if (floorNeighborCount > 2) {
          eligible = false;
          break;
        }
      }
    }

    const info: WindowInfo = { cells, eligible };
    this.#windowCache.set(centerCell, info);
    return info;
  }

  #storePatternResult(key: string, deadlocked: boolean): void {
    if (this.#cacheLimit <= 0) return;
    while (this.#patternCache.size >= this.#cacheLimit) {
      const oldest = this.#patternCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#patternCache.delete(oldest);
    }
    this.#patternCache.set(key, deadlocked);
  }

  check(
    board: CompiledSearchBoard,
    boxes: readonly DenseBox[],
    movedCell: number,
  ): boolean {
    this.#checks += 1;

    const windowInfo = this.#getWindowInfo(board, movedCell);
    if (!windowInfo.eligible) return false;

    const windowCellSet = new Set(windowInfo.cells);
    const movedPos = board.positions[movedCell];
    if (!movedPos) return false;

    const localBoxes: LocalBox[] = [];
    for (const box of boxes) {
      if (windowCellSet.has(box.cell)) {
        const pos = board.positions[box.cell];
        if (pos) {
          localBoxes.push({
            cell: box.cell,
            label: box.label,
            row: pos.row,
            col: pos.column,
          });
        }
      }
    }

    if (localBoxes.length < MIN_BOX_COUNT || localBoxes.length > this.#boxLimit) {
      return false;
    }

    const stateUpperBound = binomial(windowInfo.cells.length, localBoxes.length);
    if (stateUpperBound > this.#stateLimit) {
      return false;
    }

    const goalsByCell = new Map<number, string>();
    for (const cell of windowInfo.cells) {
      const label = board.goalLabelByCell[cell];
      if (label !== null) {
        goalsByCell.set(cell, label);
      }
    }

    const floorPositions = windowInfo.cells.map((cell) => {
      const pos = board.positions[cell];
      return { row: pos.row, col: pos.column };
    });

    const patternKey = canonicalPatternKey(floorPositions, localBoxes, goalsByCell, board);

    const cachedResult = this.#patternCache.get(patternKey);
    if (cachedResult !== undefined) {
      this.#cacheHits += 1;
      this.#patternCache.delete(patternKey);
      this.#patternCache.set(patternKey, cachedResult);
      if (cachedResult) this.#deadlocks += 1;
      return cachedResult;
    }

    const deadlocked = this.#runBFS(board, windowCellSet, localBoxes, movedPos);
    this.#storePatternResult(patternKey, deadlocked);
    if (deadlocked) this.#deadlocks += 1;
    return deadlocked;
  }

  #runBFS(
    board: CompiledSearchBoard,
    windowCells: ReadonlySet<number>,
    initialBoxes: readonly LocalBox[],
    centerPos: { row: number; column: number },
  ): boolean {
    const isInsideWindow = (row: number, col: number): boolean => {
      return (
        Math.abs(row - centerPos.row) <= CHEBYSHEV_RADIUS &&
        Math.abs(col - centerPos.column) <= CHEBYSHEV_RADIUS
      );
    };

    const goalSolved = (bxs: readonly LocalBox[]): boolean => {
      for (const box of bxs) {
        if (board.goalLabelByCell[box.cell] !== box.label) return false;
      }
      return true;
    };

    if (goalSolved(initialBoxes)) return false;

    const seen = new Set<string>();
    const queue: (readonly LocalBox[])[] = [];
    const initSig = boxSignature(initialBoxes);
    seen.add(initSig);
    queue.push(initialBoxes);

    let head = 0;
    const stateLimit = this.#stateLimit;

    while (head < queue.length) {
      if (seen.size > stateLimit) {
        return false;
      }

      const current = queue[head++];

      const occupiedSet = new Set<number>();
      for (const box of current) occupiedSet.add(box.cell);

      for (let bi = 0; bi < current.length; bi++) {
        const box = current[bi];
        const boxPos = board.positions[box.cell];
        if (!boxPos) continue;

        for (let d = 0; d < 4; d++) {
          const dir = DIRECTION_DELTAS[d];
          const supportRow = boxPos.row - dir[0];
          const supportCol = boxPos.column - dir[1];
          const destRow = boxPos.row + dir[0];
          const destCol = boxPos.column + dir[1];

          const supportCell = board.cellAt(supportRow, supportCol);
          if (supportCell < 0) continue;
          if (occupiedSet.has(supportCell)) continue;

          const destCell = board.cellAt(destRow, destCol);
          if (destCell < 0) continue;
          if (occupiedSet.has(destCell)) continue;

          let newBoxes: LocalBox[];
          if (isInsideWindow(destRow, destCol)) {
            const destPos = board.positions[destCell];
            if (!destPos) continue;
            newBoxes = current.map((b, i) =>
              i === bi
                ? { cell: destCell, label: b.label, row: destPos.row, col: destPos.column }
                : b,
            );
          } else {
            newBoxes = current.filter((_, i) => i !== bi);
          }

          if (newBoxes.length === 0 || goalSolved(newBoxes)) {
            return false;
          }

          const sig = boxSignature(newBoxes);
          if (seen.has(sig)) continue;
          seen.add(sig);
          queue.push(newBoxes);
        }
      }
    }

    return true;
  }
}

const DIRECTION_DELTAS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export function createsPatternDeadlock(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  movedCell: number,
  cache: PatternDeadlockCache,
): boolean {
  return cache.check(board, boxes, movedCell);
}
