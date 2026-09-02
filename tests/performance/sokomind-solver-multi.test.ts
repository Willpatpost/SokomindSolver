import assert from "node:assert/strict";
import { test } from "node:test";

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import {
  createSession,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import type { SolverRequest } from "../../src/solver/contracts.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import {
  solutionFromLegacyPath,
  toLegacyState,
} from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import {
  isPerformanceTestChild,
  relayPerformanceJson,
  runPerformanceTestModule,
} from "../support/child-process-gate.ts";

// ---------------------------------------------------------------------------
// Puzzle suite — varying difficulty
// ---------------------------------------------------------------------------

interface PuzzleCase {
  readonly id: string;
  readonly label: string;
  readonly maxElapsedMs: number;
  readonly maxVisited: number;
  readonly transpositionLimit: number;
  readonly planBeamWidth: number;
  readonly planBoxBranches: number;
  readonly maxPlanSegments: number;
  readonly maxDepth: number;
}

const PUZZLE_CASES: readonly PuzzleCase[] = [
  {
    id: "beginner-three",
    label: "easy (beginner-three)",
    maxElapsedMs: 30_000,
    maxVisited: 2_000,
    transpositionLimit: 10_000,
    planBeamWidth: 16,
    planBoxBranches: 4,
    maxPlanSegments: 40,
    maxDepth: 200,
  },
  {
    id: "classic-1",
    label: "medium (classic-1)",
    maxElapsedMs: 30_000,
    maxVisited: 3_000,
    transpositionLimit: 30_000,
    planBeamWidth: 24,
    planBoxBranches: 6,
    maxPlanSegments: 80,
    maxDepth: 300,
  },
  {
    id: "adv-gallery",
    label: "advanced (adv-gallery)",
    maxElapsedMs: 30_000,
    maxVisited: 4_000,
    transpositionLimit: 40_000,
    planBeamWidth: 24,
    planBoxBranches: 6,
    maxPlanSegments: 100,
    maxDepth: 350,
  },
  {
    id: "expert-maze",
    label: "hard (expert-maze)",
    maxElapsedMs: 30_000,
    maxVisited: 5_000,
    transpositionLimit: 50_000,
    planBeamWidth: 32,
    planBoxBranches: 6,
    maxPlanSegments: 140,
    maxDepth: 400,
  },
];

const PERFORMANCE_CASE_ENV = "SOKOMIND_MULTI_PERFORMANCE_CASE";
const PROCESS_STARTUP_ALLOWANCE_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requestFor(puzzle: PuzzleDefinition): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

function runPuzzleCase(puzzleCase: PuzzleCase): void {
  const originalPostMessage = globalThis.postMessage;
  globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;

  try {
    const puzzle = PUZZLE_BY_ID[puzzleCase.id];
    assert.ok(puzzle, `puzzle '${puzzleCase.id}' must exist in catalog`);

    const request = requestFor(puzzle);
    const started = performance.now();
    const result = search({
      algorithm: "plan-macro-beam",
      state: toLegacyState(request),
      maxDepth: puzzleCase.maxDepth,
      maxVisited: puzzleCase.maxVisited,
      transpositionLimit: puzzleCase.transpositionLimit,
      planBeamWidth: puzzleCase.planBeamWidth,
      planBoxBranches: puzzleCase.planBoxBranches,
      maxPlanSegments: puzzleCase.maxPlanSegments,
      planSlack: 240,
      sequenceMacroLimit: 24,
      sequenceMacroExplored: 48,
      sequenceMacroResults: 4,
      targetedMacroExplored: 64,
      progressIntervalMs: 5_000,
    });
    const elapsedMs = performance.now() - started;

    // Assert solved.
    assert.equal(
      result.status,
      "solved",
      `${puzzleCase.label}: expected solved, got ${result.status}`,
    );
    assert.ok(
      Array.isArray(result.path),
      `${puzzleCase.label}: result must have a path`,
    );

    // Reconstruct and verify the solution.
    const solution = solutionFromLegacyPath(request, result.path);
    assert.ok(solution, `${puzzleCase.label}: solution must be non-null`);

    const verification = verifySolverSolution(request, solution);
    assert.equal(
      verification.valid,
      true,
      `${puzzleCase.label}: replay verification failed`,
    );

    // Assert time bound when the synchronous search returns normally. The
    // parent process also enforces an absolute deadline if it does not return.
    assert.ok(
      elapsedMs <= puzzleCase.maxElapsedMs,
      `${puzzleCase.label}: elapsed ${Math.round(elapsedMs)}ms exceeds ${puzzleCase.maxElapsedMs}ms limit`,
    );

    console.info(
      JSON.stringify({
        puzzle: puzzleCase.id,
        label: puzzleCase.label,
        elapsedMs: Math.round(elapsedMs),
        moves: solution.moves,
        pushes: solution.pushes,
        visited: result.visited,
        generated: result.generated,
      }),
    );
  } finally {
    if (originalPostMessage === undefined) {
      Reflect.deleteProperty(globalThis, "postMessage");
    } else {
      globalThis.postMessage = originalPostMessage;
    }
  }
}

const childCaseId = process.env[PERFORMANCE_CASE_ENV];
if (isPerformanceTestChild(import.meta.url)) {
  const puzzleCase = PUZZLE_CASES.find(({ id }) => id === childCaseId);
  test(`Sokomind Solver solves ${childCaseId ?? "an unknown case"}`, () => {
    assert.ok(puzzleCase, "isolated performance case must be configured");
    runPuzzleCase(puzzleCase);
  });
} else {
  for (const puzzleCase of PUZZLE_CASES) {
    test(`${puzzleCase.label} completes within a hard process deadline`, () => {
      const result = runPerformanceTestModule(
        import.meta.url,
        puzzleCase.maxElapsedMs + PROCESS_STARTUP_ALLOWANCE_MS,
        { [PERFORMANCE_CASE_ENV]: puzzleCase.id },
      );
      relayPerformanceJson(result.stdout);
    });
  }
}
