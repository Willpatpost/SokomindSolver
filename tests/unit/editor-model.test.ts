import assert from "node:assert/strict";
import test from "node:test";

import {
  TYPED_LABELS,
  MIN_SIZE,
  MAX_SIZE,
  createInitialState,
  editorReducer,
  stateToPuzzle,
  validateEditorState,
} from "../../src/features/editor/editor-model.ts";
import { validatePuzzle } from "../../src/core/puzzle.ts";

test("initial state creates a 7x7 grid of walls", () => {
  const state = createInitialState();
  assert.equal(state.width, 7);
  assert.equal(state.height, 7);
  assert.equal(state.cells.length, 7);
  assert.equal(state.cells[0].length, 7);
  assert.ok(state.cells.every((row) => row.every((cell) => cell === "O")));
});

test("set-cell places the selected tool", () => {
  let state = createInitialState();
  state = editorReducer(state, { type: "set-tool", tool: " " });
  state = editorReducer(state, { type: "set-cell", row: 1, column: 1 });
  assert.equal(state.cells[1][1], " ");
});

test("placing a robot removes existing robot", () => {
  let state = createInitialState();
  state = editorReducer(state, { type: "set-tool", tool: "R" });
  state = editorReducer(state, { type: "set-cell", row: 1, column: 1 });
  assert.equal(state.cells[1][1], "R");
  state = editorReducer(state, { type: "set-cell", row: 2, column: 2 });
  assert.equal(state.cells[2][2], "R");
  assert.equal(state.cells[1][1], " ");
});

test("resize preserves existing cells in bounds", () => {
  let state = createInitialState();
  state = editorReducer(state, { type: "set-tool", tool: " " });
  state = editorReducer(state, { type: "set-cell", row: 0, column: 0 });
  assert.equal(state.cells[0][0], " ");
  state = editorReducer(state, { type: "resize", width: 5, height: 5 });
  assert.equal(state.width, 5);
  assert.equal(state.height, 5);
  assert.equal(state.cells[0][0], " ");
});

test("resize fills new area with walls", () => {
  let state = createInitialState();
  state = editorReducer(state, { type: "resize", width: 9, height: 9 });
  assert.equal(state.cells[8][8], "O");
});

test("resize clamps to min/max", () => {
  let state = createInitialState();
  state = editorReducer(state, { type: "resize", width: 1, height: 1 });
  assert.equal(state.width, 3);
  assert.equal(state.height, 3);
  state = editorReducer(state, { type: "resize", width: 50, height: 50 });
  assert.equal(state.width, 20);
  assert.equal(state.height, 20);
});

test("clear fills all cells with walls", () => {
  let state = createInitialState();
  state = editorReducer(state, { type: "set-tool", tool: " " });
  state = editorReducer(state, { type: "set-cell", row: 1, column: 1 });
  state = editorReducer(state, { type: "clear" });
  assert.ok(state.cells.every((row) => row.every((cell) => cell === "O")));
});

test("validates missing robot and boxes", () => {
  const state = createInitialState();
  const result = validateEditorState(state);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("robot")));
  assert.ok(result.errors.some((e) => e.includes("box")));
});

test("validates generic box/goal mismatch", () => {
  let state = createInitialState();
  state = editorReducer(state, { type: "set-tool", tool: "R" });
  state = editorReducer(state, { type: "set-cell", row: 1, column: 1 });
  state = editorReducer(state, { type: "set-tool", tool: "X" });
  state = editorReducer(state, { type: "set-cell", row: 2, column: 2 });
  const result = validateEditorState(state);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("mismatch")));
});

