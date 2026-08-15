/**
 * Beam-128 with push cost weight tuning.
 * Higher pushCostWeight makes the beam prefer states with fewer pushes.
 * Tests: pushCostWeight = 1.2, 1.5, 2.0, 3.0
 * Also tests: lower estimateWeight to give more weight to push minimization.
 */
import { readFileSync, writeFileSync } from "node:fs";
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
  { name: "b128-pcw1.2", pcw: 1.2, ew: 1.15, gaw: 4 },
  { name: "b128-pcw1.5", pcw: 1.5, ew: 1.15, gaw: 4 },
  { name: "b128-pcw2.0", pcw: 2.0, ew: 1.15, gaw: 4 },
  { name: "b128-pcw3.0", pcw: 3.0, ew: 1.15, gaw: 4 },
  { name: "b128-pcw1.5-ew0.8", pcw: 1.5, ew: 0.8, gaw: 4 },
  { name: "b128-pcw2.0-ew0.8", pcw: 2.0, ew: 0.8, gaw: 4 },
  { name: "b128-pcw1-ew0.5", pcw: 1.0, ew: 0.5, gaw: 4 },
  { name: "b128-pcw1.5-gaw6", pcw: 1.5, ew: 1.15, gaw: 6 },
];

const results = [];
const bestPushes = 290; // current best from beam-128 default

for (const cfg of configs) {
  console.log(`\n=== ${cfg.name} ===`);
  const started = performance.now();
  const planResult = search({
    algorithm: "plan-macro-beam",
    state,
    maxDepth: 460,
    maxVisited: 24_000,
    transpositionLimit: 240_000,
    planBeamWidth: 128,
    planBoxBranches: 6,
    maxPlanSegments: 160,
    planSlack: 240,
    sequenceMacroLimit: 24,
    sequenceMacroExplored: 48,
    sequenceMacroResults: 4,
    targetedMacroExplored: 64,
    planPushCostWeight: cfg.pcw,
    planEstimateWeight: cfg.ew,
    planGoalAccessWeight: cfg.gaw,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);

  if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
    console.log(`  FAILED (${planResult.status}) | ${Math.round(ms/1000)}s`);
    results.push({ name: cfg.name, status: "failed" });
    continue;
  }

  const sol = solutionFromLegacyPath(request, planResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  console.log(`  m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid} | ${Math.round(ms/1000)}s`);
  results.push({ name: cfg.name, moves: sol.moves, pushes: sol.pushes, walks: sol.moves - sol.pushes, valid, status: "ok" });

  if (valid && sol.pushes < bestPushes) {
    console.log(`  *** NEW BEST PUSH COUNT: ${sol.pushes} ***`);
    writeFileSync(`/tmp/v3-${cfg.name}-path.json`, JSON.stringify(planResult.path));
  }
}

console.log("\n=== Summary ===");
for (const r of results) {
  if (r.status === "ok") {
    console.log(`${r.name.padEnd(22)} m=${r.moves} p=${r.pushes} w=${r.walks} ${r.valid ? "valid" : "INVALID"}`);
  } else {
    console.log(`${r.name.padEnd(22)} FAILED`);
  }
}

// If found a plan with fewer pushes, converge it
const bestResult = results
  .filter(r => r.status === "ok" && r.valid && r.pushes < bestPushes)
  .sort((a, b) => a.pushes - b.pushes)[0];

if (bestResult) {
  console.log(`\nBest: ${bestResult.name} with ${bestResult.pushes} pushes — converging...`);
  let currentPath = JSON.parse(readFileSync(`/tmp/v3-${bestResult.name}-path.json`, "utf-8"));
  for (let pass = 0; pass < 5; pass++) {
    const prevSol = solutionFromLegacyPath(request, currentPath);
    const prevMoves = prevSol.moves;
    const result = search({
      algorithm: "solution-window-rewrite",
      state,
      solutionPath: currentPath,
      maxVisited: 800_000,
      greedyPermutation: false,
      permutationVisited: 300_000,
      permutationWindowPushes: [16, 32, 48],
      perPermutationWindowVisited: 4000,
      permutationHeuristicWeight: 3,
      permutationBidirectional: true,
      permutationMSTHeuristic: true,
      permutationExtraPasses: 1,
      permutationTargetedPasses: 10,
      windowPushes: [16, 32, 48],
      windowVisited: 40_000,
      windowTotalVisited: 300_000,
      moveWindowVisited: 200_000,
      moveWindowPushes: [1, 2, 4, 8, 16],
      moveWindowAttempts: 30,
      moveWindowMinimumOverhead: 2,
      perMoveWindowVisited: 5000,
      moveWindowExtraPushes: 8,
      moveWindowRandomAttempts: 80,
      moveWindowSeed: pass * 1000,
      moveBridgeWeight: 2.0,
      progressIntervalMs: 60_000,
    });
    if (!result.path) {
      console.log(`  Pass ${pass + 1}: converged at ${prevMoves}`);
      break;
    }
    const pSol = solutionFromLegacyPath(request, result.path);
    if (pSol.moves >= prevMoves) {
      console.log(`  Pass ${pass + 1}: converged at ${prevMoves}`);
      break;
    }
    currentPath = result.path;
    console.log(`  Pass ${pass + 1}: m=${pSol.moves} p=${pSol.pushes} w=${pSol.moves - pSol.pushes} | delta=${pSol.moves - prevMoves}`);
  }
  const finalSol = solutionFromLegacyPath(request, currentPath);
  const finalValid = verifySolverSolution(request, finalSol).valid;
  console.log(`\n=== FINAL: ${finalSol.moves} moves / ${finalSol.pushes} pushes / ${finalSol.moves - finalSol.pushes} walks | valid=${finalValid} ===`);
  writeFileSync("/tmp/v3-push-tuning-best.json", JSON.stringify(currentPath));
}
