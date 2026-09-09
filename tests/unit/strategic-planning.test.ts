import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession, stepSnapshot, type PuzzleDefinition } from "../../src/core/index.ts";
import { search, validateStrategicPlanContract, evaluateStrategicPlanState, rebaseStrategicPlan } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { solutionFromLegacyPath, toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";
import { analysisPlanFromAnalysis } from "../../src/solver/implementations/sokomind-legacy.ts";
import { preparationPlan, structuralPlan, checkpointContinuationPlans } from "../../src/solver/implementations/sokomind-plans.ts";
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
  resources: Array<{id: string; consumerTaskId: string; cells: string[]; alternatives?: string[][]; availableFrom: string; availableUntil: string}>;
  tasks: Array<{id: string; kind: string; boxIndex: number; boxCandidates?: number[]; completesWhen: {kind: string; cells: string[]; label?: string}; dependsOn: string[]; requires: string[]; evidence: {snapshotKey: string}; forTaskId?: string}>;
  hypotheses: Array<{taskIds: string[]}>;
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
  assert.ok(validateStrategicPlanContract(plan));
  for (const resource of plan.resources.filter(resource => !resource.alternatives)) {
    assert.equal(plan.tasks.find(task => task.id === resource.consumerTaskId)?.kind, "release");
  }
});

test("the analyzer expands a task group when another box blocks the route", () => {
  const blocked: PuzzleDefinition = {...puzzle, rows: [
    "OOOOOOO", "O  R  O", "O OAO O", "O  X SO", "O  a  O", "O     O", "OOOOOOO",
  ]};
  const {request, state, plan} = prepare(blocked);
  assert.ok((plan.statistics.groupWidenings ?? 0) > 0);
  assert.ok(validateStrategicPlanContract(plan));
  assert.ok(plan.tasks.some(task => task.kind === "stage"));
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
  }}).payload.strategicAnalysis, {maxMs: 250, inferenceWork: 0, maxExpanded: 2, maxGenerated: 3});
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
  assert.deepEqual(preparationPlan(state, 250).payload.strategicAnalysis, {maxMs: 250, inferenceWork: 0});
  const converted = analysisPlanFromAnalysis(analysis);
  assert.ok(converted?.strategicPlan);
  assert.deepEqual(structuralPlan(state, request, {}, "fast", 1, converted).payload.strategicPlan, plan);
  assert.equal(parseSokomindOptions({}).strategicAnalysisMs, 0);
  assert.equal(parseSokomindOptions({}).strategicPlanExecution, false);
  assert.equal(parseSokomindOptions({strategicPlanExecution: true}).strategicPlanExecution, true);
  assert.throws(() => parseSokomindOptions({strategicPlanExecution: "yes"}));
  assert.equal(structuralPlan(state, request, {}, "fast", 1, converted).payload.planStrategicExecution, false);
  assert.equal(parseSokomindOptions({strategicAnalysisMs: 250}).strategicAnalysisMs, 250);
  for (const invalid of [-1, 1001, NaN, "250"]) {
    assert.throws(() => parseSokomindOptions({strategicAnalysisMs: invalid}));
  }
  assert.throws(() => parseSokomindOptions({strategicAnalysisMs: 250, deterministic: true}), /deterministic/);
});

function typedPlan() {
  const prepared = prepare();
  assert.ok(validateStrategicPlanContract(prepared.plan));
  return {...prepared, plan: prepared.plan};
}

