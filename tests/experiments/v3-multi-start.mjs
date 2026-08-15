/**
 * V3 multi-start: try multiple plan-macro-beam configurations,
 * rewrite each, keep the best result.
 * Different push orderings may rewrite differently.
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

const planConfigs = [
  { name: "baseline", overrides: {} },
  { name: "branches-10", overrides: { planBoxBranches: 10 } },
  { name: "branches-8", overrides: { planBoxBranches: 8 } },
  { name: "branches-4", overrides: { planBoxBranches: 4 } },
  { name: "beam-48", overrides: { planBeamWidth: 48, maxVisited: 10_000 } },
  { name: "beam-64", overrides: { planBeamWidth: 64, maxVisited: 15_000 } },
  { name: "slack-300", overrides: { planSlack: 300 } },
  { name: "slack-180", overrides: { planSlack: 180 } },
  { name: "segments-200", overrides: { maxPlanSegments: 200 } },
  { name: "macro-limit-32", overrides: { sequenceMacroLimit: 32, sequenceMacroExplored: 64 } },
];

const basePlanParams = {
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
};

const rewriteBase = {
  algorithm: "solution-window-rewrite",
  state,
  maxVisited: 500_000,
  greedyPermutation: true,
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
};

let bestMoves = Infinity;
let bestConfig = null;

for (const config of planConfigs) {
  const params = { ...basePlanParams, ...config.overrides };
  console.log(`\n--- ${config.name} ---`);
  const planStarted = performance.now();
  const planResult = search(params);
  const planMs = Math.round(performance.now() - planStarted);

  if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
    console.log(`  Plan: FAILED (${planResult.status}) | vis=${planResult.visited} | ${planMs}ms`);
    continue;
  }

  const raw = solutionFromLegacyPath(request, planResult.path);
  console.log(`  Raw: m=${raw.moves} p=${raw.pushes} w=${raw.moves - raw.pushes} | ${planMs}ms`);

  // Rewrite
  const rewriteStarted = performance.now();
  const rewriteResult = search({ ...rewriteBase, solutionPath: planResult.path });
  const rewriteMs = Math.round(performance.now() - rewriteStarted);

  if (rewriteResult.path) {
    const sol = solutionFromLegacyPath(request, rewriteResult.path);
    const valid = verifySolverSolution(request, sol).valid;
    console.log(`  Rewrite: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | greedy=${rewriteResult.greedyImprovement} impr=${rewriteResult.improvements} moveImpr=${rewriteResult.moveImprovements} | ${Math.round(rewriteMs/1000)}s | valid=${valid}`);

    if (sol.moves < bestMoves) {
      bestMoves = sol.moves;
      bestConfig = config.name;
    }
    if (sol.moves < 700) {
      console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
    }
  } else {
    console.log(`  Rewrite: no improvement | ${Math.round(rewriteMs/1000)}s`);
    if (raw.moves < bestMoves) {
      bestMoves = raw.moves;
      bestConfig = config.name;
    }
  }
}

console.log(`\n=== BEST: ${bestMoves} moves (${bestConfig}) ===`);
if (bestMoves < 700) console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
