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

  get stats(): GoalCommitmentStats {
    return {
      checks: this.#checks,
      commitments: this.#commitments,
    };
  }

  findProvenCommitments(
    board: CompiledSearchBoard,
    boxes: readonly DenseBox[],
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

    return committed;
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

export function findProvenCommitments(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  detector: GoalCommitmentDetector,
): ReadonlySet<number> {
  return detector.findProvenCommitments(board, boxes);
}

/**
 * Returns true only when the static board contains a goal on which a matching
 * box could satisfy the commitment rule. If false, the detector cannot commit
 * a box in any reachable state because labels and board geometry are fixed.
 */
export function hasPotentialGoalCommitment(
  board: CompiledSearchBoard,
): boolean {
  for (let cell = 0; cell < board.cellCount; cell++) {
    if (
      board.goalLabelByCell[cell] !== null &&
      isStaticallyImmovable(board, cell)
    ) {
      return true;
    }
  }
  return false;
}
