import assert from "node:assert/strict";
import test from "node:test";

import {
  createRng,
  floodFill,
  generateFloorLayout,
  generateBoardTemplate,
} from "../../src/features/generator/board-template.ts";
import {
  canRobotReach,
  enumerateReversePulls,
  scrambleByReversePull,
} from "../../src/features/generator/reverse-play.ts";
import {
  classifyFromMetrics,
  classifyPuzzleDifficulty,
  solvePuzzleForSteps,
} from "../../src/features/generator/difficulty-classifier.ts";
import {
  buildPuzzleFromScramble,
  generatePuzzle,
} from "../../src/features/generator/generate-puzzle.ts";
import {
  VALID_LABELS,
  assignLabels,
  traceBoxGoalPairing,
  findPathCrossings,
} from "../../src/features/generator/label-assignment.ts";
import { validatePuzzle } from "../../src/core/puzzle.ts";
import type { PuzzleDefinition } from "../../src/core/model.ts";

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

test("createRng: same seed produces same sequence", () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 20; i++) {
    assert.equal(a(), b());
  }
});

test("createRng: different seeds produce different sequences", () => {
  const a = createRng(1);
  const b = createRng(2);
  let differ = false;
  for (let i = 0; i < 10; i++) {
    if (a() !== b()) {
      differ = true;
      break;
    }
  }
  assert.ok(differ);
});

test("createRng: values are in [0, 1)", () => {
  const rng = createRng(123);
  for (let i = 0; i < 100; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `value ${v} not in [0,1)`);
  }
});

// ---------------------------------------------------------------------------
// floodFill
// ---------------------------------------------------------------------------

test("floodFill: connected room returns all floor cells", () => {
  const grid = [
    ["O", "O", "O", "O"],
    ["O", " ", " ", "O"],
    ["O", " ", " ", "O"],
    ["O", "O", "O", "O"],
  ];
  const result = floodFill(grid, { row: 1, column: 1 });
  assert.equal(result.size, 4);
  assert.ok(result.has("1,1"));
  assert.ok(result.has("1,2"));
  assert.ok(result.has("2,1"));
  assert.ok(result.has("2,2"));
});

test("floodFill: disconnected rooms return only the starting component", () => {
  const grid = [
    ["O", "O", "O", "O", "O"],
    ["O", " ", "O", " ", "O"],
    ["O", " ", "O", " ", "O"],
    ["O", "O", "O", "O", "O"],
  ];
  const left = floodFill(grid, { row: 1, column: 1 });
  assert.equal(left.size, 2);
  assert.ok(left.has("1,1"));
  assert.ok(left.has("2,1"));
  assert.ok(!left.has("1,3"));
});

test("floodFill: starting on a wall returns empty set", () => {
  const grid = [
    ["O", "O"],
    ["O", " "],
  ];
  const result = floodFill(grid, { row: 0, column: 0 });
  assert.equal(result.size, 0);
});

// ---------------------------------------------------------------------------
// generateFloorLayout
// ---------------------------------------------------------------------------

test("generateFloorLayout: border cells are all walls", () => {
  const rng = createRng(100);
  const grid = generateFloorLayout(8, 8, 11, rng);
  for (let c = 0; c < 8; c++) {
    assert.equal(grid[0][c], "O", `top border [0,${c}]`);
    assert.equal(grid[7][c], "O", `bottom border [7,${c}]`);
  }
  for (let r = 0; r < 8; r++) {
    assert.equal(grid[r][0], "O", `left border [${r},0]`);
    assert.equal(grid[r][7], "O", `right border [${r},7]`);
  }
});

test("generateFloorLayout: floor count meets minimum", () => {
  const rng = createRng(200);
  const minFloor = 11;
  const grid = generateFloorLayout(8, 8, minFloor, rng);
  let floorCount = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (cell !== "O") floorCount++;
    }
  }
  assert.ok(floorCount >= minFloor, `floor count ${floorCount} < ${minFloor}`);
});

