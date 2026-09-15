import { minimumAssignmentCost } from "./assignment.ts";
import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";

export interface GoalCommitmentStats {
  readonly checks: number;
  readonly commitments: number;
}

export class GoalCommitmentDetector {
  #checks = 0;
  #commitments = 0;
  readonly #frozenBuffer: Uint8Array;
  readonly #queueBuffer: Int32Array;
  readonly #inQueueBuffer: Uint8Array;

  constructor(maxBoxes: number = 64) {
    this.#frozenBuffer = new Uint8Array(maxBoxes);
    this.#queueBuffer = new Int32Array(5 * maxBoxes + 1);
    this.#inQueueBuffer = new Uint8Array(maxBoxes);
  }

  get stats(): GoalCommitmentStats {
    return {
      checks: this.#checks,
      commitments: this.#commitments,
    };
  }

  findProvenCommitments(
    board: CompiledSearchBoard,
    boxes: readonly DenseBox[],
    deadlockOccupancy?: Int32Array,
  ): ReadonlySet<number> {
    this.#checks += 1;
    const committed = new Set<number>();

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (board.goalLabelByCell[box.cell] !== box.label) continue;
      if (!isStaticallyImmovable(board, box.cell)) continue;
      if (!residualAssignmentFeasible(board, boxes, i)) continue;
      committed.add(i);
      this.#commitments += 1;
    }

    if (deadlockOccupancy) {
      this.#findFrozenCommitments(board, boxes, deadlockOccupancy, committed);
    }

    return committed;
  }

  #findFrozenCommitments(
    board: CompiledSearchBoard,
    boxes: readonly DenseBox[],
    occupancy: Int32Array,
    committed: Set<number>,
  ): void {
    const n = boxes.length;
    const frozen = this.#frozenBuffer;
    const queue = this.#queueBuffer;
    const inQueue = this.#inQueueBuffer;
    frozen.fill(0, 0, n);
    inQueue.fill(0, 0, n);
    let qHead = 0;
    let qTail = 0;

    for (let i = 0; i < n; i++) {
      if (committed.has(i)) {
        frozen[i] = 1;
        continue;
      }
      queue[qTail++] = i;
      inQueue[i] = 1;
    }

    while (qHead < qTail) {
      const i = queue[qHead++];
      inQueue[i] = 0;
      if (frozen[i]) continue;

      const box = boxes[i];
      const cell = box.cell;
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

      if (!verticalStuck || !horizontalStuck) continue;

      if (board.goalLabelByCell[cell] !== box.label) continue;

      frozen[i] = 1;

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

    const newlyFrozen: number[] = [];
    for (let i = 0; i < n; i++) {
      if (frozen[i] && !committed.has(i)) newlyFrozen.push(i);
    }
    if (newlyFrozen.length === 0) return;

    if (!residualGroupAssignmentFeasible(board, boxes, committed, newlyFrozen)) return;
    for (const i of newlyFrozen) {
      committed.add(i);
      this.#commitments += 1;
    }
  }
}

function isStaticallyImmovable(
  board: CompiledSearchBoard,
  cell: number,
): boolean {
  const neighbors = board.neighbors[cell];
  const up = neighbors[0];
  const down = neighbors[1];
  const left = neighbors[2];
  const right = neighbors[3];

  const verticalOpen = up >= 0 && down >= 0;
  const horizontalOpen = left >= 0 && right >= 0;

  return !verticalOpen && !horizontalOpen;
}

function residualAssignmentFeasible(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  excludeIndex: number,
): boolean {
  const excludedBox = boxes[excludeIndex];
  const excludedCell = excludedBox.cell;
  const label = excludedBox.label;

  const labelBoxCells: number[] = [];
  for (let i = 0; i < boxes.length; i++) {
    if (i === excludeIndex) continue;
    if (boxes[i].label === label) labelBoxCells.push(boxes[i].cell);
  }

  const allGoals = board.goalCellsByLabel.get(label) ?? [];
  const residualGoals: number[] = [];
  for (const g of allGoals) {
    if (g === excludedCell) continue;
    residualGoals.push(g);
  }

  if (labelBoxCells.length !== residualGoals.length) return false;
  if (labelBoxCells.length === 0) return true;

  const costs = labelBoxCells.map((boxCell) =>
    residualGoals.map((goalCell) => {
      const distance = board.reversePushDistancesByGoal.get(goalCell)?.[boxCell] ?? -1;
      return distance < 0 ? Number.POSITIVE_INFINITY : distance;
    }),
  );

  return Number.isFinite(minimumAssignmentCost(costs));
}

function residualGroupAssignmentFeasible(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  alreadyCommitted: ReadonlySet<number>,
  newlyFrozen: readonly number[],
): boolean {
  const excludeSet = new Set(alreadyCommitted);
  for (const i of newlyFrozen) excludeSet.add(i);

  const labelGroups = new Map<string, { boxCells: number[]; excludedGoals: number[] }>();
  for (const i of newlyFrozen) {
    const box = boxes[i];
    let group = labelGroups.get(box.label);
    if (!group) {
      group = { boxCells: [], excludedGoals: [] };
      labelGroups.set(box.label, group);
    }
    group.excludedGoals.push(box.cell);
  }
  for (const i of alreadyCommitted) {
    const box = boxes[i];
    let group = labelGroups.get(box.label);
    if (!group) {
      group = { boxCells: [], excludedGoals: [] };
      labelGroups.set(box.label, group);
    }
    group.excludedGoals.push(box.cell);
  }

  for (let i = 0; i < boxes.length; i++) {
    if (excludeSet.has(i)) continue;
    const box = boxes[i];
    const group = labelGroups.get(box.label);
    if (group) group.boxCells.push(box.cell);
  }

  for (const [label, group] of labelGroups) {
    const allGoals = board.goalCellsByLabel.get(label) ?? [];
    const excludedGoalSet = new Set(group.excludedGoals);
    const residualGoals: number[] = [];
    for (const g of allGoals) {
      if (!excludedGoalSet.has(g)) residualGoals.push(g);
    }
    if (group.boxCells.length !== residualGoals.length) return false;
    if (group.boxCells.length === 0) continue;

    const costs = group.boxCells.map((boxCell) =>
      residualGoals.map((goalCell) => {
        const distance = board.reversePushDistancesByGoal.get(goalCell)?.[boxCell] ?? -1;
        return distance < 0 ? Number.POSITIVE_INFINITY : distance;
      }),
    );
    if (!Number.isFinite(minimumAssignmentCost(costs))) return false;
  }
  return true;
}

export function findProvenCommitments(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  detector: GoalCommitmentDetector,
  deadlockOccupancy?: Int32Array,
): ReadonlySet<number> {
  return detector.findProvenCommitments(board, boxes, deadlockOccupancy);
}

export function hasPotentialGoalCommitment(
  board: CompiledSearchBoard,
): boolean {
  for (let cell = 0; cell < board.cellCount; cell++) {
    if (board.goalLabelByCell[cell] !== null) {
      if (isStaticallyImmovable(board, cell)) return true;
      const neighbors = board.neighbors[cell];
      let wallCount = 0;
      for (let d = 0; d < 4; d++) {
        if (neighbors[d] < 0) wallCount++;
      }
      if (wallCount >= 1) return true;
    }
  }
  return false;
}
