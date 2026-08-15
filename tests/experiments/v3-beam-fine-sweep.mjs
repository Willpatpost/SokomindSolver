/**
 * Fine beam width sweep around the 192 sweet spot.
 * Tests: 176, 184, 200, 208, 224, 240, 288, 320
 * Tries to find even lower push counts near the beam-192 optimum.
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

const beamWidths = [224, 240, 248, 264, 272, 288, 320, 384, 512];
const results = [];
let bestPushes = 266; // current best from beam-256

for (const beamWidth of beamWidths) {
  const scale = Math.ceil(beamWidth / 32);
  console.log(`\n=== beam-${beamWidth} ===`);
  const started = performance.now();
  const planResult = search({
    algorithm: "plan-macro-beam",
    state,
    maxDepth: 460,
    maxVisited: scale * 6_000,
    transpositionLimit: scale * 60_000,
    planBeamWidth: beamWidth,
    planBoxBranches: 6,
    maxPlanSegments: 160,
    planSlack: 240,
    sequenceMacroLimit: 24,
    sequenceMacroExplored: 48,
    sequenceMacroResults: 4,
    targetedMacroExplored: 64,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);

  if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
    console.log(`  FAILED (${planResult.status}) | ${Math.round(ms/1000)}s`);
    results.push({ beamWidth, status: "failed" });
    continue;
  }

  const sol = solutionFromLegacyPath(request, planResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  console.log(`  m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid} | ${Math.round(ms/1000)}s`);
  results.push({ beamWidth, moves: sol.moves, pushes: sol.pushes, walks: sol.moves - sol.pushes, valid, status: "ok" });

  if (valid && sol.pushes < bestPushes) {
    bestPushes = sol.pushes;
    console.log(`  *** NEW BEST PUSH COUNT: ${sol.pushes} ***`);
    writeFileSync(`/tmp/v3-beam-${beamWidth}-path.json`, JSON.stringify(planResult.path));
  }
}

console.log("\n=== Summary ===");
console.log("Width | Moves | Pushes | Walks | Status");
console.log("-".repeat(50));
for (const r of results) {
  if (r.status === "ok") {
    const marker = r.pushes === bestPushes ? " <<<" : "";
    console.log(`${String(r.beamWidth).padStart(5)} | ${String(r.moves).padStart(5)} | ${String(r.pushes).padStart(6)} | ${String(r.walks).padStart(5)} | ${r.valid ? "valid" : "INVALID"}${marker}`);
  } else {
    console.log(`${String(r.beamWidth).padStart(5)} | FAILED`);
  }
}
