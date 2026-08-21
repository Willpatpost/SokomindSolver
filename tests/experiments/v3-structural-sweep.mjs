/**
 * V3 structural sweep: keeper diversity, fixed setup distance, segment walk penalty,
 * first-push proximity, walk-aware candidate dedup.
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

const BASE = {
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
};

const experiments = [
  // Baseline
  { name: "baseline", o: {} },

  // First-push proximity alone (key lever: biases toward nearby boxes)
  { name: "prox=0.2", o: { planFirstPushProximityWeight: 0.2 } },
  { name: "prox=0.5", o: { planFirstPushProximityWeight: 0.5 } },
  { name: "prox=1.0", o: { planFirstPushProximityWeight: 1.0 } },
  { name: "prox=2.0", o: { planFirstPushProximityWeight: 2.0 } },

  // Fixed setup distance alone (now excludes solved boxes)
  { name: "su=1.0", o: { planSetupWeight: 1.0 } },
  { name: "su=2.0", o: { planSetupWeight: 2.0 } },
  { name: "su=4.0", o: { planSetupWeight: 4.0 } },

  // Keeper diversity alone
  { name: "keepDiv", o: { planKeeperDiversity: true } },

  // Walk-aware candidate dedup alone
  { name: "prefMoves", o: { planPreferLowerMoves: true } },

  // Segment walk penalty alone
  { name: "segWalk=0.3", o: { planSegmentWalkWeight: 0.3 } },
  { name: "segWalk=1.0", o: { planSegmentWalkWeight: 1.0 } },

  // Combinations
  { name: "prox=0.5+keepDiv", o: { planFirstPushProximityWeight: 0.5, planKeeperDiversity: true } },
  { name: "prox=1.0+su=2.0", o: { planFirstPushProximityWeight: 1.0, planSetupWeight: 2.0 } },
  { name: "prox=1.0+prefMoves", o: { planFirstPushProximityWeight: 1.0, planPreferLowerMoves: true } },
  { name: "prox=0.5+segWalk=0.3+keepDiv", o: { planFirstPushProximityWeight: 0.5, planSegmentWalkWeight: 0.3, planKeeperDiversity: true } },
  { name: "prox=1.0+su=2.0+keepDiv+prefMoves", o: { planFirstPushProximityWeight: 1.0, planSetupWeight: 2.0, planKeeperDiversity: true, planPreferLowerMoves: true } },
  { name: "all=moderate", o: { planFirstPushProximityWeight: 0.5, planSetupWeight: 1.0, planSegmentWalkWeight: 0.3, planKeeperDiversity: true, planPreferLowerMoves: true } },
];

console.log(`=== V3 Structural Sweep ===`);
console.log(`Date: ${new Date().toISOString()}`);
console.log(`Experiments: ${experiments.length}`);
console.log("");

const results = [];
for (const exp of experiments) {
  const params = { ...BASE, ...exp.o };
  const started = performance.now();
  const result = search(params);
  const elapsedMs = Math.round(performance.now() - started);

  let moves = null, pushes = null, walks = null, valid = false;
  if (result.status === "solved" && Array.isArray(result.path)) {
    const solution = solutionFromLegacyPath(request, result.path);
    if (solution) {
      moves = solution.moves;
      pushes = solution.pushes;
      walks = moves - pushes;
      valid = verifySolverSolution(request, solution).valid;
    }
  }

  results.push({ name: exp.name, moves, pushes, walks, visited: result.visited, retained: result.retained, elapsedMs, valid, status: result.status });

  const baseline = results[0];
  const delta = moves && baseline.moves ? moves - baseline.moves : "N/A";
  const tag = moves == null ? "NO SOL" : delta < -30 ? "BETTER" : delta > 30 ? "WORSE" : "~SAME";
  console.log(`[${exp.name}] ${result.status} | m=${moves ?? "-"} p=${pushes ?? "-"} w=${walks ?? "-"} | vis=${result.visited} ret=${result.retained} | ${elapsedMs}ms | d=${delta} ${tag}`);
}

console.log("");
console.log("=== SORTED BY MOVES ===");
const sorted = [...results].filter(r => r.moves).sort((a, b) => a.moves - b.moves);
for (const r of sorted) {
  console.log(`  ${r.moves} moves / ${r.pushes} pushes / ${r.walks} walks | ${r.name}`);
}
