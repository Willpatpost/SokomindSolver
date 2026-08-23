/**
 * Benchmark: push-block reordering optimizer against Grand Hall routes.
 *
 * Run directly:
 *   node --experimental-strip-types tests/performance/push-block-reorder-benchmark.ts
 *
 * This is NOT wired into CI — it is a manual diagnostic tool.
 */

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession } from "../../src/core/index.ts";
import type { SolverRequest } from "../../src/solver/contracts.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import {
  solutionFromLegacyPath,
  toLegacyState,
} from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import {
  optimizePushBlockOrder,
  extractPushBlocks,
  attemptAdjacentSwap,
  type OptimizationReport,
} from "../../src/solver/search/push-block-reorder.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";

function requestFor(puzzle: { id: string; title: string; difficulty: string; boxes: number; rows: readonly string[] }): SolverRequest {
  const session = createSession(puzzle as Parameters<typeof createSession>[0]);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
  };
}

function printReport(label: string, report: OptimizationReport): void {
  console.log(`\n=== ${label} ===`);
  console.log(`Original:       ${report.originalMoves} moves / ${report.originalPushes} pushes`);
  console.log(`Routing-only:   ${report.routingOnlyMoves} moves / ${report.routingOnlyPushes} pushes`);
  console.log(`Optimized:      ${report.optimizedMoves} moves / ${report.optimizedPushes} pushes`);
  console.log(`Routing saving: ${report.originalMoves - report.routingOnlyMoves} moves`);
  console.log(`Ordering saving:${report.routingOnlyMoves - report.optimizedMoves} moves`);
  console.log(`Total saving:   ${report.originalMoves - report.optimizedMoves} moves`);
  console.log(`Push blocks:    ${report.blockCount} (split on any walk interruption)`);
  console.log(`Swaps:          ${report.successfulSwaps} accepted / ${report.attemptedSwaps} attempted / ${report.rejectedSwaps} rejected`);
  console.log(`Box episodes:   ${report.totalEpisodesBefore} → ${report.totalEpisodesAfter} (split only on box-identity change)`);
  console.log(`Max ep/box:     ${report.maxEpisodesPerBoxBefore} → ${report.maxEpisodesPerBoxAfter}`);
  console.log(`Elapsed:        ${report.elapsedMs.toFixed(0)}ms`);
}

// Suppress worker postMessage in Node
const originalPostMessage = globalThis.postMessage;
globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;

const huge = PUZZLE_BY_ID.huge;
if (!huge) {
  console.error("Grand Hall puzzle not found in catalog");
  process.exit(1);
}
const request = requestFor(huge);

console.log("Running Grand Hall benchmark...\n");

// 1. Get 893/278 first-found route
console.log("Searching for first-found route...");
const searchStarted = performance.now();
const result = search({
  algorithm: "plan-macro-beam",
  state: toLegacyState(request),
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
  planSolutionComparisonBudget: 0,
  progressIntervalMs: 5_000,
});
const searchElapsed = performance.now() - searchStarted;
console.log(`Search: ${searchElapsed.toFixed(0)}ms`);

if (result.status !== "solved" || !result.path) {
  console.error("Search failed");
  process.exit(1);
}

const firstFound = solutionFromLegacyPath(request, result.path);
if (!firstFound) {
  console.error("Failed to convert legacy path");
  process.exit(1);
}
console.log(`First-found: ${firstFound.moves} moves / ${firstFound.pushes} pushes`);

const v1 = verifySolverSolution(request, firstFound);
if (!v1.valid) {
  console.error("First-found solution failed verification!");
  process.exit(1);
}

