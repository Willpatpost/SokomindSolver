/**
 * Generate and save the converged baseline path to a JSON file.
 * Subsequent experiments can load it to skip the 40-minute setup.
 */
import { writeFileSync } from "node:fs";
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

if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
  console.log(`Plan failed: ${planResult.status}`);
  process.exit(1);
}

let currentPath = planResult.path;
let sol = solutionFromLegacyPath(request, currentPath);
console.log(`Plan: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);

// Converge
console.log("\nConverging...");
for (let pass = 0; pass < 8; pass++) {
  const prevMoves = solutionFromLegacyPath(request, currentPath).moves;
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
    console.log(`  Pass ${pass + 1}: converged at ${prevMoves}`);
    break;
  }
  const passSol = solutionFromLegacyPath(request, result.path);
  if (passSol.moves >= prevMoves) {
    console.log(`  Pass ${pass + 1}: converged at ${prevMoves}`);
    break;
  }
  currentPath = result.path;
  console.log(`  Pass ${pass + 1}: m=${passSol.moves} p=${passSol.pushes} w=${passSol.moves - passSol.pushes}`);
}

sol = solutionFromLegacyPath(request, currentPath);
const valid = verifySolverSolution(request, sol).valid;
console.log(`\nFinal: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid}`);

// Save
const outFile = "/tmp/v3-baseline-path.json";
writeFileSync(outFile, JSON.stringify(currentPath));
console.log(`Saved ${currentPath.length}-element path to ${outFile}`);
