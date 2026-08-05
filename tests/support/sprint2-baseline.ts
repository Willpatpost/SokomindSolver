/**
 * Sprint 2 baseline measurement script.
 *
 * Runs classic A* on deterministic fixtures and reports metrics.
 * Usage: node --experimental-strip-types tests/support/sprint2-baseline.ts
 */

import { createSession, type PuzzleDefinition } from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";
import { classicAStarSolver } from "../../src/solver/implementations/index.ts";

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

async function main() {
  console.log("Sprint 2 Baseline Measurements");
  console.log("==============================\n");

  for (const fixture of fixtures) {
    const request = makeRequest(fixture);
    const start = performance.now();
    const result = await classicAStarSolver.solve(request, context());
    const elapsed = performance.now() - start;

    console.log(`Fixture: ${fixture.id}`);
    console.log(`  Status: ${result.status}`);
    if (result.status === "solved") {
      console.log(`  Moves: ${result.solution.moves}`);
      console.log(`  Pushes: ${result.solution.pushes}`);
      console.log(`  Optimality: ${result.solution.optimality}`);
    }
    console.log(`  Elapsed: ${elapsed.toFixed(1)}ms`);
    console.log(`  Expanded: ${result.metrics.expandedStates}`);
    console.log(`  Generated: ${result.metrics.generatedStates}`);
    if (result.metrics.counters) {
      const c = result.metrics.counters;
      console.log(`  Duplicates: ${c.duplicateStates ?? 0}`);
      console.log(`  Reopens: ${c.reopens ?? 0}`);
      console.log(`  Deadlock prunes: ${c.deadlockPrunes ?? 0}`);
      console.log(`  Infeasible prunes: ${c.infeasiblePrunes ?? 0}`);
      console.log(`  Reachability floods: ${c.reachabilityFloods ?? 0}`);
      console.log(`  Peak frontier: ${result.metrics.peakFrontierSize ?? 0}`);
      console.log(`  Max depth: ${c.maxDepth ?? 0}`);
      console.log(`  Est. memory: ${c.estimatedMemoryBytes ?? 0}`);
    }
    console.log();
  }
}

main().catch(console.error);