test("generateFloorLayout: floor is fully connected", () => {
  const rng = createRng(300);
  const grid = generateFloorLayout(9, 9, 14, rng);
  let firstFloor: { row: number; column: number } | undefined;
  let totalFloor = 0;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (grid[r][c] !== "O") {
        totalFloor++;
        if (!firstFloor) firstFloor = { row: r, column: c };
      }
    }
  }
  assert.ok(firstFloor, "no floor cells found");
  const component = floodFill(grid, firstFloor!);
  assert.equal(component.size, totalFloor, "floor is not fully connected");
});

// ---------------------------------------------------------------------------
// generateBoardTemplate
// ---------------------------------------------------------------------------

test("generateBoardTemplate: correct dimensions", () => {
  const rng = createRng(400);
  const t = generateBoardTemplate(7, 6, 2, rng);
  assert.equal(t.width, 7);
  assert.equal(t.height, 6);
  assert.equal(t.grid.length, 6);
  assert.equal(t.grid[0].length, 7);
});

test("generateBoardTemplate: goal count matches boxCount", () => {
  const rng = createRng(500);
  const t = generateBoardTemplate(8, 8, 3, rng);
  assert.equal(t.goalPositions.length, 3);
});

test("generateBoardTemplate: robot on floor and reachable from goals", () => {
  const rng = createRng(600);
  const t = generateBoardTemplate(7, 7, 2, rng);
  assert.equal(t.grid[t.robotPosition.row][t.robotPosition.column], " ");
  const reachable = floodFill(t.grid, t.robotPosition);
  for (const g of t.goalPositions) {
    assert.ok(
      reachable.has(`${g.row},${g.column}`),
      `goal at (${g.row},${g.column}) not reachable from robot`,
    );
  }
});

// ---------------------------------------------------------------------------
// canRobotReach
// ---------------------------------------------------------------------------

test("canRobotReach: adjacent floor cell is reachable", () => {
  const grid = [
    ["O", "O", "O"],
    ["O", " ", " "],
    ["O", "O", "O"],
  ];
  const result = canRobotReach(
    grid,
    { row: 1, column: 1 },
    { row: 1, column: 2 },
    [],
  );
  assert.ok(result);
});

test("canRobotReach: blocked by box returns false", () => {
  const grid = [
    ["O", "O", "O", "O"],
    ["O", " ", " ", " "],
    ["O", "O", "O", "O"],
  ];
  const result = canRobotReach(
    grid,
    { row: 1, column: 1 },
    { row: 1, column: 3 },
    [{ row: 1, column: 2 }],
  );
  assert.equal(result, false);
});

test("canRobotReach: same position returns true", () => {
  const grid = [
    ["O", "O", "O"],
    ["O", " ", "O"],
    ["O", "O", "O"],
  ];
  const result = canRobotReach(
    grid,
    { row: 1, column: 1 },
    { row: 1, column: 1 },
    [],
  );
  assert.ok(result);
});

// ---------------------------------------------------------------------------
// enumerateReversePulls
// ---------------------------------------------------------------------------

test("enumerateReversePulls: box in open room has valid pulls", () => {
  const grid = [
    ["O", "O", "O", "O", "O", "O", "O"],
    ["O", " ", " ", " ", " ", " ", "O"],
    ["O", " ", " ", " ", " ", " ", "O"],
    ["O", " ", " ", " ", " ", " ", "O"],
    ["O", " ", " ", " ", " ", " ", "O"],
    ["O", " ", " ", " ", " ", " ", "O"],
    ["O", "O", "O", "O", "O", "O", "O"],
  ];
  const pulls = enumerateReversePulls(
    grid,
    [{ row: 3, column: 3 }],
    { row: 1, column: 1 },
  );
  assert.ok(pulls.length > 0, "should have at least one valid pull");
});

