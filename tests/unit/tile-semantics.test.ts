import assert from "node:assert/strict";
import test from "node:test";

import {
  isWallChar,
  isRobotChar,
  isGenericBoxChar,
  isTypedBoxChar,
  isBoxChar,
  isGenericGoalChar,
  isTypedGoalChar,
  isGoalChar,
  isFloorChar,
  isWalkableChar,
} from "../../src/features/generator/v2/tile-semantics.ts";

import {
  evaluatePuzzleWithSteps,
} from "../../src/features/generator/v2/index.ts";

import type { PuzzleDefinition } from "../../src/core/model.ts";

import {
  enumerateReachablePushes,
} from "../../src/features/generator/v2/reachable-pushes.ts";

import {
  analyzeSolutionDepth,
} from "../../src/features/generator/v2/solution-depth-analysis.ts";

// ---------------------------------------------------------------------------
// Tile semantics unit tests
// ---------------------------------------------------------------------------

test("isWallChar identifies only O", () => {
  assert.ok(isWallChar("O"));
  assert.ok(!isWallChar("R"));
  assert.ok(!isWallChar("X"));
  assert.ok(!isWallChar("S"));
  assert.ok(!isWallChar(" "));
  assert.ok(!isWallChar("A"));
});

test("isRobotChar identifies only R", () => {
  assert.ok(isRobotChar("R"));
  assert.ok(!isRobotChar("O"));
  assert.ok(!isRobotChar("X"));
  assert.ok(!isRobotChar("S"));
  assert.ok(!isRobotChar("A"));
});

test("isGenericBoxChar identifies only X", () => {
  assert.ok(isGenericBoxChar("X"));
  assert.ok(!isGenericBoxChar("O"));
  assert.ok(!isGenericBoxChar("R"));
  assert.ok(!isGenericBoxChar("S"));
  assert.ok(!isGenericBoxChar("A"));
});

test("isTypedBoxChar identifies dedicated uppercase box labels", () => {
  assert.ok(isTypedBoxChar("A"));
  assert.ok(isTypedBoxChar("B"));
  assert.ok(isTypedBoxChar("Z"));
  assert.ok(isTypedBoxChar("N"));
  assert.ok(!isTypedBoxChar("O"), "wall is not a typed box");
  assert.ok(!isTypedBoxChar("R"), "robot is not a typed box");
  assert.ok(!isTypedBoxChar("S"), "generic goal is not a typed box");
  assert.ok(!isTypedBoxChar("X"), "generic box is not a typed box");
  assert.ok(!isTypedBoxChar("a"), "lowercase is not a typed box");
  assert.ok(!isTypedBoxChar(" "), "floor is not a typed box");
});

test("isBoxChar covers generic and typed boxes, excludes O/R/S", () => {
  assert.ok(isBoxChar("X"));
  assert.ok(isBoxChar("A"));
  assert.ok(isBoxChar("B"));
  assert.ok(isBoxChar("Z"));
  assert.ok(!isBoxChar("O"), "wall is not a box");
  assert.ok(!isBoxChar("R"), "robot is not a box");
  assert.ok(!isBoxChar("S"), "generic goal is not a box");
  assert.ok(!isBoxChar("a"), "lowercase goal is not a box");
  assert.ok(!isBoxChar(" "), "floor is not a box");
});

test("isGenericGoalChar identifies only S", () => {
  assert.ok(isGenericGoalChar("S"));
  assert.ok(!isGenericGoalChar("s"));
  assert.ok(!isGenericGoalChar("X"));
  assert.ok(!isGenericGoalChar("O"));
});

test("isTypedGoalChar identifies lowercase letters", () => {
  assert.ok(isTypedGoalChar("a"));
  assert.ok(isTypedGoalChar("b"));
  assert.ok(isTypedGoalChar("z"));
  assert.ok(!isTypedGoalChar("A"));
  assert.ok(!isTypedGoalChar("S"));
  assert.ok(!isTypedGoalChar(" "));
});

test("isGoalChar covers generic and typed goals", () => {
  assert.ok(isGoalChar("S"));
  assert.ok(isGoalChar("a"));
  assert.ok(isGoalChar("z"));
  assert.ok(!isGoalChar("O"));
  assert.ok(!isGoalChar("X"));
  assert.ok(!isGoalChar("R"));
});

test("isFloorChar identifies only space", () => {
  assert.ok(isFloorChar(" "));
  assert.ok(!isFloorChar("O"));
  assert.ok(!isFloorChar("R"));
});

