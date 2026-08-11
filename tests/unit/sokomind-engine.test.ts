import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

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

const MIXED_TYPED_PUZZLE: PuzzleDefinition = {
  id: "mixed-typed-engine",
  title: "Mixed typed engine",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOOOO",
    "O  R  O",
    "O A X O",
    "O a S O",
    "O     O",
    "OOOOOOO",
  ],
};

function requestFor(puzzle: PuzzleDefinition): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
  };
}

describe("vendored Sokomind engine", () => {
  // globalThis.postMessage does not exist in Node.js, so t.mock.method()
  // cannot be used (it requires the property to already be a function).
  // Instead we use t.after() — the Node test runner's built-in cleanup hook —
  // which is resilient to mid-test crashes and avoids manual try/finally.
  beforeEach((t) => {
    const original = globalThis.postMessage;
    globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;
    if ("after" in t) {
      t.after(() => {
        if (original === undefined) {
          Reflect.deleteProperty(globalThis, "postMessage");
        } else {
          globalThis.postMessage = original;
        }
      });
    }
  });

  it("solves and replay-verifies a mixed generic/dedicated puzzle", () => {
    const request = requestFor(MIXED_TYPED_PUZZLE);
    const result = search({
      algorithm: "ultimate",
      state: toLegacyState(request),
      maxVisited: 20_000,
      beamWidth: 160,
      maxDepth: 80,
    });
    assert.equal(result.status, "solved");
    assert.ok(Array.isArray(result.path));
    const solution = solutionFromLegacyPath(request, result.path);
    assert.ok(solution);
    assert.equal(verifySolverSolution(request, solution).valid, true);
    assert.equal(solution.pushes, 2);
  });

  it("rehydrates a structured-cloned prepared board without changing the route", () => {
    const request = requestFor(MIXED_TYPED_PUZZLE);
    const state = toLegacyState(request);
    const analysisResult = search({
      algorithm: "analyze-puzzle",
      state,
    });
    const analysis = analysisResult.analysis as
      | { readonly preparedBoard?: unknown }
      | undefined;
    assert.ok(analysis?.preparedBoard);
    const preparedBoard = structuredClone(analysis.preparedBoard);

    const result = search({
      algorithm: "ultimate",
      state: { ...state, preparedBoard },
      maxVisited: 20_000,
      beamWidth: 160,
      maxDepth: 80,
    });

    assert.equal(result.status, "solved");
    assert.ok(Array.isArray(result.path));
    assert.equal(
      (result.performance?.preparedBoardReuses as number | undefined) ?? 0,
      1,
    );
    const solution = solutionFromLegacyPath(request, result.path);
    assert.ok(solution);
    assert.equal(verifySolverSolution(request, solution).valid, true);
  });

  it("shares one state budget across the ultimate portfolio", () => {
    const request = requestFor(MIXED_TYPED_PUZZLE);
    const result = search({
      algorithm: "ultimate",
      state: toLegacyState(request),
      maxVisited: 1,
      maxGenerated: 1,
      beamWidth: 32,
      maxDepth: 80,
    });

    assert.equal(result.status, "cutoff");
    assert.ok(Number(result.visited) <= 1);
    assert.ok(Number(result.generated) <= 1);
    assert.ok(
      Number(result.performance?.denseLayoutBuilds ?? 0) <= 1,
      "the budget must not restart four full portfolio lanes",
    );
  });

  it("reserves rewrite states for move-specific windows", () => {
    const request = requestFor(MIXED_TYPED_PUZZLE);
    const state = toLegacyState(request);
    const incumbent = search({
      algorithm: "ultimate",
      state,
      maxVisited: 20_000,
      beamWidth: 160,
      maxDepth: 80,
    });
    assert.ok(Array.isArray(incumbent.path));

    const rewritten = search({
      algorithm: "solution-window-rewrite",
      state,
      solutionPath: incumbent.path,
      maxVisited: 200,
      permutationVisited: 0,
      windowTotalVisited: 0,
      moveWindowVisited: 200,
      moveWindowAttempts: 2,
      perMoveWindowVisited: 100,
      moveWindowMinimumOverhead: 1,
    });

    assert.ok(Array.isArray(rewritten.path));
    assert.ok(Number(rewritten.moveVisited) > 0);
    const solution = solutionFromLegacyPath(request, rewritten.path);
    assert.ok(solution);
    assert.equal(verifySolverSolution(request, solution).valid, true);
  });

  it("enforces and reports the rewrite generated-state budget", () => {
    const request = requestFor(MIXED_TYPED_PUZZLE);
    const state = toLegacyState(request);
    const incumbent = search({
      algorithm: "ultimate",
      state,
      maxVisited: 20_000,
      beamWidth: 160,
      maxDepth: 80,
    });
    assert.ok(Array.isArray(incumbent.path));

    const rewritten = search({
      algorithm: "solution-window-rewrite",
      state,
      solutionPath: incumbent.path,
      maxVisited: 1_000,
      maxGenerated: 1,
      permutationVisited: 500,
      permutationWindowPushes: [1],
      perPermutationWindowVisited: 500,
      windowTotalVisited: 500,
      windowPushes: [1],
      moveWindowVisited: 500,
      moveWindowMinimumOverhead: 1,
    });

    assert.ok(Array.isArray(rewritten.path));
    assert.ok(Number(rewritten.generated) <= 1);
  });

  it("reports injectable isolate memory separately from live engine storage", (t) => {
    const memoryRuntime = globalThis as typeof globalThis & {
      __sokomindMemoryUsage?: () => number;
    };
    const originalMemoryUsage = memoryRuntime.__sokomindMemoryUsage;
    memoryRuntime.__sokomindMemoryUsage = () => 42 * 1024 * 1024;
    t.after(() => {
      if (originalMemoryUsage === undefined) {
        Reflect.deleteProperty(memoryRuntime, "__sokomindMemoryUsage");
      } else {
        memoryRuntime.__sokomindMemoryUsage = originalMemoryUsage;
      }
    });

    const request = requestFor(MIXED_TYPED_PUZZLE);
    const result = search({
      algorithm: "analyze-puzzle",
      state: toLegacyState(request),
    });
    const performance = result.performance;
    const memory = performance?.memory as
      | Readonly<Record<string, unknown>>
      | undefined;
    const engineMemory = performance?.engineMemory as
      | Readonly<Record<string, unknown>>
      | undefined;

    assert.equal(performance?.schemaVersion, 4);
    assert.equal(memory?.source, "injected-runtime");
    assert.equal(memory?.usedBytes, 42 * 1024 * 1024);
    assert.ok(
      ((engineMemory?.boardBytes as number | undefined) ?? 0) > 0,
    );
    assert.ok(
      ((engineMemory?.currentBytes as number | undefined) ?? 0) > 0,
    );
  });
});
