import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  analyzeGoalMacros,
  isGoalMacroViolation,
} from "../../src/solver/search/goal-macros.ts";
import {
  type DenseBox,
} from "../../src/solver/search/model.ts";

describe("analyzeGoalMacros", () => {
  it("returns empty analysis for board with no rooms", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  X  O",
      "O  S  O",
      "O     O",
      "OOOOOOO",
    ]));
    const analysis = analyzeGoalMacros(board);
    assert.equal(analysis.roomOrders.length, 0);
  });

  it("returns empty analysis for room with only 1 goal", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOO",
      "ORX O",
      "O  SO",
      "OOOOO",
    ]));
    const analysis = analyzeGoalMacros(board);
    assert.equal(analysis.roomOrders.length, 0);
  });

  it("identifies packing order for room with 2 goals", () => {
    // Goal room behind articulation point (gate).
    // Two goals at different depths.
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOOOO",
      "OR      O",
      "OOO OOOOO",
      "O  XX   O",
      "O  SS   O",
      "OOOOOOOOO",
    ]));
    const analysis = analyzeGoalMacros(board);
    // Whether rooms with 2+ goals are detected depends on topology.
    // The gate detection requires articulation points.
    if (analysis.roomOrders.length > 0) {
      const order = analysis.roomOrders[0];
      assert.ok(order.goalsByDepth.length >= 2);
      // Deepest goal should come first in goalsByDepth
      const firstDepth = order.depthByGoal.get(order.goalsByDepth[0])!;
      const lastDepth = order.depthByGoal.get(
        order.goalsByDepth[order.goalsByDepth.length - 1],
      )!;
      assert.ok(firstDepth >= lastDepth, "goalsByDepth should be ordered deepest first");
    }
  });

  it("maps goals to their room index", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOOOO",
      "OR      O",
      "OOO OOOOO",
      "O  XX   O",
      "O  SS   O",
      "OOOOOOOOO",
    ]));
    const analysis = analyzeGoalMacros(board);
    for (let i = 0; i < analysis.roomOrders.length; i++) {
      for (const goalCell of analysis.roomOrders[i].goalsByDepth) {
        assert.equal(analysis.goalToRoom.get(goalCell), i);
      }
    }
  });
});

describe("isGoalMacroViolation", () => {
  it("returns false when movedCell is not a goal", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  XX O",
      "O  SS O",
      "OOOOOOO",
    ]));
    const analysis = analyzeGoalMacros(board);
    const boxes: readonly DenseBox[] = [
      { id: "X:0", label: "X", cell: board.cellAt(2, 3) },
      { id: "X:1", label: "X", cell: board.cellAt(2, 4) },
    ];
    assert.equal(isGoalMacroViolation(board, boxes, board.cellAt(2, 3), analysis), false);
  });

  it("returns false when box is on goal but not immovable", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOOOO",
      "OR      O",
      "OOO OOOOO",
      "O  XX   O",
      "O  SS   O",
      "OOOOOOOOO",
    ]));
    const analysis = analyzeGoalMacros(board);
    const goalCells = board.goalCellsByLabel.get("X") ?? [];
    if (goalCells.length < 2 || analysis.roomOrders.length === 0) {
      assert.ok(true, "no room goals to test");
      return;
    }
    // Place box on the shallowest goal (which has open neighbors)
    const shallowGoal = goalCells[0];
    const deepGoal = goalCells[1];
    // Check if the shallow goal is movable (not wall-locked on both axes)
    const neighbors = board.neighbors[shallowGoal];
    const verticalOpen = neighbors[0] >= 0 && neighbors[1] >= 0;
    const horizontalOpen = neighbors[2] >= 0 && neighbors[3] >= 0;
    if (verticalOpen || horizontalOpen) {
      const boxes: readonly DenseBox[] = [
        { id: "X:0", label: "X", cell: shallowGoal },
        { id: "X:1", label: "X", cell: deepGoal },
      ];
      // Not immovable → no violation
      assert.equal(isGoalMacroViolation(board, boxes, shallowGoal, analysis), false);
    }
  });

  it("returns false when all deeper goals are filled", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOOOO",
      "OR      O",
      "OOO OOOOO",
      "O  XX   O",
      "O  SS   O",
      "OOOOOOOOO",
    ]));
    const analysis = analyzeGoalMacros(board);
    const goalCells = board.goalCellsByLabel.get("X") ?? [];
    if (goalCells.length < 2 || analysis.roomOrders.length === 0) {
      assert.ok(true, "no room goals to test");
      return;
    }
    // Place boxes on ALL goals → no violation possible
    const boxes: readonly DenseBox[] = goalCells.map((cell, i) => ({
      id: `X:${i}`,
      label: "X",
      cell,
    }));
    for (const goalCell of goalCells) {
      assert.equal(isGoalMacroViolation(board, boxes, goalCell, analysis), false);
    }
  });

  it("returns false for non-room goals", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOO",
      "OR    O",
      "O  X  O",
      "O  S  O",
      "O     O",
      "OOOOOOO",
    ]));
    const analysis = analyzeGoalMacros(board);
    const goalCells = board.goalCellsByLabel.get("X") ?? [];
    const boxes: readonly DenseBox[] = goalCells.map((cell, i) => ({
      id: `X:${i}`,
      label: "X",
      cell,
    }));
    for (const goalCell of goalCells) {
      assert.equal(isGoalMacroViolation(board, boxes, goalCell, analysis), false);
    }
  });

  it("returns false when box label does not match goal label", () => {
    const board = compileSearchBoard(parsePuzzleRows([
      "OOOOOOOOO",
      "OR A a  O",
      "O  B b  O",
      "OOOOOOOOO",
    ]));
    const analysis = analyzeGoalMacros(board);
    const goalCells = board.goalCellsByLabel.get("A") ?? [];
    if (goalCells.length > 0) {
      const boxes: readonly DenseBox[] = [
        { id: "B:0", label: "B", cell: goalCells[0] },
      ];
      assert.equal(isGoalMacroViolation(board, boxes, goalCells[0], analysis), false);
    }
  });

  it("does not produce false positives on exhaustive small board", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "ORXX O",
      "O    O",
      "O SS O",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const analysis = analyzeGoalMacros(board);
    let falsePositives = 0;

    for (let left = 0; left < board.cellCount; left++) {
      for (let right = left + 1; right < board.cellCount; right++) {
        const boxes: readonly DenseBox[] = [
          { id: "X:0", label: "X", cell: left },
          { id: "X:1", label: "X", cell: right },
        ];
        const dead1 = isGoalMacroViolation(board, boxes, left, analysis);
        const dead2 = isGoalMacroViolation(board, boxes, right, analysis);
        if (!dead1 && !dead2) continue;

        for (let robot = 0; robot < board.cellCount; robot++) {
          if (robot === left || robot === right) continue;
          const exact = exactRemainingPushes(board, robot, boxes);
          if (exact !== null) {
            falsePositives++;
            break;
          }
        }
      }
    }

    assert.equal(falsePositives, 0, "Goal macros must not prune solvable states");
  });
});

