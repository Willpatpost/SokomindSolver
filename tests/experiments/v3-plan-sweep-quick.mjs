/**
 * Quick plan parameter sweep: compare raw plan outputs only (no convergence).
 * Tests whether different planMoveCostWeight values produce different solutions.
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
  { name: "default", moveCostWeight: 0.005, firstPushProx: 0, segWalkWt: 0, moveDom: 0, estWt: 1.15, pushWt: 1 },
  { name: "walk-05", moveCostWeight: 0.05, firstPushProx: 0.3, segWalkWt: 0, moveDom: 0, estWt: 1.15, pushWt: 1 },
  { name: "walk-10", moveCostWeight: 0.1, firstPushProx: 0.5, segWalkWt: 0, moveDom: 0.01, estWt: 1.15, pushWt: 1 },
  { name: "walk-20", moveCostWeight: 0.2, firstPushProx: 1.0, segWalkWt: 0.1, moveDom: 0.02, estWt: 1.15, pushWt: 1 },
  { name: "walk-30", moveCostWeight: 0.3, firstPushProx: 1.5, segWalkWt: 0.2, moveDom: 0.03, estWt: 1.15, pushWt: 1 },
  { name: "walk-50", moveCostWeight: 0.5, firstPushProx: 2.0, segWalkWt: 0.3, moveDom: 0.05, estWt: 1.15, pushWt: 1 },
  { name: "walk-100", moveCostWeight: 1.0, firstPushProx: 3.0, segWalkWt: 0.5, moveDom: 0.1, estWt: 1.15, pushWt: 1 },
  // Also try reducing push cost weight
  { name: "lowpush-30", moveCostWeight: 0.3, firstPushProx: 1.0, segWalkWt: 0.1, moveDom: 0.02, estWt: 1.0, pushWt: 0.5 },
  { name: "lowpush-50", moveCostWeight: 0.5, firstPushProx: 1.0, segWalkWt: 0.1, moveDom: 0.03, estWt: 0.8, pushWt: 0.3 },
  // Try higher beam width with walk-aware
  { name: "wide-walk-20", moveCostWeight: 0.2, firstPushProx: 1.0, segWalkWt: 0.1, moveDom: 0.02, estWt: 1.15, pushWt: 1, beamWidth: 64 },
  { name: "wide-walk-30", moveCostWeight: 0.3, firstPushProx: 1.5, segWalkWt: 0.2, moveDom: 0.03, estWt: 1.15, pushWt: 1, beamWidth: 64 },
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
    planBeamWidth: cfg.beamWidth || 32,
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
    planEstimateWeight: cfg.estWt,
    planPushCostWeight: cfg.pushWt,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);

  if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
    console.log(`  FAILED: ${planResult.status} | ${Math.round(ms/1000)}s`);
    results.push({ name: cfg.name, status: "failed", ms });
    continue;
  }

  const sol = solutionFromLegacyPath(request, planResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  console.log(`  m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid} | ${Math.round(ms/1000)}s`);
  results.push({
    name: cfg.name,
    moves: sol.moves,
    pushes: sol.pushes,
    walks: sol.moves - sol.pushes,
    valid,
    ms,
  });
}

console.log("\n\n=== SUMMARY ===");
console.log("Config              | Moves | Pushes | Walks");
console.log("-".repeat(55));
for (const r of results) {
  if (r.status === "failed") {
    console.log(`${r.name.padEnd(20)}| FAILED (${Math.round(r.ms/1000)}s)`);
    continue;
  }
  console.log(`${r.name.padEnd(20)}| ${String(r.moves).padEnd(6)}| ${String(r.pushes).padEnd(7)}| ${r.walks}`);
}

writeFileSync("/tmp/v3-plan-sweep-results.json", JSON.stringify(results, null, 2));
