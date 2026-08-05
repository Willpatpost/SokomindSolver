import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSession,
  move,
} from "../../src/core/index.ts";
import {
  detectDeadlock,
  findPushedBox,
} from "../../src/solver/deadlock-bridge.ts";
import type { Box, PuzzleDefinition } from "../../src/core/model.ts";

function puzzle(rows: readonly string[]): PuzzleDefinition {
  let boxCount = 0;
  for (const row of rows) {
    for (const ch of row) {
      if (ch === "X") boxCount++;
      if (/^[A-Z]$/.test(ch) && !"ORSX".includes(ch)) boxCount++;
    }
  }
  return {
    id: "test",
    title: "Test",
    difficulty: "tutorial",
    boxes: boxCount,
    rows,
  };
}

describe("deadlock bridge", () => {
  it("detects box pushed into a corner", () => {
    // Layout: robot pushes box into a corner (1,1) which has walls above and left
    // R=robot, X=generic box, S=generic goal
    const def = puzzle([
      "OOOOOO",
      "O    O",
      "O X  O",
      "OR  SO",
      "O    O",
      "OOOOOO",
    ]);
    const session = createSession(def);
    // Robot at (3,1), box at (2,2), goal at (3,4)
    // Step 1: move right to (3,2)
    const s1 = move(session, "right");
    // Step 2: move up to push box from (2,2) to (1,2)
    const s2 = move(s1, "up");
    assert.notEqual(s2, s1, "push up should succeed");
    // Step 3: move right to (2,3)
    const s3 = move(s2, "right");
    // Step 4: move up to (1,3)
    const s4 = move(s3, "up");
    // Step 5: move left — push box from (1,2) to (1,1) — corner!
    const s5 = move(s4, "left");
    assert.notEqual(s5, s4, "push left into corner should succeed");

    const pushedBox = findPushedBox(s4.snapshot.boxes, s5.snapshot.boxes);
    assert.ok(pushedBox, "should find pushed box");

    const result = detectDeadlock(s5.board, s5.snapshot, pushedBox.id);
    assert.equal(result.isDeadlocked, true, "box in corner should be deadlocked");
    assert.ok(result.deadlockedBoxIds.length > 0);
  });

  it("does not flag a box pushed toward its goal", () => {
    // Robot above box, goal below — push box straight down toward goal
    const def = puzzle([
      "OOOOO",
      "O R O",
      "O X O",
      "O   O",
      "O S O",
      "OOOOO",
    ]);
    const session = createSession(def);
    // Robot at (1,2), box at (2,2), goal at (4,2)
    // Push box down: robot goes (1,2)->(2,2), box goes (2,2)->(3,2)
    const s1 = move(session, "down");
    assert.notEqual(s1, session, "push down should succeed");

    const pushedBox = findPushedBox(session.snapshot.boxes, s1.snapshot.boxes);
    assert.ok(pushedBox);

    const result = detectDeadlock(s1.board, s1.snapshot, pushedBox.id);
    assert.equal(result.isDeadlocked, false, "box heading toward goal is not deadlocked");
  });

  it("does not flag a solved board", () => {
    const def = puzzle([
      "OOOOO",
      "ORXSO",
      "OOOOO",
    ]);
    const session = createSession(def);
    // Robot at (1,1), box at (1,2), goal at (1,3)
    const after = move(session, "right");
    assert.equal(after.solved, true);

    const result = detectDeadlock(after.board, after.snapshot);
    assert.equal(result.isDeadlocked, false);
  });

  it("findPushedBox identifies the moved box", () => {
    const def = puzzle([
      "OOOOO",
      "ORX O",
      "O  SO",
      "OOOOO",
    ]);
    const session = createSession(def);
    const after = move(session, "right");
    assert.notEqual(after, session);

    const pushed = findPushedBox(session.snapshot.boxes, after.snapshot.boxes);
    assert.ok(pushed);
    assert.equal(pushed.id, session.snapshot.boxes[0].id);
  });

  it("detects 2x2 freeze deadlock (boxes + wall row)", () => {
    // Two boxes side by side pushed up against the top wall row.
    // After both pushes the 2×2 square (row 0-1, col 2-3) is:
    //   wall  wall
    //   box   box   → fully blocked, neither box on goal → deadlock
    const def = puzzle([
      "OOOOOO",
      "O    O",
      "O XX O",
      "OR  SO",
      "O  S O",
      "OOOOOO",
    ]);
    const session = createSession(def);
    // Robot at (3,1), boxes at (2,2) and (2,3), goals at (3,4) and (4,3)

    // Step 1: move right → robot (3,1)→(3,2)
    const s1 = move(session, "right");
    assert.notEqual(s1, session);

    // Step 2: move up → push left box (2,2)→(1,2), robot→(2,2)
    const s2 = move(s1, "up");
    assert.notEqual(s2, s1);

    // Step 3: move down → robot (2,2)→(3,2)
    const s3 = move(s2, "down");
    assert.notEqual(s3, s2);

    // Step 4: move right → robot (3,2)→(3,3)
    const s4 = move(s3, "right");
    assert.notEqual(s4, s3);

    // Step 5: move up → push right box (2,3)→(1,3), robot→(2,3)
    // This creates the 2×2 freeze at rows 0-1, cols 2-3
    const s5 = move(s4, "up");
    assert.notEqual(s5, s4);

    const pushedBox = findPushedBox(s4.snapshot.boxes, s5.snapshot.boxes);
    assert.ok(pushedBox, "should find pushed box");

    const result = detectDeadlock(s5.board, s5.snapshot, pushedBox.id);
    assert.equal(result.isDeadlocked, true, "2×2 freeze should be deadlocked");
    assert.ok(result.deadlockedBoxIds.length > 0);
  });

  it("findPushedBox identifies pushed box by index comparison", () => {
    const boxA: Box = { id: "A:0", label: "A", position: { row: 1, column: 1 } };
    const boxB: Box = { id: "B:0", label: "B", position: { row: 2, column: 2 } };

    const previous = [boxA, boxB];
    const next = [{ ...boxA, position: { row: 1, column: 2 } }, boxB];

    const pushed = findPushedBox(previous, next);
    assert.equal(pushed?.id, "A:0");
  });

  it("does not flag box on a matching goal", () => {
    const def = puzzle([
      "OOOOO",
      "ORAaO",
      "OOOOO",
    ]);
    const session = createSession(def);
    // Robot at (1,1), box A at (1,2), goal a at (1,3)
    const after = move(session, "right");
    assert.equal(after.solved, true);
    const result = detectDeadlock(after.board, after.snapshot);
    assert.equal(result.isDeadlocked, false);
  });
});
