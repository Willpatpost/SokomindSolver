/**
 * V3 marathon rewrite: designed for long-running optimization.
 * Phase 1: Plan-macro-beam
 * Phase 2: Multiple rewrite rounds with escalating parameters
 *   Round 1: Standard parameters (fast)
 *   Round 2-3: Medium parameters
 *   Round 4-6: Large permutation windows
 *   Round 7-9: Very large windows + aggressive move optimization
 *   Round 10+: Mega windows with huge budgets
 * Each round uses the previous round's result as input.
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

// Phase 1
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

// Rewrite parameter tiers
const tiers = [
  { name: "standard", permVis: 150_000, permWin: [8, 16, 32, 48], perPerm: 2000,
    winPush: [8, 16, 32, 48], winVis: 30_000, winTotal: 200_000,
    moveVis: 100_000, movePush: [1, 2, 4, 8], moveAttempts: 20,
    moveMin: 3, perMove: 3000, moveExtra: 6, maxVis: 500_000 },
  { name: "medium", permVis: 300_000, permWin: [8, 16, 32, 48, 64], perPerm: 4000,
    winPush: [8, 16, 32, 48, 64], winVis: 50_000, winTotal: 300_000,
    moveVis: 150_000, movePush: [1, 2, 4, 8, 16], moveAttempts: 30,
    moveMin: 2, perMove: 5000, moveExtra: 8, maxVis: 800_000 },
  { name: "large", permVis: 500_000, permWin: [16, 32, 48, 64, 96], perPerm: 8000,
    winPush: [16, 32, 48, 64, 96], winVis: 80_000, winTotal: 500_000,
    moveVis: 200_000, movePush: [1, 2, 4, 8, 16, 32], moveAttempts: 40,
    moveMin: 1, perMove: 8000, moveExtra: 10, maxVis: 1_200_000 },
  { name: "mega", permVis: 800_000, permWin: [32, 48, 64, 96, 128], perPerm: 12000,
    winPush: [32, 48, 64, 96], winVis: 100_000, winTotal: 800_000,
    moveVis: 300_000, movePush: [1, 2, 4, 8, 16, 32], moveAttempts: 50,
    moveMin: 1, perMove: 10000, moveExtra: 12, maxVis: 2_000_000 },
];

const MAX_ROUNDS = 20;
let totalRewriteMs = 0;

for (let round = 0; round < MAX_ROUNDS; round++) {
  const tier = tiers[Math.min(Math.floor(round / 3), tiers.length - 1)];
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;

  const params = {
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: tier.maxVis,
    greedyPermutation: false,
    permutationVisited: tier.permVis,
    permutationWindowPushes: tier.permWin,
    perPermutationWindowVisited: tier.perPerm,
    windowPushes: tier.winPush,
    windowVisited: tier.winVis,
    windowTotalVisited: tier.winTotal,
    moveWindowVisited: tier.moveVis,
    moveWindowPushes: tier.movePush,
    moveWindowAttempts: tier.moveAttempts,
    moveWindowMinimumOverhead: tier.moveMin,
    perMoveWindowVisited: tier.perMove,
    moveWindowExtraPushes: tier.moveExtra,
    progressIntervalMs: 60_000,
  };

  console.log(`\n--- Round ${round + 1} (${tier.name}, from ${prevMoves} moves) ---`);
  const rewriteStarted = performance.now();
  const result = search(params);
  const rewriteMs = Math.round(performance.now() - rewriteStarted);
  totalRewriteMs += rewriteMs;

  if (!result.path) {
    console.log(`  No improvement | ${Math.round(rewriteMs/1000)}s`);
    continue;
  }

  const sol = solutionFromLegacyPath(request, result.path);
  const valid = verifySolverSolution(request, sol).valid;
  const delta = sol.moves - prevMoves;

  if (delta >= 0) {
    console.log(`  No improvement (${sol.moves} >= ${prevMoves}) | ${Math.round(rewriteMs/1000)}s`);
    continue;
  }

  console.log(`  Result: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | impr=${result.improvements} moveImpr=${result.moveImprovements} permImpr=${result.permutationImprovements} | ${Math.round(rewriteMs/1000)}s | delta=${delta} | valid=${valid}`);

  currentPath = result.path;

  if (sol.moves < 700) {
    console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
    break;
  }

  // After 2 consecutive rounds with <3 improvement in the same tier, move to next tier
  if (Math.abs(delta) < 3 && round >= 2) {
    const tierIndex = Math.min(Math.floor(round / 3), tiers.length - 1);
    if (tierIndex >= tiers.length - 1) {
      console.log("  (converged at max tier)");
      break;
    }
  }
}

const finalSol = solutionFromLegacyPath(request, currentPath);
const finalValid = verifySolverSolution(request, finalSol).valid;
console.log(`\n=== FINAL: ${finalSol.moves} moves / ${finalSol.pushes} pushes / ${finalSol.moves - finalSol.pushes} walks | ${Math.round(totalRewriteMs/1000)}s | valid=${finalValid} ===`);
if (finalSol.moves < 700) {
  console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
}
