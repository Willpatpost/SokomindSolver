/**
 * V3 full permutation: run pushPermutationSearch on the ENTIRE solution
 * with a large visited budget. Tests whether A* can find a good global ordering.
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

// Full-solution permutation with very large budget
console.log("\n--- Full solution permutation ---");
const rewriteStarted = performance.now();
const rewriteResult = search({
  algorithm: "solution-window-rewrite",
  state,
  solutionPath: planResult.path,
  maxVisited: 2_000_000,
  greedyPermutation: false,
  // Single permutation window covering ALL pushes
  permutationVisited: 2_000_000,
  permutationWindowPushes: [316],
  perPermutationWindowVisited: 2_000_000,
  // No bridge A* or move windows
  windowTotalVisited: 0,
  moveWindowVisited: 0,
  progressIntervalMs: 30_000,
});
const rewriteMs = Math.round(performance.now() - rewriteStarted);

console.log(`Permutation: vis=${rewriteResult.permutationVisited} gen=${rewriteResult.permutationGenerated} windows=${rewriteResult.permutationWindows} impr=${rewriteResult.permutationImprovements} | ${Math.round(rewriteMs/1000)}s`);

if (rewriteResult.path) {
  const sol = solutionFromLegacyPath(request, rewriteResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  console.log(`Result: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid}`);
  console.log(`\n=== FINAL: ${sol.moves} moves / ${sol.pushes} pushes / ${sol.moves - sol.pushes} walks ===`);
} else {
  console.log("No improvement found");
}