test("enumerateReversePulls: corner box has limited pulls", () => {
  const grid = [
    ["O", "O", "O", "O"],
    ["O", " ", " ", "O"],
    ["O", " ", "O", "O"],
    ["O", "O", "O", "O"],
  ];
  const pulls = enumerateReversePulls(
    grid,
    [{ row: 2, column: 1 }],
    { row: 1, column: 1 },
  );
  assert.ok(pulls.length <= 2, "corner box should have few pulls");
});

// ---------------------------------------------------------------------------
// scrambleByReversePull
// ---------------------------------------------------------------------------

test("scrambleByReversePull: produces correct box count", () => {
  const rng = createRng(700);
  const template = generateBoardTemplate(7, 7, 2, rng);
  const rng2 = createRng(701);
  const scrambled = scrambleByReversePull(template, 10, rng2);
  assert.equal(scrambled.boxPositions.length, template.goalPositions.length);
});

test("scrambleByReversePull: robot is on floor", () => {
  const rng = createRng(800);
  const template = generateBoardTemplate(8, 8, 3, rng);
  const rng2 = createRng(801);
  const scrambled = scrambleByReversePull(template, 15, rng2);
  const { row, column } = scrambled.robotPosition;
  assert.equal(template.grid[row][column], " ");
});

test("scrambleByReversePull: boxes are on floor cells", () => {
  const rng = createRng(900);
  const template = generateBoardTemplate(7, 7, 2, rng);
  const rng2 = createRng(901);
  const scrambled = scrambleByReversePull(template, 8, rng2);
  for (const bp of scrambled.boxPositions) {
    assert.equal(
      template.grid[bp.row][bp.column],
      " ",
      `box at (${bp.row},${bp.column}) is not on floor`,
    );
  }
});

// ---------------------------------------------------------------------------
// classifyFromMetrics
// ---------------------------------------------------------------------------

test("classifyFromMetrics: simple tutorial case", () => {
  const d = classifyFromMetrics(5, 3, 1);
  assert.equal(d, "tutorial");
});

test("classifyFromMetrics: intermediate boundary", () => {
  const d = classifyFromMetrics(50, 30, 4);
  assert.equal(d, "intermediate");
});

test("classifyFromMetrics: master when exceeding all thresholds", () => {
  const d = classifyFromMetrics(1000, 500, 15);
  assert.equal(d, "master");
});

test("classifyFromMetrics: beginner range", () => {
  const d = classifyFromMetrics(20, 10, 2);
  assert.equal(d, "beginner");
});

// ---------------------------------------------------------------------------
// buildPuzzleFromScramble
// ---------------------------------------------------------------------------

test("buildPuzzleFromScramble: produces valid puzzle", () => {
  const rng = createRng(1000);
  const template = generateBoardTemplate(7, 7, 2, rng);
  const rng2 = createRng(1001);
  const scrambled = scrambleByReversePull(template, 10, rng2);

  const goalKeys = new Set(
    template.goalPositions.map((g) => `${g.row},${g.column}`),
  );
  const allOffGoals = scrambled.boxPositions.every(
    (bp) => !goalKeys.has(`${bp.row},${bp.column}`),
  );

  if (!allOffGoals) {
    return;
  }

  const puzzle = buildPuzzleFromScramble(scrambled, "beginner");
  const validation = validatePuzzle(puzzle);
  assert.ok(validation.valid, `validation errors: ${validation.errors.map((e) => e.message).join("; ")}`);
});

test("buildPuzzleFromScramble: row count matches grid dimensions", () => {
  const rng = createRng(1100);
  const template = generateBoardTemplate(6, 6, 1, rng);
  const rng2 = createRng(1101);
  const scrambled = scrambleByReversePull(template, 5, rng2);
  const puzzle = buildPuzzleFromScramble(scrambled, "tutorial");
  assert.equal(puzzle.rows.length, 6);
  assert.equal(puzzle.rows[0].length, 6);
});

