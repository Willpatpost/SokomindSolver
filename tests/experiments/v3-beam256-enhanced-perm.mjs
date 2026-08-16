/**
 * Enhanced permutation optimization on the converged beam-256 path.
 * Uses multi-size targeted permutation with re-ranking.
 * Very large permutation windows (up to 133 pushes = half of 266).
 *
 * Waits for /tmp/v3-beam256-converged.json to be available.
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

const pathFile = "/tmp/v3-beam256-converged.json";
while (!existsSync(pathFile)) {
  console.log("Waiting for " + pathFile + "...");
  const start = Date.now();
  while (Date.now() - start < 30_000) { /* no-op */ }
}

let currentPath = JSON.parse(readFileSync(pathFile, "utf-8"));
let sol = solutionFromLegacyPath(request, currentPath);
console.log(`Starting from converged beam-256: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);

let bestEverMoves = sol.moves;
let staleCount = 0;

for (let round = 0; round < 60; round++) {
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;
  const seed = round * 31337 + 42;
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
    permutationVisited: permHeavy ? 1_500_000 : 500_000,
    permutationWindowPushes: permHeavy ? [32, 48, 64, 96, 133] : [16, 32, 48, 64],
    perPermutationWindowVisited: permHeavy ? 18000 : 8000,
    permutationHeuristicWeight: 5,
    permutationBidirectional: true,
    permutationCoarseIdentity: true,
    permutationMSTHeuristic: true,
    permutationExtraPasses: 3,
    permutationTargetedPasses: permHeavy ? 60 : 25,
    permutationTargetedWindowPushes: permHeavy ? [48, 64, 96, 133] : [32, 48, 64, 96],
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
    writeFileSync("/tmp/v3-beam256-enhanced-best.json", JSON.stringify(currentPath));
  }
  if (roundSol.moves < 700) {
    console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
    break;
  }
}

const finalSol = solutionFromLegacyPath(request, currentPath);
const finalValid = verifySolverSolution(request, finalSol).valid;
console.log(`\n=== FINAL: ${finalSol.moves} moves / ${finalSol.pushes} pushes / ${finalSol.moves - finalSol.pushes} walks | valid=${finalValid} ===`);
if (finalSol.moves < 700) console.log("*** TARGET ACHIEVED ***");
