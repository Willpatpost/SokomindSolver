/**
 * Loads a saved baseline path and applies enhanced optimization.
 * Run v3-save-baseline.mjs first to generate the path file.
 *
 * Usage: node --experimental-strip-types tests/experiments/v3-from-baseline.mjs [path-file]
 *   Default path file: /tmp/v3-baseline-path.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession } from "../../src/core/index.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { solutionFromLegacyPath, toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

globalThis.postMessage = () => {};

const pathFile = process.argv[2] || "/tmp/v3-baseline-path.json";
if (!existsSync(pathFile)) {
  console.log(`Path file not found: ${pathFile}`);
  console.log("Run v3-save-baseline.mjs first.");
  process.exit(1);
}

const huge = PUZZLE_BY_ID.huge;
const session = createSession(huge);
const request = {
  board: session.board,
  snapshot: session.snapshot,
  objective: { kind: "moves" },
};
const state = toLegacyState(request);

let currentPath = JSON.parse(readFileSync(pathFile, "utf-8"));
let sol = solutionFromLegacyPath(request, currentPath);
const valid0 = verifySolverSolution(request, sol).valid;
console.log(`Loaded baseline: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid0}`);

if (!valid0) {
  console.log("INVALID baseline path!");
  process.exit(1);
}

// Enhanced iterative rewrite with ALL features
const tiers = [
  // Tier 1: standard re-optimization with bidirectional + bridge improvements
  { name: "standard-bidir", hWeight: 0, bidir: true, coarse: false, mbWeight: 1.5,
    mst: false, extraPasses: 0, targeted: 0,
    bridgeBidir: true, bridgeExtra: 2, bridgeWt: 1.2,
    permVis: 200_000, permWin: [8, 16, 32, 48], perPerm: 3000,
    winPush: [8, 16, 32, 48], winVis: 40_000, winTotal: 250_000,
    moveVis: 150_000, movePush: [1, 2, 4, 8], moveAttempts: 25,
    moveMin: 2, perMove: 4000, moveExtra: 6, moveRandom: 50, maxVis: 600_000 },
  // Tier 2: medium + MST + offset + targeted
  { name: "medium-mst", hWeight: 3, bidir: true, coarse: false, mbWeight: 2.0,
    mst: true, extraPasses: 1, targeted: 15,
    bridgeBidir: true, bridgeExtra: 2, bridgeWt: 1.3,
    permVis: 400_000, permWin: [16, 32, 48], perPerm: 6000,
    winPush: [16, 32, 48], winVis: 50_000, winTotal: 400_000,
    moveVis: 200_000, movePush: [1, 2, 4, 8, 16], moveAttempts: 40,
    moveMin: 2, perMove: 6000, moveExtra: 8, moveRandom: 80, maxVis: 1_000_000 },
  // Tier 3: medium-large + all features, coarse
  { name: "large-mst", hWeight: 5, bidir: true, coarse: true, mbWeight: 2.5,
    mst: true, extraPasses: 2, targeted: 25,
    bridgeBidir: true, bridgeExtra: 3, bridgeWt: 1.4,
    permVis: 800_000, permWin: [32, 48, 64], perPerm: 10000,
    winPush: [32, 48, 64], winVis: 80_000, winTotal: 600_000,
    moveVis: 300_000, movePush: [1, 2, 4, 8, 16, 32], moveAttempts: 50,
    moveMin: 1, perMove: 8000, moveExtra: 10, moveRandom: 120, maxVis: 1_500_000 },
  // Tier 4: large + everything maxed
  { name: "mega-mst", hWeight: 5, bidir: true, coarse: true, mbWeight: 3.0,
    mst: true, extraPasses: 2, targeted: 40,
    bridgeBidir: true, bridgeExtra: 4, bridgeWt: 1.5,
    permVis: 1_200_000, permWin: [48, 64, 96], perPerm: 15000,
    winPush: [48, 64, 96, 128], winVis: 120_000, winTotal: 1_000_000,
    moveVis: 400_000, movePush: [1, 2, 4, 8, 16, 32, 48], moveAttempts: 60,
    moveMin: 1, perMove: 12000, moveExtra: 14, moveRandom: 160, maxVis: 2_500_000 },
  // Tier 5: ultra
  { name: "ultra-mst", hWeight: 8, bidir: true, coarse: true, mbWeight: 3.0,
    mst: true, extraPasses: 2, targeted: 50,
    bridgeBidir: true, bridgeExtra: 4, bridgeWt: 1.5,
    permVis: 1_500_000, permWin: [64, 96, 128], perPerm: 20000,
    winPush: [64, 96, 128], winVis: 150_000, winTotal: 1_500_000,
    moveVis: 500_000, movePush: [1, 2, 4, 8, 16, 32, 48], moveAttempts: 80,
    moveMin: 1, perMove: 15000, moveExtra: 16, moveRandom: 200, maxVis: 3_000_000 },
];

const MAX_ROUNDS = 50;
let totalMs = 0;
let staleCount = 0;

for (let round = 0; round < MAX_ROUNDS; round++) {
  const tierIdx = Math.min(Math.floor(round / 3), tiers.length - 1);
  const tier = tiers[tierIdx];
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;

  console.log(`\n--- Round ${round + 1} (${tier.name}, from ${prevMoves} moves) ---`);
  const started = performance.now();
  const result = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: tier.maxVis,
    greedyPermutation: false,
    permutationVisited: tier.permVis,
    permutationWindowPushes: tier.permWin,
    perPermutationWindowVisited: tier.perPerm,
    permutationHeuristicWeight: tier.hWeight || undefined,
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
  const ms = Math.round(performance.now() - started);
  totalMs += ms;

  if (!result.path) {
    console.log(`  No path | ${Math.round(ms/1000)}s`);
    staleCount++;
    if (staleCount >= 4 && tierIdx >= tiers.length - 1) {
      console.log("  (converged at max tier)");
      break;
    }
    continue;
  }

  const roundSol = solutionFromLegacyPath(request, result.path);
  const roundValid = verifySolverSolution(request, roundSol).valid;
  const delta = roundSol.moves - prevMoves;

  if (delta >= 0) {
    console.log(`  No improvement (${roundSol.moves} >= ${prevMoves}) | ${Math.round(ms/1000)}s`);
    staleCount++;
    if (staleCount >= 4 && tierIdx >= tiers.length - 1) {
      console.log("  (converged at max tier)");
      break;
    }
    continue;
  }

  staleCount = 0;
  console.log(`  Result: m=${roundSol.moves} p=${roundSol.pushes} w=${roundSol.moves - roundSol.pushes} | impr=${result.improvements} moveImpr=${result.moveImprovements} permImpr=${result.permutationImprovements} | ${Math.round(ms/1000)}s | delta=${delta} | valid=${roundValid}`);
  currentPath = result.path;

  writeFileSync("/tmp/v3-best-path.json", JSON.stringify(currentPath));
  console.log(`  (saved ${currentPath.length}-move path)`);

  if (roundSol.moves < 700) {
    console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
    break;
  }
}

const finalSol = solutionFromLegacyPath(request, currentPath);
const finalValid = verifySolverSolution(request, finalSol).valid;
console.log(`\n=== FINAL: ${finalSol.moves} moves / ${finalSol.pushes} pushes / ${finalSol.moves - finalSol.pushes} walks | ${Math.round(totalMs/1000)}s | valid=${finalValid} ===`);
if (finalSol.moves < 700) {
  console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
}
