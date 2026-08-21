/**
 * Test plan-macro-beam with higher budget (4x default).
 * More budget might find a solution with fewer pushes.
 */
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession } from "../../src/core/index.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { solutionFromLegacyPath, toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";

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
  { name: "default (6K)", maxVisited: 6_000, transpositionLimit: 60_000 },
  { name: "2x (12K)", maxVisited: 12_000, transpositionLimit: 120_000 },
  { name: "4x (24K)", maxVisited: 24_000, transpositionLimit: 240_000 },
  { name: "8x (48K)", maxVisited: 48_000, transpositionLimit: 480_000 },
];

for (const cfg of configs) {
  console.log(`\n--- ${cfg.name} ---`);
  const started = performance.now();
  const result = search({
    algorithm: "plan-macro-beam",
    state,
    maxDepth: 460,
    maxVisited: cfg.maxVisited,
    transpositionLimit: cfg.transpositionLimit,
    planBeamWidth: 32,
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

  if (result.status !== "solved" || !Array.isArray(result.path)) {
    console.log(`  FAILED: ${result.status} | ${Math.round(ms/1000)}s`);
    continue;
  }

  const sol = solutionFromLegacyPath(request, result.path);
  console.log(`  Raw: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | ${Math.round(ms/1000)}s`);
}
