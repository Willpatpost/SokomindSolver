import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GenerationEvidence, replayWitness, solveWithEvidence, witnessedResult } from "../../src/features/generator/v2/generation-evidence.ts";
import { runForge, type ForgeConfig } from "../../src/features/generator/v2/puzzle-forge.ts";
import { classicGreedySolver } from "../../src/solver/implementations/classic-solvers.ts";
import type { SolverAdapter, SolverResult, SolutionStep } from "../../src/solver/contracts.ts";
import type { Direction, PuzzleDefinition } from "../../src/core/model.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/generator/generated-quality-samples.json", import.meta.url), "utf8"));
const sample = fixture.samples.find((s: { seed: number }) => s.seed === 310049);
const puzzle: PuzzleDefinition = { id: "evidence-fixture", title: "Evidence", difficulty: "beginner", boxes: 3, rows: sample.rows };
const directions: Record<string, Direction> = { u: "up", d: "down", l: "left", r: "right" };
const steps: SolutionStep[] = [...sample.witness as string].map((letter) => ({ direction: directions[letter.toLowerCase()], kind: letter === letter.toUpperCase() ? "push" : "walk" }));
const solved: SolverResult = { status: "solved", metrics: { elapsedMs: 5, expandedStates: 20 }, solution: {
  steps, moves: steps.length, pushes: steps.filter((step) => step.kind === "push").length,
  objective: { kind: "moves" }, objectiveScore: steps.length, optimality: "unknown",
} };

test("evidence reuse binds exact rows, solver identity, replay, and compatible budgets", async () => {
  const evidence = new GenerationEvidence();
  let calls = 0;
  const solver: SolverAdapter = { metadata: classicGreedySolver.metadata, solve: async () => { calls++; return solved; } };
  assert.ok(replayWitness(puzzle, steps));
  await solveWithEvidence(puzzle, solver, { maxElapsedMs: 10 }, undefined, evidence);
  await solveWithEvidence({ ...puzzle, id: "different-id" }, solver, { maxElapsedMs: 20 }, undefined, evidence);
  assert.equal(calls, 1);
  assert.equal(evidence.cacheHits, 1);
  await solveWithEvidence(puzzle, solver, { maxExpandedStates: 1 }, undefined, evidence);
  assert.equal(calls, 2, "A smaller search budget must not inherit out-of-budget metrics");
  const movedRows = [...puzzle.rows].reverse();
  await solveWithEvidence({ ...puzzle, rows: movedRows }, solver, {}, undefined, evidence);
  assert.equal(calls, 3, "Geometry changes invalidate evidence even when metadata is unchanged");
  await solveWithEvidence(puzzle, { ...solver, metadata: { ...solver.metadata, version: "changed" } }, {}, undefined, evidence);
  assert.equal(calls, 4);
});

test("witness fallback is legal, bounded evidence and never upgrades cancellation or optimality", () => {
  const failed: SolverResult = { status: "unsolved", reason: "limit-reached", metrics: { elapsedMs: 10, expandedStates: 100 } };
  const result = witnessedResult(puzzle, steps, failed);
  assert.equal(result.status, "solved");
  if (result.status === "solved") assert.equal(result.solution.optimality, "unknown");
  assert.equal(witnessedResult(puzzle, steps.slice(0, 2), failed), failed);
  const wrongKinds = steps.map((step) => ({ ...step, kind: "walk" as const }));
  assert.equal(witnessedResult(puzzle, wrongKinds, failed), failed);
  const cancelled: SolverResult = { status: "cancelled", metrics: { elapsedMs: 10 } };
  assert.equal(witnessedResult(puzzle, steps, cancelled), cancelled);
});

test("real generation reuses solves without changing qualified boards, routes, or quality", async () => {
  const config: ForgeConfig = { ...fixture.config, baseSeed: 310049, boxCounts: [3] };
  const cached = await runForge(config, { workers: 1 });
  const uncached = await runForge({ ...config, reuseEvidence: false }, { workers: 1 });
  assert.equal(cached.candidates.length, 1);
  assert.equal(uncached.candidates.length, 1);
  assert.deepEqual(cached.candidates[0].puzzle.rows, uncached.candidates[0].puzzle.rows);
  assert.deepEqual(cached.candidates[0].solutionSteps, uncached.candidates[0].solutionSteps);
  assert.deepEqual(cached.candidates[0].qualityProfile, uncached.candidates[0].qualityProfile);
  assert.ok(cached.performance!.evidenceCacheHits > 0);
  assert.ok(cached.performance!.solverCalls < uncached.performance!.solverCalls);
});
