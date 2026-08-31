import assert from "node:assert/strict";
import test from "node:test";

import { analyzeInteraction } from "../../src/features/generator/v2/interaction-analysis.ts";
import type { SolutionStep } from "../../src/solver/contracts.ts";

test("tracks per-box participation and cross-type route sharing", () => {
  const grid = [
    "OOOOOOOOOO",
    "O        O",
    "O R X    O",
    "O   A    O",
    "O        O",
    "OOOOOOOOOO",
  ].map((row) => [...row]);

  const steps: SolutionStep[] = [
    { direction: "right", kind: "walk" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "down", kind: "walk" },
    { direction: "down", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "up", kind: "push" },
    { direction: "left", kind: "walk" },
    { direction: "up", kind: "walk" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
  ];

  const metrics = analyzeInteraction(grid, steps, new Set(), grid[0].length);

  assert.equal(metrics.inactiveBoxCount, 0);
  assert.equal(metrics.onePushBoxCount, 0);
  assert.equal(metrics.minPushesPerBox, 3);
  assert.ok(metrics.crossTypeSharedRouteCells >= 3);
});

test("identifies untouched and one-push decorative boxes", () => {
  const grid = [
    "OOOOOOOO",
    "O R X AO",
    "O      O",
    "OOOOOOOO",
  ].map((row) => [...row]);
  const steps: SolutionStep[] = [
    { direction: "right", kind: "walk" },
    { direction: "right", kind: "push" },
  ];

  const metrics = analyzeInteraction(grid, steps, new Set(), grid[0].length);

  assert.equal(metrics.inactiveBoxCount, 1);
  assert.equal(metrics.onePushBoxCount, 1);
  assert.equal(metrics.minPushesPerBox, 0);
  assert.equal(metrics.crossTypeSharedRouteCells, 0);
});
