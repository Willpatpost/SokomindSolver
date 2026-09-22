import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyNecessity } from "../../src/features/generator/v2/index.ts";
import type { SolutionStep } from "../../src/solver/contracts.ts";

const grid = [
  ["O","O","O","O","O","O","O"],
  ["O"," "," ","R"," "," ","O"],
  ["O"," ","X"," ","X"," ","O"],
  ["O"," ","S"," ","S"," ","O"],
  ["O","O","O","O","O","O","O"],
];

function step(dir: "up" | "down" | "left" | "right", kind: "walk" | "push"): SolutionStep {
  return { direction: dir, kind };
}

// Route A: pushes both boxes down
const routeA: readonly SolutionStep[] = [
  step("left", "walk"),
  step("down", "push"),
  step("up", "walk"),
  step("right", "walk"),
  step("right", "walk"),
  step("down", "push"),
];

// Route B: only pushes box0 (left box)
const routeB: readonly SolutionStep[] = [
  step("left", "walk"),
  step("down", "push"),
];

test("all boxes required when every route uses them", () => {
  const result = classifyNecessity(grid, [{ steps: routeA }]);
  assert.equal(result.requiredCount, 2, "both boxes should be required with single route");
  for (const box of result.boxes) {
    assert.equal(box.necessity, "required");
    assert.equal(box.routesUsing, 1);
  }
});

test("box is observed when used in some routes but not all", () => {
  const result = classifyNecessity(grid, [{ steps: routeA }, { steps: routeB }]);
  const box0 = result.boxes[0];
  const box1 = result.boxes[1];
  assert.equal(box0.necessity, "required", "box0 used in both routes");
  assert.equal(box1.necessity, "observed", "box1 only used in one route");
  assert.equal(result.requiredCount, 1);
  assert.equal(result.observedCount, 1);
});

test("empty routes produce inconclusive", () => {
  const result = classifyNecessity(grid, []);
  assert.equal(result.inconclusiveCount, 2);
});

test("multiple routes with same usage produce required", () => {
  const result = classifyNecessity(grid, [{ steps: routeA }, { steps: routeA }]);
  assert.equal(result.requiredCount, 2);
  assert.equal(result.observedCount, 0);
});
