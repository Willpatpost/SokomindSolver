/**
 * V3 weight experiments for Grand Hall.
 *
 * Calls search() directly with varied parameters, records move/push counts.
 * Run: node --experimental-strip-types tests/experiments/v3-weight-experiments.mjs
 */

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import {
  createSession,
} from "../../src/core/index.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import {
  solutionFromLegacyPath,
  toLegacyState,
} from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

globalThis.postMessage = () => {};

const huge = PUZZLE_BY_ID.huge;
if (!huge) throw new Error("Grand Hall puzzle not found");

const session = createSession(huge);
const request = {
  board: session.board,
  snapshot: session.snapshot,
  objective: { kind: "moves" },
};
const state = toLegacyState(request);

const BASE_PARAMS = {
  algorithm: "plan-macro-beam",
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

const experiments = [
  { name: "baseline", overrides: {} },

  // planMoveWeight variations
  { name: "pmw=0.01", overrides: { planMoveWeight: 0.01 } },
  { name: "pmw=0.02", overrides: { planMoveWeight: 0.02 } },
  { name: "pmw=0.03", overrides: { planMoveWeight: 0.03 } },
  { name: "pmw=0.05", overrides: { planMoveWeight: 0.05 } },

  // Wider beam
  { name: "beam=48", overrides: { planBeamWidth: 48 } },
  { name: "beam=64", overrides: { planBeamWidth: 64 } },

  // More segments
  { name: "segments=240", overrides: { maxPlanSegments: 240 } },

  // More slack
  { name: "slack=360", overrides: { planSlack: 360 } },
  { name: "slack=480", overrides: { planSlack: 480 } },

  // More box branches
  { name: "boxes=8", overrides: { planBoxBranches: 8 } },

  // More macros
  { name: "macro=32", overrides: { sequenceMacroLimit: 32 } },
  { name: "macro=48", overrides: { sequenceMacroLimit: 48 } },

  // More visited budget
  { name: "visited=12k", overrides: { maxVisited: 12_000 } },

  // Combos
  { name: "beam64+vis12k", overrides: { planBeamWidth: 64, maxVisited: 12_000 } },
  { name: "beam64+slack480", overrides: { planBeamWidth: 64, planSlack: 480 } },
  { name: "beam64+box8+vis12k", overrides: { planBeamWidth: 64, planBoxBranches: 8, maxVisited: 12_000 } },
];

console.log("=== V3 Weight Experiments: Grand Hall (plan-macro-beam) ===");
console.log(`Date: ${new Date().toISOString()}`);
console.log(`Experiments: ${experiments.length}`);
console.log("");

const results = [];

for (const exp of experiments) {
  const params = { ...BASE_PARAMS, state, ...exp.overrides };
  const started = performance.now();
  const result = search(params);
  const elapsedMs = Math.round(performance.now() - started);

  let moves = null, pushes = null, valid = false;
  if (result.status === "solved" && Array.isArray(result.path)) {
    const solution = solutionFromLegacyPath(request, result.path);
    if (solution) {
      moves = solution.moves;
      pushes = solution.pushes;
      valid = verifySolverSolution(request, solution).valid;
    }
  }

  const row = {
    name: exp.name,
    status: result.status,
    moves,
    pushes,
    visited: result.visited ?? null,
    generated: result.generated ?? null,
    elapsedMs,
    valid,
  };
  results.push(row);

  const baseline = results[0];
  const moveDelta = moves && baseline.moves ? moves - baseline.moves : "N/A";
  const verdict = moves == null ? "NO SOLUTION"
    : moveDelta < -20 ? "BETTER"
    : moveDelta > 20 ? "WORSE"
    : "NEUTRAL";

  console.log(`[${exp.name}] ${result.status} | moves=${moves ?? "-"} pushes=${pushes ?? "-"} | visited=${result.visited} | ${elapsedMs}ms | delta=${moveDelta} | ${verdict}`);
}

console.log("");
console.log("=== Summary Table ===");
console.log("Name | Moves | Pushes | Visited | Time(ms) | Delta | Verdict");
console.log("--- | --- | --- | --- | --- | --- | ---");
for (const r of results) {
  const baseline = results[0];
  const delta = r.moves && baseline.moves ? r.moves - baseline.moves : "N/A";
  const verdict = r.moves == null ? "NO SOLUTION"
    : delta < -20 ? "BETTER"
    : delta > 20 ? "WORSE"
    : "NEUTRAL";
  console.log(`${r.name} | ${r.moves ?? "-"} | ${r.pushes ?? "-"} | ${r.visited ?? "-"} | ${r.elapsedMs} | ${delta} | ${verdict}`);
}
