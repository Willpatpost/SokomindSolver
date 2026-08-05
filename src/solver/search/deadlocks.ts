import type {
  CompiledSearchBoard,
} from "./compiled-board.ts";
import type {
  DenseBox,
} from "./model.ts";

/**
 * True when a box on `cell` cannot reach any goal carrying the same label,
 * even after every other box is removed.
 */
export function isStaticDeadCell(
  board: CompiledSearchBoard,
  cell: number,
  label: string,
): boolean {
  if (!Number.isInteger(cell) || cell < 0 || cell >= board.cellCount) {
    return true;
  }
  const goals = board.goalCellsByLabel.get(label);
  if (!goals?.length) return true;
  return !goals.some((goalCell) => {
    const distance = board.reversePushDistancesByGoal.get(goalCell)?.[cell] ?? -1;
    return distance >= 0;
  });
}

function occupancyByCell(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
): Int32Array {
  const occupancy = new Int32Array(board.cellCount);
  occupancy.fill(-1);
  boxes.forEach((box, index) => {
    if (!Number.isInteger(box.cell) || box.cell < 0 || box.cell >= board.cellCount) {
      throw new RangeError(`Box ${JSON.stringify(box.id)} has an invalid dense cell.`);
    }
    if (occupancy[box.cell] >= 0) {
      throw new Error(`Multiple boxes occupy dense cell ${box.cell}.`);
    }
    occupancy[box.cell] = index;
  });
  return occupancy;
}

/**
 * Detect the conservative wall/box 2×2 deadlock.
 *
 * A completely blocked 2×2 square cannot release any participating box.
 * It is dead only when at least one contained box is not already on its
 * matching goal. Passing movedCell restricts checks to the four squares that
 * could have changed after a push.
 */
export function createsFullyBlockedTwoByTwoDeadlock(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  movedCell?: number,
  occupancy?: Int32Array,
): boolean {
  const occ = occupancy ?? occupancyByCell(board, boxes);
  const origins: Array<readonly [number, number]> = [];

  if (movedCell !== undefined) {
    if (
      !Number.isInteger(movedCell) ||
      movedCell < 0 ||
      movedCell >= board.cellCount
    ) {
      throw new RangeError("movedCell must identify a floor cell.");
    }
    const moved = board.positions[movedCell];
    for (const row of [moved.row - 1, moved.row]) {
      for (const column of [moved.column - 1, moved.column]) {
        if (
          row >= 0 &&
          column >= 0 &&
          row + 1 < board.height &&
          column + 1 < board.width
        ) {
          origins.push([row, column]);
        }
      }
    }
  } else {
    for (let row = 0; row + 1 < board.height; row += 1) {
      for (let column = 0; column + 1 < board.width; column += 1) {
        origins.push([row, column]);
      }
    }
  }

  for (const [row, column] of origins) {
    const cells = [
      board.cellAt(row, column),
      board.cellAt(row + 1, column),
      board.cellAt(row, column + 1),
      board.cellAt(row + 1, column + 1),
    ];
    if (!cells.every((cell) => cell < 0 || occ[cell] >= 0)) continue;

    const containsUnsolvedBox = cells.some((cell) => {
      if (cell < 0) return false;
      const boxIndex = occ[cell];
      if (boxIndex < 0) return false;
      return board.goalLabelByCell[cell] !== boxes[boxIndex].label;
    });
    if (containsUnsolvedBox) return true;
  }

  return false;
}

/**
 * Detect freeze deadlocks via fixpoint analysis.
 *
 * A box is "frozen" when both its horizontal and vertical axes are blocked.
 * An axis is blocked when both directions on that axis lead to a wall (neighbor
 * cell < 0) or to another frozen box. The algorithm iterates until no new boxes
 * become frozen (fixpoint). If any frozen box is NOT on its matching goal, the
 * state is a deadlock.
 *
 * This generalises the 2x2 check to catch longer chains of mutually stuck boxes
 * along walls or in L-shapes.
 */
export function hasFreezeDeadlock(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  occupancy: Int32Array,
): boolean {
  const n = boxes.length;
  const frozen = new Uint8Array(n); // 0 = not frozen, 1 = frozen
  const inQueue = new Uint8Array(n);
  const queue = new Int32Array(5 * n + 1);
  let qHead = 0;
  let qTail = 0;

  for (let i = 0; i < n; i++) {
    queue[qTail++] = i;
    inQueue[i] = 1;
  }

  while (qHead < qTail) {
    const i = queue[qHead++];
    inQueue[i] = 0;
    if (frozen[i]) continue;

    const cell = boxes[i].cell;
    const neighbors = board.neighbors[cell];
    if (!neighbors) continue;

    const up = neighbors[0];
    const down = neighbors[1];
    const upBlocked = up < 0 || (occupancy[up] >= 0 && frozen[occupancy[up]] === 1);
    const downBlocked = down < 0 || (occupancy[down] >= 0 && frozen[occupancy[down]] === 1);
    const verticalStuck = upBlocked && downBlocked;

    const left = neighbors[2];
    const right = neighbors[3];
    const leftBlocked = left < 0 || (occupancy[left] >= 0 && frozen[occupancy[left]] === 1);
    const rightBlocked = right < 0 || (occupancy[right] >= 0 && frozen[occupancy[right]] === 1);
    const horizontalStuck = leftBlocked && rightBlocked;

    if (verticalStuck && horizontalStuck) {
      frozen[i] = 1;
      if (board.goalLabelByCell[cell] !== boxes[i].label) {
        return true;
      }
      for (let d = 0; d < 4; d++) {
        const adj = neighbors[d];
        if (adj >= 0) {
          const adjIdx = occupancy[adj];
          if (adjIdx >= 0 && !frozen[adjIdx] && !inQueue[adjIdx]) {
            queue[qTail++] = adjIdx;
            inQueue[adjIdx] = 1;
          }
        }
      }
    }
  }

  return false;
}