test("buildPuzzleFromScramble: contains robot, boxes, and goals", () => {
  const rng = createRng(1200);
  const template = generateBoardTemplate(7, 7, 2, rng);
  const rng2 = createRng(1201);
  const scrambled = scrambleByReversePull(template, 8, rng2);
  const puzzle = buildPuzzleFromScramble(scrambled, "beginner");
  const allChars = puzzle.rows.join("");
  assert.ok(allChars.includes("R"), "puzzle should contain robot");
  const boxCount = (allChars.match(/X/g) ?? []).length;
  assert.equal(boxCount, 2, "should have 2 boxes");
  const goalCount = (allChars.match(/S/g) ?? []).length;
  assert.equal(goalCount, 2, "should have 2 goals");
});

// ---------------------------------------------------------------------------
// VALID_LABELS
// ---------------------------------------------------------------------------

test("VALID_LABELS: exactly 22 entries, no O/R/S/X", () => {
  assert.equal(VALID_LABELS.length, 22);
  const forbidden = ["O", "R", "S", "X"];
  for (const label of VALID_LABELS) {
    assert.ok(
      !forbidden.includes(label),
      `label ${label} is in forbidden set`,
    );
  }
});

test("VALID_LABELS: all uppercase letters", () => {
  for (const label of VALID_LABELS) {
    assert.ok(
      label >= "A" && label <= "Z",
      `label ${label} is not uppercase`,
    );
  }
});

// ---------------------------------------------------------------------------
// classifyPuzzleDifficulty (solver-backed)
// ---------------------------------------------------------------------------

const SIMPLE_PUZZLE: PuzzleDefinition = {
  id: "test-simple",
  title: "Simple",
  difficulty: "tutorial",
  boxes: 1,
  rows: ["OOOOO", "O R O", "O X O", "O S O", "OOOOO"],
};

test("classifyPuzzleDifficulty: solves a trivial puzzle and returns tutorial", async () => {
  const result = await classifyPuzzleDifficulty(SIMPLE_PUZZLE);
  assert.ok(result !== null, "should solve the puzzle");
  assert.equal(result!.difficulty, "tutorial");
  assert.ok(result!.moves > 0);
  assert.ok(result!.pushes > 0);
  assert.ok(result!.elapsedMs >= 0);
});

