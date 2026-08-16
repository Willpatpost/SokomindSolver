/**
 * Move-window-only sweep with seed variation.
 *
 * Skips permutation and push-bridge phases for fast iterations.
 * Uses moveWindowSeed to explore different random windows each round.
 * Each round is ~5-10x faster than a full rewrite round.
 *
 * Usage: node --experimental-strip-types tests/experiments/v3-movewindow-sweep.mjs [path-file]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession } from "../../src/core/index.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { solutionFromLegacyPath, toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

globalThis.postMessage = () => {};

const pathFile = process.argv[2] || "/tmp/v3-pipeline-converged.json";
if (!existsSync(pathFile)) {
  console.log(`Path file not found: ${pathFile}`);
  console.log("Waiting...");
  while (!existsSync(pathFile)) {
    await new Promise(r => setTimeout(r, 5000));
  }
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
console.log(`Loaded: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);

let totalMs = 0;
let bestEverMoves = sol.moves;
let staleCount = 0;

for (let round = 0; round < 300; round++) {
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;
  const seed = round * 104729 + 7;

  const started = performance.now();
  const result = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: 600_000,
    greedyPermutation: false,
    skipPermutation: true,
    skipPushBridge: true,
    moveWindowVisited: 600_000,
    moveWindowPushes: [1, 2, 4, 8, 16, 32, 48],
    moveWindowAttempts: 80,
    moveWindowMinimumOverhead: 1,
    perMoveWindowVisited: 12000,
    moveWindowExtraPushes: 14,
    moveWindowRandomAttempts: 300,
    moveWindowSeed: seed,
    moveBridgeWeight: 2.5,
    progressIntervalMs: 120_000,
  });
  const ms = Math.round(performance.now() - started);
  totalMs += ms;

  if (!result.path) {
    if (round % 20 === 0) console.log(`  Round ${round + 1}: no path | ${Math.round(ms/1000)}s`);
    staleCount++;
    if (staleCount >= 50) break;
    continue;
  }

  const roundSol = solutionFromLegacyPath(request, result.path);
  const delta = roundSol.moves - prevMoves;
  if (delta >= 0) {
    if (round % 20 === 0) console.log(`  Round ${round + 1}: no improvement | moveI=${result.moveImprovements} | ${Math.round(ms/1000)}s`);
    staleCount++;
    if (staleCount >= 50) break;
    continue;
  }

  staleCount = 0;
  console.log(`  Round ${round + 1}: m=${roundSol.moves} p=${roundSol.pushes} w=${roundSol.moves - roundSol.pushes} | delta=${delta} | moveI=${result.moveImprovements} | ${Math.round(ms/1000)}s`);
  currentPath = result.path;

  if (roundSol.moves < bestEverMoves) {
    bestEverMoves = roundSol.moves;
    writeFileSync("/tmp/v3-movewindow-best.json", JSON.stringify(currentPath));
  }
  if (roundSol.moves < 700) {
    console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
    break;
  }
}

const finalSol = solutionFromLegacyPath(request, currentPath);
console.log(`\n=== FINAL: ${finalSol.moves} moves / ${finalSol.pushes} pushes | ${Math.round(totalMs/1000)}s ===`);
