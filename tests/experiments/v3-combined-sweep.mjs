/**
 * V3 combined sweep: dominance weight + scoring + setup distance.
 * New payload params:
 *   planMoveDominanceWeight: weight of moves in dedup comparison (default 0 = push-only)
 *   planMoveCostWeight: coefficient for moves in scoring (default 0.005 = planMoveWeight)
 *   planPushCostWeight: coefficient for pushes in scoring (default 1)
 *   planSetupWeight: next-push Manhattan distance penalty (default 0)
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
  // Baseline: no changes (dom=0, original scoring)
  { name: "baseline(dom=0)", o: {} },

  // Dominance only
  { name: "dom=0.1", o: { planMoveDominanceWeight: 0.1 } },
  { name: "dom=0.2", o: { planMoveDominanceWeight: 0.2 } },
  { name: "dom=0.3", o: { planMoveDominanceWeight: 0.3 } },

  // Dominance + move cost in scoring
  { name: "dom=0.2,mcw=0.05", o: { planMoveDominanceWeight: 0.2, planMoveCostWeight: 0.05 } },
  { name: "dom=0.2,mcw=0.1", o: { planMoveDominanceWeight: 0.2, planMoveCostWeight: 0.1 } },
  { name: "dom=0.3,mcw=0.1", o: { planMoveDominanceWeight: 0.3, planMoveCostWeight: 0.1 } },

  // Dominance + setup distance only
  { name: "dom=0.2,su=0.5", o: { planMoveDominanceWeight: 0.2, planSetupWeight: 0.5 } },
  { name: "dom=0.2,su=1.0", o: { planMoveDominanceWeight: 0.2, planSetupWeight: 1.0 } },
  { name: "dom=0.3,su=0.5", o: { planMoveDominanceWeight: 0.3, planSetupWeight: 0.5 } },

  // Setup only (no dominance change)
  { name: "su=0.5", o: { planSetupWeight: 0.5 } },
  { name: "su=1.0", o: { planSetupWeight: 1.0 } },
  { name: "su=2.0", o: { planSetupWeight: 2.0 } },

  // Full combo
  { name: "dom=0.2,mcw=0.05,su=0.5", o: { planMoveDominanceWeight: 0.2, planMoveCostWeight: 0.05, planSetupWeight: 0.5 } },
  { name: "dom=0.2,mcw=0.1,su=1.0", o: { planMoveDominanceWeight: 0.2, planMoveCostWeight: 0.1, planSetupWeight: 1.0 } },
];

console.log(`=== V3 Combined Sweep ===`);
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
