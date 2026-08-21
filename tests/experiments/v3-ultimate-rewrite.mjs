/**
 * V3 ultimate rewrite: enhanced greedy (16 attempts) + iterative window rewrite.
 * Alternates greedy permutation and window rewrite passes until convergence.
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
const planStarted = performance.now();
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
const planMs = Math.round(performance.now() - planStarted);

if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
  console.log(`Plan failed: ${planResult.status} | ${planMs}ms`);
  process.exit(1);
}

let currentPath = planResult.path;
const rawSolution = solutionFromLegacyPath(request, currentPath);
console.log(`Raw: m=${rawSolution.moves} p=${rawSolution.pushes} w=${rawSolution.moves - rawSolution.pushes} | ${planMs}ms`);

// Phase 2: iterative enhanced greedy + window rewrite
const MAX_PASSES = 12;
let totalRewriteMs = 0;
let passNumber = 0;

for (let pass = 0; pass < MAX_PASSES; pass++) {
  passNumber = pass + 1;
  const prevSolution = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSolution.moves;

  const rewriteParams = {
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: 600_000,
    // Enhanced greedy: 16 attempts with randomized tie-breaking
    greedyPermutation: true,
    greedyAttempts: 16,
    // Permutation: larger windows on later passes
    permutationVisited: 200_000,
    permutationWindowPushes: pass < 2 ? [8, 16, 32, 48] : [16, 32, 48, 64],
    perPermutationWindowVisited: pass < 2 ? 2000 : 3000,
    // Bridge A*
    windowPushes: [8, 16, 32, 48],
    windowVisited: 40_000,
    windowTotalVisited: 250_000,
    // Move window
    moveWindowVisited: 150_000,
    moveWindowPushes: [1, 2, 4, 8, 16],
    moveWindowAttempts: 30,
    moveWindowMinimumOverhead: 2,
    perMoveWindowVisited: 4000,
    moveWindowExtraPushes: 8,
    progressIntervalMs: 60_000,
  };

  console.log(`--- Pass ${passNumber} (from ${prevMoves} moves) ---`);
  const rewriteStarted = performance.now();
  const rewriteResult = search(rewriteParams);
  const rewriteMs = Math.round(performance.now() - rewriteStarted);
  totalRewriteMs += rewriteMs;

  if (!rewriteResult.path) {
    console.log(`  No improvement | ${Math.round(rewriteMs/1000)}s`);
    break;
  }

  const sol = solutionFromLegacyPath(request, rewriteResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  const delta = sol.moves - prevMoves;

  console.log(`  Result: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | greedy=${rewriteResult.greedyImprovement} impr=${rewriteResult.improvements} moveImpr=${rewriteResult.moveImprovements} permImpr=${rewriteResult.permutationImprovements} | ${Math.round(rewriteMs/1000)}s | delta=${delta} | valid=${valid}`);

  if (delta >= 0) {
    console.log("  (no improvement)");
    break;
  }

  currentPath = rewriteResult.path;

  if (sol.moves < 700) {
    console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
    break;
  }

  if (Math.abs(delta) < 3) {
    console.log("  (converged)");
    break;
  }
}

const finalSolution = solutionFromLegacyPath(request, currentPath);
const finalValid = verifySolverSolution(request, finalSolution).valid;
console.log(`\n=== FINAL: ${finalSolution.moves} moves / ${finalSolution.pushes} pushes / ${finalSolution.moves - finalSolution.pushes} walks | ${passNumber} passes | ${Math.round(totalRewriteMs/1000)}s | valid=${finalValid} ===`);
if (finalSolution.moves < 700) {
  console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
}