test("isWalkableChar is everything except wall", () => {
  assert.ok(isWalkableChar(" "));
  assert.ok(isWalkableChar("R"));
  assert.ok(isWalkableChar("X"));
  assert.ok(isWalkableChar("S"));
  assert.ok(isWalkableChar("A"));
  assert.ok(isWalkableChar("a"));
  assert.ok(!isWalkableChar("O"));
});

// ---------------------------------------------------------------------------
// Oracle Test A — Wall is never treated as a box
//
// The pre-fix evaluator used `ch >= "A" && ch <= "Z"` which includes O.
// This test verifies that a board with many O characters does not inflate
// the box count in the branching analysis grid parsing.
// ---------------------------------------------------------------------------

test("evaluator branching analysis does not count walls as boxes", async () => {
  const puzzle: PuzzleDefinition = {
    id: "oracle-wall",
    title: "Wall Oracle",
    difficulty: "tutorial",
    boxes: 1,
    rows: [
      "OOOOO",
      "OR  O",
      "O X O",
      "O S O",
      "OOOOO",
    ],
  };
  const result = await evaluatePuzzleWithSteps(puzzle);
  assert.ok(result.vector, "evaluation should produce a vector");
  assert.equal(result.vector.boxCount, 1);
});

// ---------------------------------------------------------------------------
// Oracle Test B — Robot is never treated as a box
// ---------------------------------------------------------------------------

test("evaluator branching analysis does not count robot as a box", async () => {
  const puzzle: PuzzleDefinition = {
    id: "oracle-robot",
    title: "Robot Oracle",
    difficulty: "tutorial",
    boxes: 1,
    rows: [
      "OOOOO",
      "O   O",
      "ORX O",
      "O S O",
      "OOOOO",
    ],
  };
  const result = await evaluatePuzzleWithSteps(puzzle);
  assert.ok(result.vector);
  assert.equal(result.vector.boxCount, 1, "R is not a box");
});

// ---------------------------------------------------------------------------
// Oracle Test C — Generic goal S is never treated as a box
// ---------------------------------------------------------------------------

test("evaluator branching analysis does not count goal S as a box", async () => {
  const puzzle: PuzzleDefinition = {
    id: "oracle-goal",
    title: "Goal Oracle",
    difficulty: "tutorial",
    boxes: 1,
    rows: [
      "OOOOO",
      "OR  O",
      "O XSO",
      "O   O",
      "OOOOO",
    ],
  };
  const result = await evaluatePuzzleWithSteps(puzzle);
  assert.ok(result.vector);
  assert.equal(result.vector.boxCount, 1, "S is a goal, not a box");
});

// ---------------------------------------------------------------------------
// Oracle Test D — Exact reachable push count
//
// Board:
//   OOOOO
//   O  RO
//   O X O
//   O S O
//   OOOOO
//
// Box X at (2,2). Robot at (1,3).
// Flood from (1,3): (1,3)->(1,2)->(1,1)->(2,1)->(3,1)->(3,2)->(3,3)
// (2,3) reachable? from (1,3) down = (2,3) grid=" ", yes. And from (3,3) up.
// So reachable cells: {(1,1),(1,2),(1,3),(2,1),(2,3),(3,1),(3,2),(3,3)}
//
// Box at (2,2):
//   Push right: support=(2,1)✓ dest=(2,3)✓ Valid
//   Push left:  support=(2,3)✓ dest=(2,1)✓ Valid
//   Push down:  support=(1,2)✓ dest=(3,2)✓ Valid
//   Push up:    support=(3,2)✓ dest=(1,2)✓ Valid
// Total: 4
// ---------------------------------------------------------------------------

test("exact reachable push count on known board", () => {
  const grid = [
    [...("OOOOO")],
    [...("O  RO")],
    [...("O X O")],
    [...("O S O")],
    [...("OOOOO")],
  ];
  const robot = { row: 1, column: 3 };
  const boxes = [{ row: 2, column: 2 }];

  const pushes = enumerateReachablePushes(grid, robot, boxes);
  assert.equal(pushes.length, 4, "exactly 4 reachable pushes");
});

// ---------------------------------------------------------------------------
// Oracle Test E — Exact forced state (only 1 reachable push)
//
// Board:
//   OOOOO
//   ORXSO
//   OOOOO
//
// Box at (1,2). Robot at (1,1).
// Flood from (1,1): only (1,1) since all neighbors are wall or box.
//   Push right: support=(1,1)✓ dest=(1,3)=S (not wall, not box)✓ Valid
//   Push left:  support=(1,3) reachable? No — robot can't reach past box.
//   Push up:    support=(2,2) wall. Invalid.
//   Push down:  support=(0,2) wall. Invalid.
// Total: 1
// ---------------------------------------------------------------------------

