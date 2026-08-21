/**
 * Test planFirstPushProximityWeight: bias first-push scoring toward
 * nearby boxes. This could produce different push sequences without
 * breaking the fragile beamWidth=32 beam.
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

const weights = [0, 0.1, 0.2, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0, 5.0, -0.5, -1.0];
const results = [];

for (const w of weights) {
  console.log(`\n=== planFirstPushProximityWeight = ${w} ===`);
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
    planFirstPushProximityWeight: w,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);

  if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
    console.log(`  FAILED (${planResult.status}) | ${Math.round(ms/1000)}s`);
    results.push({ weight: w, status: "failed" });
    continue;
  }
  const sol = solutionFromLegacyPath(request, planResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  console.log(`  m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid} | ${Math.round(ms/1000)}s`);

  if (valid) {
    results.push({ weight: w, moves: sol.moves, pushes: sol.pushes,
      walks: sol.moves - sol.pushes, path: planResult.path, status: "ok" });
  } else {
    results.push({ weight: w, status: "invalid" });
  }
}

console.log("\n=== Summary ===");
const ok = results.filter(r => r.status === "ok");
for (const r of ok) {
  console.log(`  w=${r.weight}: m=${r.moves} p=${r.pushes} w=${r.walks}`);
}
const failed = results.filter(r => r.status !== "ok");
for (const r of failed) {
  console.log(`  w=${r.weight}: ${r.status}`);
}

// Find unique plans
const unique = new Map();
for (const r of ok) {
  const key = `${r.moves}/${r.pushes}`;
  if (!unique.has(key)) unique.set(key, r);
}
console.log(`\nUnique plans: ${unique.size}`);

// Converge the best unique plans
const best = [...unique.values()].sort((a, b) => a.moves - b.moves);
if (best.length === 0) {
  console.log("No valid plans.");
  process.exit(1);
}

const topPlans = best.slice(0, 4);
for (const plan of topPlans) {
  console.log(`\n--- Converging: w=${plan.weight} (raw ${plan.moves} moves) ---`);
  let currentPath = plan.path;
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
  console.log(`  Final: m=${finalSol.moves} p=${finalSol.pushes} w=${finalSol.moves - finalSol.pushes}`);
  if (finalSol.moves < 700) {
    console.log("*** TARGET ACHIEVED ***");
    writeFileSync("/tmp/v3-proximity-best.json", JSON.stringify(currentPath));
  }
}