test("valid puzzle passes validation", () => {
  let state = createInitialState();
  state = editorReducer(state, { type: "set-tool", tool: " " });
  state = editorReducer(state, { type: "set-cell", row: 1, column: 1 });
  state = editorReducer(state, { type: "set-cell", row: 1, column: 2 });
  state = editorReducer(state, { type: "set-cell", row: 1, column: 3 });
  state = editorReducer(state, { type: "set-cell", row: 2, column: 1 });
  state = editorReducer(state, { type: "set-cell", row: 2, column: 2 });
  state = editorReducer(state, { type: "set-cell", row: 2, column: 3 });
  state = editorReducer(state, { type: "set-tool", tool: "R" });
  state = editorReducer(state, { type: "set-cell", row: 1, column: 1 });
  state = editorReducer(state, { type: "set-tool", tool: "X" });
  state = editorReducer(state, { type: "set-cell", row: 1, column: 2 });
  state = editorReducer(state, { type: "set-tool", tool: "S" });
  state = editorReducer(state, { type: "set-cell", row: 1, column: 3 });
  const result = validateEditorState(state);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("offers every legal typed label and excludes reserved symbols", () => {
  assert.equal(TYPED_LABELS.length, 22);
  assert.equal(new Set(TYPED_LABELS).size, 22);
  assert.ok(TYPED_LABELS.includes("A"));
  assert.ok(TYPED_LABELS.includes("Z"));
  for (const reserved of ["O", "R", "S", "X"]) {
    assert.equal(
      (TYPED_LABELS as readonly string[]).includes(reserved),
      false,
    );
  }
});

test("supports a matching Z typed box and goal through core validation", () => {
  let state = createInitialState();
  state = editorReducer(state, {
    type: "load",
    puzzle: {
      id: "typed-z",
      title: "Typed Z",
      difficulty: "beginner",
      boxes: 1,
      rows: ["OOOOO", "O R O", "O Z O", "O z O", "OOOOO"],
    },
  });

  assert.deepEqual(validateEditorState(state), { valid: true, errors: [] });
  assert.equal(validatePuzzle(stateToPuzzle(state)).valid, true);
});

// ---------------------------------------------------------------------------
// Boundary conditions
// ---------------------------------------------------------------------------

test("MIN_SIZE is 3 and MAX_SIZE is 20", () => {
  assert.equal(MIN_SIZE, 3);
  assert.equal(MAX_SIZE, 20);
});

test("creating a board at exactly MIN_SIZE x MIN_SIZE", () => {
  let state = createInitialState();
  state = editorReducer(state, {
    type: "resize",
    width: MIN_SIZE,
    height: MIN_SIZE,
  });
  assert.equal(state.width, MIN_SIZE);
  assert.equal(state.height, MIN_SIZE);
  assert.equal(state.cells.length, MIN_SIZE);
  assert.equal(state.cells[0].length, MIN_SIZE);
});

test("creating a board at exactly MAX_SIZE x MAX_SIZE", () => {
  let state = createInitialState();
  state = editorReducer(state, {
    type: "resize",
    width: MAX_SIZE,
    height: MAX_SIZE,
  });
  assert.equal(state.width, MAX_SIZE);
  assert.equal(state.height, MAX_SIZE);
  assert.equal(state.cells.length, MAX_SIZE);
  assert.equal(state.cells[0].length, MAX_SIZE);
  // new cells should be filled with walls
  assert.equal(state.cells[MAX_SIZE - 1][MAX_SIZE - 1], "O");
});

test("resize below MIN_SIZE is clamped to MIN_SIZE", () => {
  let state = createInitialState();
  state = editorReducer(state, { type: "resize", width: 1, height: 1 });
  assert.equal(state.width, MIN_SIZE);
  assert.equal(state.height, MIN_SIZE);

  state = editorReducer(state, { type: "resize", width: 0, height: 0 });
  assert.equal(state.width, MIN_SIZE);
  assert.equal(state.height, MIN_SIZE);

  state = editorReducer(state, { type: "resize", width: -5, height: -5 });
  assert.equal(state.width, MIN_SIZE);
  assert.equal(state.height, MIN_SIZE);
});

test("resize above MAX_SIZE is clamped to MAX_SIZE", () => {
  let state = createInitialState();
  state = editorReducer(state, { type: "resize", width: 50, height: 50 });
  assert.equal(state.width, MAX_SIZE);
  assert.equal(state.height, MAX_SIZE);

  state = editorReducer(state, { type: "resize", width: 100, height: 200 });
  assert.equal(state.width, MAX_SIZE);
  assert.equal(state.height, MAX_SIZE);
});

test("resize clamps width and height independently", () => {
  let state = createInitialState();
  state = editorReducer(state, { type: "resize", width: 1, height: 50 });
  assert.equal(state.width, MIN_SIZE);
  assert.equal(state.height, MAX_SIZE);

  state = editorReducer(state, { type: "resize", width: 50, height: 1 });
  assert.equal(state.width, MAX_SIZE);
  assert.equal(state.height, MIN_SIZE);
});

test("resize at exactly MIN_SIZE-1 and MAX_SIZE+1 is clamped", () => {
  let state = createInitialState();
  state = editorReducer(state, {
    type: "resize",
    width: MIN_SIZE - 1,
    height: MIN_SIZE - 1,
  });
  assert.equal(state.width, MIN_SIZE);
  assert.equal(state.height, MIN_SIZE);

  state = editorReducer(state, {
    type: "resize",
    width: MAX_SIZE + 1,
    height: MAX_SIZE + 1,
  });
  assert.equal(state.width, MAX_SIZE);
  assert.equal(state.height, MAX_SIZE);
});

test("resize preserves cells when shrinking to MIN_SIZE", () => {
  let state = createInitialState(); // 7x7
  // Place a floor at (1,1) - should survive shrink to 3x3
  state = editorReducer(state, { type: "set-tool", tool: " " });
  state = editorReducer(state, { type: "set-cell", row: 1, column: 1 });
  state = editorReducer(state, {
    type: "resize",
    width: MIN_SIZE,
    height: MIN_SIZE,
  });
  assert.equal(state.cells[1][1], " ");
});

test("resize to MAX_SIZE fills new area with walls", () => {
  let state = createInitialState(); // 7x7
  state = editorReducer(state, {
    type: "resize",
    width: MAX_SIZE,
    height: MAX_SIZE,
  });
  // Check a cell beyond the original 7x7 area
  assert.equal(state.cells[10][10], "O");
  assert.equal(state.cells[MAX_SIZE - 1][MAX_SIZE - 1], "O");
});

test("all-wall board with a robot fails validation (no boxes)", () => {
  let state = createInitialState(); // all walls
  state = editorReducer(state, { type: "set-tool", tool: "R" });
  state = editorReducer(state, { type: "set-cell", row: 3, column: 3 });
  const result = validateEditorState(state);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("box")));
});