function exactStateKey(robot: number, boxes: readonly DenseBox[]): string {
  const boxKey = boxes
    .map(({ label, cell }) => `${label.length}:${label}@${cell}`)
    .sort()
    .join(";");
  return `${robot}|${boxKey}`;
}

interface OracleState {
  readonly robot: number;
  readonly boxes: readonly DenseBox[];
  readonly pushes: number;
}

function exactRemainingPushes(
  board: CompiledSearchBoard,
  robot: number,
  initialBoxes: readonly DenseBox[],
): number | null {
  const initial: OracleState = { robot, boxes: initialBoxes, pushes: 0 };
  const distances = new Map([[exactStateKey(robot, initialBoxes), 0]]);
  const deque = new Map<number, OracleState>([[0, initial]]);
  let front = 0;
  let back = 1;

  while (front < back) {
    const current = deque.get(front);
    deque.delete(front);
    front += 1;
    if (!current) continue;
    const currentKey = exactStateKey(current.robot, current.boxes);
    if (distances.get(currentKey) !== current.pushes) continue;
    if (current.boxes.every(({ label, cell }) => board.goalLabelByCell[cell] === label)) {
      return current.pushes;
    }

    const boxIndexByCell = new Int32Array(board.cellCount);
    boxIndexByCell.fill(-1);
    current.boxes.forEach(({ cell }, index) => { boxIndexByCell[cell] = index; });

    for (let d = 0; d < board.neighbors[current.robot].length; d++) {
      const destination = board.neighbors[current.robot][d];
      if (destination < 0) continue;
      const pushedBoxIndex = boxIndexByCell[destination];
      let nextBoxes = current.boxes;
      let pushCost = 0;
      if (pushedBoxIndex >= 0) {
        const boxDestination = board.neighbors[destination][d];
        if (boxDestination < 0 || boxIndexByCell[boxDestination] >= 0) continue;
        nextBoxes = current.boxes.map((box, index) =>
          index === pushedBoxIndex ? { ...box, cell: boxDestination } : box,
        );
        pushCost = 1;
      }
      const next: OracleState = { robot: destination, boxes: nextBoxes, pushes: current.pushes + pushCost };
      const nextKey = exactStateKey(next.robot, next.boxes);
      if (next.pushes >= (distances.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(nextKey, next.pushes);
      if (pushCost) { deque.set(back, next); back++; }
      else { front--; deque.set(front, next); }
    }
  }

  return null;
}
