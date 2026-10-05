import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";

interface BoxGoalPair {
  readonly label: string;
  readonly boxCell: number;
  readonly goalCell: number;
  readonly boxPos: number;
  readonly goalPos: number;
  readonly pushDist: number;
}

function collectAxisPairs(
  board: CompiledSearchBoard,
  assignment: ReadonlyMap<string, { boxCells: readonly number[]; goalCells: readonly number[]; columns: readonly number[] }>,
  getAxisCoord: (cell: number) => number,
  getLineCoord: (cell: number) => number,
  pairsOut?: string[],
): number {
  const lineMap = new Map<number, BoxGoalPair[]>();

  for (const [label, state] of assignment) {
    const { boxCells, goalCells, columns } = state;
    // A label with several goals can be matched differently by another
    // assignment of the same cost, which may cross no pairs at all.
    if (goalCells.length !== 1) continue;
    for (let i = 0; i < boxCells.length; i++) {
      const boxCell = boxCells[i];
      const goalCell = goalCells[columns[i]];
      const boxLine = getLineCoord(boxCell);
      const goalLine = getLineCoord(goalCell);
      if (boxLine !== goalLine) continue;

      const boxPos = getAxisCoord(boxCell);
      const goalPos = getAxisCoord(goalCell);
      const pushDist = board.reversePushDistancesByGoal.get(goalCell)?.[boxCell] ?? -1;
      // A box whose shortest route already leaves the line can step aside
      // at no extra cost.
      if (pushDist !== Math.abs(boxPos - goalPos)) continue;

      const pair: BoxGoalPair = { label, boxCell, goalCell, boxPos, goalPos, pushDist };
      const list = lineMap.get(boxLine) ?? [];
      list.push(pair);
      lineMap.set(boxLine, list);
    }
  }

  let totalConflicts = 0;

  for (const pairs of lineMap.values()) {
    if (pairs.length < 2) continue;

    const conflicts: { i: number; j: number; dist: number }[] = [];
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const a = pairs[i];
        const b = pairs[j];
        const aLeftOfB = a.boxPos < b.boxPos;
        const aGoalLeftOfBGoal = a.goalPos < b.goalPos;
        if (aLeftOfB !== aGoalLeftOfBGoal) {
          conflicts.push({ i, j, dist: a.pushDist + b.pushDist });
        }
      }
    }

    if (conflicts.length === 0) continue;

    conflicts.sort((a, b) => b.dist - a.dist);
    const used = new Set<number>();
    for (const conflict of conflicts) {
      if (!used.has(conflict.i) && !used.has(conflict.j)) {
        totalConflicts += 1;
        used.add(conflict.i);
        used.add(conflict.j);
        pairsOut?.push(pairs[conflict.i].label, pairs[conflict.j].label);
      }
    }
  }

  return totalConflicts;
}

/**
 * Extra pushes forced by boxes that must pass each other on a row or column.
 *
 * Only pairs whose boxes both have a single goal of their label, on the same
 * line, with a relaxed push distance equal to the straight distance, count.
 * Such boxes are matched to that goal by every assignment. Two boxes that
 * both stay on the line keep their order, so one box of each crossing pair
 * must leave it; that takes a push off the line and one back, at least two
 * pushes beyond its straight distance. Pairs are matched greedily so that
 * each box pays for one pair per axis, and pushes across the line and along
 * it are counted separately, so the row and column terms add. The result is
 * therefore a lower bound on the pushes beyond the assignment cost.
 *
 * Each such label has one goal and so one box. When `pairsOut` is given, the
 * labels of every matched pair are appended to it, two per pair. A pair is
 * worth 2, and those pushes belong to its two labels' boxes, so any set of
 * matched pairs is worth at most the extra pushes of the labels it names.
 */
export function computeLinearConflict(
  board: CompiledSearchBoard,
  // The assignment contains box cells; retain this public argument for callers.
  _boxes: readonly DenseBox[],
  assignment: ReadonlyMap<string, { boxCells: readonly number[]; goalCells: readonly number[]; columns: readonly number[] }>,
  pairsOut?: string[],
): number {
  const getRow = (cell: number) => board.positions[cell].row;
  const getCol = (cell: number) => board.positions[cell].column;

  const rowConflicts = collectAxisPairs(board, assignment, getCol, getRow, pairsOut);
  const colConflicts = collectAxisPairs(board, assignment, getRow, getCol, pairsOut);

  return (rowConflicts + colConflicts) * 2;
}