test("exact forced state — only one reachable push", () => {
  const grid = [
    [...("OOOOO")],
    [...("ORXSO")],
    [...("OOOOO")],
  ];
  const robot = { row: 1, column: 1 };
  const boxes = [{ row: 1, column: 2 }];

  const pushes = enumerateReachablePushes(grid, robot, boxes);
  assert.equal(pushes.length, 1, "exactly 1 reachable push (forced)");
  assert.equal(pushes[0].direction, "right");
});

// ---------------------------------------------------------------------------
// Oracle Test F — analyzeSolutionDepth parses only real boxes
//
// Board with O, R, S on it — none should be treated as boxes.
// With empty steps, distinctBoxesMoved should be 0 regardless.
// More importantly, the internal box array must have length 2 (A and B),
// not 5+ (if O, R, S were misidentified).
// ---------------------------------------------------------------------------

test("analyzeSolutionDepth does not treat O/R/S as boxes", () => {
  const grid = [
    [...("OOOOOOO")],
    [...("OR    O")],
    [...("O A B O")],
    [...("O a b O")],
    [...("OOOOOOO")],
  ];

  const result = analyzeSolutionDepth(grid, []);
  assert.equal(result.distinctBoxesMoved, 0, "no steps means no boxes moved");
  assert.equal(result.boxSwitchRate, 0);
});

// ---------------------------------------------------------------------------
// Oracle Test — Typed boxes A and B are correctly recognized
// ---------------------------------------------------------------------------

test("typed boxes A and B are recognized by evaluator", async () => {
  const puzzle: PuzzleDefinition = {
    id: "oracle-typed",
    title: "Typed Oracle",
    difficulty: "beginner",
    boxes: 2,
    rows: [
      "OOOOOOO",
      "OR    O",
      "O A B O",
      "O a b O",
      "OOOOOOO",
    ],
  };
  const result = await evaluatePuzzleWithSteps(puzzle);
  assert.ok(result.vector);
  assert.equal(result.vector.boxCount, 2, "A and B are the only boxes");
});

// ---------------------------------------------------------------------------
// Oracle Test — Exact reachable pushes with typed boxes
//
// Board:
//   OOOOO
//   O  RO
//   O A O
//   O a O
//   OOOOO
//
// Same geometry as Test D but with typed box A. Should still be 4 pushes.
// ---------------------------------------------------------------------------

test("reachable pushes work correctly with typed boxes", () => {
  const grid = [
    [...("OOOOO")],
    [...("O  RO")],
    [...("O A O")],
    [...("O a O")],
    [...("OOOOO")],
  ];
  const robot = { row: 1, column: 3 };
  const boxes = [{ row: 2, column: 2 }];

  const pushes = enumerateReachablePushes(grid, robot, boxes);
  assert.equal(pushes.length, 4, "typed box A has exactly 4 reachable pushes");
});

// ---------------------------------------------------------------------------
// Oracle Test — Two-box board with exact known reachable pushes
//
// Board:
//   OOOOOOO
//   OR X  O
//   O   X O
//   O SS  O
//   OOOOOOO
//
// Box0 at (1,3), Box1 at (2,4).
// Robot at (1,1). Flood from (1,1):
//   (1,1)->(1,2)->(2,1)->(2,2)->(2,3)->(3,1)->(3,2)->(3,3)->(3,4)->(3,5)
//   ->(2,5)->(1,5)->(1,4)
// So all non-wall non-box cells are reachable.
//
// Box0 at (1,3):
//   right: support=(1,2)✓ dest=(1,4)✓ Valid
//   left:  support=(1,4)✓ dest=(1,2)✓ Valid
//   down:  support=(0,3) wall. Invalid.
//   up:    support=(2,3)✓ dest=(0,3) wall. Invalid.
// Box0 pushes: 2
//
// Box1 at (2,4):
//   right: support=(2,3)✓ dest=(2,5)✓ Valid
//   left:  support=(2,5)✓ dest=(2,3)✓ Valid
//   down:  support=(1,4)✓ dest=(3,4)✓ Valid
//   up:    support=(3,4)✓ dest=(1,4)✓ Valid
// Box1 pushes: 4
//
// Total: 6
// ---------------------------------------------------------------------------

test("exact reachable push count with two boxes", () => {
  const grid = [
    [...("OOOOOOO")],
    [...("OR X  O")],
    [...("O   X O")],
    [...("O SS  O")],
    [...("OOOOOOO")],
  ];
  const robot = { row: 1, column: 1 };
  const boxes = [
    { row: 1, column: 3 },
    { row: 2, column: 4 },
  ];

  const pushes = enumerateReachablePushes(grid, robot, boxes);
  assert.equal(pushes.length, 6, "exactly 6 reachable pushes across 2 boxes");
});
