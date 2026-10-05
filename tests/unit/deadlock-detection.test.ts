import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createsFullyBlockedTwoByTwoDeadlock,
  hasFreezeDeadlock,
} from "../../src/solver/search/deadlocks.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import { parsePuzzleRows } from "../../src/core/puzzle.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { toDenseBoxes, type DenseBox } from "../../src/solver/search/model.ts";
import {
  allReachableStateCosts,
  exactRemainingMoves,
} from "../support/exact-solver-oracle.ts";

function makeOccupancy(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
): Int32Array {
  const occ = new Int32Array(board.cellCount);
  occ.fill(-1);
  boxes.forEach((box, i) => {
    occ[box.cell] = i;
  });
  return occ;
}

function compile(rows: readonly string[]): CompiledSearchBoard {
  return compileSearchBoard(parsePuzzleRows(rows));
}

function boxAt(
  board: CompiledSearchBoard,
  row: number,
  column: number,
  label: string,
  id?: string,
): DenseBox {
  const cell = board.cellAt(row, column);
  if (cell < 0) {
    throw new Error(
      `No floor cell at (${row}, ${column}) — check your board layout.`,
    );
  }
  return { id: id ?? `${label}:0`, label, cell };
}

describe("hasFreezeDeadlock", () => {
  it("returns false when boxes can move (no deadlock)", () => {
    // Box in the middle of an open room — free on both axes.
    // Layout includes X and S so parsePuzzleRows is happy.
    const board = compile([
      "OOOOO",
      "O   O",
      "O X O",
      "O  SO",
      "OR  O",
      "OOOOO",
    ]);
    // Use the box from the layout at (2,2)
    const boxes: DenseBox[] = [boxAt(board, 2, 2, "X")];
    const occ = makeOccupancy(board, boxes);
    assert.equal(
      hasFreezeDeadlock(board, boxes, occ),
      false,
      "box in middle of open room should not be frozen",
    );
  });

  it("detects freeze deadlock — box in a 1-cell pocket not on goal", () => {
    // Box at (2,2) is surrounded by walls on all 4 sides (1-cell pocket).
    // Goal is at (4,2), not at (2,2), so frozen box is off goal = deadlock.
    // The layout has X at (5,2) and S at (4,2) to satisfy validation.
    // We override box position to (2,2) in our DenseBox.
    const board = compile([
      "OOOOO",
      "OOOOO",
      "OO OO",
      "OOOOO",
      "OOSOO",
      "OOXOO",
      "OOROO",
      "OOOOO",
    ]);
    // Place box at (2,2) instead of its parsed position
    const boxes: DenseBox[] = [boxAt(board, 2, 2, "X")];
    const occ = makeOccupancy(board, boxes);
    assert.equal(
      hasFreezeDeadlock(board, boxes, occ),
      true,
      "box in 1-cell pocket away from goal is a freeze deadlock",
    );
  });

  it("returns false when frozen box is on its matching goal", () => {
    // Box at (2,2) is surrounded by walls (frozen), and the goal is also
    // at (2,2). Frozen on goal = no deadlock.
    // Layout: S at (2,2), X at (4,2) to satisfy validation.
    const board = compile([
      "OOOOO",
      "OOOOO",
      "OOSOO",
      "OOOOO",
      "OOXOO",
      "OO OO",
      "OOROO",
      "OOOOO",
    ]);
    // Place box at (2,2) which is the goal cell
    const boxes: DenseBox[] = [boxAt(board, 2, 2, "X")];
    const occ = makeOccupancy(board, boxes);
    assert.equal(
      hasFreezeDeadlock(board, boxes, occ),
      false,
      "frozen box on its matching goal should NOT be a deadlock",
    );
  });

  it("freezes a box on a wall row only when both of its neighbors there are dead", async () => {
    // The wall above blocks the vertical axis. With no goal on row 1, both
    // horizontal neighbors are dead cells, so every push of the box is useless.
    const goalless = compile([
      "OOOOOOO",
      "O X   O",
      "O    SO",
      "OR    O",
      "OOOOOOO",
    ]);
    const stuck = [boxAt(goalless, 1, 2, "X")];
    assert.equal(hasFreezeDeadlock(goalless, stuck, makeOccupancy(goalless, stuck)), true);

    // With a goal on row 1 the right neighbor is live: one dead side is not
    // enough, and the exact solver still finds the 4-move solution.
    const rows = [
      "OOOOOO",
      "O X SO",
      "O    O",
      "OR   O",
      "OOOOOO",
    ];
    const board = compile(rows);
    const free = [boxAt(board, 1, 2, "X")];
    const occ = makeOccupancy(board, free);
    assert.equal(hasFreezeDeadlock(board, free, occ), false);
    assert.equal(hasFreezeDeadlock(board, free, occ, free[0].cell), false);
    const parsed = parsePuzzleRows(rows);
    const result = await runExactMoveAStar({
      board: parsed,
      snapshot: {
        puzzleId: "freeze-one-dead-side",
        robot: parsed.initialRobot,
        boxes: parsed.initialBoxes,
        moves: 0,
        pushes: 0,
        solved: false,
      },
      objective: { kind: "moves" },
    }, {
      signal: new AbortController().signal,
      reportProgress: () => undefined,
      now: () => performance.now(),
    });
    assert.equal(result.status, "solved");
    assert.equal(result.solution?.moves, 4);
    assert.equal(result.solution?.optimality, "proven");
  });

  it("returns false with no boxes", () => {
    // Board with no boxes or goals — trivially no deadlock.
    const board = compile([
      "OOOOO",
      "OR  O",
      "OOOOO",
    ]);
    const boxes: DenseBox[] = [];
    const occ = makeOccupancy(board, boxes);
    assert.equal(
      hasFreezeDeadlock(board, boxes, occ),
      false,
      "no boxes means no freeze deadlock",
    );
  });

  it("detects deadlock when one of multiple boxes is frozen off goal", () => {
    // Two boxes: one trapped in a 1-cell pocket (frozen, not on goal),
    // one free in an open room. The frozen box makes the state a deadlock.
    // Layout has XX and SS to satisfy validation.
    const board = compile([
      "OOOOOOOOO",
      "OOOOO   O",
      "OO OO   O",
      "OOOOO   O",
      "O  SS   O",
      "ORX X   O",
      "OOOOOOOOO",
    ]);
    const boxA: DenseBox = boxAt(board, 2, 2, "X", "X:0"); // pocket (frozen)
    const boxB: DenseBox = boxAt(board, 1, 6, "X", "X:1"); // open room (free)
    const boxes = [boxA, boxB];
    const occ = makeOccupancy(board, boxes);
    assert.equal(
      hasFreezeDeadlock(board, boxes, occ),
      true,
      "one frozen box not on goal makes the whole state a deadlock",
    );
  });

  it("treats a wall on one side as blocking the axis", () => {
    // Walls left, right and above; floor below. The robot cannot stand on the
    // wall above to push the box down, so the box can never move.
    const board = compile([
      "OOOOO",
      "OOOOO",
      "OO OO",
      "OO OO",
      "OOSOO",
      "OOXOO",
      "OOROO",
      "OOOOO",
    ]);
    const boxes: DenseBox[] = [boxAt(board, 2, 2, "X")];
    assert.equal(hasFreezeDeadlock(board, boxes, makeOccupancy(board, boxes)), true);
  });

  it("detects freeze with dedicated labels — frozen box has wrong label for goal", () => {
    // Box labeled 'A' placed in a 1-cell pocket. Goal 'a' (for label A) is elsewhere.
    // The pocket has no goal → frozen box not on its goal → deadlock.
    // Layout: A at (5,2), a at (4,2) to satisfy validation.
    const board = compile([
      "OOOOO",
      "OOOOO",
      "OO OO",
      "OOOOO",
      "OOaOO",
      "OOAOO",
      "OOROO",
      "OOOOO",
    ]);
    // Place box A at (2,2) in the pocket instead of its parsed (5,2) position
    const boxes: DenseBox[] = [boxAt(board, 2, 2, "A", "A:0")];
    const occ = makeOccupancy(board, boxes);
    assert.equal(
      hasFreezeDeadlock(board, boxes, occ),
      true,
      "frozen box with wrong label for cell goal is a deadlock",
    );
  });

  it("releases a box once the neighbor that blocked it is released", () => {
    // Box 0 has a wall above, and box 1 blocks its horizontal axis until box 1
    // leaves the set: box 1's vertical axis has a live goal cell below it.
    const board = compile([
      "OOOOOOO",
      "OOOO  O",
      "O  XX O",
      "O  SS O",
      "O  R  O",
      "OOOOOOO",
    ]);
    const boxes = [boxAt(board, 2, 3, "X", "X:0"), boxAt(board, 2, 4, "X", "X:1")];
    const occ = makeOccupancy(board, boxes);
    assert.equal(hasFreezeDeadlock(board, boxes, occ), false);
    assert.equal(hasFreezeDeadlock(board, boxes, occ, boxes[0].cell), false);
  });

  it("freezes a box held only by a box frozen on its goal", () => {
    // The X box on S sits in a corner. The box below it has a wall on its
    // right and that box above it, so neither can ever move. No 2x2 square is
    // fully blocked, and the box's own cell is not a dead cell.
    const board = compile([
      "OOOOOO",
      "OOS  O",
      "O XO O",
      "O  X O",
      "OR  SO",
      "OOOOOO",
    ]);
    const boxes = [boxAt(board, 1, 2, "X", "X:0"), boxAt(board, 2, 2, "X", "X:1")];
    const occ = makeOccupancy(board, boxes);
    assert.equal(createsFullyBlockedTwoByTwoDeadlock(board, boxes), false);
    assert.equal(hasFreezeDeadlock(board, boxes, occ), true);
    assert.equal(hasFreezeDeadlock(board, boxes, occ, boxes[1].cell), true);
    assert.equal(exactRemainingMoves(board, board.cellAt(4, 1), boxes).exactMoves, null);
  });

  it("allows a frozen pair only when both boxes are on their own goals", () => {
    const xBoard = compile([
      "OOOOOOOO",
      "O XX SSO",
      "O      O",
      "O R    O",
      "OOOOOOOO",
    ]);
    const typedBoard = compile([
      "OOOOOO",
      "Oab  O",
      "O    O",
      "O AB O",
      "OR   O",
      "OOOOOO",
    ]);
    const cases = [
      [xBoard, [boxAt(xBoard, 1, 2, "X", "X:0"), boxAt(xBoard, 1, 3, "X", "X:1")], true],
      [xBoard, [boxAt(xBoard, 1, 5, "X", "X:0"), boxAt(xBoard, 1, 6, "X", "X:1")], false],
      // A on b's goal and B on a's goal, then each on its own.
      [typedBoard, [boxAt(typedBoard, 1, 2, "A"), boxAt(typedBoard, 1, 1, "B")], true],
      [typedBoard, [boxAt(typedBoard, 1, 1, "A"), boxAt(typedBoard, 1, 2, "B")], false],
    ] as const;
    for (const [board, boxes, dead] of cases) {
      const occ = makeOccupancy(board, boxes);
      assert.equal(hasFreezeDeadlock(board, boxes, occ), dead);
      assert.equal(hasFreezeDeadlock(board, boxes, occ, boxes[0].cell), dead);
    }
  });

  it("checks that the boxes left over can still reach the goals left over", () => {
    // B in the corner holds the first A on goal a, frozen there. The second A
    // is on row 1 and can only ever reach that goal, not the one on row 3.
    const board = compile([
      "OOOOOOO",
      "Oba   O",
      "O AAB O",
      "O  a  O",
      "OR    O",
      "OOOOOOO",
    ]);
    const boxes = [
      boxAt(board, 1, 1, "B", "B:0"),
      boxAt(board, 1, 2, "A", "A:0"),
      boxAt(board, 1, 4, "A", "A:1"),
    ];
    const occ = makeOccupancy(board, boxes);
    assert.equal(hasFreezeDeadlock(board, boxes, occ), true);
    assert.equal(hasFreezeDeadlock(board, boxes, occ, boxes[1].cell), true);
    assert.equal(exactRemainingMoves(board, board.cellAt(4, 1), boxes).exactMoves, null);
  });

  it("only flags unsolvable states on exhaustive small boards", () => {
    const boards = [
      ["OOOOOOO", "OS   SO", "O XX  O", "O  O  O", "OR    O", "OOOOOOO"],
      ["OOOOOOO", "Oa   bO", "O AB  O", "O  O  O", "OR    O", "OOOOOOO"],
      ["OOOOOOO", "OS   aO", "O XA  O", "O  O  O", "OR    O", "OOOOOOO"],
      ["OOOOOO", "Oa  bO", "O AABO", "O  a O", "OR   O", "OOOOOO"],
    ];
    for (const rows of boards) {
      const parsed = parsePuzzleRows(rows);
      const board = compileSearchBoard(parsed);
      const robot = board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column);
      let flagged = 0;
      for (const state of allReachableStateCosts(board, robot, toDenseBoxes(board, parsed.initialBoxes)).values()) {
        const occ = makeOccupancy(board, state.boxes);
        const dead = hasFreezeDeadlock(board, state.boxes, occ) ||
          state.boxes.some((box) => hasFreezeDeadlock(board, state.boxes, occ, box.cell));
        if (!dead) continue;
        flagged += 1;
        assert.equal(state.exactMoves, null, `${rows.join("/")}: ${JSON.stringify(state.boxes)}`);
      }
      assert.ok(flagged > 0, rows.join("/"));
    }
  });
});

describe("createsFullyBlockedTwoByTwoDeadlock", () => {
  it("agrees with the full-board scan for every moved box against a wall", () => {
    const offGoal = compile([
      "OOOOOO",
      "OXX  O",
      "O  SSO",
      "OR   O",
      "OOOOOO",
    ]);
    const onGoal = compile([
      "OOOOOO",
      "OSS  O",
      "O XX O",
      "OR   O",
      "OOOOOO",
    ]);
    for (const [board, dead] of [[offGoal, true], [onGoal, false]] as const) {
      // Both boxes on row 1, under the top wall: walls fill the square's top half.
      const boxes = [boxAt(board, 1, 1, "X", "X:0"), boxAt(board, 1, 2, "X", "X:1")];
      const occ = makeOccupancy(board, boxes);
      assert.equal(createsFullyBlockedTwoByTwoDeadlock(board, boxes), dead);
      for (const box of boxes) {
        assert.equal(createsFullyBlockedTwoByTwoDeadlock(board, boxes, box.cell, occ), dead);
      }
    }
  });
});
