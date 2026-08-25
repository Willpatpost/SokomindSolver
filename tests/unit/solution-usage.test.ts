import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSolutionUsage } from "../../src/features/generator/v2/solution-usage.ts";
import type { SolutionStep } from "../../src/solver/contracts.ts";

function parseGrid(rows: readonly string[]): string[][] {
  return rows.map((r) => [...r]);
}

// ---------------------------------------------------------------------------
// analyzeSolutionUsage
// ---------------------------------------------------------------------------

test("trivial 1-box puzzle has high floor coverage", () => {
  const grid = parseGrid([
    "OOOOO",
    "O R O",
    "O X O",
    "O S O",
    "OOOOO",
  ]);
  const totalFloor = 9;
  const steps: SolutionStep[] = [
    { direction: "down", kind: "walk" },
    { direction: "down", kind: "push" },
  ];

  const result = analyzeSolutionUsage(grid, steps, totalFloor);

  assert.ok(result.solutionFloorCoverage > 0, "coverage should be positive");
  assert.ok(result.cellsUsedBySolution >= 3, "at least robot start + walk + push destination");
});

test("solutionUnusedFloorRatio = 1 - solutionFloorCoverage", () => {
  const grid = parseGrid([
    "OOOOO",
    "O R O",
    "O X O",
    "O S O",
    "OOOOO",
  ]);
  const steps: SolutionStep[] = [
    { direction: "down", kind: "walk" },
    { direction: "down", kind: "push" },
  ];
  const result = analyzeSolutionUsage(grid, steps, 9);

  const sum = result.solutionFloorCoverage + result.solutionUnusedFloorRatio;
  assert.ok(Math.abs(sum - 1) < 1e-10, `coverage + unused should be 1, got ${sum}`);
});

test("puzzle with unused alcove has lower coverage", () => {
  const grid = parseGrid([
    "OOOOOOOOO",
    "O R     O",
    "O X     O",
    "O S  OOOO",
    "O    O",
    "OOOOOO",
  ]);
  const steps: SolutionStep[] = [
    { direction: "down", kind: "walk" },
    { direction: "down", kind: "push" },
  ];

  let totalFloor = 0;
  for (const row of grid) {
    for (const ch of row) {
      if (ch !== "O") totalFloor++;
    }
  }

  const result = analyzeSolutionUsage(grid, steps, totalFloor);
  assert.ok(result.solutionUnusedFloorRatio > 0.3, "significant unused floor expected");
});

test("empty steps still count initial positions", () => {
  const grid = parseGrid([
    "OOOOO",
    "O R O",
    "O X O",
    "O S O",
    "OOOOO",
  ]);
  const result = analyzeSolutionUsage(grid, [], 9);

  assert.ok(result.cellsUsedBySolution >= 2, "robot + box initial positions");
  assert.ok(result.solutionFloorCoverage > 0, "coverage includes initial state");
});

test("zero totalFloor returns zero metrics", () => {
  const grid = parseGrid(["OOO", "OOO"]);
  const result = analyzeSolutionUsage(grid, [], 0);
  assert.equal(result.solutionFloorCoverage, 0);
  assert.equal(result.solutionUnusedFloorRatio, 0);
  assert.equal(result.cellsUsedBySolution, 0);
});
