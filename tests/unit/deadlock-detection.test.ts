import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasFreezeDeadlock } from "../../src/solver/search/deadlocks.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import { parsePuzzleRows } from "../../src/core/puzzle.ts";
import type { DenseBox } from "../../src/solver/search/model.ts";

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

  it("returns false for box against one wall with a free axis", () => {
    // Box against the top wall — only stuck in one direction on vertical axis.
    // Horizontal axis fully free. Not frozen.
    const board = compile([
      "OOOOOOO",
      "O X   O",
      "O    SO",
      "OR    O",
      "OOOOOOO",
    ]);
    const boxes: DenseBox[] = [boxAt(board, 1, 2, "X")];
    const occ = makeOccupancy(board, boxes);
    assert.equal(
      hasFreezeDeadlock(board, boxes, occ),
      false,
      "box against one wall with free horizontal axis should not be frozen",
    );
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

  it("returns false when box is in corridor with one open end", () => {
    // Box in a 1-wide corridor: walls left, right, and above, but floor below.
    // Stuck horizontally but not vertically — not frozen.
    // Layout: X at (5,2), S at (4,2) to satisfy validation.
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
    // Place box at (2,2): up=wall(1,2), down=(3,2)=floor, left=wall, right=wall
    // horizontal stuck, vertical NOT stuck → not frozen
    const boxes: DenseBox[] = [boxAt(board, 2, 2, "X")];
    const occ = makeOccupancy(board, boxes);
    assert.equal(
      hasFreezeDeadlock(board, boxes, occ),
      false,
      "box in corridor with one open direction should not be frozen",
    );
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
});
