import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession, type PuzzleDefinition } from "../../src/core/index.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { solutionFromLegacyPath, toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";
import { analysisPlanFromAnalysis } from "../../src/solver/implementations/sokomind-legacy.ts";
import { preparationPlan, structuralPlan } from "../../src/solver/implementations/sokomind-plans.ts";
import { parseSokomindOptions } from "../../src/solver/implementations/sokomind-options.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

const puzzle: PuzzleDefinition = {
  id: "strategic-two", title: "Strategic two", difficulty: "tutorial", boxes: 2,
  rows: ["OOOOOOO", "O  R  O", "O A X O", "O a S O", "O     O", "OOOOOOO"],
};
interface Plan {
  schemaVersion: number;
  snapshotKey: string;
  candidates: Array<{path: string[]; moves: number; pushes: number; tasks: string[]}>;
  statistics: {expanded: number; generated: number; elapsedMs: number; groupWidenings?: number};
}
beforeEach(t => {
  assert.ok("after" in t);
  const original = globalThis.postMessage;
  globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;
  t.after(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, "postMessage");
    else globalThis.postMessage = original;
  });
});
function requestFor(definition = puzzle) {
  const session = createSession(definition);
  return {board: session.board, snapshot: session.snapshot, objective: {kind: "moves" as const}};
}
function prepare(definition = puzzle, config: Record<string, number> = {}) {
  const request = requestFor(definition);
  const state = toLegacyState(request);
  const result = search({algorithm: "analyze-puzzle", state,
    strategicAnalysis: {maxMs: 1000, ...config}});
  const analysis = result.analysis as {strategicPlan: Plan};
  return {request, state, analysis, plan: analysis.strategicPlan};
}

test("analysis builds composed paths that discovery verifies and executes without expansion", () => {
  const {request, state, plan} = prepare();
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  assert.ok(plan.candidates.some(candidate => candidate.tasks.length >= 2));
  const result = search({algorithm: "plan-macro-beam", state, strategicPlan: plan, maxVisited: 1});
  assert.equal(result.status, "solved");
  assert.equal(result.visited, 0);
  assert.ok(result.path);
  const solution = solutionFromLegacyPath(request, result.path);
  assert.ok(solution);
  assert.equal(verifySolverSolution(request, solution).valid, true);
  assert.equal(solution.pushes, 2);
});

test("prepared paths survive canonical orientation changes", () => {
  for (const rows of [
    puzzle.rows.map(row => [...row].reverse().join("")),
    [...puzzle.rows].reverse().map(row => [...row].reverse().join("")),
  ]) {
    const {request, state, plan} = prepare({...puzzle, rows});
    const result = search({algorithm: "plan-macro-beam", state, strategicPlan: plan, maxVisited: 1});
    assert.ok(result.path);
    const solution = solutionFromLegacyPath(request, result.path);
    assert.ok(solution);
    assert.equal(verifySolverSolution(request, solution).valid, true);
    assert.equal(result.visited, 0);
  }
});

test("stale snapshots and malformed paths fall back instead of trusting plan metadata", () => {
  const {state, plan} = prepare();
  for (const bad of [
    {...plan, snapshotKey: "stale"},
    {...plan, schemaVersion: 999},
    {...plan, candidates: [{path: ["not-a-move"], moves: 1, pushes: 0}]},
    {...plan, candidates: [{path: Array(513).fill("Up")}]},
  ]) {
    const result = search({algorithm: "plan-macro-beam", state, strategicPlan: bad,
      maxVisited: 1, planDiagnostics: true});
    assert.equal((result.planDiagnostics as {preparedPlansAccepted: number}).preparedPlansAccepted, 0);
    assert.ok(Number(result.visited) > 0);
  }
});