test("connected inference keeps alternative supports and interchangeable owners in its contract", () => {
  const {plan} = prepare(PUZZLE_BY_ID.huge!);
  assert.ok(validateStrategicPlanContract(plan));
  const task = plan.tasks.find(task => task.boxCandidates && task.boxCandidates.length > 1);
  if (task) {
    const [, , wireBoxes] = JSON.parse(plan.snapshotKey) as [string[], number[], [string, string][]];
    const boxes = wireBoxes.map(([cell, label]) => [...cell.split(",").map(Number), label] as [number, number, string]);
    const alternative = task.boxCandidates!.find(index => index !== task.boxIndex)!;
    boxes[alternative] = [...task.completesWhen.cells[0].split(",").map(Number), boxes[alternative][2]] as [number, number, string];
    assert.ok(evaluateStrategicPlanState({boxes}, plan).completed.includes(task.id));
    boxes[alternative][2] = "wrong-label";
    assert.equal(evaluateStrategicPlanState({boxes}, plan).completed.includes(task.id), false);
    const invalid = {...plan, tasks: plan.tasks.map(value => value.id === task.id
      ? {...value, completesWhen: {...value.completesWhen, label: "wrong-label"}} : value)};
    assert.equal(validateStrategicPlanContract(invalid), false);
  }
});

test("a clearance witness expires with its consumer and support alternatives are disjunctive", () => {
  const {plan} = typedPlan();
  const [, , wireBoxes] = JSON.parse(plan.snapshotKey) as [string[], number[], [string, string][]];
  const boxes = wireBoxes.map(([cell, label]) => [...cell.split(",").map(Number), label] as [number, number, string]);
  const consumer = {...plan.tasks[0], dependsOn: [], requires: []};
  const stage = {...plan.tasks[1], kind: "stage" as const, forTaskId: consumer.id, dependsOn: [], requires: [],
    completesWhen: {kind: "box-at-cells" as const, boxIndex: plan.tasks[1].boxIndex, cells: ["4,1"]}};
  const model = {...plan, tasks: [consumer, stage],
    hypotheses: [{...plan.hypotheses[0], taskIds: [consumer.id, stage.id]}], candidates: [],
    resources: [{id: "choices", consumerTaskId: consumer.id, cells: [wireBoxes[stage.boxIndex][0], "4,1", "4,2", "4,3"],
      alternatives: [[wireBoxes[stage.boxIndex][0], "4,1"], ["4,2", "4,3"]],
      availableFrom: "task-enabled" as const, availableUntil: "task-complete" as const}]};
  assert.ok(validateStrategicPlanContract(model));
  assert.equal(evaluateStrategicPlanState({boxes}, model).resourceRisk, 0);
  assert.ok(evaluateStrategicPlanState({boxes}, model).enabled.includes(stage.id));
  boxes[consumer.boxIndex] = [...consumer.completesWhen.cells[0].split(",").map(Number), boxes[consumer.boxIndex][2]] as [number, number, string];
  assert.equal(evaluateStrategicPlanState({boxes}, model).enabled.includes(stage.id), false);
  assert.equal(validateStrategicPlanContract({...model, tasks: [{...consumer, dependsOn: [stage.id]}, stage]}), false);
});

test("V2 validates predicates, scope, references, cycles, bounds and JSON shape", () => {
  const {plan, state} = typedPlan();
  const variants = [
    {...plan, tasks: [{...plan.tasks[0], completesWhen: {kind: "invented", cells: ["1,1"]}}, ...plan.tasks.slice(1)]},
    {...plan, tasks: [{...plan.tasks[0], dependsOn: [plan.tasks[0].id]}, ...plan.tasks.slice(1)]},
    {...plan, tasks: [{...plan.tasks[0], dependsOn: ["missing"]}, ...plan.tasks.slice(1)]},
    {...plan, tasks: [{...plan.tasks[0], evidence: {...plan.tasks[0].evidence, snapshotKey: "stale"}}, ...plan.tasks.slice(1)]},
    {...plan, tasks: [{...plan.tasks[0], completesWhen: {kind: "box-at-cells", boxIndex: 999, cells: ["1,1"]}}, ...plan.tasks.slice(1)]},
    {...plan, tasks: [{...plan.tasks[0], completesWhen: {...plan.tasks[0].completesWhen, cells: ["0,0"]}}, ...plan.tasks.slice(1)]},
    {...plan, tasks: Array(129).fill(plan.tasks[0])},
    {...plan, extra: () => {}},
  ];
  for (const invalid of variants) {
    assert.equal(validateStrategicPlanContract(invalid), false);
    const result = search({algorithm: "plan-macro-beam", state, strategicPlan: invalid, maxVisited: 1, planDiagnostics: true});
    const diagnostics = result.planDiagnostics as {preparedPlansAccepted: number; strategicExecution?: unknown};
    assert.equal(diagnostics.preparedPlansAccepted, 0);
    assert.equal(diagnostics.strategicExecution, undefined);
  }
  const cyclic: Record<string, unknown> = {...plan}; cyclic.extra = cyclic;
  assert.equal(validateStrategicPlanContract(cyclic), false);
  const tasks = plan.tasks.map(task => ({...task, dependsOn: [...task.dependsOn]}));
  tasks[0].dependsOn = [tasks[1].id]; tasks[1].dependsOn = [tasks[0].id];
  assert.equal(validateStrategicPlanContract({...plan, tasks}), false);
});

