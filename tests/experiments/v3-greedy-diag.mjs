/**
 * V3 greedy diagnostic: test enhanced greedy (16 attempts) and report failure details.
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

// Phase 1: plan-macro-beam
console.log("--- Phase 1: plan-macro-beam ---");
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

if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
  console.log(`Plan failed: ${planResult.status}`);
  process.exit(1);
}

const rawSolution = solutionFromLegacyPath(request, planResult.path);
console.log(`Raw: m=${rawSolution.moves} p=${rawSolution.pushes} w=${rawSolution.moves - rawSolution.pushes}`);

// Phase 2: test greedy with diagnostics
console.log("\n--- Phase 2: greedy diagnostic (16 attempts) ---");
const rewriteResult = search({
  algorithm: "solution-window-rewrite",
  state,
  solutionPath: planResult.path,
  maxVisited: 500_000,
  greedyPermutation: true,
  greedyAttempts: 16,
  permutationVisited: 150_000,
  permutationWindowPushes: [8, 16, 32, 48],
  perPermutationWindowVisited: 2000,
  windowPushes: [8, 16, 32, 48],
  windowVisited: 30_000,
  windowTotalVisited: 200_000,
  moveWindowVisited: 100_000,
  moveWindowPushes: [1, 2, 4, 8],
  moveWindowAttempts: 20,
  moveWindowMinimumOverhead: 3,
  perMoveWindowVisited: 3000,
  moveWindowExtraPushes: 6,
  progressIntervalMs: 60_000,
});

console.log("\nGreedy diagnostics:", JSON.stringify(rewriteResult.greedyDiag, null, 2));
console.log(`Greedy improvement: ${rewriteResult.greedyImprovement}`);

if (rewriteResult.path) {
  const sol = solutionFromLegacyPath(request, rewriteResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  console.log(`\nResult: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | impr=${rewriteResult.improvements} moveImpr=${rewriteResult.moveImprovements} permImpr=${rewriteResult.permutationImprovements} | valid=${valid}`);
  console.log(`\n=== FINAL: ${sol.moves} moves / ${sol.pushes} pushes / ${sol.moves - sol.pushes} walks ===`);
} else {
  console.log("No improvement");
}
