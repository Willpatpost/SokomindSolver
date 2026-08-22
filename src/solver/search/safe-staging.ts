import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";
import { isStaticDeadCell } from "./deadlocks.ts";
import { SEARCH_DIRECTIONS } from "./compiled-board.ts";

export interface StagingQuality {
  readonly cell: number;
  readonly label: string;
  readonly isDeadCell: boolean;
  readonly pushFlexibility: number;
  readonly supportAccess: number;
  readonly goalDistance: number;
  readonly isArticulation: boolean;
  readonly isTunnel: boolean;
  readonly isOnGoal: boolean;
  readonly isOnOtherGoal: boolean;
  readonly score: number;
}

export interface StagingCandidate {
  readonly cell: number;
  readonly quality: StagingQuality;
  readonly reversePushDistance: number;
}

export function evaluateStagingQuality(
  board: CompiledSearchBoard,
  cell: number,
  label: string,
): StagingQuality {
  const dead = isStaticDeadCell(board, cell, label);
  const neighbors = board.neighbors[cell];

  let pushFlexibility = 0;
  let supportAccess = 0;
  for (let d = 0; d < SEARCH_DIRECTIONS.length; d++) {
    const target = neighbors[d];
    const oppositeDir = SEARCH_DIRECTIONS[d].oppositeIndex;
    const support = neighbors[oppositeDir];
    if (support >= 0) {
      supportAccess++;
      if (target >= 0) {
        pushFlexibility++;
      }
    }
  }

  let goalDistance = -1;
  const goals = board.goalCellsByLabel.get(label);
  if (goals) {
    for (const goalCell of goals) {
      const distances = board.reversePushDistancesByGoal.get(goalCell);
      if (!distances) continue;
      const d = distances[cell];
      if (d >= 0 && (goalDistance < 0 || d < goalDistance)) {
        goalDistance = d;
      }
    }
  }

  const isArticulation = board.topology.articulations.has(cell);
  const isTunnel = board.topology.tunnels.has(cell);
  const cellGoalLabel = board.goalLabelByCell[cell];
  const isOnGoal = cellGoalLabel === label;
  const isOnOtherGoal = cellGoalLabel !== null && cellGoalLabel !== label;

  let score: number;
  if (dead) {
    score = -Infinity;
  } else {
    score = 0;
    score += pushFlexibility * 2;
    score += supportAccess * 1.5;
    if (goalDistance >= 0) {
      score -= Math.min(goalDistance * 0.1, 10);
    }
    if (isArticulation) score -= 8;
    if (isTunnel) score -= 6;
    if (isOnOtherGoal) score -= 3;
    if (isOnGoal) score += 1;
  }

  return Object.freeze({
    cell,
    label,
    isDeadCell: dead,
    pushFlexibility,
    supportAccess,
    goalDistance,
    isArticulation,
    isTunnel,
    isOnGoal,
    isOnOtherGoal,
    score,
  });
}

export function computeStagingMap(
  board: CompiledSearchBoard,
  label: string,
): readonly StagingQuality[] {
  const result: StagingQuality[] = new Array(board.cellCount);
  for (let cell = 0; cell < board.cellCount; cell++) {
    result[cell] = evaluateStagingQuality(board, cell, label);
  }
  return Object.freeze(result);
}

export function findBestStagingCells(
  board: CompiledSearchBoard,
  boxCell: number,
  label: string,
  maxCandidates: number = 10,
): readonly StagingCandidate[] {
  const map = computeStagingMap(board, label);
  const boxPos = board.positions[boxCell];
  const candidates: StagingCandidate[] = [];

  for (let cell = 0; cell < board.cellCount; cell++) {
    if (cell === boxCell) continue;
    const quality = map[cell];
    if (quality.isDeadCell) continue;

    const pos = board.positions[cell];
    const reversePushDistance =
      Math.abs(boxPos.row - pos.row) + Math.abs(boxPos.column - pos.column);

    candidates.push(
      Object.freeze({ cell, quality, reversePushDistance }),
    );
  }

  candidates.sort((a, b) => {
    const scoreDiff = b.quality.score - a.quality.score;
    if (scoreDiff !== 0) return scoreDiff;
    return a.reversePushDistance - b.reversePushDistance;
  });

  return Object.freeze(candidates.slice(0, maxCandidates));
}

export function hasStagingInterference(
  board: CompiledSearchBoard,
  stagingCell: number,
  otherBoxes: readonly DenseBox[],
): boolean {
  if (board.topology.articulations.has(stagingCell)) return true;
  if (board.topology.tunnels.has(stagingCell)) return true;

  for (const box of otherBoxes) {
    const goals = board.goalCellsByLabel.get(box.label);
    if (!goals) continue;
    for (const goalCell of goals) {
      if (goalCell === stagingCell) return true;
    }
  }

  return false;
}
