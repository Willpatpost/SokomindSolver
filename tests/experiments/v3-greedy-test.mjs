/**
 * V3 greedy walk-optimal test: uses greedy permutation before standard rewrite.
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

// Phase 1: plan-macro-beam
console.log("--- Phase 1: plan-macro-beam ---");
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

const rawSolution = solutionFromLegacyPath(request, planResult.path);
console.log(`Raw: m=${rawSolution.moves} p=${rawSolution.pushes} w=${rawSolution.moves - rawSolution.pushes}`);

// Phase 2: rewrite with greedy permutation
console.log("--- Phase 2: rewrite (with greedy perm) ---");
const rewriteStarted = performance.now();
const rewriteResult = search({
  algorithm: "solution-window-rewrite",
  state,
  solutionPath: planResult.path,
  maxVisited: 500_000,
  greedyPermutation: true,
  permutationVisited: 100_000,
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
const rewriteMs = Math.round(performance.now() - rewriteStarted);

if (rewriteResult.path) {
  const sol = solutionFromLegacyPath(request, rewriteResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  console.log(`Result: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | greedy=${rewriteResult.greedyImprovement} impr=${rewriteResult.improvements} moveImpr=${rewriteResult.moveImprovements} permImpr=${rewriteResult.permutationImprovements} | ${Math.round(rewriteMs/1000)}s | valid=${valid}`);
  console.log(`\n=== FINAL: ${sol.moves} moves / ${sol.pushes} pushes / ${sol.moves - sol.pushes} walks ===`);
  if (sol.moves < 700) console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
} else {
  console.log(`No improvement | ${Math.round(rewriteMs/1000)}s`);
}