// 2. Optimize 893/278 route with per-swap diagnostics
console.log("\nOptimizing first-found route (with swap log)...");
{
  const board = compileSearchBoard(request.board);
  let best = firstFound;
  let seq = extractPushBlocks(request, best);
  let swapNumber = 0;

  console.log(`\n--- Swap-by-swap log (${seq.blocks.length} initial blocks) ---`);

  for (let pass = 0; pass < 10; pass++) {
    let improved = false;
    for (let i = 0; i < seq.blocks.length - 1; i++) {
      const candidate = attemptAdjacentSwap(request, board, seq.blocks, i);
      if (candidate && candidate.moves < best.moves && candidate.pushes <= best.pushes) {
        swapNumber++;
        const saving = best.moves - candidate.moves;
        const blockA = seq.blocks[i];
        const blockB = seq.blocks[i + 1];
        console.log(
          `Swap #${swapNumber}: blocks [${i}, ${i + 1}]  ` +
          `${blockA.boxLabel}(${blockA.pushes.length}p) <-> ${blockB.boxLabel}(${blockB.pushes.length}p)  ` +
          `${best.moves} → ${candidate.moves} moves  (−${saving})`
        );
        best = candidate;
        seq = extractPushBlocks(request, best);
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  console.log(`--- End swap log: ${swapNumber} swaps, ${firstFound.moves} → ${best.moves} moves ---`);
}

const report1 = optimizePushBlockOrder(request, firstFound, {
  maxPasses: 10,
  maxSwapAttempts: 500,
  maxElapsedMs: 60_000,
});
printReport("First-found (893/278)", report1);

if (report1.optimizedSolution) {
  const v = verifySolverSolution(request, report1.optimizedSolution);
  console.log(`Verification: ${v.valid ? "PASS" : "FAIL"}`);
}

// 3. Get 789/270 rewritten route
console.log("\nRunning solution-window-rewrite...");
const rewriteStarted = performance.now();
const rewrite = search({
  algorithm: "solution-window-rewrite",
  state: toLegacyState(request),
  solutionPath: result.path,
  maxVisited: 50_000,
  permutationVisited: 10_000,
  permutationWindowPushes: [8, 16, 32],
  perPermutationWindowVisited: 1_500,
  windowPushes: [8, 16, 32],
  windowVisited: 12_000,
  windowTotalVisited: 15_000,
  frontierLimit: 12_000,
  moveWindowVisited: 25_000,
  moveWindowPushes: [1, 2, 4],
  moveWindowAttempts: 12,
  perMoveWindowVisited: 4_000,
  moveWindowExtraPushes: 4,
  moveWindowMinimumOverhead: 6,
  adaptiveMoveWindows: true,
  adaptiveMoveMinimumPriorImprovements: 8,
  moveWindowMissLimit: 1,
});
const rewriteElapsed = performance.now() - rewriteStarted;
console.log(`Rewrite: ${rewriteElapsed.toFixed(0)}ms`);

if (!rewrite.path) {
  console.error("Rewrite produced no path");
  process.exit(1);
}

const rewritten = solutionFromLegacyPath(request, rewrite.path);
if (!rewritten) {
  console.error("Failed to convert rewritten path");
  process.exit(1);
}
console.log(`Rewritten: ${rewritten.moves} moves / ${rewritten.pushes} pushes`);

const v2 = verifySolverSolution(request, rewritten);
if (!v2.valid) {
  console.error("Rewritten solution failed verification!");
  process.exit(1);
}

// 4. Optimize 789/270 route
console.log("\nOptimizing rewritten route...");
const report2 = optimizePushBlockOrder(request, rewritten, {
  maxPasses: 10,
  maxSwapAttempts: 500,
  maxElapsedMs: 60_000,
});
printReport("Rewritten (789/270)", report2);

if (report2.optimizedSolution) {
  const v = verifySolverSolution(request, report2.optimizedSolution);
  console.log(`Verification: ${v.valid ? "PASS" : "FAIL"}`);
}

// 5. Block extraction summary for both routes
console.log("\n=== Push Block Summary ===");
const seq1 = extractPushBlocks(request, firstFound);
const seq2 = extractPushBlocks(request, rewritten);
console.log(`First-found blocks: ${seq1.blocks.length}`);
console.log(`Rewritten blocks:   ${seq2.blocks.length}`);

// Note about 628 route
console.log("\n=== 628/244 Reference Route ===");
console.log("Not available in the codebase. The optimizer is puzzle-independent");
console.log("and can be tested against it if the route is provided externally.");

// Restore
if (originalPostMessage === undefined) {
  Reflect.deleteProperty(globalThis, "postMessage");
} else {
  globalThis.postMessage = originalPostMessage;
}

console.log("\nBenchmark complete.");
