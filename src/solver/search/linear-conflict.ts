import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";

interface BoxGoalPair {
  readonly boxCell: number;
  readonly goalCell: number;
  readonly boxPos: number;
  readonly goalPos: number;
  readonly pushDist: number;
}

function collectAxisPairs(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  assignment: ReadonlyMap<string, { boxCells: readonly number[]; goalCells: readonly number[]; columns: readonly number[] }>,
  getAxisCoord: (cell: number) => number,
  getLineCoord: (cell: number) => number,
): number {
  const lineMap = new Map<number, BoxGoalPair[]>();

  for (const [, state] of assignment) {
    const { boxCells, goalCells, columns } = state;
    for (let i = 0; i < boxCells.length; i++) {
      const boxCell = boxCells[i];
      const goalCell = goalCells[columns[i]];
      const boxLine = getLineCoord(boxCell);
      const goalLine = getLineCoord(goalCell);
      if (boxLine !== goalLine) continue;

      const pair: BoxGoalPair = {
        boxCell,
        goalCell,
        boxPos: getAxisCoord(boxCell),
        goalPos: getAxisCoord(goalCell),
        pushDist: board.reversePushDistancesByGoal.get(goalCell)?.[boxCell] ?? 0,
      };
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
      }
    }
  }

  return totalConflicts;
}

export function computeLinearConflict(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  assignment: ReadonlyMap<string, { boxCells: readonly number[]; goalCells: readonly number[]; columns: readonly number[] }>,
): number {
  const getRow = (cell: number) => board.positions[cell].row;
  const getCol = (cell: number) => board.positions[cell].column;

  const rowConflicts = collectAxisPairs(board, boxes, assignment, getCol, getRow);
  const colConflicts = collectAxisPairs(board, boxes, assignment, getRow, getCol);

  return (rowConflicts + colConflicts) * 2;
}
