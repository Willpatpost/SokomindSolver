/**
 * Analyze where walks come from in the baseline Grand Hall solution.
 * Breaks down walks per segment to understand the distribution.
 */
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession } from "../../src/core/index.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";

globalThis.postMessage = () => {};

const huge = PUZZLE_BY_ID.huge;
const session = createSession(huge);
const request = {
  board: session.board,
  snapshot: session.snapshot,
  objective: { kind: "moves" },
};
const state = toLegacyState(request);

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
};

const result = search(params);
if (result.status !== "solved" || !Array.isArray(result.path)) {
  console.log("No solution found");
  process.exit(1);
}

const path = result.path;
const _PUSH_DIRS = ["u", "d", "l", "r"];

// Analyze the path: identify push vs walk moves
let pushes = 0, walks = 0;
const _segments = [];
let _currentSegmentStart = 0;
let _currentSegmentWalks = 0;
let _currentSegmentPushes = 0;
let _robotY, _robotX;

// We need to replay the path to track robot position
// The path is an array of move directions
// For now, just count consecutive walks before pushes

// Actually, let's analyze the macro segments from the search tree
// The path is flat - each element is a move direction (u/d/l/r or U/D/L/R)
// Uppercase = push, lowercase = walk
for (let i = 0; i < path.length; i++) {
  const move = path[i];
  const isPush = move === move.toUpperCase();
  if (isPush) {
    pushes++;
    _currentSegmentPushes++;
  } else {
    walks++;
    _currentSegmentWalks++;
  }
}

console.log(`Total: ${path.length} moves = ${pushes} pushes + ${walks} walks`);
console.log(`Average walks per push: ${(walks/pushes).toFixed(2)}`);

// Analyze walk runs (consecutive walk steps before a push)
let walkRuns = [];
let currentRun = 0;
for (let i = 0; i < path.length; i++) {
  const move = path[i];
  const isPush = move === move.toUpperCase();
  if (isPush) {
    walkRuns.push(currentRun);
    currentRun = 0;
  } else {
    currentRun++;
  }
}

// Distribution of walk runs
const sorted = [...walkRuns].sort((a, b) => a - b);
console.log(`\nWalk runs (walks before each push): ${walkRuns.length} runs`);
console.log(`  Min: ${sorted[0]}, Max: ${sorted[sorted.length-1]}`);
console.log(`  Median: ${sorted[Math.floor(sorted.length/2)]}`);
console.log(`  Mean: ${(walkRuns.reduce((a,b) => a+b, 0) / walkRuns.length).toFixed(2)}`);

// Histogram
const buckets = [0, 1, 2, 3, 4, 5, 10, 15, 20, 30, 50, 100];
console.log("\nHistogram:");
for (let i = 0; i < buckets.length; i++) {
  const lo = buckets[i];
  const hi = i + 1 < buckets.length ? buckets[i+1] : Infinity;
  const count = walkRuns.filter(w => w >= lo && w < hi).length;
  const totalWalks = walkRuns.filter(w => w >= lo && w < hi).reduce((a,b) => a+b, 0);
  if (count > 0) {
    console.log(`  ${lo}-${hi === Infinity ? '∞' : hi-1}: ${count} pushes, ${totalWalks} total walks (${(totalWalks/walks*100).toFixed(1)}%)`);
  }
}

// Top 10 longest walks
console.log("\nTop 20 longest walk runs:");
const indexed = walkRuns.map((w, i) => ({walks: w, pushIndex: i}))
  .sort((a, b) => b.walks - a.walks)
  .slice(0, 20);
for (const {walks: w, pushIndex} of indexed) {
  console.log(`  Push #${pushIndex}: ${w} walks`);
}

// Cumulative: how many walks would be saved by capping
console.log("\nWalk savings by capping:");
for (const cap of [3, 5, 8, 10, 15, 20]) {
  const saved = walkRuns.reduce((sum, w) => sum + Math.max(0, w - cap), 0);
  console.log(`  Cap at ${cap}: save ${saved} walks (${(saved/walks*100).toFixed(1)}%)`);
}
