import {
  minimumAssignmentCost,
} from "./assignment.ts";
import type {
  CompiledSearchBoard,
} from "./compiled-board.ts";
import {
  canonicalBoxSignature,
  type DenseBox,
} from "./model.ts";

export interface AssignmentHeuristicOptions {
  readonly maxCacheEntries?: number;
}

export interface AssignmentHeuristicStats {
  readonly calls: number;
  readonly cacheHits: number;
  readonly cacheEntries: number;
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
  const groupedBoxes = boxesByLabel(boxes);
  const labels = new Set([
    ...groupedBoxes.keys(),
    ...board.goalCellsByLabel.keys(),
  ]);
  let total = 0;

  for (const label of [...labels].sort((left, right) => left.localeCompare(right))) {
    const boxCells = groupedBoxes.get(label) ?? [];
    const goalCells = board.goalCellsByLabel.get(label) ?? [];
    if (boxCells.length !== goalCells.length) {
      return Number.POSITIVE_INFINITY;
    }
    if (boxCells.length === 0) continue;

    const costs = boxCells.map((boxCell) =>
      goalCells.map((goalCell) => {
        const distance = board.reversePushDistancesByGoal.get(goalCell)?.[boxCell] ?? -1;
        return distance < 0 ? Number.POSITIVE_INFINITY : distance;
      }),
    );
    const labelCost = minimumAssignmentCost(costs);
    if (!Number.isFinite(labelCost)) return Number.POSITIVE_INFINITY;
    total += labelCost;
  }

  return total;
}

/**
 * Admissible lower bound on the walk cost to reach the first push.
 *
 * For every box that is NOT yet on its matching goal, the player must walk
 * to one of the four adjacent cells (the "support" cell) before pushing.
 * The Manhattan distance from the player to the closest such support cell
 * is a lower bound on the walk moves needed to begin the first push.
 *
 * When every box is already on its goal the remaining work is zero, and
 * this function returns 0 (consistent with the assignment heuristic
 * returning 0 in the solved state).
 *
 * The estimate is admissible because:
 *   1. Manhattan distance <= actual BFS walk distance (obstacles only add cost).
 *   2. The player cannot push any box without first reaching a support cell.
 *   3. Walk moves and push moves are disjoint, so the walk lower bound can
 *      be safely added to the push-only lower bound without double-counting.
 */
export function minimumWalkToFirstPush(
  board: CompiledSearchBoard,
  playerCell: number,
  boxes: readonly DenseBox[],
): number {
  const playerPos = board.positions[playerCell];
  if (!playerPos) return 0;

  let minDist = Number.POSITIVE_INFINITY;

  for (const box of boxes) {
    // Skip boxes that are already on their matching goal.
    if (board.goalLabelByCell[box.cell] === box.label) continue;

    const boxPos = board.positions[box.cell];
    if (!boxPos) continue;

    // Check each of the four neighbor cells as potential support positions.
    const neighbors = board.neighbors[box.cell];
    if (!neighbors) continue;

    for (let d = 0; d < 4; d++) {
      const supportCell = neighbors[d];
      if (supportCell === undefined || supportCell < 0) continue;
      const supportPos = board.positions[supportCell];
      if (!supportPos) continue;

      const manhattan =
        Math.abs(playerPos.row - supportPos.row) +
        Math.abs(playerPos.column - supportPos.column);
      if (manhattan < minDist) {
        minDist = manhattan;
        if (manhattan === 0) return 0; // Player is already at a support cell
      }
    }
  }

  return Number.isFinite(minDist) ? minDist : 0;
}

/**
 * Bounded LRU wrapper around the admissible assignment lower bound.
 *
 * Cache identity ignores same-label box ids through canonicalBoxSignature.
 */
export class AssignmentHeuristic {
  readonly #board: CompiledSearchBoard;
  readonly #maxCacheEntries: number;
  readonly #cache = new Map<string, number>();
  #calls = 0;
  #cacheHits = 0;

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
  }

  get stats(): AssignmentHeuristicStats {
    return Object.freeze({
      calls: this.#calls,
      cacheHits: this.#cacheHits,
      cacheEntries: this.#cache.size,
    });
  }

  evaluate(boxes: readonly DenseBox[]): number {
    this.#calls += 1;
    const signature = canonicalBoxSignature(boxes);
    const cached = this.#cache.get(signature);
    if (cached !== undefined) {
      this.#cacheHits += 1;
      // Refresh insertion order for bounded LRU eviction.
      this.#cache.delete(signature);
      this.#cache.set(signature, cached);
      return cached;
    }

    const value = assignmentLowerBound(this.#board, boxes);
    if (this.#maxCacheEntries > 0) {
      while (this.#cache.size >= this.#maxCacheEntries) {
        const oldest = this.#cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#cache.delete(oldest);
      }
      this.#cache.set(signature, value);
    }
    return value;
  }

  clearCache(): void {
    this.#cache.clear();
  }

  resetStats(): void {
    this.#calls = 0;
    this.#cacheHits = 0;
  }
}
