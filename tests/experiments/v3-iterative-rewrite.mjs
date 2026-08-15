/**
 * V3 iterative rewrite: run plan-macro-beam then repeatedly rewrite until convergence.
 * Uses aggressive parameters: larger windows, more budget, more iterations.
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

const planOverrides = {};
for (const arg of process.argv.slice(2)) {
  const [key, val] = arg.split("=");
  if (key && val !== undefined) {
    planOverrides[key] = val === "true" ? true : val === "false" ? false : Number(val);
  }
}

// Phase 1: plan-macro-beam
const planParams = {
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
  ...planOverrides,
};

console.log("Plan overrides:", JSON.stringify(planOverrides));
console.log("--- Phase 1: plan-macro-beam ---");
const planStarted = performance.now();
const planResult = search(planParams);
const planMs = Math.round(performance.now() - planStarted);

if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
  console.log(`Plan failed: ${planResult.status} | vis=${planResult.visited} | ${planMs}ms`);
  process.exit(1);
}

let currentPath = planResult.path;
const rawSolution = solutionFromLegacyPath(request, currentPath);
console.log(`Raw: m=${rawSolution.moves} p=${rawSolution.pushes} w=${rawSolution.moves - rawSolution.pushes} | ${planMs}ms`);

// Phase 2: iterative rewrite
const MAX_PASSES = 8;
let totalRewriteMs = 0;
let passNumber = 0;

for (let pass = 0; pass < MAX_PASSES; pass++) {
  passNumber = pass + 1;
  const prevSolution = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSolution.moves;

  // Aggressive rewrite parameters - larger windows each pass
  const rewriteParams = {
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: 500_000,
    // Permutation: reorder pushes within windows
    permutationVisited: 150_000,
    permutationWindowPushes: pass === 0 ? [8, 16, 32, 48] : [16, 32, 48, 64],
    perPermutationWindowVisited: pass === 0 ? 2000 : 3000,
    // Bridge A*: find shorter push paths
    windowPushes: [8, 16, 32, 48],
    windowVisited: 30_000,
    windowTotalVisited: 200_000,
    // Move window: find shorter move paths for individual segments
    moveWindowVisited: 100_000,
    moveWindowPushes: [1, 2, 4, 8],
    moveWindowAttempts: 20,
    moveWindowMinimumOverhead: 3,
    perMoveWindowVisited: 3000,
    moveWindowExtraPushes: 6,
    progressIntervalMs: 60_000,
  };

  console.log(`--- Pass ${passNumber} rewrite (from ${prevMoves} moves) ---`);
  const rewriteStarted = performance.now();
  const rewriteResult = search(rewriteParams);
  const rewriteMs = Math.round(performance.now() - rewriteStarted);
  totalRewriteMs += rewriteMs;

  if (!rewriteResult.path) {
    console.log(`  No improvement found | ${rewriteMs}ms`);
    break;
  }

  const rewriteSolution = solutionFromLegacyPath(request, rewriteResult.path);
  const valid = verifySolverSolution(request, rewriteSolution).valid;
  const delta = rewriteSolution.moves - prevMoves;

  if (delta >= 0) {
    console.log(`  No improvement (${rewriteSolution.moves} >= ${prevMoves}) | ${rewriteMs}ms`);
    break;
  }

  console.log(`  Rewritten: m=${rewriteSolution.moves} p=${rewriteSolution.pushes} w=${rewriteSolution.moves - rewriteSolution.pushes} | impr=${rewriteResult.improvements} moveImpr=${rewriteResult.moveImprovements} permImpr=${rewriteResult.permutationImprovements} | ${rewriteMs}ms | delta=${delta} | valid=${valid}`);

  currentPath = rewriteResult.path;

  if (rewriteSolution.moves < 700) {
    console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
    break;
  }

  // Stop if improvement is marginal
  if (Math.abs(delta) < 5) {
    console.log("  (converged - marginal improvement)");
    break;
  }
}

const finalSolution = solutionFromLegacyPath(request, currentPath);
const finalValid = verifySolverSolution(request, finalSolution).valid;
console.log(`\n=== FINAL: ${finalSolution.moves} moves / ${finalSolution.pushes} pushes / ${finalSolution.moves - finalSolution.pushes} walks | ${passNumber} passes | ${Math.round(totalRewriteMs/1000)}s rewrite | valid=${finalValid} ===`);
if (finalSolution.moves < 700) {
  console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
}
