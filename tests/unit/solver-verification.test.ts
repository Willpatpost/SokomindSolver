import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSession,
  stepSnapshot,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import type {
  SolverProgress,
  SolverRequest,
  SolverSolution,
} from "../../src/solver/contracts.ts";
import {
  assertVerifiedSolverSolution,
  solutionFromIncumbentRoute,
  SolverSolutionVerificationError,
  verifySolverSolution,
} from "../../src/solver/verification.ts";

function makeRequest(rows: readonly string[]): SolverRequest {
  const puzzle: PuzzleDefinition = {
    id: "verify",
    title: "Verify",
    difficulty: "tutorial",
    boxes: 1,
    rows,
  };
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
  };
}

function makeSolution(
  steps: SolverSolution["steps"],
  pushes: number,
): SolverSolution {
  return {
    steps,
    moves: steps.length,
    pushes,
    objective: { kind: "moves" },
    objectiveScore: steps.length,
    optimality: "unknown",
  };
}

describe("solver solution verification", () => {
  it("replays a legal solution through the canonical core transition", () => {
    const request = makeRequest(["OOOOO", "ORXSO", "OOOOO"]);
    const solution = makeSolution(
      [{ direction: "right", kind: "push" }],
      1,
    );

    const verified = verifySolverSolution(request, solution);
    assert.equal(verified.valid, true);
    if (!verified.valid) return;

    const canonical = stepSnapshot(
      request.board,
      request.snapshot,
      "right",
    );
    assert.equal(canonical.moved, true);
    assert.equal(canonical.pushed, true);
    assert.deepEqual(verified.finalSnapshot, canonical.snapshot);
    assert.equal(verified.finalSnapshot.solved, true);
    assert.deepEqual(
      assertVerifiedSolverSolution(request, solution),
      verified.finalSnapshot,
    );
  });

  it("rejects blocked moves before trusting solver counters", () => {
    const request = makeRequest(["OOOOO", "ORXSO", "OOOOO"]);
    const result = verifySolverSolution(
      request,
      makeSolution([{ direction: "up", kind: "walk" }], 0),
    );

    assert.deepEqual(
      { valid: result.valid, code: result.valid ? undefined : result.code },
      { valid: false, code: "illegal-step" },
    );
    assert.throws(
      () =>
        assertVerifiedSolverSolution(
          request,
          makeSolution([{ direction: "up", kind: "walk" }], 0),
        ),
      SolverSolutionVerificationError,
    );
  });

  it("rejects false walk/push annotations", () => {
    const request = makeRequest(["OOOOO", "ORXSO", "OOOOO"]);
    const result = verifySolverSolution(
      request,
      makeSolution([{ direction: "right", kind: "walk" }], 0),
    );

    assert.equal(result.valid, false);
    if (result.valid) return;
    assert.equal(result.code, "step-kind-mismatch");
    assert.equal(result.stepIndex, 0);
  });

  it("rejects legal paths that do not solve and obsolete objectives", () => {
    const request = makeRequest(["OOOOOO", "OR XSO", "OOOOOO"]);
    const unfinished = verifySolverSolution(
      request,
      makeSolution([{ direction: "right", kind: "walk" }], 0),
    );
    assert.equal(unfinished.valid, false);
    if (!unfinished.valid) assert.equal(unfinished.code, "unsolved");

    const wrongObjective = verifySolverSolution(request, {
      ...makeSolution([{ direction: "right", kind: "walk" }], 0),
      objective: { kind: "pushes" },
      objectiveScore: 0,
    } as unknown as SolverSolution);
    assert.equal(wrongObjective.valid, false);
    if (!wrongObjective.valid) {
      assert.equal(wrongObjective.code, "invalid-solution");
    }
  });

  it("returns invalid-request when the request itself is malformed", () => {
    // Construct a request with a completely bogus board to trigger
    // assertValidSolverRequest failure. Use a non-SolverValidationError path
    // by passing something that is not even an object.
    const badRequest = {
      board: "not a board",
      snapshot: "not a snapshot",
      objective: { kind: "moves" },
    } as unknown as SolverRequest;
    const solution = makeSolution(
      [{ direction: "right", kind: "push" }],
      1,
    );

    const result = verifySolverSolution(badRequest, solution);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, "invalid-request");
      assert.match(result.message, /invalid/i);
    }
  });

  it("rejects solution with mismatched move count (pre-validation gate)", () => {
    // When solution.moves != steps.length, assertValidSolverSolution
    // rejects it before replay, producing "invalid-solution".
    const request = makeRequest(["OOOOOO", "OR XSO", "OOOOOO"]);
    const solution: SolverSolution = {
      steps: [
        { direction: "right", kind: "walk" },
        { direction: "right", kind: "push" },
      ],
      moves: 99, // wrong: should be 2
      pushes: 1,
      objective: { kind: "moves" },
      objectiveScore: 99,
      optimality: "unknown",
    };

    const result = verifySolverSolution(request, solution);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, "invalid-solution");
      assert.match(result.message, /invalid/i);
    }
  });

  it("rejects solution with mismatched push count (pre-validation gate)", () => {
    // When solution.pushes != count of push-kind steps,
    // assertValidSolverSolution rejects it before replay.
    const request = makeRequest(["OOOOO", "ORXSO", "OOOOO"]);
    const solution: SolverSolution = {
      steps: [{ direction: "right", kind: "push" }],
      moves: 1,
      pushes: 5, // wrong: should be 1
      objective: { kind: "moves" },
      objectiveScore: 1,
      optimality: "unknown",
    };

    const result = verifySolverSolution(request, solution);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.code, "invalid-solution");
    }
  });

  it("throws SolverSolutionVerificationError for all rejection codes", () => {
    // Test that assertVerifiedSolverSolution wraps the failure
    const request = makeRequest(["OOOOO", "ORXSO", "OOOOO"]);

    // step-kind-mismatch
    assert.throws(
      () =>
        assertVerifiedSolverSolution(
          request,
          makeSolution([{ direction: "right", kind: "walk" }], 0),
        ),
      (error: unknown) =>
        error instanceof SolverSolutionVerificationError &&
        error.failure.code === "step-kind-mismatch" &&
        error.failure.stepIndex === 0,
    );

    // illegal-step
    assert.throws(
      () =>
        assertVerifiedSolverSolution(
          request,
          makeSolution([{ direction: "up", kind: "walk" }], 0),
        ),
      (error: unknown) =>
        error instanceof SolverSolutionVerificationError &&
        error.failure.code === "illegal-step",
    );
  });
});

