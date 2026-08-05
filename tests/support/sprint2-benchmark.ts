/**
 * Sprint 2 timing benchmark with proper statistical methodology.
 *
 * - Separate warm-up phase (1 run per fixture, discarded)
 * - 5 measured runs per fixture
 * - Reports median of the 5 runs
 * - Reports all counters including avoidedReachabilityFloods
 *
 * Usage: node --experimental-strip-types tests/support/sprint2-benchmark.ts
 */

import { createSession, type PuzzleDefinition } from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";
import { classicAStarSolver } from "../../src/solver/implementations/index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TWO_GENERIC_BOXES: PuzzleDefinition = {
  id: "two-generic-boxes",
  title: "Two generic boxes",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOOOO",
    "O SS  O",
    "O XX  O",
    "O  R  O",
    "O     O",
    "OOOOOOO",
  ],
};

const EXACT_KEEPER_REGRESSION: PuzzleDefinition = {
  id: "exact-keeper-regression",
  title: "Exact keeper identity regression",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOOOO",
    "O X SSO",
    "O   O O",
    "OO XR O",
    "O     O",
    "OOOOOOO",
  ],
};

const MEDIUM_4BOX: PuzzleDefinition = {
  id: "medium-4box",
  title: "Medium 4-box",
  difficulty: "intermediate",
  boxes: 4,
  rows: [
    "OOOOOOOO",
    "OO    OO",
    "O  XX  O",
    "O XRXSSO",
    "O    SSO",
    "OOOOOOOO",
  ],
};

const TYPED_2BOX: PuzzleDefinition = {
  id: "typed-2box",
  title: "Typed 2-box",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOOOO",
    "OR A  O",
    "O  B  O",
    "O ab  O",
    "OOOOOOO",
  ],
};

const fixtures = [
  TWO_GENERIC_BOXES,
  EXACT_KEEPER_REGRESSION,
  MEDIUM_4BOX,
  TYPED_2BOX,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(puzzle: PuzzleDefinition): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
    limits: { maxElapsedMs: 30_000, maxMemoryBytes: 256 * 1024 * 1024 },
  };
}

function context(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    now: () => performance.now(),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const MEASURED_RUNS = 5;

async function main() {
  console.log("Sprint 2 Benchmark (median of 5 timed runs)");
  console.log("=============================================\n");
  console.log(`Node: ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log();

  for (const fixture of fixtures) {
    // --- Warm-up (1 run, discarded) ---
    console.log(`Warm-up: ${fixture.id}...`);
    const warmupRequest = makeRequest(fixture);
    await classicAStarSolver.solve(warmupRequest, context());

    // --- Measured runs ---
    const elapsed: number[] = [];
    let lastResult: Awaited<ReturnType<typeof classicAStarSolver.solve>> | undefined;

    for (let i = 0; i < MEASURED_RUNS; i++) {
      const request = makeRequest(fixture);
      const start = performance.now();
      const result = await classicAStarSolver.solve(request, context());
      const dt = performance.now() - start;
      elapsed.push(dt);
      lastResult = result;
    }

    const result = lastResult!;
    const medianMs = median(elapsed);

    console.log(`\nFixture: ${fixture.id}`);
    console.log(`  Status: ${result.status}`);
    if (result.status === "solved") {
      console.log(`  Moves: ${result.solution.moves}`);
      console.log(`  Pushes: ${result.solution.pushes}`);
      console.log(`  Optimality: ${result.solution.optimality}`);
    }
    console.log(`  Median elapsed: ${medianMs.toFixed(2)}ms`);
    console.log(`  All runs: [${elapsed.map((t) => t.toFixed(2) + "ms").join(", ")}]`);
    console.log(`  Expanded: ${result.metrics.expandedStates ?? 0}`);
    console.log(`  Generated: ${result.metrics.generatedStates ?? 0}`);

    const c = result.metrics.counters ?? {};
    console.log(`  Reachability floods: ${c.reachabilityFloods ?? 0}`);
    console.log(`  Avoided reachability floods: ${c.avoidedReachabilityFloods ?? 0}`);
    console.log(`  Duplicates: ${c.duplicateStates ?? 0}`);
    console.log(`  Deadlock prunes: ${c.deadlockPrunes ?? 0}`);
    console.log(`  Infeasible prunes: ${c.infeasiblePrunes ?? 0}`);
    console.log(`  Peak frontier: ${result.metrics.peakFrontierSize ?? 0}`);
    console.log(`  Max depth: ${c.maxDepth ?? 0}`);
    console.log(`  Est. memory: ${c.estimatedMemoryBytes ?? 0}`);

    const rss = process.memoryUsage().rss;
    console.log(`  Process RSS: ${(rss / 1024 / 1024).toFixed(1)} MB`);
    console.log();
  }
}

main().catch(console.error);
