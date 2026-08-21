/**
 * V3 beam permutation: test beam search on push orderings.
 * Tests multiple beam widths, then converges the best result.
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

console.log("--- Plan ---");
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

const rawSolution = solutionFromLegacyPath(request, planResult.path);
console.log(`Raw: m=${rawSolution.moves} p=${rawSolution.pushes} w=${rawSolution.moves - rawSolution.pushes}`);

let bestBeamPath = null;
let bestBeamMoves = Infinity;

for (const width of [50, 100, 200, 400, 800, 1600]) {
  console.log(`\n--- Beam permutation (width=${width}) ---`);
  const started = performance.now();
  const result = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: planResult.path,
    maxVisited: 100,
    greedyPermutation: true,
    greedyAttempts: 1,
    beamPermutationWidth: width,
    skipPermutation: true,
    skipPushBridge: true,
    moveWindowVisited: 0,
    moveWindowRandomAttempts: 0,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);
  console.log(`Diag: ${JSON.stringify(result.greedyDiag)}`);
  console.log(`Improvement: ${result.greedyImprovement} | ${Math.round(ms/1000)}s`);
  if (result.greedyImprovement > 0 && result.path) {
    const sol = solutionFromLegacyPath(request, result.path);
    const valid = verifySolverSolution(request, sol).valid;
    console.log(`Result: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid}`);
    if (sol.moves < bestBeamMoves) {
      bestBeamMoves = sol.moves;
      bestBeamPath = result.path;
    }
  }
}

if (!bestBeamPath) {
  console.log("\nNo beam permutation succeeded. Falling back to raw plan.");
  bestBeamPath = planResult.path;
  bestBeamMoves = rawSolution.moves;
}

writeFileSync("/tmp/v3-beam-perm-best.json", JSON.stringify(bestBeamPath));
console.log(`\nBest beam result: ${bestBeamMoves} moves`);

console.log("\n--- Quick convergence ---");
let currentPath = bestBeamPath;
for (let pass = 0; pass < 6; pass++) {
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;
  const started = performance.now();
  const convResult = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: 1_000_000,
    greedyPermutation: false,
    permutationVisited: 400_000,
    permutationWindowPushes: [16, 32, 48, 64],
    perPermutationWindowVisited: 6000,
    permutationHeuristicWeight: 4,
    permutationBidirectional: true,
    permutationMSTHeuristic: true,
    permutationExtraPasses: 1,
    permutationTargetedPasses: 15,
    bridgeBidirectional: true,
    bridgeExtraPushes: 3,
    bridgeWeight: 1.3,
    windowPushes: [16, 32, 48],
    windowVisited: 50_000,
    windowTotalVisited: 400_000,
    moveWindowVisited: 250_000,
    moveWindowPushes: [1, 2, 4, 8, 16, 32],
    moveWindowAttempts: 40,
    moveWindowMinimumOverhead: 2,
    perMoveWindowVisited: 6000,
    moveWindowExtraPushes: 10,
    moveWindowRandomAttempts: 100,
    moveWindowSeed: pass * 2000,
    moveBridgeWeight: 2.0,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);
  if (!convResult.path) {
    console.log(`  Pass ${pass + 1}: converged at ${prevMoves} | ${Math.round(ms/1000)}s`);
    break;
  }
  const pSol = solutionFromLegacyPath(request, convResult.path);
  if (pSol.moves >= prevMoves) {
    console.log(`  Pass ${pass + 1}: converged at ${prevMoves} | ${Math.round(ms/1000)}s`);
    break;
  }
  currentPath = convResult.path;
  console.log(`  Pass ${pass + 1}: m=${pSol.moves} p=${pSol.pushes} w=${pSol.moves - pSol.pushes} | delta=${pSol.moves - prevMoves} | ${Math.round(ms/1000)}s`);
}

const finalSol = solutionFromLegacyPath(request, currentPath);
const finalValid = verifySolverSolution(request, finalSol).valid;
console.log(`\n=== FINAL: ${finalSol.moves} moves / ${finalSol.pushes} pushes / ${finalSol.moves - finalSol.pushes} walks | valid=${finalValid} ===`);
writeFileSync("/tmp/v3-beam-perm-converged.json", JSON.stringify(currentPath));
if (finalSol.moves < 700) console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
