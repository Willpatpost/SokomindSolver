/**
 * Test weighted permutation heuristic with large windows.
 * The weighted heuristic (permutationHeuristicWeight > 1) biases the A* search
 * toward completing orderings, finding more improvements within the same budget.
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
console.log("--- plan-macro-beam ---");
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

if (planResult.status !== "solved") {
  console.log(`Plan failed: ${planResult.status}`);
  process.exit(1);
}

let currentPath = planResult.path;
const rawSol = solutionFromLegacyPath(request, currentPath);
console.log(`Raw: m=${rawSol.moves} p=${rawSol.pushes}`);

// Phase 2: baseline rewrite with standard params
console.log("\n--- baseline standard rewrite ---");
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

if (baseResult.path) {
  currentPath = baseResult.path;
  const sol = solutionFromLegacyPath(request, currentPath);
  console.log(`Baseline: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);
}

// Phase 3: test weighted heuristic at different weights and window sizes
const tests = [
  { weight: 2, windows: [32, 48, 64, 96], perPerm: 8000, permVis: 500_000 },
  { weight: 3, windows: [32, 48, 64, 96], perPerm: 8000, permVis: 500_000 },
  { weight: 2, windows: [48, 64, 96, 128], perPerm: 12000, permVis: 800_000 },
  { weight: 3, windows: [48, 64, 96, 128], perPerm: 12000, permVis: 800_000 },
  { weight: 5, windows: [64, 96, 128, 160], perPerm: 15000, permVis: 1_000_000 },
];

let bestPath = currentPath;
let bestMoves = solutionFromLegacyPath(request, currentPath).moves;

for (const test of tests) {
  const prevSol = solutionFromLegacyPath(request, bestPath);
  console.log(`\n--- weight=${test.weight} windows=[${test.windows}] (from ${prevSol.moves} moves) ---`);
  const started = performance.now();
  const result = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: bestPath,
    maxVisited: 1_500_000,
    greedyPermutation: false,
    permutationVisited: test.permVis,
    permutationWindowPushes: test.windows,
    perPermutationWindowVisited: test.perPerm,
    permutationHeuristicWeight: test.weight,
    windowPushes: [16, 32, 48, 64],
    windowVisited: 60_000,
    windowTotalVisited: 400_000,
    moveWindowVisited: 200_000,
    moveWindowPushes: [1, 2, 4, 8, 16],
    moveWindowAttempts: 30,
    moveWindowMinimumOverhead: 2,
    perMoveWindowVisited: 6000,
    moveWindowExtraPushes: 8,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);

  if (result.path) {
    const sol = solutionFromLegacyPath(request, result.path);
    const valid = verifySolverSolution(request, sol).valid;
    const delta = sol.moves - prevSol.moves;
    console.log(`  Result: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | impr=${result.improvements} permImpr=${result.permutationImprovements} | ${Math.round(ms/1000)}s | delta=${delta} | valid=${valid}`);
    if (sol.moves < bestMoves) {
      bestPath = result.path;
      bestMoves = sol.moves;
    }
    if (sol.moves < 700) {
      console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
      break;
    }
  } else {
    console.log(`  No improvement | ${Math.round(ms/1000)}s`);
  }
}

const finalSol = solutionFromLegacyPath(request, bestPath);
const finalValid = verifySolverSolution(request, finalSol).valid;
console.log(`\n=== FINAL: ${finalSol.moves} moves / ${finalSol.pushes} pushes / ${finalSol.moves - finalSol.pushes} walks | valid=${finalValid} ===`);
