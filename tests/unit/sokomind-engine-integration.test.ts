import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

// ---------------------------------------------------------------------------
// Benchmark puzzles (inline)
// ---------------------------------------------------------------------------

/**
 * Trivial 1-box puzzle: push one generic box right onto its goal.
 *
 *   O O O O O
 *   O R X S O
 *   O O O O O
 *
 * Optimal: 1 push, 1 move.
 */
const ONE_BOX_TRIVIAL: PuzzleDefinition = {
  id: "integration-one-box",
  title: "One box trivial",
  difficulty: "tutorial",
  boxes: 1,
  rows: [
    "OOOOO",
    "ORXSO",
    "OOOOO",
  ],
};

/**
 * Two generic boxes in a small room. The robot pushes each box one cell
 * onto its respective goal.
 *
 *   O O O O O
 *   O R X S O
 *   O   X S O
 *   O O O O O
 */
const TWO_BOX_SMALL: PuzzleDefinition = {
  id: "integration-two-box-small",
  title: "Two box small",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOO",
    "ORXSO",
    "O XSO",
    "OOOOO",
  ],
};

/**
 * Two labeled (dedicated) boxes that must go to matching goals.
 *
 *   O O O O O O
 *   O R A   a O
 *   O   B b   O
 *   O O O O O O
 *
 * Box A must reach goal a; box B must reach goal b.
 */
const TWO_LABELED_BOXES: PuzzleDefinition = {
  id: "integration-two-labeled",
  title: "Two labeled boxes",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOOO",
    "ORA aO",
    "O Bb O",
    "OOOOOO",
  ],
};

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

/**
 * Suppress `globalThis.postMessage` for the duration of a test callback.
 * The engine calls `postMessage` assuming it runs inside a Web Worker;
 * in a bare Node.js environment this would throw.
 *
 * Uses the same save/restore pattern as the existing unit tests rather than
 * `t.mock.method`, because `postMessage` does not exist on `globalThis` in
 * Node.js and the mock tracker requires an existing method.
 */
function withSuppressedPostMessage(fn: () => void): void {
  const original: typeof globalThis.postMessage | undefined =
    globalThis.postMessage;
  globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;
  try {
    fn();
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, "postMessage");
    } else {
      globalThis.postMessage = original;
    }
  }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Sokomind engine end-to-end integration", () => {
  it("solves a trivial 1-box puzzle and verification passes", () => {
    withSuppressedPostMessage(() => {
      const request = requestFor(ONE_BOX_TRIVIAL);
      const result = search({
        algorithm: "ultimate",
        state: toLegacyState(request),
        maxVisited: 5_000,
        beamWidth: 64,
        maxDepth: 40,
      });

      assert.equal(result.status, "solved", "engine must solve the puzzle");
      assert.ok(Array.isArray(result.path), "result must include a path");

      const solution = solutionFromLegacyPath(request, result.path);
      assert.ok(solution, "legacy path must convert to a SolverSolution");

      const verification = verifySolverSolution(request, solution);
      assert.equal(
        verification.valid,
        true,
        `verification failed: ${"message" in verification ? verification.message : ""}`,
      );

      // Optimal for this layout is 1 push, 1 move.
      assert.ok(
        solution.pushes >= 1 && solution.pushes <= 3,
        `pushes should be in [1, 3] but got ${solution.pushes}`,
      );
      assert.ok(
        solution.moves >= 1 && solution.moves <= 10,
        `moves should be in [1, 10] but got ${solution.moves}`,
      );
    });
  });

  it("solves a 2-box generic puzzle and verification passes", () => {
    withSuppressedPostMessage(() => {
      const request = requestFor(TWO_BOX_SMALL);
      const result = search({
        algorithm: "ultimate",
        state: toLegacyState(request),
        maxVisited: 20_000,
        beamWidth: 160,
        maxDepth: 80,
      });

      assert.equal(result.status, "solved", "engine must solve the puzzle");
      assert.ok(Array.isArray(result.path), "result must include a path");

      const solution = solutionFromLegacyPath(request, result.path);
      assert.ok(solution, "legacy path must convert to a SolverSolution");

      const verification = verifySolverSolution(request, solution);
      assert.equal(
        verification.valid,
        true,
        `verification failed: ${"message" in verification ? verification.message : ""}`,
      );

      assert.ok(
        solution.pushes >= 2 && solution.pushes <= 20,
        `pushes should be in [2, 20] but got ${solution.pushes}`,
      );
      assert.ok(
        solution.moves >= 2 && solution.moves <= 50,
        `moves should be in [2, 50] but got ${solution.moves}`,
      );
    });
  });

  it("solves a 2-box labeled/dedicated puzzle and verification passes", () => {
    withSuppressedPostMessage(() => {
      const request = requestFor(TWO_LABELED_BOXES);
      const result = search({
        algorithm: "ultimate",
        state: toLegacyState(request),
        maxVisited: 20_000,
        beamWidth: 160,
        maxDepth: 80,
      });

      assert.equal(result.status, "solved", "engine must solve the puzzle");
      assert.ok(Array.isArray(result.path), "result must include a path");

      const solution = solutionFromLegacyPath(request, result.path);
      assert.ok(solution, "legacy path must convert to a SolverSolution");

      const verification = verifySolverSolution(request, solution);
      assert.equal(
        verification.valid,
        true,
        `verification failed: ${"message" in verification ? verification.message : ""}`,
      );

      // Each box needs at least 1 push; upper bound is generous.
      assert.ok(
        solution.pushes >= 2 && solution.pushes <= 20,
        `pushes should be in [2, 20] but got ${solution.pushes}`,
      );
      assert.ok(
        solution.moves >= 2 && solution.moves <= 50,
        `moves should be in [2, 50] but got ${solution.moves}`,
      );
    });
  });
});