test("completion is reversible and resource occupation matters only during its consumer interval", () => {
  const {plan} = typedPlan();
  const [, , wireBoxes] = JSON.parse(plan.snapshotKey) as [string[], number[], [string, string][]];
  const boxes = wireBoxes.map(([cell, label]) => [...cell.split(",").map(Number), label] as [number, number, string]);
  const first = plan.tasks[0], second = plan.tasks[1];
  const tasks = plan.tasks.map(task => task.id === second.id ? {...task, dependsOn: [first.id]} : task);
  const resources = [{id: "temporary-support", cells: [wireBoxes[0][0]], consumerTaskId: second.id,
    availableFrom: "task-enabled" as const, availableUntil: "task-complete" as const}];
  const model = {...plan, tasks, resources};
  assert.ok(validateStrategicPlanContract(model));
  const initial = evaluateStrategicPlanState({boxes}, model);
  assert.equal(initial.completed.includes(first.id), false);
  assert.equal(initial.enabled.includes(second.id), false);
  assert.equal(initial.resourceRisk, 0);
  const after = boxes.map(box => [...box] as [number, number, string]);
  assert.ok(["box-at-cells", "goal-filled"].includes(first.completesWhen.kind));
  const [y,x] = first.completesWhen.cells[0].split(",").map(Number);
  after[first.boxIndex] = [y,x,after[first.boxIndex][2]];
  // Make the reserved resource an occupied cell of the now-complete first task.
  model.resources[0].cells = [first.completesWhen.cells[0]];
  const completed = evaluateStrategicPlanState({boxes: after}, model);
  assert.ok(completed.completed.includes(first.id));
  assert.ok(completed.enabled.includes(second.id));
  assert.equal(completed.resourceRisk, 1);
  assert.equal(evaluateStrategicPlanState({boxes}, model).completed.includes(first.id), false);
});

test("a plan with no prepared paths controls real search and still returns a replay-valid solution", () => {
  const {plan, state, request} = typedPlan();
  const result = search({algorithm: "plan-macro-beam", state, strategicPlan: {...plan, candidates: []}, planDiagnostics: true});
  assert.ok(result.path);
  const counters = (result.planDiagnostics as {strategicExecution: {evaluations: number; advancingFirstPushes: number}}).strategicExecution;
  assert.ok(counters.evaluations > 0);
  assert.ok(counters.advancingFirstPushes > 0);
  const solution = solutionFromLegacyPath(request, result.path);
  assert.ok(solution && verifySolverSolution(request, solution).valid);
  const control = search({algorithm: "plan-macro-beam", state, strategicPlan: {...plan, candidates: []},
    planStrategicExecution: false, planDiagnostics: true});
  assert.equal((control.planDiagnostics as {strategicExecution?: unknown}).strategicExecution, undefined);
});

