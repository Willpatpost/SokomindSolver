/**
 * Intensive move-window-only optimization on the converged wide-128 path.
 * Skips permutation and push bridge to focus all budget on walk reduction.
 * Runs 400 rounds with unique seeds and large per-window budgets.
 *
 * Waits for /tmp/v3-wide128-converged.json to be available.
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

// Wait for converged path
const pathFile = "/tmp/v3-wide128-converged.json";
while (!existsSync(pathFile)) {
  console.log("Waiting for " + pathFile + "...");
  const start = Date.now();
  while (Date.now() - start < 30_000) { /* spin wait 30s */ }
}

let currentPath = JSON.parse(readFileSync(pathFile, "utf-8"));
let sol = solutionFromLegacyPath(request, currentPath);
console.log(`Starting from converged: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);

let bestEverMoves = sol.moves;
let staleCount = 0;

for (let round = 0; round < 400; round++) {
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;
  const seed = round * 104729 + 31337;

  const started = performance.now();
  const result = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: 600_000,
    skipPermutation: true,
    skipPushBridge: true,
    moveWindowVisited: 500_000,
    moveWindowPushes: [1, 2, 4, 8, 16, 32, 48, 64],
    moveWindowAttempts: 40,
    moveWindowMinimumOverhead: 1,
    perMoveWindowVisited: 15000,
    moveWindowExtraPushes: 12,
    moveWindowRandomAttempts: 300,
    moveWindowSeed: seed,
    moveBridgeWeight: 2.0,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);

  if (!result.path) {
    staleCount++;
    if (round % 20 === 0) console.log(`  Round ${round + 1}: no path | ${Math.round(ms/1000)}s (stale=${staleCount})`);
    if (staleCount >= 80) break;
    continue;
  }

  const roundSol = solutionFromLegacyPath(request, result.path);
  const delta = roundSol.moves - prevMoves;
  if (delta >= 0) {
    staleCount++;
    if (round % 20 === 0) console.log(`  Round ${round + 1}: no improvement (${roundSol.moves}) | moveI=${result.moveImprovements} | ${Math.round(ms/1000)}s (stale=${staleCount})`);
    if (staleCount >= 80) break;
    continue;
  }

  staleCount = 0;
  currentPath = result.path;
  console.log(`  Round ${round + 1}: m=${roundSol.moves} p=${roundSol.pushes} w=${roundSol.moves - roundSol.pushes} | delta=${delta} | moveI=${result.moveImprovements} | ${Math.round(ms/1000)}s`);

  if (roundSol.moves < bestEverMoves) {
    bestEverMoves = roundSol.moves;
    writeFileSync("/tmp/v3-wide128-moveturbo-best.json", JSON.stringify(currentPath));
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
