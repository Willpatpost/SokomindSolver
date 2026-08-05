import assert from "node:assert/strict";
import test from "node:test";

import {
  PuzzleValidationError,
  createSession,
  isSolved,
  move,
  parsePuzzle,
  parsePuzzleRows,
  reset,
  sessionReducer,
  undo,
  validatePuzzle,
  validatePuzzleRows,
  type PuzzleDefinition,
} from "../../src/core/index.ts";

function puzzle(
  rows: readonly string[],
  boxes = 1,
): PuzzleDefinition {
  return {
    id: "test-puzzle",
    title: "Test Puzzle",
    difficulty: "tutorial",
    boxes,
    rows,
  };
}

test("parses generic and dedicated pieces into JSON-safe board data", () => {
  const board = parsePuzzle(
    puzzle([
      "OOOOOOO",
      "OR X  O",
      "O A S O",
      "O a   O",
      "OOOOOOO",
    ], 2),
  );

  assert.equal(board.width, 7);
  assert.equal(board.height, 5);
  assert.deepEqual(board.initialRobot, { row: 1, column: 1 });
  assert.deepEqual(
    board.initialBoxes.map(({ id, label, position }) => ({ id, label, position })),
    [
      { id: "X:0", label: "X", position: { row: 1, column: 3 } },
      { id: "A:0", label: "A", position: { row: 2, column: 2 } },
    ],
  );
  assert.deepEqual(
    board.goals.map(({ label, position }) => ({ label, position })),
    [
      { label: "X", position: { row: 2, column: 4 } },
      { label: "A", position: { row: 3, column: 2 } },
    ],
  );
  assert.doesNotThrow(() => JSON.stringify(board));
  assert.ok(Object.isFrozen(board));
  assert.ok(Object.isFrozen(board.initialBoxes));
});

test("normalizes missing ragged cells to walls", () => {
  const board = parsePuzzleRows([
    "OOOOO",
    "OR  O",
    "OOOO",
    "OaA O",
    "OOOOO",
  ]);

  assert.equal(board.width, 5);
  assert.equal(board.rows[2], "OOOOO");
  assert.deepEqual(board.walls.at(-1), { row: 4, column: 4 });
  assert.ok(
    board.walls.some(({ row, column }) => row === 2 && column === 4),
  );
});

test("reports unsupported symbols, robot errors, and per-label mismatches", () => {
  const unsupported = validatePuzzleRows(["OOO", "OR?", "OOO"]);
  assert.equal(unsupported.valid, false);
  assert.deepEqual(
    unsupported.errors.map(({ code }) => code),
    ["unsupported-symbol"],
  );
  assert.deepEqual(
    {
      row: unsupported.errors[0]?.row,
      column: unsupported.errors[0]?.column,
    },
    { row: 1, column: 2 },
  );

  const invalid = validatePuzzle(
    puzzle([
      "OOOOO",
      "ORR O",
      "O A O",
      "O b O",
      "OOOOO",
    ]),
  );
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(({ code }) => code === "robot-count"));
  assert.equal(
    invalid.errors.filter(({ code }) => code === "box-goal-mismatch").length,
    2,
  );
  assert.throws(() => parsePuzzle(puzzle(["OOO", "O O", "OOO"], 0)), {
    name: "PuzzleValidationError",
  });
});

test("rejects lowercase x instead of treating it as a generic goal", () => {
  const result = validatePuzzleRows(["OOOOO", "ORXxO", "OOOOO"]);

  assert.equal(result.valid, false);
  assert.equal(result.errors[0]?.code, "unsupported-symbol");
  assert.deepEqual(
    {
      row: result.errors[0]?.row,
      column: result.errors[0]?.column,
    },
    { row: 1, column: 3 },
  );
});

test("preserves collection metadata in a game session", () => {
  const session = createSession({
    ...puzzle(["OOOOO", "ORXSO", "OOOOO"]),
    collection: "Sokomind Generated",
  });

  assert.equal(session.puzzle.collection, "Sokomind Generated");
});

test("validates puzzle metadata and declared box count", () => {
  const result = validatePuzzle({
    id: "",
    title: "Metadata",
    difficulty: "impossible",
    boxes: 2,
    rows: ["OOOOO", "ORXSO", "OOOOO"],
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === "invalid-metadata"));
  assert.ok(
    result.errors.some(({ code }) => code === "box-metadata-mismatch"),
  );
});