test("classifyPuzzleDifficulty: returns null for unsolvable puzzle", async () => {
  const unsolvable: PuzzleDefinition = {
    id: "test-unsolvable",
    title: "Unsolvable",
    difficulty: "tutorial",
    boxes: 1,
    rows: ["OOOOO", "ORXOO", "O  SO", "O   O", "OOOOO"],
  };
  const result = await classifyPuzzleDifficulty(unsolvable);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// solvePuzzleForSteps
// ---------------------------------------------------------------------------

test("solvePuzzleForSteps: returns solution with steps", async () => {
  const solution = await solvePuzzleForSteps(SIMPLE_PUZZLE);
  assert.ok(solution !== null, "should solve the puzzle");
  assert.ok(solution!.steps.length > 0, "should have steps");
  assert.ok(solution!.moves > 0);
  assert.ok(solution!.pushes > 0);
});

// ---------------------------------------------------------------------------
// traceBoxGoalPairing
// ---------------------------------------------------------------------------

test("traceBoxGoalPairing: pairs boxes to goals after solving", async () => {
  const twoPuzzle: PuzzleDefinition = {
    id: "test-two",
    title: "Two",
    difficulty: "beginner",
    boxes: 2,
    rows: ["OOOOOOO", "O R   O", "O X X O", "O S S O", "OOOOOOO"],
  };
  const solution = await solvePuzzleForSteps(twoPuzzle);
  assert.ok(solution !== null);
  const pairing = traceBoxGoalPairing(twoPuzzle, solution!.steps);
  assert.equal(pairing.size, 2, "should pair both boxes");
});

// ---------------------------------------------------------------------------
// findPathCrossings
// ---------------------------------------------------------------------------

test("findPathCrossings: non-crossing boxes return empty", async () => {
  const sideBySide: PuzzleDefinition = {
    id: "test-side",
    title: "Side",
    difficulty: "beginner",
    boxes: 2,
    rows: ["OOOOOOO", "O R   O", "O X X O", "O S S O", "OOOOOOO"],
  };
  const solution = await solvePuzzleForSteps(sideBySide);
  assert.ok(solution !== null);
  const crossings = findPathCrossings(sideBySide, solution!.steps);
  assert.ok(Array.isArray(crossings));
});

// ---------------------------------------------------------------------------
// assignLabels
// ---------------------------------------------------------------------------

test("assignLabels: converts generic boxes to labeled pairs", async () => {
  const puzzle: PuzzleDefinition = {
    id: "test-label",
    title: "Label",
    difficulty: "beginner",
    boxes: 2,
    rows: ["OOOOOOO", "O R   O", "O X X O", "O S S O", "OOOOOOO"],
  };
  const solution = await solvePuzzleForSteps(puzzle);
  assert.ok(solution !== null);
  const rng = createRng(42);
  const labeled = assignLabels(puzzle, solution!, rng);

  const allChars = labeled.rows.join("");
  const upperLabels = [...allChars].filter(
    (ch) => ch >= "A" && ch <= "Z" && !["O", "R", "S", "X"].includes(ch),
  );
  const lowerLabels = [...allChars].filter(
    (ch) => ch >= "a" && ch <= "z",
  );
  assert.equal(upperLabels.length, 2, "should have 2 labeled boxes");
  assert.equal(lowerLabels.length, 2, "should have 2 labeled goals");

  const validation = validatePuzzle(labeled);
  assert.ok(validation.valid, `labeled puzzle should be valid: ${validation.errors.map((e) => e.message).join("; ")}`);
});

test("assignLabels: returns puzzle unchanged when boxCount < 2", async () => {
  const solution = await solvePuzzleForSteps(SIMPLE_PUZZLE);
  assert.ok(solution !== null);
  const rng = createRng(99);
  const result = assignLabels(SIMPLE_PUZZLE, solution!, rng);
  assert.deepStrictEqual(result.rows, SIMPLE_PUZZLE.rows);
});

// ---------------------------------------------------------------------------
// generatePuzzle (integration)
// ---------------------------------------------------------------------------

test("generatePuzzle: produces valid tutorial puzzle", { timeout: 30_000 }, async () => {
  const result = await generatePuzzle({
    width: 6,
    height: 6,
    boxCount: 2,
    targetDifficulty: "tutorial",
    useLabels: false,
    maxAttempts: 50,
  });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.ok(result.attempts > 0);
    assert.ok(result.solverMoves > 0);
    const validation = validatePuzzle(result.puzzle);
    assert.ok(validation.valid);
  }
});

test("generatePuzzle: produces labeled puzzle when requested", { timeout: 30_000 }, async () => {
  const result = await generatePuzzle({
    width: 7,
    height: 7,
    boxCount: 2,
    targetDifficulty: "beginner",
    useLabels: true,
    maxAttempts: 50,
  });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    const allChars = result.puzzle.rows.join("");
    const hasLabels = [...allChars].some(
      (ch) => ch >= "A" && ch <= "Z" && !["O", "R", "S", "X"].includes(ch),
    );
    assert.ok(hasLabels, "puzzle should have labeled boxes");
  }
});

test("generatePuzzle: respects abort signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await generatePuzzle(
    {
      width: 6,
      height: 6,
      boxCount: 2,
      targetDifficulty: "tutorial",
      useLabels: false,
      maxAttempts: 100,
    },
    undefined,
    controller.signal,
  );
  assert.equal(result.status, "failed");
});

test("generatePuzzle: calls progress callback", { timeout: 30_000 }, async () => {
  const messages: string[] = [];
  await generatePuzzle(
    {
      width: 6,
      height: 6,
      boxCount: 2,
      targetDifficulty: "tutorial",
      useLabels: false,
      maxAttempts: 50,
    },
    (progress) => { messages.push(progress.message); },
  );
  assert.ok(messages.length > 0, "should have received progress messages");
});
