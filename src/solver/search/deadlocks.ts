import type {
  CompiledSearchBoard,
} from "./compiled-board.ts";
import type {
  DenseBox,
} from "./model.ts";
import { residualGroupAssignmentFeasible } from "./goal-commitment.ts";

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

  if (movedCell === undefined) {
    for (let row = 0; row + 1 < board.height; row += 1) {
      for (let column = 0; column + 1 < board.width; column += 1) {
        if (isDeadTwoByTwo(board, boxes, occ, row, column)) return true;
      }
    }
    return false;
  }

  if (
    !Number.isInteger(movedCell) ||
    movedCell < 0 ||
    movedCell >= board.cellCount
  ) {
    throw new RangeError("movedCell must identify a floor cell.");
  }
  const moved = board.positions[movedCell];
  for (let row = moved.row - 1; row <= moved.row; row += 1) {
    for (let column = moved.column - 1; column <= moved.column; column += 1) {
      if (
        row >= 0 &&
        column >= 0 &&
        row + 1 < board.height &&
        column + 1 < board.width &&
        isDeadTwoByTwo(board, boxes, occ, row, column)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** The 2×2 square at (row, column) is all walls and boxes, with a box off its goal. */
function isDeadTwoByTwo(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  occ: Int32Array,
  row: number,
  column: number,
): boolean {
  const topLeft = board.cellAt(row, column);
  const bottomLeft = board.cellAt(row + 1, column);
  const topRight = board.cellAt(row, column + 1);
  const bottomRight = board.cellAt(row + 1, column + 1);
  if (
    !isWallOrBox(occ, topLeft) ||
    !isWallOrBox(occ, bottomLeft) ||
    !isWallOrBox(occ, topRight) ||
    !isWallOrBox(occ, bottomRight)
  ) {
    return false;
  }
  return (
    holdsUnsolvedBox(board, boxes, occ, topLeft) ||
    holdsUnsolvedBox(board, boxes, occ, bottomLeft) ||
    holdsUnsolvedBox(board, boxes, occ, topRight) ||
    holdsUnsolvedBox(board, boxes, occ, bottomRight)
  );
}

function isWallOrBox(occ: Int32Array, cell: number): boolean {
  return cell < 0 || occ[cell] >= 0;
}

function holdsUnsolvedBox(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  occ: Int32Array,
  cell: number,
): boolean {
  if (cell < 0) return false;
  const boxIndex = occ[cell];
  return boxIndex >= 0 && board.goalLabelByCell[cell] !== boxes[boxIndex].label;
}

// Scratch for hasFreezeDeadlock, grown on demand. The check is synchronous and
// never re-enters itself, so one set of buffers serves every caller.
let freezeInSet = new Uint8Array(0);
let freezeInQueue = new Uint8Array(0);
let freezeMembers = new Int32Array(0);
let freezeQueue = new Int32Array(0);

const NO_COMMITMENTS: ReadonlySet<number> = new Set();
const deadCellsByBoard = new WeakMap<CompiledSearchBoard, Map<string, Uint8Array>>();

/** Static dead cells for `label`, computed once per board and label. */
function deadCellsFor(board: CompiledSearchBoard, label: string): Uint8Array {
  let byLabel = deadCellsByBoard.get(board);
  if (!byLabel) {
    byLabel = new Map();
    deadCellsByBoard.set(board, byLabel);
  }
  let dead = byLabel.get(label);
  if (!dead) {
    dead = new Uint8Array(board.cellCount);
    for (let cell = 0; cell < board.cellCount; cell++) {
      if (isStaticDeadCell(board, cell, label)) dead[cell] = 1;
    }
    byLabel.set(label, dead);
  }
  return dead;
}

/**
 * Detect freeze deadlocks as a greatest fixpoint.
 *
 * Start with the boxes in the moved box's 4-connected box component (every box
 * when movedCell is omitted) and assume they are all frozen. An axis of a box
 * is blocked when either side is a wall or a box still in the set, or when both
 * sides are static dead cells for the box's label. Drop any box with a free
 * axis and recheck its neighbors until the set is stable.
 *
 * No box left in the set can move in any solution: its first push would need
 * a wall cell or an unmoved set box as destination or support, or would land
 * on a cell from which its label's goals are unreachable. So the state is dead
 * when a set box is off its own label's goal, or when the remaining boxes of
 * `residualBoxes` cannot be matched to the goals the set leaves free.
 *
 * `occupancy` indexes `boxes`. Pi-corral passes only the corral boxes as
 * `boxes`, which can only shrink the set, and the full box list with the push
 * applied as `residualBoxes`, so the matching sees every box.
 */
export function hasFreezeDeadlock(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  occupancy: Int32Array,
  movedCell?: number,
  residualBoxes: readonly DenseBox[] = boxes,
): boolean {
  const n = boxes.length;
  if (freezeInSet.length < n) {
    freezeInSet = new Uint8Array(n);
    freezeInQueue = new Uint8Array(n);
    freezeMembers = new Int32Array(n);
    // Each box enters once at the start and again at most once per dropped
    // neighbor, which bounds the queue by 5n.
    freezeQueue = new Int32Array(5 * n + 1);
  }
  const inSet = freezeInSet;
  const inQueue = freezeInQueue;
  const members = freezeMembers;
  const queue = freezeQueue;
  inSet.fill(0, 0, n);

  let memberCount = 0;
  if (movedCell === undefined) {
    for (let i = 0; i < n; i++) {
      inSet[i] = 1;
      members[memberCount++] = i;
    }
  } else {
    const start = occupancy[movedCell];
    if (start < 0) return false;
    inSet[start] = 1;
    members[memberCount++] = start;
    for (let k = 0; k < memberCount; k++) {
      const neighbors = board.neighbors[boxes[members[k]].cell];
      for (let d = 0; d < 4; d++) {
        const adj = neighbors[d];
        if (adj < 0) continue;
        const j = occupancy[adj];
        if (j >= 0 && !inSet[j]) {
          inSet[j] = 1;
          members[memberCount++] = j;
        }
      }
    }
  }

  let qHead = 0;
  let qTail = 0;
  for (let k = 0; k < memberCount; k++) {
    queue[qTail++] = members[k];
    inQueue[members[k]] = 1;
  }

  while (qHead < qTail) {
    const i = queue[qHead++];
    inQueue[i] = 0;
    if (!inSet[i]) continue;

    const box = boxes[i];
    const neighbors = board.neighbors[box.cell];
    if (
      freezeAxisBlocked(board, box.label, neighbors[0], neighbors[1], occupancy, inSet) &&
      freezeAxisBlocked(board, box.label, neighbors[2], neighbors[3], occupancy, inSet)
    ) {
      continue;
    }

    inSet[i] = 0;
    for (let d = 0; d < 4; d++) {
      const adj = neighbors[d];
      if (adj < 0) continue;
      const j = occupancy[adj];
      if (j >= 0 && inSet[j] && !inQueue[j]) {
        queue[qTail++] = j;
        inQueue[j] = 1;
      }
    }
  }

  let frozenCount = 0;
  for (let k = 0; k < memberCount; k++) {
    const i = members[k];
    if (!inSet[i]) continue;
    if (board.goalLabelByCell[boxes[i].cell] !== boxes[i].label) return true;
    frozenCount += 1;
  }
  if (frozenCount === 0) return false;

  const frozen: number[] = [];
  for (let j = 0; j < residualBoxes.length; j++) {
    const i = occupancy[residualBoxes[j].cell];
    if (i >= 0 && inSet[i]) frozen.push(j);
  }
  return !residualGroupAssignmentFeasible(board, residualBoxes, NO_COMMITMENTS, frozen);
}

/** Neither push along the axis through `a` and `b` can ever help. */
function freezeAxisBlocked(
  board: CompiledSearchBoard,
  label: string,
  a: number,
  b: number,
  occupancy: Int32Array,
  inSet: Uint8Array,
): boolean {
  if (a < 0 || b < 0) return true;
  const atA = occupancy[a];
  if (atA >= 0 && inSet[atA]) return true;
  const atB = occupancy[b];
  if (atB >= 0 && inSet[atB]) return true;
  const dead = deadCellsFor(board, label);
  return dead[a] === 1 && dead[b] === 1;
}
