/**
 * Sweep plan-macro-beam parameters to find different raw solutions.
 * Different plans may rewrite to different (potentially lower) move counts.
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

const configs = [
  { name: "default", planBeamWidth: 32, planBoxBranches: 6, planSlack: 240 },
  { name: "wide-beam", planBeamWidth: 64, planBoxBranches: 6, planSlack: 240 },
  { name: "wide-beam-2", planBeamWidth: 128, planBoxBranches: 6, planSlack: 240 },
  { name: "more-branches", planBeamWidth: 32, planBoxBranches: 12, planSlack: 240 },
  { name: "wide+branches", planBeamWidth: 64, planBoxBranches: 12, planSlack: 240 },
  { name: "tight-slack", planBeamWidth: 32, planBoxBranches: 6, planSlack: 160 },
  { name: "loose-slack", planBeamWidth: 32, planBoxBranches: 6, planSlack: 360 },
  { name: "big-macro", planBeamWidth: 32, planBoxBranches: 6, planSlack: 240,
    sequenceMacroLimit: 48, sequenceMacroExplored: 96, sequenceMacroResults: 8 },
];

for (const cfg of configs) {
  console.log(`\n--- ${cfg.name} ---`);
  const started = performance.now();
  const result = search({
    algorithm: "plan-macro-beam",
    state,
    maxDepth: 460,
    maxVisited: 6_000,
    transpositionLimit: 60_000,
    planBeamWidth: cfg.planBeamWidth,
    planBoxBranches: cfg.planBoxBranches,
    maxPlanSegments: 160,
    planSlack: cfg.planSlack,
    sequenceMacroLimit: cfg.sequenceMacroLimit ?? 24,
    sequenceMacroExplored: cfg.sequenceMacroExplored ?? 48,
    sequenceMacroResults: cfg.sequenceMacroResults ?? 4,
    targetedMacroExplored: 64,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);

  if (result.status !== "solved" || !Array.isArray(result.path)) {
    console.log(`  FAILED: ${result.status} | ${Math.round(ms/1000)}s`);
    continue;
  }

  const sol = solutionFromLegacyPath(request, result.path);
  console.log(`  Raw: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | ${Math.round(ms/1000)}s`);

  // Quick rewrite to see rewrite potential
  const rewriteResult = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: result.path,
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

  if (rewriteResult.path) {
    const rSol = solutionFromLegacyPath(request, rewriteResult.path);
    const valid = verifySolverSolution(request, rSol).valid;
    console.log(`  Rewritten: m=${rSol.moves} p=${rSol.pushes} w=${rSol.moves - rSol.pushes} | valid=${valid}`);
  } else {
    console.log(`  Rewrite: no improvement`);
  }
}
