import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SolverSolution, SolutionStep } from "../../src/solver/contracts.ts";
import type { RepairOperator } from "../../src/solver/implementations/sokomind-candidate-archive.ts";
import { repairPlan, type RepairPlanInput } from "../../src/solver/implementations/sokomind-improvement.ts";
import { DEFAULT_REWRITE_BUDGET_ALLOCATION } from "../../src/solver/implementations/sokomind-plans.ts";
import { resolveSokomindTuning } from "../../src/solver/implementations/sokomind-tuning.ts";

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

const input: RepairPlanInput = {
  state: { rows: ["OOOOO", "O R O", "O X O", "O s O", "OOOOO"], robot: [1, 2], boxes: [["2,2", "X"]] },
  solution: makeSolution(30),
  maxVisited: 1000,
  maxGenerated: 8000,
  maxElapsedMs: 500,
  pass: 2,
  profile: resolveSokomindTuning(),
  candidateIndex: 1,
  allocation: DEFAULT_REWRITE_BUDGET_ALLOCATION,
  diagnostics: false,
  rescheduleRounds: 8,
  context: {
    boxPairs: [[0, 1]],
    targetOverrides: { 0: "S" },
    prioritizedWindows: [{ startPush: 0, endPush: 4, maxVisited: 100 }],
  },
};

describe("repair operator dispatch", () => {
  it("gives every repair operator its engine plan", () => {
    // Keyed by operator, so a new operator does not typecheck until it is listed.
    const expected: Record<RepairOperator, readonly [string, string]> = {
      "window": ["solution-rewrite-c1-p2", "solution-window-rewrite"],
      "perturb-and-repair": ["solution-rewrite-c1-p2", "solution-window-rewrite"],
      "box": ["solution-reschedule-c1", "solution-box-reschedule"],
      "goal-reassignment": ["solution-reschedule-c1", "solution-box-reschedule"],
      "two-box": ["solution-reschedule-2box-c1", "solution-box-reschedule"],
      "dependency-window": ["solution-dep-window-c1", "solution-window-rewrite"],
    };
    for (const [operator, [id, algorithm]] of Object.entries(expected)) {
      const plan = repairPlan(operator as RepairOperator, input);
      assert.equal(plan.id, id, operator);
      assert.equal(plan.payload.algorithm, algorithm, operator);
    }
  });

  it("runs perturb-and-repair as the window rewrite", () => {
    assert.deepEqual(repairPlan("perturb-and-repair", input), repairPlan("window", input));
  });

  it("passes each operator its repair context", () => {
    assert.equal(repairPlan("box", input).payload.rescheduleRounds, 8);
    assert.deepEqual(repairPlan("goal-reassignment", input).payload.rescheduleTargetOverrides, { 0: "S" });
    assert.deepEqual(repairPlan("two-box", input).payload.rescheduleBoxPairs, [[0, 1]]);
    assert.deepEqual(repairPlan("dependency-window", input).payload.prioritizedWindows, input.context?.prioritizedWindows);
    assert.equal(repairPlan("window", input).payload.prioritizedWindows, undefined);
  });
});
