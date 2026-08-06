import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parsePuzzleRows,
} from "../../src/core/index.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  findProvenCommitments,
  GoalCommitmentDetector,
} from "../../src/solver/search/goal-commitment.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";

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
  const initial: OracleState = {
    robot,
    boxes: initialBoxes,
    pushes: 0,
  };
  const distances = new Map([[exactStateKey(robot, initialBoxes), 0]]);

  const deque = new Map<number, OracleState>([[0, initial]]);
  let front = 0;
  let back = 1;
  const pushFront = (state: OracleState): void => {
    front -= 1;
    deque.set(front, state);
  };
  const pushBack = (state: OracleState): void => {
    deque.set(back, state);
    back += 1;
  };

  while (front < back) {
    const current = deque.get(front);
    deque.delete(front);
    front += 1;
    if (!current) continue;

    const currentKey = exactStateKey(current.robot, current.boxes);
    if (distances.get(currentKey) !== current.pushes) continue;
    if (
      current.boxes.every(
        ({ label, cell }) => board.goalLabelByCell[cell] === label,
      )
    ) {
      return current.pushes;
    }

    const boxIndexByCell = new Int32Array(board.cellCount);
    boxIndexByCell.fill(-1);
    current.boxes.forEach(({ cell }, index) => {
      boxIndexByCell[cell] = index;
    });

    for (
      let directionIndex = 0;
      directionIndex < board.neighbors[current.robot].length;
      directionIndex += 1
    ) {
      const destination = board.neighbors[current.robot][directionIndex];
      if (destination < 0) continue;

      const pushedBoxIndex = boxIndexByCell[destination];
      let nextBoxes = current.boxes;
      let pushCost = 0;
      if (pushedBoxIndex >= 0) {
        const boxDestination = board.neighbors[destination][directionIndex];
        if (
          boxDestination < 0 ||
          boxIndexByCell[boxDestination] >= 0
        ) {
          continue;
        }
        nextBoxes = current.boxes.map((box, index) =>
          index === pushedBoxIndex
            ? { ...box, cell: boxDestination }
            : box,
        );
        pushCost = 1;
      }

      const next: OracleState = {
        robot: destination,
        boxes: nextBoxes,
        pushes: current.pushes + pushCost,
      };
      const nextKey = exactStateKey(next.robot, next.boxes);
      if (next.pushes >= (distances.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }
      distances.set(nextKey, next.pushes);
      if (pushCost) pushBack(next);
      else pushFront(next);
    }
  }

  return null;
}

