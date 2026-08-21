/**
 * Sweep plan parameters to find walk-optimized initial solutions.
 * The default planMoveCostWeight (0.005) barely considers walks.
 * Higher values should produce plans with different push orderings
 * that minimize total moves, not just pushes.
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

const configs = [
  { name: "default", moveCostWeight: 0.005, firstPushProx: 0, segWalkWt: 0, moveDom: 0 },
  { name: "walk-aware-1", moveCostWeight: 0.05, firstPushProx: 0.3, segWalkWt: 0, moveDom: 0 },
  { name: "walk-aware-2", moveCostWeight: 0.1, firstPushProx: 0.5, segWalkWt: 0, moveDom: 0.01 },
  { name: "walk-heavy-1", moveCostWeight: 0.2, firstPushProx: 1.0, segWalkWt: 0.1, moveDom: 0.02 },
  { name: "walk-heavy-2", moveCostWeight: 0.3, firstPushProx: 1.5, segWalkWt: 0.2, moveDom: 0.03 },
  { name: "walk-dominant", moveCostWeight: 0.5, firstPushProx: 2.0, segWalkWt: 0.3, moveDom: 0.05 },
  { name: "extreme-walk", moveCostWeight: 1.0, firstPushProx: 3.0, segWalkWt: 0.5, moveDom: 0.1 },
];

const results = [];

for (const cfg of configs) {
  console.log(`\n=== ${cfg.name} ===`);
  const started = performance.now();
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
    planMoveCostWeight: cfg.moveCostWeight,
    planFirstPushProximityWeight: cfg.firstPushProx,
    planSegmentWalkWeight: cfg.segWalkWt,
    planMoveDominanceWeight: cfg.moveDom,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);

  if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
    console.log(`  FAILED: ${planResult.status} | ${Math.round(ms/1000)}s`);
    results.push({ name: cfg.name, status: "failed" });
    continue;
  }

  const sol = solutionFromLegacyPath(request, planResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  console.log(`  Plan: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid} | ${Math.round(ms/1000)}s`);
  results.push({
    name: cfg.name,
    moves: sol.moves,
    pushes: sol.pushes,
    walks: sol.moves - sol.pushes,
    valid,
    ms,
    pathLen: planResult.path.length,
  });

  // Quick convergence: 2 passes
  let currentPath = planResult.path;
  for (let pass = 0; pass < 2; pass++) {
    const prevSol = solutionFromLegacyPath(request, currentPath);
    const prevMoves = prevSol.moves;
    const result = search({
      algorithm: "solution-window-rewrite",
      state,
      solutionPath: currentPath,
      maxVisited: 400_000,
      greedyPermutation: false,
      permutationVisited: 100_000,
      permutationWindowPushes: [8, 16, 32, 48],
      perPermutationWindowVisited: 2000,
      windowPushes: [8, 16, 32, 48],
      windowVisited: 30_000,
      windowTotalVisited: 200_000,
      moveWindowVisited: 80_000,
      moveWindowPushes: [1, 2, 4, 8],
      moveWindowAttempts: 20,
      moveWindowMinimumOverhead: 3,
      perMoveWindowVisited: 3000,
      moveWindowExtraPushes: 6,
      progressIntervalMs: 60_000,
    });

    if (!result.path) {
      console.log(`  Conv ${pass + 1}: converged at ${prevMoves}`);
      break;
    }
    const passSol = solutionFromLegacyPath(request, result.path);
    if (passSol.moves >= prevMoves) {
      console.log(`  Conv ${pass + 1}: converged at ${prevMoves}`);
      break;
    }
    currentPath = result.path;
    console.log(`  Conv ${pass + 1}: m=${passSol.moves} p=${passSol.pushes} w=${passSol.moves - passSol.pushes}`);
  }

  const finalSol = solutionFromLegacyPath(request, currentPath);
  results[results.length - 1].convergedMoves = finalSol.moves;
  results[results.length - 1].convergedPushes = finalSol.pushes;
  results[results.length - 1].convergedWalks = finalSol.moves - finalSol.pushes;

  // Save best path for each config
  writeFileSync(`/tmp/v3-plan-${cfg.name}.json`, JSON.stringify(currentPath));
}

console.log("\n\n=== SUMMARY ===");
console.log("Config              | Plan m/p/w          | Converged m/p/w");
console.log("-".repeat(75));
for (const r of results) {
  if (r.status === "failed") {
    console.log(`${r.name.padEnd(20)}| FAILED`);
    continue;
  }
  const plan = `${r.moves}/${r.pushes}/${r.walks}`;
  const conv = r.convergedMoves
    ? `${r.convergedMoves}/${r.convergedPushes}/${r.convergedWalks}`
    : "N/A";
  console.log(`${r.name.padEnd(20)}| ${plan.padEnd(20)}| ${conv}`);
}

// Save summary
writeFileSync("/tmp/v3-plan-sweep-results.json", JSON.stringify(results, null, 2));
