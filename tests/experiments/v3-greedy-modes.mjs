/**
 * V3 greedy mode test: test constraint-aware and wide randomization modes.
 */
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession } from "../../src/core/index.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { solutionFromLegacyPath, toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";

globalThis.postMessage = () => {};

const huge = PUZZLE_BY_ID.huge;
const session = createSession(huge);
const request = {
  board: session.board,
  snapshot: session.snapshot,
  objective: { kind: "moves" },
};
const state = toLegacyState(request);

console.log("--- Plan ---");
const planResult = search({
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
});

if (planResult.status !== "solved") {
  console.log(`Plan failed: ${planResult.status}`);
  process.exit(1);
}

const rawSolution = solutionFromLegacyPath(request, planResult.path);
console.log(`Raw: m=${rawSolution.moves} p=${rawSolution.pushes} w=${rawSolution.moves - rawSolution.pushes}`);

// Test different attempt counts with constraint-aware + wide modes
for (const attempts of [32, 64, 256, 512]) {
  console.log(`\n--- Greedy (${attempts} attempts, mixed modes) ---`);
  const started = performance.now();
  const result = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: planResult.path,
    maxVisited: 1,
    greedyPermutation: true,
    greedyAttempts: attempts,
    permutationVisited: 0,
    windowTotalVisited: 0,
    moveWindowVisited: 0,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);
  console.log(`Diag: ${JSON.stringify(result.greedyDiag)}`);
  console.log(`Improvement: ${result.greedyImprovement} | ${ms}ms`);
  if (result.greedyImprovement > 0 && result.path) {
    const sol = solutionFromLegacyPath(request, result.path);
    console.log(`Result: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);
  }
}
