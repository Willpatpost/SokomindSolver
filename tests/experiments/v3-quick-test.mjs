/**
 * Quick single Grand Hall test with current engine.
 * Run: node --experimental-strip-types tests/experiments/v3-quick-test.mjs
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

const overrides = {};
for (const arg of process.argv.slice(2)) {
  const [key, val] = arg.split("=");
  if (key && val !== undefined) overrides[key] = Number(val);
}

const params = {
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
  ...overrides,
};

console.log("Params override:", JSON.stringify(overrides));
const started = performance.now();
const result = search(params);
const elapsedMs = Math.round(performance.now() - started);

if (result.status === "solved" && Array.isArray(result.path)) {
  const solution = solutionFromLegacyPath(request, result.path);
  const valid = verifySolverSolution(request, solution).valid;
  console.log(`SOLVED | moves=${solution.moves} pushes=${solution.pushes} walks=${solution.moves - solution.pushes} | visited=${result.visited} generated=${result.generated} retained=${result.retained} peakFrontier=${result.peakFrontier} | ${elapsedMs}ms | valid=${valid}`);
} else {
  console.log(`${result.status} | visited=${result.visited} generated=${result.generated} | ${elapsedMs}ms`);
}
