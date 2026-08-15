/**
 * V3 mega rewrite: uses very large permutation windows to deeply reorder pushes.
 * First runs plan-macro-beam, then does a single aggressive rewrite pass.
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

console.log("--- Phase 1: plan-macro-beam ---");
const planStarted = performance.now();
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
const planMs = Math.round(performance.now() - planStarted);

if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
  console.log(`Plan failed: ${planResult.status} | ${planMs}ms`);
  process.exit(1);
}

const rawSolution = solutionFromLegacyPath(request, planResult.path);
console.log(`Raw: m=${rawSolution.moves} p=${rawSolution.pushes} w=${rawSolution.moves - rawSolution.pushes} | ${planMs}ms`);

console.log("--- Phase 2: mega rewrite ---");
const rewriteParams = {
  algorithm: "solution-window-rewrite",
  state,
  solutionPath: planResult.path,
  maxVisited: 2_000_000,
  // Very large permutation windows - reorder entire sections
  permutationVisited: 800_000,
  permutationWindowPushes: [16, 32, 64, 96, 128],
  perPermutationWindowVisited: 10_000,
  // Large bridge A* windows
  windowPushes: [8, 16, 32, 48, 64],
  windowVisited: 50_000,
  windowTotalVisited: 600_000,
  // Aggressive move window
  moveWindowVisited: 300_000,
  moveWindowPushes: [1, 2, 4, 8, 16],
  moveWindowAttempts: 40,
  moveWindowMinimumOverhead: 2,
  perMoveWindowVisited: 5_000,
  moveWindowExtraPushes: 8,
  progressIntervalMs: 60_000,
};

const rewriteStarted = performance.now();
const rewriteResult = search(rewriteParams);
const rewriteMs = Math.round(performance.now() - rewriteStarted);

if (rewriteResult.path) {
  const sol = solutionFromLegacyPath(request, rewriteResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  console.log(`Mega rewrite: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | impr=${rewriteResult.improvements} moveImpr=${rewriteResult.moveImprovements} permImpr=${rewriteResult.permutationImprovements} | ${Math.round(rewriteMs/1000)}s | valid=${valid}`);
  console.log(`\n=== FINAL: ${sol.moves} moves / ${sol.pushes} pushes / ${sol.moves - sol.pushes} walks ===`);
  if (sol.moves < 700) console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
} else {
  console.log(`No improvement | ${Math.round(rewriteMs/1000)}s`);
  console.log(`\n=== FINAL: ${rawSolution.moves} moves (raw) ===`);
}
