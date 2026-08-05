import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

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

// Wall-clock timing gates are sanity checks, not correctness proofs.
// State-count and deterministic-result assertions are the real gates.
// Set SOKOMIND_TIMING_SCALE=2 on slower hardware (e.g. shared server CPUs).
const TIMING_SCALE = Math.max(1, Number(process.env.SOKOMIND_TIMING_SCALE) || 1);

const MAXIMUMS = Object.freeze({
  searchElapsedMs: 60_000 * TIMING_SCALE,
  rewriteElapsedMs: 90_000 * TIMING_SCALE,
  totalElapsedMs: 180_000 * TIMING_SCALE,
  moves: 1_300,
  pushes: 350,
  visited: 2_500,
  generated: 20_000,
  retained: 5_000,
  peakFrontier: 600,
});

const REVIEWED_DETERMINISTIC_RESULT = Object.freeze({
  moves: 1_010,
  pushes: 316,
  visited: 1_843,
  generated: 13_844,
  retained: 3_471,
  peakFrontier: 387,
});

const REVIEWED_REWRITE_RESULT = Object.freeze({
  moves: 874,
  pushes: 304,
  visited: 50_000,
  moveVisited: 25_000,
});

const HARD_PROCESS_TIMEOUT_MS = MAXIMUMS.totalElapsedMs + 30_000 * TIMING_SCALE;

function mirrorRows(rows: readonly string[]): readonly string[] {
  return rows.map((row) => [...row].reverse().join(""));
}

function rotateRows(rows: readonly string[]): readonly string[] {
  return [...rows]
    .reverse()
    .map((row) => [...row].reverse().join(""));
}

function requestFor(puzzle: PuzzleDefinition): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
  };
}

function runHugePerformanceGate(t: TestContext): void {
  const huge = PUZZLE_BY_ID.huge;
  assert.ok(huge);
  const cases = [
    ["base", huge.rows],
    ["mirrored", mirrorRows(huge.rows)],
    ["rotated", rotateRows(huge.rows)],
  ] as const;

  // globalThis.postMessage does not exist in Node.js, so t.mock.method()
  // cannot be used (it requires the property to already be a function).
  // Instead we use t.after() — the Node test runner's built-in cleanup hook —
  // which is resilient to mid-test crashes and avoids manual try/finally.
  const originalPostMessage = globalThis.postMessage;
  globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;
  t.after(() => {
    if (originalPostMessage === undefined) {
      Reflect.deleteProperty(globalThis, "postMessage");
    } else {
      globalThis.postMessage = originalPostMessage;
    }
  });

  const suiteStarted = performance.now();

  for (const [name, rows] of cases) {
    const request = requestFor({
      ...huge,
      id: `huge-${name}`,
      title: `${huge.title} (${name})`,
      rows,
    });
    const started = performance.now();
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
      progressIntervalMs: 5_000,
    });
    const elapsedMs = performance.now() - started;
    assert.equal(result.status, "solved", `${name} status`);
    assert.ok(Array.isArray(result.path), `${name} path`);
    const solution = solutionFromLegacyPath(request, result.path);
    assert.ok(solution, `${name} solution`);
    assert.equal(
      verifySolverSolution(request, solution).valid,
      true,
      `${name} replay`,
    );
    assert.ok(
      elapsedMs <= MAXIMUMS.searchElapsedMs,
      `${name} search elapsed`,
    );
    assert.ok(solution.moves <= MAXIMUMS.moves, `${name} moves`);
    assert.ok(solution.pushes <= MAXIMUMS.pushes, `${name} pushes`);
    assert.ok(
      (result.visited ?? Infinity) <= MAXIMUMS.visited,
      `${name} visited`,
    );
    assert.ok(
      (result.generated ?? Infinity) <= MAXIMUMS.generated,
      `${name} generated`,
    );
    assert.ok(
      (result.retained ?? Infinity) <= MAXIMUMS.retained,
      `${name} retained`,
    );
    assert.ok(
      (result.peakFrontier ?? Infinity) <= MAXIMUMS.peakFrontier,
      `${name} peak frontier`,
    );
    assert.deepEqual(
      {
        moves: solution.moves,
        pushes: solution.pushes,
        visited: result.visited,
        generated: result.generated,
        retained: result.retained,
        peakFrontier: result.peakFrontier,
      },
      REVIEWED_DETERMINISTIC_RESULT,
      `${name} deterministic result`,
    );
    if (name === "base") {
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
      });
      const rewriteElapsedMs = performance.now() - rewriteStarted;
      assert.ok(
        rewriteElapsedMs <= MAXIMUMS.rewriteElapsedMs,
        `base rewrite elapsed ${Math.round(rewriteElapsedMs)}ms`,
      );
      assert.ok(Array.isArray(rewrite.path), "base rewrite path");
      const rewrittenSolution = solutionFromLegacyPath(
        request,
        rewrite.path,
      );
      assert.ok(rewrittenSolution, "base rewritten solution");
      assert.equal(
        verifySolverSolution(request, rewrittenSolution).valid,
        true,
        "base rewrite replay",
      );
      assert.deepEqual(
        {
          moves: rewrittenSolution.moves,
          pushes: rewrittenSolution.pushes,
          visited: rewrite.visited,
          moveVisited: rewrite.moveVisited,
        },
        REVIEWED_REWRITE_RESULT,
        "base deterministic rewrite",
      );
      console.info(
        JSON.stringify({
          name: "base-rewrite",
          elapsedMs: Math.round(rewriteElapsedMs),
          moves: rewrittenSolution.moves,
          pushes: rewrittenSolution.pushes,
          visited: rewrite.visited,
          moveVisited: rewrite.moveVisited,
        }),
      );
    }
    console.info(
      JSON.stringify({
        name,
        elapsedMs: Math.round(elapsedMs),
        moves: solution.moves,
        pushes: solution.pushes,
        visited: result.visited,
        generated: result.generated,
        retained: result.retained,
        peakFrontier: result.peakFrontier,
      }),
    );
  }
  const totalElapsedMs = performance.now() - suiteStarted;
  assert.ok(
    totalElapsedMs <= MAXIMUMS.totalElapsedMs,
    `total elapsed ${Math.round(totalElapsedMs)}ms`,
  );
  console.info(
    JSON.stringify({ name: "total", elapsedMs: Math.round(totalElapsedMs) }),
  );
}

const TEST_NAME =
  "Sokomind Solver replay-solves Grand Hall in three orientations";

if (isPerformanceTestChild(import.meta.url)) {
  test(TEST_NAME, runHugePerformanceGate);
} else {
  test(`${TEST_NAME} within a hard process deadline`, () => {
    const result = runPerformanceTestModule(
      import.meta.url,
      HARD_PROCESS_TIMEOUT_MS,
    );
    relayPerformanceJson(result.stdout);
  });
}
