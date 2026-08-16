/**
 * Quick diagnostic: plan + rewrite + walk distribution analysis.
 * Shows which pushes have the longest walks, helping identify optimization targets.
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

// Phase 1: plan
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
  console.log(`Plan failed: ${planResult.status}`);
  process.exit(1);
}

// Phase 2: iterative rewrite (3 passes)
let currentPath = planResult.path;
for (let pass = 0; pass < 3; pass++) {
  const result = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: 500_000,
    greedyPermutation: false,
    permutationVisited: 150_000,
    permutationWindowPushes: [8, 16, 32, 48],
    perPermutationWindowVisited: 2000,
    windowPushes: [8, 16, 32, 48],
    windowVisited: 30_000,
    windowTotalVisited: 200_000,
    moveWindowVisited: 100_000,
    moveWindowPushes: [1, 2, 4, 8],
    moveWindowAttempts: 20,
    moveWindowMinimumOverhead: 3,
    perMoveWindowVisited: 3000,
    moveWindowExtraPushes: 6,
    progressIntervalMs: 60_000,
  });
  if (result.path) {
    currentPath = result.path;
    const sol = solutionFromLegacyPath(request, currentPath);
    console.log(`Pass ${pass+1}: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes}`);
  } else {
    console.log(`Pass ${pass+1}: no improvement`);
    break;
  }
}

// Phase 3: Walk distribution analysis using solutionFromLegacyPath
const sol = solutionFromLegacyPath(request, currentPath);
const walkRuns = [];
let currentRun = 0;
for (const step of sol.steps) {
  if (step.kind === "push") {
    walkRuns.push(currentRun);
    currentRun = 0;
  } else {
    currentRun++;
  }
}

const totalWalks = walkRuns.reduce((a, b) => a + b, 0);
const totalPushes = walkRuns.length;
console.log(`\n=== Walk distribution (${totalPushes} pushes, ${totalWalks} walks) ===`);
console.log(`Average walk per push: ${(totalWalks/totalPushes).toFixed(2)}`);

const sorted = [...walkRuns].sort((a, b) => a - b);
console.log(`Min: ${sorted[0]}, Median: ${sorted[Math.floor(sorted.length/2)]}, Max: ${sorted[sorted.length-1]}`);

// Histogram
const buckets = [[0,0],[1,1],[2,2],[3,3],[4,5],[6,10],[11,20],[21,50],[51,Infinity]];
console.log("\nHistogram (walks before each push):");
for (const [lo, hi] of buckets) {
  const matching = walkRuns.filter(w => w >= lo && w <= hi);
  const count = matching.length;
  const total = matching.reduce((a,b) => a+b, 0);
  if (count > 0) {
    console.log(`  ${lo}-${hi === Infinity ? '∞' : hi}: ${count} pushes (${(count/totalPushes*100).toFixed(0)}%), ${total} walks (${(total/totalWalks*100).toFixed(1)}%)`);
  }
}

// Top 30 longest walks
console.log("\nTop 30 longest walks:");
const indexed = walkRuns.map((w, i) => ({walks: w, pushIndex: i}))
  .sort((a, b) => b.walks - a.walks)
  .slice(0, 30);
let cumulTop = 0;
for (const {walks: w, pushIndex} of indexed) {
  cumulTop += w;
  console.log(`  Push #${pushIndex}: ${w} walks`);
}
console.log(`Top 30 total: ${cumulTop} walks (${(cumulTop/totalWalks*100).toFixed(1)}%)`);

// What would perfect walk reduction look like?
console.log("\nIf we could cap walks:");
for (const cap of [1, 2, 3, 5, 8, 10]) {
  const saved = walkRuns.reduce((sum, w) => sum + Math.max(0, w - cap), 0);
  const newTotal = totalPushes + (totalWalks - saved);
  console.log(`  Cap at ${cap}: ${totalWalks - saved} walks, ${newTotal} total moves (save ${saved})`);
}
