import assert from "node:assert/strict";
import { test } from "node:test";
import { detectShortcuts } from "../../src/features/generator/v2/index.ts";
import type { PuzzleDefinition } from "../../src/core/model.ts";
import type { SolutionStep } from "../../src/solver/contracts.ts";
import type { DistinctRoute } from "../../src/features/generator/v2/finalist-evaluator.ts";

const puzzle: PuzzleDefinition = {
  id: "shortcut-test", title: "Shortcut", difficulty: "beginner", boxes: 2,
  rows: [
    "OOOOOOO",
    "O  R  O",
    "O X X O",
    "O S S O",
    "OOOOOOO",
  ],
};

function step(dir: "up" | "down" | "left" | "right", kind: "walk" | "push"): SolutionStep {
  return { direction: dir, kind };
}

// Robot at (1,3), boxes at (2,2) and (2,4), goals at (3,2) and (3,4)
// Witness pushes both boxes down to goals
const witnessSteps: readonly SolutionStep[] = [
  step("left", "walk"),    // (1,3) -> (1,2)
  step("down", "push"),    // push box0 from (2,2) -> (3,2), robot to (2,2)
  step("up", "walk"),      // (2,2) -> (1,2)
  step("right", "walk"),   // (1,2) -> (1,3)
  step("right", "walk"),   // (1,3) -> (1,4)
  step("down", "push"),    // push box1 from (2,4) -> (3,4), robot to (2,4)
];

// Route that only pushes box0 (bypasses box1)
const shortRouteSteps: readonly SolutionStep[] = [
  step("left", "walk"),    // (1,3) -> (1,2)
  step("down", "push"),    // push box0 from (2,2) -> (3,2)
];

const shortRoute: DistinctRoute = {
  solverId: "short",
  steps: shortRouteSteps,
  moves: 2,
  pushes: 1,
  pushFingerprint: "d",
};

const equivalentRoute: DistinctRoute = {
  solverId: "equiv",
  steps: witnessSteps,
  moves: 6,
  pushes: 2,
  pushFingerprint: "dd",
};

test("route with fewer pushes and bypassed boxes is flagged as shortcut", () => {
  const result = detectShortcuts(puzzle, witnessSteps, [shortRoute]);
  assert.ok(result.hasShortcuts, "should detect shortcut");
  assert.equal(result.comparisons.length, 1);
  assert.ok(result.comparisons[0].isShortcut);
  assert.ok(result.comparisons[0].pushReduction > 0);
});

test("equivalent route is not flagged as shortcut", () => {
  const result = detectShortcuts(puzzle, witnessSteps, [equivalentRoute]);
  assert.equal(result.hasShortcuts, false, "equivalent route should not be shortcut");
  assert.equal(result.comparisons[0].bypassedBoxes.length, 0);
});

test("empty routes produce empty analysis", () => {
  const result = detectShortcuts(puzzle, witnessSteps, []);
  assert.equal(result.hasShortcuts, false);
  assert.equal(result.comparisons.length, 0);
  assert.equal(result.maxSeverity, 0);
});

test("multiple routes: only the shortcut is flagged", () => {
  const result = detectShortcuts(puzzle, witnessSteps, [equivalentRoute, shortRoute]);
  assert.equal(result.comparisons.length, 2);
  const shortcuts = result.comparisons.filter(c => c.isShortcut);
  assert.ok(shortcuts.length >= 1, "at least one shortcut");
  assert.equal(shortcuts[0].routeSolverId, "short");
});
