/**
 * Aggressive solution rewrite with seed variation.
 *
 * Uses moveWindowSeed to break RNG stagnation across rounds.
 * Loads a pre-converged baseline and runs maximum-effort optimization
 * with varying random seeds to explore different optimization paths.
 *
 * Usage: node --experimental-strip-types tests/experiments/v3-aggressive-rewrite.mjs [path-file]
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
  console.log("Waiting for baseline...");
  while (!existsSync(pathFile)) {
    await new Promise(r => setTimeout(r, 10000));
  }
  console.log("Baseline appeared, starting...");
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

const MAX_ROUNDS = 120;
let totalMs = 0;
let staleCount = 0;
let bestEverMoves = sol.moves;

for (let round = 0; round < MAX_ROUNDS; round++) {
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;
  const seed = round * 7919 + 1;

  // Alternate between permutation-heavy and move-window-heavy rounds
  const permHeavy = round % 3 !== 2;
  const moveHeavy = round % 3 !== 0;

  const config = {
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: 2_500_000,
    greedyPermutation: false,

    // Permutation phase
    permutationVisited: permHeavy ? 1_200_000 : 400_000,
    permutationWindowPushes: permHeavy ? [32, 48, 64, 96] : [16, 32, 48],
    perPermutationWindowVisited: permHeavy ? 15000 : 6000,
    permutationHeuristicWeight: 5,
    permutationBidirectional: true,
    permutationCoarseIdentity: true,
    permutationMSTHeuristic: true,
    permutationExtraPasses: 2,
    permutationTargetedPasses: permHeavy ? 50 : 20,

    // Bridge phase
    bridgeBidirectional: true,
    bridgeExtraPushes: 4,
    bridgeWeight: 1.4,
    windowPushes: [48, 64, 96, 128],
    windowVisited: 120_000,
    windowTotalVisited: 800_000,

    // Move-window phase (ranked)
    moveWindowVisited: moveHeavy ? 500_000 : 250_000,
    moveWindowPushes: [1, 2, 4, 8, 16, 32, 48],
    moveWindowAttempts: moveHeavy ? 80 : 40,
    moveWindowMinimumOverhead: 1,
    perMoveWindowVisited: moveHeavy ? 15000 : 8000,
    moveWindowExtraPushes: 16,

    // Move-window phase (random) - with seed variation!
    moveWindowRandomAttempts: moveHeavy ? 250 : 120,
    moveWindowSeed: seed,
    moveBridgeWeight: 2.5,

    progressIntervalMs: 60_000,
  };

  console.log(`\n--- Round ${round + 1} (seed=${seed}, perm=${permHeavy?"heavy":"light"}, move=${moveHeavy?"heavy":"light"}, from ${prevMoves} moves) ---`);
  const started = performance.now();
  const result = search(config);
  const ms = Math.round(performance.now() - started);
  totalMs += ms;

  if (!result.path) {
    console.log(`  No path | ${Math.round(ms/1000)}s`);
    staleCount++;
    if (staleCount >= 12) {
      console.log("  (converged after 12 stale rounds)");
      break;
    }
    continue;
  }

  const roundSol = solutionFromLegacyPath(request, result.path);
  const roundValid = verifySolverSolution(request, roundSol).valid;
  const delta = roundSol.moves - prevMoves;

  if (delta >= 0) {
    console.log(`  No improvement (${roundSol.moves} >= ${prevMoves}) | permImpr=${result.permutationImprovements} moveImpr=${result.moveImprovements} | ${Math.round(ms/1000)}s`);
    staleCount++;
    if (staleCount >= 12) {
      console.log("  (converged after 12 stale rounds)");
      break;
    }
    continue;
  }

  staleCount = 0;
  console.log(`  Result: m=${roundSol.moves} p=${roundSol.pushes} w=${roundSol.moves - roundSol.pushes} | delta=${delta} | permImpr=${result.permutationImprovements} moveImpr=${result.moveImprovements} | valid=${roundValid} | ${Math.round(ms/1000)}s`);
  currentPath = result.path;

  if (roundSol.moves < bestEverMoves) {
    bestEverMoves = roundSol.moves;
    writeFileSync("/tmp/v3-aggressive-best.json", JSON.stringify(currentPath));
  }

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