test("board with only walls is invalid (no robot, no boxes, no goals)", () => {
  const state = createInitialState(); // all walls, 7x7
  const result = validateEditorState(state);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("robot")));
  assert.ok(result.errors.some((e) => e.includes("box")));
  assert.ok(result.errors.some((e) => e.includes("goal")));
});

test("valid puzzle on a MIN_SIZE x MIN_SIZE board", () => {
  let state = createInitialState();
  state = editorReducer(state, {
    type: "load",
    puzzle: {
      id: "min-board",
      title: "Min Board",
      difficulty: "beginner",
      boxes: 1,
      rows: ["OOO", "OOO", "OOO"],
    },
  });
  assert.equal(state.width, MIN_SIZE);
  assert.equal(state.height, MIN_SIZE);
  // Place robot, box, and goal in the single interior cell (row 1, col 1)
  // Need at least floor + robot + box + goal, but 3x3 only has 1 interior cell.
  // Use a load with a more creative layout:
  state = editorReducer(state, {
    type: "load",
    puzzle: {
      id: "min-valid",
      title: "Min Valid",
      difficulty: "beginner",
      boxes: 1,
      rows: ["ORO", "OXO", "OSO"],
    },
  });
  assert.equal(state.width, MIN_SIZE);
  assert.equal(state.height, MIN_SIZE);
  const result = validateEditorState(state);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("set-cell on a MAX_SIZE x MAX_SIZE board works at all corners", () => {
  let state = createInitialState();
  state = editorReducer(state, {
    type: "resize",
    width: MAX_SIZE,
    height: MAX_SIZE,
  });
  state = editorReducer(state, { type: "set-tool", tool: " " });

  // Top-left
  state = editorReducer(state, { type: "set-cell", row: 0, column: 0 });
  assert.equal(state.cells[0][0], " ");

  // Top-right
  state = editorReducer(state, {
    type: "set-cell",
    row: 0,
    column: MAX_SIZE - 1,
  });
  assert.equal(state.cells[0][MAX_SIZE - 1], " ");

  // Bottom-left
  state = editorReducer(state, {
    type: "set-cell",
    row: MAX_SIZE - 1,
    column: 0,
  });
  assert.equal(state.cells[MAX_SIZE - 1][0], " ");

  // Bottom-right
  state = editorReducer(state, {
    type: "set-cell",
    row: MAX_SIZE - 1,
    column: MAX_SIZE - 1,
  });
  assert.equal(state.cells[MAX_SIZE - 1][MAX_SIZE - 1], " ");
});

test("set-cell out of bounds on a MIN_SIZE board is ignored", () => {
  let state = createInitialState();
  state = editorReducer(state, {
    type: "resize",
    width: MIN_SIZE,
    height: MIN_SIZE,
  });
  state = editorReducer(state, { type: "set-tool", tool: " " });

  const before = state;
  state = editorReducer(state, {
    type: "set-cell",
    row: MIN_SIZE,
    column: 0,
  });
  assert.equal(state, before); // unchanged reference

  state = editorReducer(state, {
    type: "set-cell",
    row: 0,
    column: MIN_SIZE,
  });
  assert.equal(state, before);

  state = editorReducer(state, { type: "set-cell", row: -1, column: 0 });
  assert.equal(state, before);

  state = editorReducer(state, { type: "set-cell", row: 0, column: -1 });
  assert.equal(state, before);
});

test("robot placed on MAX_SIZE board is unique", () => {
  let state = createInitialState();
  state = editorReducer(state, {
    type: "resize",
    width: MAX_SIZE,
    height: MAX_SIZE,
  });
  state = editorReducer(state, { type: "set-tool", tool: "R" });
  state = editorReducer(state, { type: "set-cell", row: 0, column: 0 });
  assert.equal(state.cells[0][0], "R");

  // Move robot to opposite corner
  state = editorReducer(state, {
    type: "set-cell",
    row: MAX_SIZE - 1,
    column: MAX_SIZE - 1,
  });
  assert.equal(state.cells[MAX_SIZE - 1][MAX_SIZE - 1], "R");
  // Original position cleared to floor
  assert.equal(state.cells[0][0], " ");
});

test("clear on a MAX_SIZE board resets all cells to walls", () => {
  let state = createInitialState();
  state = editorReducer(state, {
    type: "resize",
    width: MAX_SIZE,
    height: MAX_SIZE,
  });
  state = editorReducer(state, { type: "set-tool", tool: " " });
  state = editorReducer(state, { type: "set-cell", row: 10, column: 10 });
  state = editorReducer(state, { type: "clear" });
  assert.ok(state.cells.every((row) => row.every((cell) => cell === "O")));
  assert.equal(state.width, MAX_SIZE);
  assert.equal(state.height, MAX_SIZE);
});
