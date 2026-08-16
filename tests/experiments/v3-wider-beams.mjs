/**
 * Test wider beam widths (160, 192, 256, 384) for plan generation.
 * wide-128 gave 290 pushes / 954 moves — can we do even better?
 * Also test beam=128 with different macro/slack settings.
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
  { name: "beam-160", beamWidth: 160, boxBranches: 6, slack: 240, macroLimit: 24, macroExplored: 48, macroResults: 4, targetMacro: 64 },
  { name: "beam-192", beamWidth: 192, boxBranches: 6, slack: 240, macroLimit: 24, macroExplored: 48, macroResults: 4, targetMacro: 64 },
  { name: "beam-256", beamWidth: 256, boxBranches: 6, slack: 240, macroLimit: 24, macroExplored: 48, macroResults: 4, targetMacro: 64 },
  { name: "beam-128-boxes8", beamWidth: 128, boxBranches: 8, slack: 240, macroLimit: 24, macroExplored: 48, macroResults: 4, targetMacro: 64 },
  { name: "beam-128-slack300", beamWidth: 128, boxBranches: 6, slack: 300, macroLimit: 24, macroExplored: 48, macroResults: 4, targetMacro: 64 },
  { name: "beam-128-macrodeep", beamWidth: 128, boxBranches: 6, slack: 240, macroLimit: 32, macroExplored: 96, macroResults: 6, targetMacro: 128 },
  { name: "beam-128-boxes8-slack300", beamWidth: 128, boxBranches: 8, slack: 300, macroLimit: 32, macroExplored: 96, macroResults: 6, targetMacro: 128 },
  { name: "beam-384", beamWidth: 384, boxBranches: 6, slack: 240, macroLimit: 24, macroExplored: 48, macroResults: 4, targetMacro: 64 },
];

const results = [];

for (const cfg of configs) {
  const scale = Math.ceil(cfg.beamWidth / 32);
  console.log(`\n=== ${cfg.name} (beam=${cfg.beamWidth}) ===`);
  const started = performance.now();
  const planResult = search({
    algorithm: "plan-macro-beam",
    state,
    maxDepth: 460,
    maxVisited: scale * 6_000,
    transpositionLimit: scale * 60_000,
    planBeamWidth: cfg.beamWidth,
    planBoxBranches: cfg.boxBranches,
    maxPlanSegments: 160,
    planSlack: cfg.slack,
    sequenceMacroLimit: cfg.macroLimit,
    sequenceMacroExplored: cfg.macroExplored,
    sequenceMacroResults: cfg.macroResults,
    targetedMacroExplored: cfg.targetMacro,
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

  if (valid && sol.pushes < 290) {
    console.log(`  *** NEW BEST PUSH COUNT: ${sol.pushes} (vs 290 for beam-128) ***`);
    writeFileSync(`/tmp/v3-${cfg.name}-path.json`, JSON.stringify(planResult.path));
  }
}

console.log("\n=== Summary ===");
console.log("Config           | Moves | Pushes | Walks | Status");
console.log("-".repeat(60));
for (const r of results) {
  if (r.status === "ok") {
    console.log(`${r.name.padEnd(18)}| ${String(r.moves).padStart(5)} | ${String(r.pushes).padStart(6)} | ${String(r.walks).padStart(5)} | ${r.valid ? "valid" : "INVALID"}`);
  } else {
    console.log(`${r.name.padEnd(18)}| ${r.status}`);
  }
}

// If any plan beat 290 pushes, converge the best one
const bestPlan = results
  .filter(r => r.status === "ok" && r.valid && r.pushes < 290)
  .sort((a, b) => a.pushes - b.pushes)[0];

if (bestPlan) {
  console.log(`\n*** Best plan: ${bestPlan.name} with ${bestPlan.pushes} pushes — convergence saved to /tmp/v3-${bestPlan.name}-path.json ***`);
}
