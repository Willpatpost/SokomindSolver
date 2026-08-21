/**
 * Quick test: compare permutation search with and without MST heuristic.
 * Runs one plan + one baseline rewrite, then a single permutation window
 * both ways to see the difference.
 */
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession } from "../../src/core/index.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { solutionFromLegacyPath, toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";

globalThis.postMessage = () => {};

const huge = PUZZLE_BY_ID.huge;
const session = createSession(huge);
const request = {
  board: session.board,
  snapshot: session.snapshot,
  objective: { kind: "moves" },
};
const state = toLegacyState(request);

// Plan
console.log("Planning...");
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
let sol = solutionFromLegacyPath(request, currentPath);
console.log(`Plan: m=${sol.moves} p=${sol.pushes}`);

// One baseline pass
console.log("Baseline...");
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
}
sol = solutionFromLegacyPath(request, currentPath);
console.log(`Baseline: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);

// Test configs: weighted-only vs weighted+MST, various weights
const configs = [
  { name: "weighted-3", hWeight: 3, mst: false, budget: 10000 },
  { name: "mst-3", hWeight: 3, mst: true, budget: 10000 },
  { name: "weighted-5", hWeight: 5, mst: false, budget: 10000 },
  { name: "mst-5", hWeight: 5, mst: true, budget: 10000 },
  { name: "weighted-8", hWeight: 8, mst: false, budget: 10000 },
  { name: "mst-8", hWeight: 8, mst: true, budget: 10000 },
];

for (const cfg of configs) {
  console.log(`\n--- ${cfg.name} ---`);
  const started = performance.now();
  const result = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: 1_000_000,
    greedyPermutation: false,
    permutationVisited: 600_000,
    permutationWindowPushes: [32, 48, 64],
    perPermutationWindowVisited: cfg.budget,
    permutationHeuristicWeight: cfg.hWeight,
    permutationBidirectional: true,
    permutationCoarseIdentity: true,
    permutationMSTHeuristic: cfg.mst,
    windowPushes: [32, 48, 64],
    windowVisited: 50_000,
    windowTotalVisited: 300_000,
    moveWindowVisited: 200_000,
    moveWindowPushes: [1, 2, 4, 8, 16],
    moveWindowAttempts: 30,
    moveWindowMinimumOverhead: 2,
    perMoveWindowVisited: 5000,
    moveWindowExtraPushes: 8,
    moveBridgeWeight: 2.0,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);
  if (!result.path) {
    console.log(`  No improvement | ${Math.round(ms/1000)}s`);
    continue;
  }
  const resSol = solutionFromLegacyPath(request, result.path);
  console.log(`  m=${resSol.moves} p=${resSol.pushes} w=${resSol.moves - resSol.pushes} | permImpr=${result.permutationImprovements} | ${Math.round(ms/1000)}s`);
}