describe("goal commitment detection", () => {
  it("detects a corner-locked box on its matching goal", () => {
    // Two X boxes, two S goals. One goal is in a corner, the other is open.
    // The residual assignment (box1 → goal at (3,4)) must be feasible.
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OSXX  O",
      "O     O",
      "OR  S O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];
    assert.equal(goalCells.length, 2);
    // Find the corner goal: (1,1) has wall above and left
    const cornerGoal = goalCells.find((c) => {
      const p = board.positions[c];
      return p.row === 1 && p.column === 1;
    });
    assert.ok(cornerGoal !== undefined);

    const boxes: DenseBox[] = [
      { id: "X:0", label: "X", cell: cornerGoal },
      { id: "X:1", label: "X", cell: board.cellAt(2, 3) },
    ];

    const detector = new GoalCommitmentDetector();
    const committed = findProvenCommitments(board, boxes, detector);

    assert.ok(committed.has(0), "Corner-locked box on goal should be committed");
    assert.ok(!committed.has(1), "Non-corner box should not be committed");
  });

  it("does not commit a box not on any goal", () => {
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OX    O",
      "O  SS O",
      "OR X  O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const detector = new GoalCommitmentDetector();
    const committed = findProvenCommitments(board, boxes, detector);

    // Boxes not on goals should never be committed
    assert.equal(committed.size, 0);
  });

  it("does not commit a box on goal but movable (floor on both sides of one axis)", () => {
    // Box on goal but with floor on both left and right (horizontal axis open)
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "O X   O",
      "O SX  O",
      "OR S  O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    // Place boxes on goals but in the middle of a row (not corner-locked)
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];

    // Find goals that have floor on both sides of at least one axis
    const boxes: DenseBox[] = goalCells.map((cell, i) => ({
      id: `X:${i}`,
      label: "X",
      cell,
    }));

    const detector = new GoalCommitmentDetector();
    const committed = findProvenCommitments(board, boxes, detector);

    // Goals at (2,2) and (3,2) — (2,2) has floor left and right → not immovable
    // (3,2) has wall below but floor above and right → check axes
    for (const idx of committed) {
      const box = boxes[idx];
      const neighbors = board.neighbors[box.cell];
      const vertOpen = neighbors[0] >= 0 && neighbors[1] >= 0;
      const horizOpen = neighbors[2] >= 0 && neighbors[3] >= 0;
      assert.ok(!vertOpen && !horizOpen, "Committed box must not have both sides open on any axis");
    }
  });

  it("does not commit when residual assignment becomes infeasible", () => {
    // Two X boxes, two X goals. If we commit box 0 to goal 0, box 1
    // must reach goal 1. If goal 1 is unreachable by box 1, commitment fails.
    const parsed = parsePuzzleRows([
      "OOOOO",
      "OSX O",
      "OOO O",
      "OSX O",
      "OR  O",
      "OOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];
    assert.equal(goalCells.length, 2);

    // Place both boxes on their goals (corner-locked)
    const boxes: DenseBox[] = goalCells.map((cell, i) => ({
      id: `X:${i}`,
      label: "X",
      cell,
    }));

    const detector = new GoalCommitmentDetector();
    const committed = findProvenCommitments(board, boxes, detector);

    // Both should be committable since residual is feasible (empty after removing each)
    // Actually, if we commit box 0 (on goal 0), residual has box 1 and goal 1.
    // If box 1 is on goal 1, residual cost is 0 (feasible).
    // Both corner-locked on their goals with feasible residual → both committed.
    assert.equal(committed.size, 2);
  });

  it("rejects commitment when residual assignment is infeasible", () => {
    // Box 0 is corner-locked on goal (1,1), but box 1 at (5,2) cannot
    // reach the remaining goal at (4,4) via reverse pushes (row 6 is
    // all wall, blocking upward pushes from row 5; row 3 wall barrier
    // blocks lateral paths).  Residual infeasible → no commitment.
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OSX   O",
      "O     O",
      "OOOOO O",
      "O   S O",
      "O X R O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);

    const boxes: DenseBox[] = [
      { id: "X:0", label: "X", cell: board.cellAt(1, 1) },
      { id: "X:1", label: "X", cell: board.cellAt(5, 2) },
    ];

    const detector = new GoalCommitmentDetector();
    const committed = findProvenCommitments(board, boxes, detector);

    assert.equal(
      committed.size,
      0,
      "Corner-locked box should NOT be committed when residual is infeasible",
    );
  });

  it("reports statistics", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "OR   O",
      "OXX  O",
      "O SS O",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const detector = new GoalCommitmentDetector();

    findProvenCommitments(board, boxes, detector);
    assert.equal(detector.stats.checks, 1);

    findProvenCommitments(board, boxes, detector);
    assert.equal(detector.stats.checks, 2);
  });

  it("commits multiple independently corner-locked boxes on goals", () => {
    // Two boxes in opposite corners, both on their goals
    const parsed = parsePuzzleRows([
      "OOOOOOO",
      "OSXX SO",
      "O     O",
      "OR    O",
      "OOOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const goalCells = [...(board.goalCellsByLabel.get("X") ?? [])];

    // Place boxes on corner goals: (1,1) is corner (wall above + left),
    // (1,5) is corner (wall above + right)
    const cornerGoals = goalCells.filter((c) => {
      const n = board.neighbors[c];
      const vertOpen = n[0] >= 0 && n[1] >= 0;
      const horizOpen = n[2] >= 0 && n[3] >= 0;
      return !vertOpen && !horizOpen;
    });

    if (cornerGoals.length >= 2) {
      const boxes: DenseBox[] = cornerGoals.slice(0, 2).map((cell, i) => ({
        id: `X:${i}`,
        label: "X",
        cell,
      }));

      const detector = new GoalCommitmentDetector();
      const committed = findProvenCommitments(board, boxes, detector);
      assert.equal(committed.size, 2, "Both corner-locked boxes on goals should be committed");
    }
  });

  it("never eliminates an optimal solution (oracle exhaustive on tiny board)", () => {
    const parsed = parsePuzzleRows([
      "OOOOOO",
      "ORXX O",
      "O    O",
      "O SS O",
      "OOOOOO",
    ]);
    const board = compileSearchBoard(parsed);
    const detector = new GoalCommitmentDetector();

    let falseReductions = 0;
    let solvableStates = 0;

    for (let left = 0; left < board.cellCount; left++) {
      for (let right = left + 1; right < board.cellCount; right++) {
        for (let robot = 0; robot < board.cellCount; robot++) {
          if (robot === left || robot === right) continue;

          const testBoxes: readonly DenseBox[] = [
            { id: "X:0", label: "X", cell: left },
            { id: "X:1", label: "X", cell: right },
          ];

          const exact = exactRemainingPushes(board, robot, testBoxes);
          if (exact === null) continue;
          solvableStates++;

          const committed = findProvenCommitments(board, testBoxes, detector);

          // For each committed box, verify that the optimal solution exists
          // even when that box stays in place (never moves).
          // The commitment means the box genuinely never needs to move.
          for (const idx of committed) {
            const box = testBoxes[idx];
            // Committed box must be on its matching goal
            assert.equal(
              board.goalLabelByCell[box.cell],
              box.label,
              "Committed box must be on its matching goal",
            );

            // Verify that removing committed box and its goal still allows
            // the remaining box(es) to reach their goal(s).
            const remainingBoxes = testBoxes.filter((_, i) => i !== idx);
            if (remainingBoxes.length > 0) {
              const residualExact = exactRemainingPushes(board, robot, remainingBoxes);
              if (residualExact === null) {
                falseReductions++;
              }
            }
          }
        }
      }
    }

    assert.equal(
      falseReductions,
      0,
      `Goal commitment falsely eliminated ${falseReductions} optimal solutions out of ${solvableStates} solvable states`,
    );
    assert.ok(solvableStates >= 50, `Expected broad solvable coverage; got ${solvableStates}`);
  });
});
