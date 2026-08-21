/**
 * Analyze the push chain structure of the Grand Hall solution.
 * Shows: chain lengths per box, dependency structure, walk distribution.
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
  progressIntervalMs: 60_000,
});

if (planResult.status !== "solved") {
  console.log("Plan failed");
  process.exit(1);
}

// Replay solution to extract push chains and walk distribution
const path = planResult.path;
const sol = solutionFromLegacyPath(request, path);
console.log(`Solution: ${sol.moves} moves, ${sol.pushes} pushes, ${sol.moves - sol.pushes} walks`);

// Count walks per segment
let pushCount = 0;
let walksSinceLastPush = 0;
const walkLengths = [];

for (const step of sol.steps) {
  if (step.kind === "push") {
    walkLengths.push(walksSinceLastPush);
    walksSinceLastPush = 0;
    pushCount++;
  } else {
    walksSinceLastPush++;
  }
}

console.log(`\n--- Walk Distribution ---`);
const walkBuckets = new Map();
for (const w of walkLengths) {
  walkBuckets.set(w, (walkBuckets.get(w) || 0) + 1);
}
const sorted = [...walkBuckets.entries()].sort((a, b) => a[0] - b[0]);
for (const [walk, count] of sorted) {
  console.log(`  walk=${walk}: ${count} pushes (${(100*count/pushCount).toFixed(1)}%)`);
}

console.log(`\n--- Walk Statistics ---`);
const totalWalks = walkLengths.reduce((a, b) => a + b, 0);
const maxWalk = Math.max(...walkLengths);
const avgWalk = totalWalks / walkLengths.length;
const medianWalk = [...walkLengths].sort((a, b) => a - b)[Math.floor(walkLengths.length / 2)];
console.log(`  Total walks: ${totalWalks}`);
console.log(`  Max walk: ${maxWalk}`);
console.log(`  Avg walk: ${avgWalk.toFixed(2)}`);
console.log(`  Median walk: ${medianWalk}`);
console.log(`  Pushes with walk >= 5: ${walkLengths.filter(w => w >= 5).length}`);
console.log(`  Pushes with walk >= 10: ${walkLengths.filter(w => w >= 10).length}`);
console.log(`  Walks from top 20 longest: ${[...walkLengths].sort((a, b) => b - a).slice(0, 20).reduce((a, b) => a + b, 0)}`);

// Show top 20 longest walks
console.log(`\n--- Top 20 Longest Walks ---`);
const indexed = walkLengths.map((w, i) => ({walk: w, pushIndex: i}));
indexed.sort((a, b) => b.walk - a.walk);
for (let i = 0; i < Math.min(20, indexed.length); i++) {
  console.log(`  Push #${indexed[i].pushIndex}: walk=${indexed[i].walk}`);
}
