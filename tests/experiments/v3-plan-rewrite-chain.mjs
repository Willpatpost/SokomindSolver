/**
 * V3 plan+rewrite chain: run plan-macro-beam then solution-window-rewrite.
 * Tests whether the rewrite can bring the solution under 700 moves.
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

const rawSolution = solutionFromLegacyPath(request, planResult.path);
console.log(`Raw: m=${rawSolution.moves} p=${rawSolution.pushes} w=${rawSolution.moves - rawSolution.pushes} | vis=${planResult.visited} | ${planMs}ms`);

console.log("--- Phase 2: solution-window-rewrite ---");
const rewriteParams = {
  algorithm: "solution-window-rewrite",
  state,
  solutionPath: planResult.path,
  maxVisited: 300_000,
  permutationVisited: 50_000,
  permutationWindowPushes: [8, 16, 32],
  perPermutationWindowVisited: 1000,
  windowPushes: [8, 16, 32],
  windowVisited: 20_000,
  moveWindowVisited: 50_000,
  moveWindowPushes: [1, 2, 4],
  moveWindowAttempts: 6,
  progressIntervalMs: 60_000,
};

const rewriteStarted = performance.now();
const rewriteResult = search(rewriteParams);
const rewriteMs = Math.round(performance.now() - rewriteStarted);

if (rewriteResult.path) {
  const rewriteSolution = solutionFromLegacyPath(request, rewriteResult.path);
  const valid = verifySolverSolution(request, rewriteSolution).valid;
  const delta = rewriteSolution.moves - rawSolution.moves;
  console.log(`Rewritten: m=${rewriteSolution.moves} p=${rewriteSolution.pushes} w=${rewriteSolution.moves - rewriteSolution.pushes} | improvements=${rewriteResult.improvements} moveImprovements=${rewriteResult.moveImprovements} | ${rewriteMs}ms | delta=${delta} | valid=${valid}`);
  console.log(`\n=== FINAL: ${rewriteSolution.moves} moves / ${rewriteSolution.pushes} pushes / ${rewriteSolution.moves - rewriteSolution.pushes} walks ===`);
  if (rewriteSolution.moves < 700) {
    console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
  }
} else {
  console.log(`Rewrite failed: no improvement | ${rewriteMs}ms`);
  console.log(`\n=== FINAL: ${rawSolution.moves} moves (raw) ===`);
}
