import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSession,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import type { SolutionStep, SolverRequest, SolverSolution } from "../../src/solver/contracts.ts";
import { validateInitialSolution } from "../../src/solver/implementations/sokomind-legacy.ts";

const TINY_PUZZLE: PuzzleDefinition = {
  id: "initial-solution-test",
  title: "Initial solution test",
  difficulty: "tutorial",
  boxes: 1,
  rows: [
    "OOOOO",
    "OR  O",
    "O X O",
    "O S O",
    "OOOOO",
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

function makeSolution(steps: readonly SolutionStep[]): SolverSolution {
  const moves = steps.length;
  const pushes = steps.filter((s) => s.kind === "push").length;
  return {
    steps,
    moves,
    pushes,
    objective: { kind: "moves" },
    objectiveScore: moves,
    optimality: "unknown",
  };
}

function step(dir: "up" | "down" | "left" | "right", kind: "walk" | "push"): SolutionStep {
  return { direction: dir, kind };
}

describe("validateInitialSolution", () => {
  it("accepts a valid solution that solves the puzzle", () => {
    const request = requestFor(TINY_PUZZLE);
    const solution = makeSolution([
      step("right", "walk"),
      step("down", "push"),
    ]);
    const result = validateInitialSolution(request, solution);
    assert.ok(typeof result !== "string", `expected SolverSolution, got: ${result}`);
    assert.equal(result.moves, 2);
    assert.equal(result.pushes, 1);
  });

  it("rejects an empty solution", () => {
    const request = requestFor(TINY_PUZZLE);
    const solution = makeSolution([]);
    const result = validateInitialSolution(request, solution);
    assert.equal(typeof result, "string");
    assert.ok((result as string).includes("non-empty"));
  });

  it("rejects a solution with an invalid direction", () => {
    const request = requestFor(TINY_PUZZLE);
    const solution = makeSolution([
      { direction: "diagonal" as any, kind: "walk" },
    ]);
    const result = validateInitialSolution(request, solution);
    assert.equal(typeof result, "string");
    assert.ok((result as string).includes("invalid direction"));
  });

  it("rejects a solution with an invalid kind", () => {
    const request = requestFor(TINY_PUZZLE);
    const solution = makeSolution([
      { direction: "down", kind: "jump" as any },
    ]);
    const result = validateInitialSolution(request, solution);
    assert.equal(typeof result, "string");
    assert.ok((result as string).includes("invalid kind"));
  });

  it("rejects a solution with illegal moves", () => {
    const request = requestFor(TINY_PUZZLE);
    const solution = makeSolution([
      step("up", "walk"),
    ]);
    const result = validateInitialSolution(request, solution);
    assert.equal(typeof result, "string");
    assert.ok((result as string).includes("replay"));
  });

  it("rejects a solution that does not solve the puzzle", () => {
    const request = requestFor(TINY_PUZZLE);
    const solution = makeSolution([
      step("right", "walk"),
    ]);
    const result = validateInitialSolution(request, solution);
    assert.equal(typeof result, "string");
    assert.ok((result as string).includes("replay"));
  });

  it("returns a replayed SolverSolution with correct pushes count", () => {
    const request = requestFor(TINY_PUZZLE);
    const solution = makeSolution([
      step("right", "walk"),
      step("down", "push"),
    ]);
    const result = validateInitialSolution(request, solution);
    assert.ok(typeof result !== "string");
    assert.equal(result.pushes, 1);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].kind, "walk");
    assert.equal(result.steps[1].kind, "push");
  });
});
