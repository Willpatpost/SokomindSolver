/**
 * V3 greedy-only: just run greedy permutation (no window rewrite) for fast diagnostics.
 * Reports how many pushes complete before getting stuck.
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

// Greedy-only: run rewrite with only greedy, no permutation/bridge/move windows
console.log("\n--- Greedy only (16 attempts) ---");
const greedyResult = search({
  algorithm: "solution-window-rewrite",
  state,
  solutionPath: planResult.path,
  maxVisited: 1,
  greedyPermutation: true,
  greedyAttempts: 16,
  permutationVisited: 0,
  windowTotalVisited: 0,
  moveWindowVisited: 0,
  progressIntervalMs: 60_000,
});

console.log("Greedy diag:", JSON.stringify(greedyResult.greedyDiag, null, 2));
console.log(`Greedy improvement: ${greedyResult.greedyImprovement}`);
if (greedyResult.path) {
  const sol = solutionFromLegacyPath(request, greedyResult.path);
  console.log(`Greedy result: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);
}

// Also test with 64 and 128 attempts
for (const attempts of [64, 128]) {
  console.log(`\n--- Greedy only (${attempts} attempts) ---`);
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
  console.log("Diag:", JSON.stringify(result.greedyDiag, null, 2));
  console.log(`Improvement: ${result.greedyImprovement}`);
  if (result.path) {
    const sol = solutionFromLegacyPath(request, result.path);
    console.log(`Result: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);
  }
}