test("adapter owns a deeply frozen copy of the plan", () => {
  const {analysis, plan} = typedPlan();
  const converted = analysisPlanFromAnalysis(analysis)!.strategicPlan!;
  assert.notEqual(converted, plan);
  assert.ok(Object.isFrozen(converted.tasks[0].completesWhen.cells));
  assert.ok(Object.isFrozen(converted.tasks[0].evidence));
});

test("checkpoint continuation replays lineage, rebinds roles, and retains strategy without stale seeds", () => {
  const {plan, state, request, analysis} = typedPlan();
  const solved = search({algorithm: "plan-macro-beam", state, strategicPlan: plan});
  assert.ok(solved.path?.length);
  const moves = {Up: "up", Down: "down", Left: "left", Right: "right"} as const;
  const move = solved.path[0] as keyof typeof moves;
  const transition = stepSnapshot(request.board, request.snapshot, moves[move]);
  const checkpointState = toLegacyState({...request, snapshot: transition.snapshot});
  const rebased = rebaseStrategicPlan(plan, state, checkpointState, [move]);
  assert.ok(rebased);
  assert.deepEqual(rebased.candidates, []);
  assert.notEqual(rebased.snapshotKey, plan.snapshotKey);
  assert.equal(rebaseStrategicPlan(plan, state, checkpointState, []), undefined);
  const [continuation] = checkpointContinuationPlans([{state: checkpointState, path: [move], cost: transition.pushed ? 1 : 0}],
    state, {...request, options: {"sokomind-solver": {strategicPlanExecution: true}}}, {}, 1, analysisPlanFromAnalysis(analysis));
  assert.equal(continuation.payload.algorithm, "plan-macro-beam");
  assert.ok(validateStrategicPlanContract(continuation.payload.strategicPlan));
  const result = search({...continuation.payload, planDiagnostics: true});
  assert.ok(result.path);
  const solution = solutionFromLegacyPath(request, [move, ...result.path]);
  assert.ok(solution && verifySolverSolution(request, solution).valid);
});


test("replayed continuations survive changed box ordering and mirrored coordinates", () => {
  for (const rows of [puzzle.rows, puzzle.rows.map(row => [...row].reverse().join(""))]) {
    const {request, state, plan} = prepare({...puzzle, rows});
    assert.ok(validateStrategicPlanContract(plan));
    const solved = search({algorithm: "plan-macro-beam", state, strategicPlan: plan});
    assert.ok(solved.path);
    let snapshot = request.snapshot;
    const prefix: string[] = [];
    const moves = {Up: "up", Down: "down", Left: "left", Right: "right"} as const;
    for (const move of solved.path.slice(0, -1)) {
      const transition = stepSnapshot(request.board, snapshot, moves[move as keyof typeof moves]);
      snapshot = transition.snapshot;
      prefix.push(move);
      if (!transition.pushed) continue;
      const checkpoint = toLegacyState({...request, snapshot});
      const reversed = {...checkpoint, boxes: [...checkpoint.boxes].reverse()};
      const rebased = rebaseStrategicPlan(plan, state, reversed, prefix);
      assert.ok(rebased);
      const continuation = search({algorithm: "plan-macro-beam", state: reversed,
        strategicPlan: rebased, planDiagnostics: true});
      assert.ok(continuation.path);
      const solution = solutionFromLegacyPath(request, [...prefix, ...continuation.path]);
      assert.ok(solution && verifySolverSolution(request, solution).valid);
    }
  }
});

test("invalid worker continuation context falls back without carrying plan authority", () => {
  const {plan, state} = typedPlan();
  const result = search({algorithm: "plan-macro-beam", state, strategicPlan: plan,
    strategicContinuation: {root: {}, path: []}, planDiagnostics: true});
  assert.ok(result.path);
  assert.equal((result.planDiagnostics as {strategicExecution?: unknown}).strategicExecution, undefined);
});