describe("incumbent route replay", () => {
  type Incumbent = NonNullable<SolverProgress["incumbent"]>;
  const incumbent = (route: string, pushes: number): Incumbent => ({
    moves: route.length,
    pushes,
    objectiveScore: route.length,
    route,
  });
  const rejects = (
    request: SolverRequest,
    value: Incumbent,
    code: string,
    stepIndex?: number,
  ) =>
    assert.throws(
      () => solutionFromIncumbentRoute(request, value),
      (error: unknown) =>
        error instanceof SolverSolutionVerificationError &&
        error.failure.code === code &&
        (stepIndex === undefined || error.failure.stepIndex === stepIndex),
    );

  it("derives step kinds by replay and never claims optimality", () => {
    const request = makeRequest(["OOOOOO", "OR XSO", "OOOOOO"]);
    const solution = solutionFromIncumbentRoute(request, incumbent("RR", 1));

    assert.deepEqual(solution.steps, [
      { direction: "right", kind: "walk" },
      { direction: "right", kind: "push" },
    ]);
    assert.equal(solution.moves, 2);
    assert.equal(solution.pushes, 1);
    assert.equal(solution.objectiveScore, 2);
    assert.equal(solution.optimality, "unknown");
    assert.ok(Object.isFrozen(solution) && Object.isFrozen(solution.steps));
    assert.equal(verifySolverSolution(request, solution).valid, true);
  });

  it("rejects routes that are missing, blocked, unfinished, or miscounted", () => {
    const request = makeRequest(["OOOOOO", "OR XSO", "OOOOOO"]);

    rejects(request, { moves: 2, pushes: 1, objectiveScore: 2 }, "invalid-solution");
    rejects(request, incumbent("RU", 1), "illegal-step", 1);
    rejects(request, incumbent("R", 0), "unsolved");
    rejects(request, incumbent("RR", 0), "invalid-solution");
    rejects(request, { ...incumbent("RR", 1), moves: 3, objectiveScore: 3 }, "invalid-solution");
    rejects(
      { ...request, board: "not a board" } as unknown as SolverRequest,
      incumbent("RR", 1),
      "invalid-request",
    );
  });
});
