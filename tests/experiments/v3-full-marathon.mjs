/**
 * Full marathon: Uses ALL engine features for maximum walk reduction.
 * Phase 1: plan-macro-beam → 1010 moves
 * Phase 2: Standard convergence to ~830
 * Phase 3: Enhanced rewrite with: weighted heuristic, MST heuristic,
 *   bidirectional permutation + bridge, coarse identity, offset passes,
 *   targeted permutation, bridge extra pushes, weighted move bridge
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

// Phase 1: plan
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

let currentPath = planResult.path;
let sol = solutionFromLegacyPath(request, currentPath);
console.log(`Raw: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);

// Phase 2: Converge to baseline
console.log("\n--- Phase 2: converge to baseline ---");
for (let pass = 0; pass < 6; pass++) {
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;
  const result = search({
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

  if (!result.path) {
    console.log(`  Pass ${pass + 1}: no improvement (converged at ${prevMoves})`);
    break;
  }

  const passSol = solutionFromLegacyPath(request, result.path);
  const delta = passSol.moves - prevMoves;
  if (delta >= 0) {
    console.log(`  Pass ${pass + 1}: no improvement (converged at ${prevMoves})`);
    break;
  }
  currentPath = result.path;
  console.log(`  Pass ${pass + 1}: m=${passSol.moves} p=${passSol.pushes} w=${passSol.moves - passSol.pushes} | delta=${delta}`);
}

sol = solutionFromLegacyPath(request, currentPath);
console.log(`Baseline converged: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);

// Phase 3: Full-featured iterative rewrite
const tiers = [
  // Tier 1: medium + MST + offset + targeted + bridge bidirectional
  { name: "medium-mst", hWeight: 3, bidir: true, coarse: false, mbWeight: 1.5,
    mst: true, extraPasses: 1, targeted: 15,
    bridgeBidir: true, bridgeExtra: 2, bridgeWt: 1.2,
    permVis: 400_000, permWin: [16, 32, 48], perPerm: 5000,
    winPush: [16, 32, 48], winVis: 50_000, winTotal: 400_000,
    moveVis: 200_000, movePush: [1, 2, 4, 8, 16], moveAttempts: 40,
    moveMin: 2, perMove: 6000, moveExtra: 8, moveRandom: 80, maxVis: 1_000_000 },
  // Tier 2: medium-large + all features
  { name: "large-mst", hWeight: 5, bidir: true, coarse: true, mbWeight: 2.0,
    mst: true, extraPasses: 2, targeted: 25,
    bridgeBidir: true, bridgeExtra: 2, bridgeWt: 1.3,
    permVis: 800_000, permWin: [32, 48, 64], perPerm: 10000,
    winPush: [32, 48, 64], winVis: 80_000, winTotal: 600_000,
    moveVis: 300_000, movePush: [1, 2, 4, 8, 16, 32], moveAttempts: 50,
    moveMin: 1, perMove: 8000, moveExtra: 10, moveRandom: 120, maxVis: 1_500_000 },
  // Tier 3: large + all features maxed
  { name: "mega-mst", hWeight: 5, bidir: true, coarse: true, mbWeight: 2.5,
    mst: true, extraPasses: 2, targeted: 40,
    bridgeBidir: true, bridgeExtra: 3, bridgeWt: 1.4,
    permVis: 1_200_000, permWin: [48, 64, 96], perPerm: 15000,
    winPush: [48, 64, 96, 128], winVis: 120_000, winTotal: 1_000_000,
    moveVis: 400_000, movePush: [1, 2, 4, 8, 16, 32, 48], moveAttempts: 60,
    moveMin: 1, perMove: 12000, moveExtra: 14, moveRandom: 160, maxVis: 2_500_000 },
  // Tier 4: ultra + everything
  { name: "ultra-mst", hWeight: 8, bidir: true, coarse: true, mbWeight: 3.0,
    mst: true, extraPasses: 2, targeted: 50,
    bridgeBidir: true, bridgeExtra: 4, bridgeWt: 1.5,
    permVis: 1_500_000, permWin: [64, 96, 128], perPerm: 20000,
    winPush: [64, 96, 128], winVis: 150_000, winTotal: 1_500_000,
    moveVis: 500_000, movePush: [1, 2, 4, 8, 16, 32, 48], moveAttempts: 80,
    moveMin: 1, perMove: 15000, moveExtra: 16, moveRandom: 200, maxVis: 3_000_000 },
];

const MAX_ROUNDS = 48;
let totalRewriteMs = 0;
let staleCount = 0;

for (let round = 0; round < MAX_ROUNDS; round++) {
  const tierIdx = Math.min(Math.floor(round / 3), tiers.length - 1);
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
    permutationHeuristicWeight: tier.hWeight,
    permutationBidirectional: tier.bidir,
    permutationCoarseIdentity: tier.coarse,
    permutationExtraPasses: tier.extraPasses,
    permutationTargetedPasses: tier.targeted,
    permutationMSTHeuristic: tier.mst,
    bridgeBidirectional: tier.bridgeBidir,
    bridgeExtraPushes: tier.bridgeExtra,
    bridgeWeight: tier.bridgeWt,
    windowPushes: tier.winPush,
    windowVisited: tier.winVis,
    windowTotalVisited: tier.winTotal,
    moveWindowVisited: tier.moveVis,
    moveWindowPushes: tier.movePush,
    moveWindowAttempts: tier.moveAttempts,
    moveWindowMinimumOverhead: tier.moveMin,
    perMoveWindowVisited: tier.perMove,
    moveWindowExtraPushes: tier.moveExtra,
    moveWindowRandomAttempts: tier.moveRandom,
    moveBridgeWeight: tier.mbWeight,
    progressIntervalMs: 60_000,
  });
  const rewriteMs = Math.round(performance.now() - rewriteStarted);
  totalRewriteMs += rewriteMs;

  if (!result.path) {
    console.log(`  No path returned | ${Math.round(rewriteMs/1000)}s`);
    staleCount++;
    if (staleCount >= 4 && tierIdx >= tiers.length - 1) {
      console.log("  (converged at max tier)");
      break;
    }
    continue;
  }

  const roundSol = solutionFromLegacyPath(request, result.path);
  const valid = verifySolverSolution(request, roundSol).valid;
  const delta = roundSol.moves - prevMoves;

  if (delta >= 0) {
    console.log(`  No improvement (${roundSol.moves} >= ${prevMoves}) | ${Math.round(rewriteMs/1000)}s`);
    staleCount++;
    if (staleCount >= 4 && tierIdx >= tiers.length - 1) {
      console.log("  (converged at max tier)");
      break;
    }
    continue;
  }

  staleCount = 0;
  console.log(`  Result: m=${roundSol.moves} p=${roundSol.pushes} w=${roundSol.moves - roundSol.pushes} | impr=${result.improvements} moveImpr=${result.moveImprovements} permImpr=${result.permutationImprovements} | ${Math.round(rewriteMs/1000)}s | delta=${delta} | valid=${valid}`);
  currentPath = result.path;

  if (roundSol.moves < 700) {
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
