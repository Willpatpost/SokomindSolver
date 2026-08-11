import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allocateParallelRewriteBudgets,
  solutionImprovementPlan,
} from "../../src/solver/implementations/sokomind-solver.ts";
import { resolveSokomindTuning } from "../../src/solver/implementations/sokomind-tuning.ts";
import type { SolverSolution, SolutionStep } from "../../src/solver/contracts.ts";

const profile = resolveSokomindTuning();

function makeSolution(moves: number): SolverSolution {
  const steps: SolutionStep[] = Array.from({ length: moves }, (_, i) => ({
    direction: (["up", "down", "left", "right"] as const)[i % 4],
    kind: i % 3 === 0 ? "push" : "walk",
  }));
  return {
    steps,
    moves,
    pushes: steps.filter((s) => s.kind === "push").length,
    objective: { kind: "moves" },
    objectiveScore: moves,
    optimality: "unknown",
  };
}

const dummyState = Object.freeze({
  rows: Object.freeze(["OOOOO", "O R O", "O X O", "O s O", "OOOOO"]),
  robot: Object.freeze([1, 2]) as readonly [number, number],
  boxes: Object.freeze([
    Object.freeze(["2,2", "X"]) as readonly [string, string],
  ]),
});

describe("rewrite worker telemetry identity", () => {
  it("reserves disjoint parallel state and elapsed budgets", () => {
    const budgets = allocateParallelRewriteBudgets(3, 10, 8, 5);

    assert.deepEqual(budgets, [
      { maxVisited: 4, maxGenerated: 3, maxElapsedMs: 2 },
      { maxVisited: 3, maxGenerated: 3, maxElapsedMs: 2 },
      { maxVisited: 3, maxGenerated: 2, maxElapsedMs: 1 },
    ]);
    assert.equal(
      budgets.reduce((sum, budget) => sum + budget.maxVisited, 0),
      10,
    );
    assert.equal(
      budgets.reduce((sum, budget) => sum + budget.maxGenerated, 0),
      8,
    );
    assert.equal(
      budgets.reduce((sum, budget) => sum + budget.maxElapsedMs, 0),
      5,
    );
  });

  it("does not manufacture one-state shares when the budget is smaller than the lane count", () => {
    assert.deepEqual(allocateParallelRewriteBudgets(3, 1, 2, 1), [
      { maxVisited: 1, maxGenerated: 1, maxElapsedMs: 1 },
      { maxVisited: 0, maxGenerated: 1, maxElapsedMs: 0 },
      { maxVisited: 0, maxGenerated: 0, maxElapsedMs: 0 },
    ]);
  });

  it("leaves an unspecified generated-state ceiling unbounded", () => {
    const budgets = allocateParallelRewriteBudgets(2, 4, undefined, 2);
    assert.deepEqual(budgets.map(({ maxGenerated }) => maxGenerated), [
      Infinity,
      Infinity,
    ]);
  });

  it("produces unique IDs for different candidates on the same pass", () => {
    const sol = makeSolution(200);
    const plan0 = solutionImprovementPlan(dummyState, sol, 1000, 1, profile, 0);
    const plan1 = solutionImprovementPlan(dummyState, sol, 1000, 1, profile, 1);
    const plan2 = solutionImprovementPlan(dummyState, sol, 1000, 1, profile, 2);

    assert.notEqual(plan0.id, plan1.id);
    assert.notEqual(plan0.id, plan2.id);
    assert.notEqual(plan1.id, plan2.id);
  });

  it("produces unique IDs for the same candidate on different passes", () => {
    const sol = makeSolution(200);
    const planP1 = solutionImprovementPlan(dummyState, sol, 1000, 1, profile, 0);
    const planP2 = solutionImprovementPlan(dummyState, sol, 1000, 2, profile, 0);

    assert.notEqual(planP1.id, planP2.id);
  });

  it("produces unique IDs across all candidate-pass combinations", () => {
    const sol = makeSolution(200);
    const ids = new Set<string>();
    for (let candidate = 0; candidate < 3; candidate++) {
      for (let pass = 1; pass <= 3; pass++) {
        const plan = solutionImprovementPlan(
          dummyState, sol, 1000, pass, profile, candidate,
        );
        assert.ok(
          !ids.has(plan.id),
          `Duplicate plan ID: ${plan.id}`,
        );
        ids.add(plan.id);
      }
    }
    assert.equal(ids.size, 9);
  });

  it("includes candidate and pass in the ID format", () => {
    const sol = makeSolution(200);
    const plan = solutionImprovementPlan(dummyState, sol, 1000, 2, profile, 1);
    assert.match(plan.id, /c1/);
    assert.match(plan.id, /p2/);
  });

  it("includes candidate and pass in the label", () => {
    const sol = makeSolution(200);
    const plan = solutionImprovementPlan(dummyState, sol, 1000, 2, profile, 1);
    assert.match(plan.label, /c1/);
    assert.match(plan.label, /p2/);
  });

  it("defaults candidateIndex to 0 when omitted", () => {
    const sol = makeSolution(200);
    const plan = solutionImprovementPlan(dummyState, sol, 1000, 1, profile);
    assert.match(plan.id, /c0/);
  });

  it("passes an independent generated-state budget to the rewrite engine", () => {
    const sol = makeSolution(200);
    const plan = solutionImprovementPlan(
      dummyState,
      sol,
      1000,
      1,
      profile,
      0,
      321,
    );
    assert.equal(plan.payload.maxVisited, 1000);
    assert.equal(plan.payload.maxGenerated, 321);
  });
});
