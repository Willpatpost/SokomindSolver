/**
 * Test the effect of planSolutionComparisonBudget on beam-128 plans.
 * Default is 96 — higher values let the search find better solutions
 * in the same layer where the first solution was found.
 */
import { writeFileSync } from "node:fs";
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

const budgets = [96, 500, 2000, 10000];

for (const budget of budgets) {
  console.log(`\n=== planSolutionComparisonBudget = ${budget} ===`);
  const started = performance.now();
  const planResult = search({
    algorithm: "plan-macro-beam",
    state,
    maxDepth: 460,
    maxVisited: 24_000,
    transpositionLimit: 240_000,
    planBeamWidth: 128,
    planBoxBranches: 6,
    maxPlanSegments: 160,
    planSlack: 240,
    sequenceMacroLimit: 24,
    sequenceMacroExplored: 48,
    sequenceMacroResults: 4,
    targetedMacroExplored: 64,
    planSolutionComparisonBudget: budget,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);

  if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
    console.log(`  FAILED (${planResult.status}) | ${Math.round(ms/1000)}s`);
    continue;
  }

  const sol = solutionFromLegacyPath(request, planResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  console.log(`  m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid} | ${Math.round(ms/1000)}s`);
  console.log(`  solutionCandidates=${planResult.solutionCandidates} comparisonStates=${planResult.solutionComparisonStates}`);

  if (valid && sol.pushes < 290) {
    console.log(`  *** FEWER PUSHES THAN BEAM-128 DEFAULT (${sol.pushes} < 290) ***`);
    writeFileSync(`/tmp/v3-b128-comp${budget}-path.json`, JSON.stringify(planResult.path));
  }
}