test("prepared paths cannot bypass the discovery push bound", () => {
  const {state, plan} = prepare();
  const result = search({algorithm: "plan-macro-beam", state, maxDepth: 1,
    strategicPlan: {...plan, candidates: plan.candidates.filter(candidate => candidate.pushes >= 2)},
    maxVisited: 1, planDiagnostics: true});
  assert.equal((result.planDiagnostics as {preparedPlansAccepted: number}).preparedPlansAccepted, 0);
  assert.ok(!result.path);
});

test("zero planning budget returns a serializable empty plan and preserves fallback", () => {
  const {request, state, plan} = prepare(puzzle, {maxMs: 0});
  assert.equal(plan.statistics.expanded, 0);
  assert.deepEqual(plan.candidates, []);
  const result = search({algorithm: "plan-macro-beam", state, strategicPlan: plan});
  assert.ok(result.path);
  const solution = solutionFromLegacyPath(request, result.path);
  assert.ok(solution);
  assert.equal(verifySolverSolution(request, solution).valid, true);
});

test("Grand Hall preparation respects the shared expansion budget", () => {
  const {plan} = prepare(PUZZLE_BY_ID.huge, {maxExpanded: 40});
  assert.ok(plan.statistics.expanded <= 40);
  assert.ok(plan.candidates.length <= 4);
  assert.ok(plan.statistics.elapsedMs >= 0);
});

test("the analyzer expands a task group when another box blocks the route", () => {
  const blocked: PuzzleDefinition = {...puzzle, rows: [
    "OOOOOOO", "O  R  O", "O OAO O", "O  X SO", "O  a  O", "O     O", "OOOOOOO",
  ]};
  const {request, state, plan} = prepare(blocked);
  assert.ok((plan.statistics.groupWidenings ?? 0) > 0);
  const result = search({algorithm: "plan-macro-beam", state, strategicPlan: plan});
  assert.ok(result.path);
  const solution = solutionFromLegacyPath(request, result.path);
  assert.ok(solution);
  assert.equal(verifySolverSolution(request, solution).valid, true);
});

test("planning respects generated-state limits and reports its actual work", () => {
  const {state, request} = prepare();
  const limited = search({algorithm: "analyze-puzzle", state,
    strategicAnalysis: {maxMs: 1000, maxGenerated: 3}});
  const plan = (limited.analysis as {strategicPlan: Plan}).strategicPlan;
  assert.ok(plan.statistics.generated <= 3);
  assert.equal(limited.visited, plan.statistics.expanded);
  assert.equal(limited.generated, plan.statistics.generated);
  assert.deepEqual(preparationPlan(state, 250, {...request, limits: {
    maxExpandedStates: 2, maxGeneratedStates: 3,
  }}).payload.strategicAnalysis, {maxMs: 250, maxExpanded: 2, maxGenerated: 3});
});

test("discovery observes its own deadline without charging earlier analysis", () => {
  const {state} = prepare();
  const result = search({algorithm: "plan-macro-beam", state, planSearchMs: 0});
  assert.equal(result.status, "cutoff");
  assert.equal(result.visited, 0);
  assert.equal(result.terminationReason, "search-time-budget");
});

test("the adapter passes experimental plans through the analysis boundary", () => {
  const {request, state, analysis, plan} = prepare();
  assert.equal(preparationPlan(state).payload.strategicAnalysis, undefined);
  assert.deepEqual(preparationPlan(state, 250).payload.strategicAnalysis, {maxMs: 250});
  const converted = analysisPlanFromAnalysis(analysis);
  assert.ok(converted?.strategicPlan);
  assert.deepEqual(structuralPlan(state, request, {}, "fast", 1, converted).payload.strategicPlan, plan);
  assert.equal(parseSokomindOptions({}).strategicAnalysisMs, 0);
  assert.equal(parseSokomindOptions({strategicAnalysisMs: 250}).strategicAnalysisMs, 250);
  for (const invalid of [-1, 1001, NaN, "250"]) {
    assert.throws(() => parseSokomindOptions({strategicAnalysisMs: invalid}));
  }
  assert.throws(() => parseSokomindOptions({strategicAnalysisMs: 250, deterministic: true}), /deterministic/);
});
