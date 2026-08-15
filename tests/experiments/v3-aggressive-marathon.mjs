/**
 * Aggressive marathon: Phase 1 does plan + one standard rewrite pass,
 * then immediately jumps to large/mega windows for deeper optimization.
 * Also tries much larger move-window budgets to reduce walk costs.
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
console.log(`Raw: m=${rawSolution.moves} p=${rawSolution.pushes} w=${rawSolution.moves - rawSolution.pushes} | ${Math.round(planMs/1000)}s`);

// Phase 2: Quick standard rewrite to baseline (~880)
console.log("\n--- Phase 2: standard rewrite to baseline ---");
const baseStarted = performance.now();
const baseResult = search({
  algorithm: "solution-window-rewrite",
  state,
  solutionPath: currentPath,
  maxVisited: 500_000,
  greedyPermutation: false,
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
const baseMs = Math.round(performance.now() - baseStarted);

if (baseResult.path) {
  const sol = solutionFromLegacyPath(request, baseResult.path);
  console.log(`Baseline: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | ${Math.round(baseMs/1000)}s`);
  currentPath = baseResult.path;
} else {
  console.log(`Baseline: no improvement | ${Math.round(baseMs/1000)}s`);
}

// Phase 3: Aggressive rewrite rounds with large/mega windows
const tiers = [
  // Start with medium-large windows
  { name: "medium-large", permVis: 400_000, permWin: [16, 32, 48, 64, 96], perPerm: 6000,
    winPush: [16, 32, 48, 64], winVis: 60_000, winTotal: 400_000,
    moveVis: 200_000, movePush: [1, 2, 4, 8, 16], moveAttempts: 30,
    moveMin: 2, perMove: 6000, moveExtra: 8, maxVis: 1_000_000 },
  // Large windows
  { name: "large", permVis: 600_000, permWin: [32, 48, 64, 96, 128], perPerm: 10000,
    winPush: [32, 48, 64, 96], winVis: 80_000, winTotal: 600_000,
    moveVis: 250_000, movePush: [1, 2, 4, 8, 16, 32], moveAttempts: 40,
    moveMin: 1, perMove: 8000, moveExtra: 10, maxVis: 1_500_000 },
  // Mega windows with huge budgets
  { name: "mega", permVis: 1_000_000, permWin: [48, 64, 96, 128, 160], perPerm: 15000,
    winPush: [32, 48, 64, 96, 128], winVis: 120_000, winTotal: 1_000_000,
    moveVis: 400_000, movePush: [1, 2, 4, 8, 16, 32], moveAttempts: 60,
    moveMin: 1, perMove: 12000, moveExtra: 14, maxVis: 2_500_000 },
  // Ultra: very large windows for final push
  { name: "ultra", permVis: 1_500_000, permWin: [64, 96, 128, 160, 200], perPerm: 20000,
    winPush: [48, 64, 96, 128], winVis: 150_000, winTotal: 1_500_000,
    moveVis: 500_000, movePush: [1, 2, 4, 8, 16, 32, 48], moveAttempts: 80,
    moveMin: 1, perMove: 15000, moveExtra: 16, maxVis: 3_000_000 },
];

const MAX_ROUNDS = 30;
let totalRewriteMs = 0;
let staleCount = 0;

for (let round = 0; round < MAX_ROUNDS; round++) {
  const tierIdx = Math.min(Math.floor(round / 4), tiers.length - 1);
  const tier = tiers[tierIdx];
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;

  console.log(`\n--- Round ${round + 1} (${tier.name}, from ${prevMoves} moves) ---`);
  const rewriteStarted = performance.now();
  const result = search({
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
  });
  const rewriteMs = Math.round(performance.now() - rewriteStarted);
  totalRewriteMs += rewriteMs;

  if (!result.path) {
    console.log(`  No path returned | ${Math.round(rewriteMs/1000)}s`);
    staleCount++;
    if (staleCount >= 3 && tierIdx >= tiers.length - 1) {
      console.log("  (converged at max tier, 3 consecutive stale)");
      break;
    }
    continue;
  }

  const sol = solutionFromLegacyPath(request, result.path);
  const valid = verifySolverSolution(request, sol).valid;
  const delta = sol.moves - prevMoves;

  if (delta >= 0) {
    console.log(`  No improvement (${sol.moves} >= ${prevMoves}) | ${Math.round(rewriteMs/1000)}s`);
    staleCount++;
    if (staleCount >= 3 && tierIdx >= tiers.length - 1) {
      console.log("  (converged at max tier, 3 consecutive stale)");
      break;
    }
    continue;
  }

  staleCount = 0;
  console.log(`  Result: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | impr=${result.improvements} moveImpr=${result.moveImprovements} permImpr=${result.permutationImprovements} | ${Math.round(rewriteMs/1000)}s | delta=${delta} | valid=${valid}`);
  currentPath = result.path;

  if (sol.moves < 700) {
    console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
    break;
  }
}

const finalSol = solutionFromLegacyPath(request, currentPath);
const finalValid = verifySolverSolution(request, finalSol).valid;
console.log(`\n=== FINAL: ${finalSol.moves} moves / ${finalSol.pushes} pushes / ${finalSol.moves - finalSol.pushes} walks | ${Math.round(totalRewriteMs/1000)}s | valid=${finalValid} ===`);
if (finalSol.moves < 700) {
  console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
}
