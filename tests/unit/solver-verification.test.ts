import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSession,
  stepSnapshot,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import type {
  SolverRequest,
  SolverSolution,
} from "../../src/solver/contracts.ts";
import {
  assertVerifiedSolverSolution,
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
});
