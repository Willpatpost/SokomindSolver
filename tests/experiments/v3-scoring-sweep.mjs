/**
 * V3 scoring formula sweep with move-based dominance active.
 * Tests different combinations of push/move cost weights.
 */
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession } from "../../src/core/index.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { solutionFromLegacyPath, toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

globalThis.postMessage = () => {};

const huge = PUZZLE_BY_ID.huge;
const session = createSession(huge);
const request = {
  board: session.board,
  snapshot: session.snapshot,
  objective: { kind: "moves" },
};
const state = toLegacyState(request);

const BASE = {
  algorithm: "plan-macro-beam",
  state,
  maxDepth: 460,
  maxVisited: 6_000,
  transpositionLimit: 60_000,
  planBeamWidth: 32,
  planBoxBranches: 6,
  maxPlanSegments: 160,
  planSlack: 240,
  sequenceMacroLimit: 24,
  sequenceMacroExplored: 48,
  sequenceMacroResults: 4,
  targetedMacroExplored: 64,
  progressIntervalMs: 60_000,
};

const experiments = [
  // Baseline with move-dominance but default scoring (push=1, move=0)
  { name: "moveDom+defaultScore", o: {} },

  // Move cost replacing push cost entirely
  { name: "move=0.3,push=0", o: { planPushCostWeight: 0, planMoveCostWeight: 0.3, planEstimateWeight: 3 } },
  { name: "move=0.5,push=0", o: { planPushCostWeight: 0, planMoveCostWeight: 0.5, planEstimateWeight: 3 } },

  // Mixed: both push and move influence
  { name: "push=0.5,move=0.15", o: { planPushCostWeight: 0.5, planMoveCostWeight: 0.15 } },
  { name: "push=0.5,move=0.3", o: { planPushCostWeight: 0.5, planMoveCostWeight: 0.3 } },
  { name: "push=1,move=0.1", o: { planPushCostWeight: 1, planMoveCostWeight: 0.1 } },
  { name: "push=1,move=0.3", o: { planPushCostWeight: 1, planMoveCostWeight: 0.3 } },
  { name: "push=0.3,move=0.3", o: { planPushCostWeight: 0.3, planMoveCostWeight: 0.3 } },

  // Move cost with increased estimate weight
  { name: "push=0,move=0.3,est=4", o: { planPushCostWeight: 0, planMoveCostWeight: 0.3, planEstimateWeight: 4 } },
  { name: "push=0.3,move=0.2,est=2", o: { planPushCostWeight: 0.3, planMoveCostWeight: 0.2, planEstimateWeight: 2 } },
];

console.log(`=== V3 Scoring Sweep (move-dominance active) ===`);
console.log(`Date: ${new Date().toISOString()}`);
console.log(`Experiments: ${experiments.length}`);
console.log("");

for (const exp of experiments) {
  const params = { ...BASE, ...exp.o };
  const started = performance.now();
  const result = search(params);
  const elapsedMs = Math.round(performance.now() - started);

  if (result.status === "solved" && Array.isArray(result.path)) {
    const solution = solutionFromLegacyPath(request, result.path);
    const valid = verifySolverSolution(request, solution).valid;
    console.log(`[${exp.name}] moves=${solution.moves} pushes=${solution.pushes} walks=${solution.moves - solution.pushes} | vis=${result.visited} gen=${result.generated} ret=${result.retained} | ${elapsedMs}ms | valid=${valid}`);
  } else {
    console.log(`[${exp.name}] ${result.status} | vis=${result.visited} gen=${result.generated} | ${elapsedMs}ms`);
  }
}
