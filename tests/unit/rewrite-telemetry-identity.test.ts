import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  sokomindRewriteConcurrency,
  solutionImprovementPlan,
} from "../../src/solver/implementations/sokomind-solver.ts";
import { dividedIntegerBudget } from "../../src/solver/implementations/sokomind-plans.ts";
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
  it("bounds rewrite concurrency by workers, memory, and candidate count", () => {
    const mib = 1024 * 1024;
    assert.equal(sokomindRewriteConcurrency(3, 512 * mib, 3), 1);
    assert.equal(sokomindRewriteConcurrency(3, 1024 * mib, 3), 2);
    assert.equal(sokomindRewriteConcurrency(3, 2048 * mib, 2), 2);
    assert.equal(sokomindRewriteConcurrency(1, undefined, 3), 1);
    assert.equal(sokomindRewriteConcurrency(3, undefined, 0), 0);
  });

  it("splits a budget into disjoint integer shares", () => {
    const shares = dividedIntegerBudget(10, 3);
    assert.deepEqual(shares, [4, 3, 3]);
    assert.equal(shares.reduce((sum, share) => sum + share, 0), 10);
  });

  it("does not manufacture one-state shares when the budget is smaller than the lane count", () => {
    assert.deepEqual(dividedIntegerBudget(1, 3), [1, 0, 0]);
    assert.deepEqual(dividedIntegerBudget(5, 0), []);
  });

  it("leaves an unbounded budget unbounded in every share", () => {
    assert.deepEqual(dividedIntegerBudget(Infinity, 2), [Infinity, Infinity]);
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