test("walks without mutating the prior session", () => {
  const initial = createSession(
    puzzle([
      "OOOOOO",
      "OR   O",
      "O X SO",
      "OOOOOO",
    ]),
  );
  const next = move(initial, "right");

  assert.notEqual(next, initial);
  assert.deepEqual(initial.snapshot.robot, { row: 1, column: 1 });
  assert.deepEqual(next.snapshot.robot, { row: 1, column: 2 });
  assert.equal(initial.moves, 0);
  assert.equal(next.moves, 1);
  assert.equal(next.pushes, 0);
  assert.equal(next.history.length, 1);
  assert.equal(next.history.head?.snapshot, initial.snapshot);
  assert.equal(next.history.head?.previous, null);
  assert.equal(next.actionLog, "R");
  assert.ok(Object.isFrozen(next));
  assert.ok(Object.isFrozen(next.snapshot));
  assert.ok(Object.isFrozen(next.history));
  assert.ok(Object.isFrozen(next.history.head));
});

test("pushes a box, counts the move and push, and detects completion", () => {
  const initial = createSession(
    puzzle([
      "OOOOO",
      "ORXSO",
      "OOOOO",
    ]),
  );
  const solved = move(initial, "right");

  assert.deepEqual(solved.snapshot.robot, { row: 1, column: 2 });
  assert.deepEqual(solved.snapshot.boxes[0]?.position, { row: 1, column: 3 });
  assert.equal(solved.moves, 1);
  assert.equal(solved.pushes, 1);
  assert.equal(solved.solved, true);
  assert.equal(isSolved(solved.snapshot), true);
  assert.equal(initial.solved, false);
});

test("treats walls and impossible pushes as identity-preserving blocked moves", () => {
  const wallBlocked = createSession(
    puzzle([
      "OOOOO",
      "OR  O",
      "OX SO",
      "OOOOO",
    ]),
  );
  assert.equal(move(wallBlocked, "up"), wallBlocked);
  assert.equal(move(wallBlocked, "left"), wallBlocked);

  const boxBlocked = createSession(
    puzzle([
      "OOOOOO",
      "ORXXSO",
      "O  S O",
      "OOOOOO",
    ], 2),
  );
  assert.equal(move(boxBlocked, "right"), boxBlocked);
  assert.equal(boxBlocked.moves, 0);
  assert.equal(boxBlocked.pushes, 0);
  assert.equal(boxBlocked.history.length, 0);
});

test("undo and reset restore snapshots and counters immutably", () => {
  const initial = createSession(
    puzzle([
      "OOOOOO",
      "OR XSO",
      "OOOOOO",
    ]),
  );
  const walked = move(initial, "right");
  const pushed = move(walked, "right");
  const undone = undo(pushed);

  assert.deepEqual(undone.snapshot, walked.snapshot);
  assert.equal(undone.moves, 1);
  assert.equal(undone.pushes, 0);
  assert.equal(undone.history.length, 1);
  assert.equal(undone.history.head, walked.history.head);
  assert.equal(undone.actionLog, "R");
  assert.equal(undo(initial), initial);

  const restarted = reset(pushed);
  assert.deepEqual(restarted.snapshot.robot, initial.snapshot.robot);
  assert.deepEqual(restarted.snapshot.boxes, initial.snapshot.boxes);
  assert.equal(restarted.moves, 0);
  assert.equal(restarted.pushes, 0);
  assert.equal(restarted.solved, false);
  assert.equal(restarted.history.length, 0);
  assert.equal(restarted.actionLog, "");
  assert.notEqual(restarted, pushed);
});

test("session reducer delegates all supported actions", () => {
  const initial = createSession(
    puzzle([
      "OOOOO",
      "ORXSO",
      "OOOOO",
    ]),
  );
  const solved = sessionReducer(initial, { type: "move", direction: "right" });
  const undone = sessionReducer(solved, { type: "undo" });
  const restarted = sessionReducer(solved, { type: "reset" });

  assert.equal(solved.solved, true);
  assert.deepEqual(undone.snapshot, initial.snapshot);
  assert.deepEqual(restarted.snapshot, initial.snapshot);
});

test("snapshots round-trip through JSON without Maps, Sets, or class state", () => {
  const session = move(
    createSession(puzzle(["OOOOO", "ORXSO", "OOOOO"])),
    "right",
  );
  const snapshot = JSON.parse(JSON.stringify(session.snapshot));

  assert.deepEqual(snapshot, session.snapshot);
  assert.deepEqual(snapshot.boxes[0], {
    id: "X:0",
    label: "X",
    position: { row: 1, column: 3 },
  });
});

test("parse errors expose structured validation issues", () => {
  assert.throws(
    () => parsePuzzleRows(["OOOO", "OR?O", "OOOO"]),
    (error) => {
      assert.ok(error instanceof PuzzleValidationError);
      assert.equal(error.issues[0]?.code, "unsupported-symbol");
      return true;
    },
  );
});
