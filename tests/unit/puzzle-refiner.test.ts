import assert from "node:assert/strict";
import { test } from "node:test";
import { refinePuzzle } from "../../src/features/generator/v2/puzzle-refiner.ts";
import { scoreSolution, type SolutionScore } from "../../src/features/generator/v2/solution-scoring.ts";
import { replayWitness } from "../../src/features/generator/v2/generation-evidence.ts";
import { createSession } from "../../src/core/game-session.ts";
import { classicAStarSolver } from "../../src/solver/implementations/classic-solvers.ts";
import type { PuzzleDefinition } from "../../src/core/model.ts";
import type { SolutionStep } from "../../src/solver/contracts.ts";

const puzzle: PuzzleDefinition = {
  id: "refiner-test", title: "Refiner", difficulty: "beginner", boxes: 2,
  rows: [
    "OOOOO",
    "O   O",
    "O X O",
    "OSRSO",
    "O X O",
    "O   O",
    "OOOOO",
  ],
};

async function solve(p: PuzzleDefinition): Promise<{ steps: readonly SolutionStep[]; score: SolutionScore }> {
  const session = createSession(p);
  const result = await classicAStarSolver.solve(
    { board: session.board, snapshot: session.snapshot, objective: { kind: "moves" },
      limits: { maxElapsedMs: 10_000, maxExpandedStates: 1_000_000 } },
    { signal: new AbortController().signal, reportProgress: () => {}, now: () => performance.now() },
  );
  assert.equal(result.status, "solved");
  if (result.status !== "solved") throw new Error("unsolvable fixture");
  const score = scoreSolution(p, result.solution);
  return { steps: result.solution.steps, score };
}

test("refinement result always includes replay-valid solution steps", async () => {
  const { steps, score } = await solve(puzzle);
  const result = await refinePuzzle(puzzle, score, steps, 5, 42);
  assert.ok(result.solutionSteps.length > 0, "result must have steps");
  assert.ok(replayWitness(result.puzzle, result.solutionSteps), "steps must replay on the returned puzzle");
});

test("unimproved refinement returns original steps unchanged", async () => {
  const { steps, score } = await solve(puzzle);
  const highScore: SolutionScore = { ...score, composite: 0.9 };
  const result = await refinePuzzle(puzzle, highScore, steps, 5, 42);
  assert.equal(result.improved, false);
  assert.deepEqual(result.solutionSteps, steps);
  assert.deepEqual(result.puzzle, puzzle);
});

test("cancellation stops refinement without corrupting result", async () => {
  const { steps, score } = await solve(puzzle);
  const abort = new AbortController();
  abort.abort();
  const result = await refinePuzzle(puzzle, score, steps, 100, 42, abort.signal);
  assert.ok(replayWitness(result.puzzle, result.solutionSteps), "result must be valid even after cancellation");
});

test("improved result has different puzzle rows and matching steps", async () => {
  const { steps, score } = await solve(puzzle);
  const lowScore: SolutionScore = { ...score, composite: 0.01 };
  const result = await refinePuzzle(puzzle, lowScore, steps, 20, 12345);
  if (result.improved) {
    assert.notDeepEqual(result.puzzle.rows, puzzle.rows, "improved puzzle should differ");
    assert.ok(replayWitness(result.puzzle, result.solutionSteps), "improved steps must replay on improved puzzle");
    assert.ok(result.solutionScore.composite > lowScore.composite, "score must improve");
  }
});

test("result includes telemetry fields", async () => {
  const { steps, score } = await solve(puzzle);
  const result = await refinePuzzle(puzzle, score, steps, 5, 42);
  assert.equal(typeof result.solverCalls, "number");
  assert.equal(typeof result.elapsedMs, "number");
  assert.ok(result.elapsedMs >= 0, "elapsedMs must be non-negative");
});

test("budget limits stop refinement early", async () => {
  const { steps, score } = await solve(puzzle);
  const lowScore: SolutionScore = { ...score, composite: 0.01 };
  const result = await refinePuzzle(puzzle, lowScore, steps, 1000, 42, undefined,
    { maxSolverCalls: 2 });
  assert.ok(result.solverCalls <= 2, "solver calls must respect budget");
  assert.ok(result.iterations < 1000, "iterations must stop before max");
  assert.ok(replayWitness(result.puzzle, result.solutionSteps), "result must be valid");
});
