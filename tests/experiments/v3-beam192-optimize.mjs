/**
 * Optimize the beam-192 plan (276 pushes, 1022 moves, 746 walks).
 * This plan has the FEWEST pushes found so far — only 78 above the 198 lower bound.
 * With 276 pushes, we need walks < 424 to hit sub-700 moves.
 *
 * Phase 1: Load pre-generated beam-192 plan
 * Phase 2: Quick convergence (6 passes)
 * Phase 3: Aggressive seed-varied rewrite (80 rounds)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

// Load the pre-generated beam-192 plan
const pathFile = "/tmp/v3-beam-192-path.json";
if (!existsSync(pathFile)) {
  console.log("ERROR: " + pathFile + " not found");
  process.exit(1);
}
let currentPath = JSON.parse(readFileSync(pathFile, "utf-8"));
let sol = solutionFromLegacyPath(request, currentPath);
const t0 = performance.now();
console.log(`Loaded beam-192 plan: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);

// Phase 2: Quick convergence
console.log("\n=== Phase 2: Convergence ===");
for (let pass = 0; pass < 6; pass++) {
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;
  const started = performance.now();
  const result = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: 1_000_000,
    greedyPermutation: false,
    permutationVisited: 500_000,
    permutationWindowPushes: [8, 16, 32, 48, 64],
    perPermutationWindowVisited: 6000,
    permutationHeuristicWeight: 4,
    permutationBidirectional: true,
    permutationMSTHeuristic: true,
    permutationExtraPasses: 2,
    permutationTargetedPasses: 20,
    permutationTargetedWindowPushes: [32, 48, 64, 96],
    permutationTargetedRounds: 2,
    bridgeBidirectional: true,
    bridgeExtraPushes: 4,
    bridgeWeight: 1.4,
    windowPushes: [16, 32, 48, 64],
    windowVisited: 60_000,
    windowTotalVisited: 400_000,
    moveWindowVisited: 300_000,
    moveWindowPushes: [1, 2, 4, 8, 16, 32],
    moveWindowAttempts: 40,
    moveWindowMinimumOverhead: 2,
    perMoveWindowVisited: 8000,
    moveWindowExtraPushes: 10,
    moveWindowRandomAttempts: 120,
    moveWindowSeed: pass * 1000,
    moveBridgeWeight: 2.0,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);
  if (!result.path) {
    console.log(`  Pass ${pass + 1}: converged at ${prevMoves} | ${Math.round(ms/1000)}s`);
    break;
  }
  const passSol = solutionFromLegacyPath(request, result.path);
  if (passSol.moves >= prevMoves) {
    console.log(`  Pass ${pass + 1}: converged at ${prevMoves} | ${Math.round(ms/1000)}s`);
    break;
  }
  currentPath = result.path;
  console.log(`  Pass ${pass + 1}: m=${passSol.moves} p=${passSol.pushes} w=${passSol.moves - passSol.pushes} | delta=${passSol.moves - prevMoves} | ${Math.round(ms/1000)}s`);
}

sol = solutionFromLegacyPath(request, currentPath);
console.log(`After convergence: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);
writeFileSync("/tmp/v3-beam192-converged.json", JSON.stringify(currentPath));

// Phase 3: Aggressive rewrite with seed variation
console.log("\n=== Phase 3: Aggressive Seed-Varied Rewrite ===");
let totalMs = 0;
let staleCount = 0;
let bestEverMoves = sol.moves;

for (let round = 0; round < 80; round++) {
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;
  const seed = round * 7919 + 17;

  const permHeavy = round % 3 !== 2;
  const moveHeavy = round % 3 !== 0;

  console.log(`\n--- Round ${round + 1} (seed=${seed}, from ${prevMoves} moves) ---`);
  const started = performance.now();
  const result = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: 2_500_000,
    greedyPermutation: false,
    permutationVisited: permHeavy ? 1_200_000 : 400_000,
    permutationWindowPushes: permHeavy ? [32, 48, 64, 96, 128] : [16, 32, 48, 64],
    perPermutationWindowVisited: permHeavy ? 12000 : 5000,
    permutationHeuristicWeight: 5,
    permutationBidirectional: true,
    permutationCoarseIdentity: true,
    permutationMSTHeuristic: true,
    permutationExtraPasses: 2,
    permutationTargetedPasses: permHeavy ? 50 : 20,
    permutationTargetedWindowPushes: permHeavy ? [48, 64, 96, 128] : [32, 48, 64, 96],
    permutationTargetedRounds: 3,
    bridgeBidirectional: true,
    bridgeExtraPushes: 4,
    bridgeWeight: 1.4,
    windowPushes: [48, 64, 96],
    windowVisited: 100_000,
    windowTotalVisited: 600_000,
    moveWindowVisited: moveHeavy ? 500_000 : 250_000,
    moveWindowPushes: [1, 2, 4, 8, 16, 32, 48, 64],
    moveWindowAttempts: moveHeavy ? 60 : 30,
    moveWindowMinimumOverhead: 1,
    perMoveWindowVisited: moveHeavy ? 15000 : 8000,
    moveWindowExtraPushes: 14,
    moveWindowRandomAttempts: moveHeavy ? 250 : 120,
    moveWindowSeed: seed,
    moveBridgeWeight: 2.5,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);
  totalMs += ms;

  if (!result.path) {
    console.log(`  No path | ${Math.round(ms/1000)}s`);
    staleCount++;
    if (staleCount >= 15) break;
    continue;
  }

  const roundSol = solutionFromLegacyPath(request, result.path);
  const delta = roundSol.moves - prevMoves;
  if (delta >= 0) {
    console.log(`  No improvement (${roundSol.moves} >= ${prevMoves}) | permI=${result.permutationImprovements} moveI=${result.moveImprovements} | ${Math.round(ms/1000)}s`);
    staleCount++;
    if (staleCount >= 15) break;
    continue;
  }

  staleCount = 0;
  const roundValid = verifySolverSolution(request, roundSol).valid;
  console.log(`  Result: m=${roundSol.moves} p=${roundSol.pushes} w=${roundSol.moves - roundSol.pushes} | delta=${delta} | permI=${result.permutationImprovements} moveI=${result.moveImprovements} | valid=${roundValid} | ${Math.round(ms/1000)}s`);
  currentPath = result.path;

  if (roundSol.moves < bestEverMoves) {
    bestEverMoves = roundSol.moves;
    writeFileSync("/tmp/v3-beam192-best.json", JSON.stringify(currentPath));
  }
  if (roundSol.moves < 700) {
    console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
    break;
  }
}

const finalSol = solutionFromLegacyPath(request, currentPath);
const finalValid = verifySolverSolution(request, finalSol).valid;
console.log(`\n=== FINAL: ${finalSol.moves} moves / ${finalSol.pushes} pushes / ${finalSol.moves - finalSol.pushes} walks | ${Math.round((performance.now() - t0)/1000)}s total | valid=${finalValid} ===`);
if (finalSol.moves < 700) {
  console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
}
