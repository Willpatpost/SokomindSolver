import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession, stepSnapshot, type Direction, type PuzzleDefinition } from "../../src/core/index.ts";
import { solutionFromLegacyPath, toLegacyState } from "../../src/solver/implementations/sokomind-legacy.ts";
import { createPlanTraceRuntime, type PlanTraceState } from "../../scripts/lib/plan-trace-runtime.ts";
import { createRouteRecoverabilityTracker } from "../../scripts/lib/route-recoverability.ts";

const puzzle: PuzzleDefinition = {id: "trace", title: "Trace", difficulty: "tutorial", boxes: 1,
  rows: ["OOOOOOO", "OR X SO", "OOOOOOO"]};
const path = ["Right", "Right", "Right"];
function referenceStates(definition = puzzle, moves = path): PlanTraceState[] {
  const session = createSession(definition);
  let snapshot = session.snapshot;
  const state = (): PlanTraceState => ({robot: [snapshot.robot.row, snapshot.robot.column],
    boxes: snapshot.boxes.map(box => [box.position.row, box.position.column, box.label]), cost: snapshot.pushes});
  const frames = [state()];
  for (const move of moves) {
    const step = stepSnapshot(session.board, snapshot, move.toLowerCase() as Direction);
    assert.ok(step.moved);
    snapshot = step.snapshot;
    if (step.pushed) frames.push(state());
  }
  assert.ok(snapshot.solved);
  return frames;
}

test("offline observation preserves a solved route and deterministic work through canonicalization", () => {
  const repeated = {...puzzle, boxes: 2, rows: ["OOOOOOOO", "OR X S O", "O  X S O", "OOOOOOOO"]};
  for (const definition of [puzzle, repeated].flatMap(board => [board,
    {...board, rows: board.rows.map(row => [...row].reverse().join(""))}])) {
    const session = createSession(definition);
    const request = {board: session.board, snapshot: session.snapshot, objective: {kind: "moves" as const}};
    const runtime = createPlanTraceRuntime();
    const payload = {algorithm: "plan-macro-beam", state: toLegacyState(request), maxVisited: 1000};
    const baseline = runtime.run(payload);
    assert.ok(baseline.path && solutionFromLegacyPath(request, baseline.path));
    const reference = runtime.reference(toLegacyState(request), baseline.path);
    const tracker = createRouteRecoverabilityTracker({...definition, rows: reference.state.rows}, reference.path);
    const observed = runtime.run(payload, tracker.observe);
    for (const key of ["path", "visited", "generated", "retained", "peakFrontier"] as const) {
      assert.deepEqual(observed[key], baseline[key], key);
    }
    assert.equal(tracker.report().frontierLoss.category, "reference-solution-generated");
    assert.equal(tracker.report().truncated, false);
  }
});

test("observer failures do not leave the VM search wrapper installed", () => {
  const session = createSession(puzzle);
  const payload = {algorithm: "plan-macro-beam", state: toLegacyState({board: session.board,
    snapshot: session.snapshot, objective: {kind: "moves"}})};
  const runtime = createPlanTraceRuntime();
  assert.throws(() => runtime.run(payload, () => { throw new Error("Observer failed"); }), /Observer failed/);
  assert.ok(runtime.run(payload).path);
});

test("distinguishes first-push selection, macro filtering, pruning, and beam selection", () => {
  const [root, first, solved] = referenceStates();
  const macro = {...first, pushes: 1, path: ["Right", "Right"]};
  for (const cause of ["first-push-selection", "macro-successor-filter", "candidate-pruning-or-search-cutoff", "beam-preselection", "beam-selection"] as const) {
    const tracker = createRouteRecoverabilityTracker(puzzle, path);
    tracker.observe({stage: "root", states: [root]});
    tracker.observe({stage: "expand", state: root, segment: 0});
    tracker.observe({stage: "first-generated", current: root, states: [first]});
    if (cause !== "first-push-selection") {
      tracker.observe({stage: "first-selected", current: root, states: [first]});
      tracker.observe({stage: "macro-returned", current: root, states: [macro]});
    }
    if (!["first-push-selection", "macro-successor-filter"].includes(cause)) {
      tracker.observe({stage: "macro-successors", current: root, states: [macro]});
      tracker.observe({stage: "reject", state: first, reason: "exact-transposition"});
    }
    if (["beam-preselection", "beam-selection"].includes(cause)) tracker.observe({stage: "candidates", states: [first]});
    if (cause === "beam-selection") {
      for (const stage of ["preselected", "eligible", "arrival-bounded"]) tracker.observe({stage, states: [first]});
      // A different state survives: it cannot masquerade as the reference prefix.
      tracker.observe({stage: "retained", states: [{...solved, robot: [1, 1]}]});
    }
    assert.equal(tracker.report().frontierLoss.category, cause);
    assert.equal(tracker.report().furthestRetainedPush, 0);
  }
});

test("a macro may retain several reference pushes without retaining each intermediate endpoint", () => {
  const [root, , solved] = referenceStates();
  const tracker = createRouteRecoverabilityTracker(puzzle, path);
  tracker.observe({stage: "root", states: [root]});
  tracker.observe({stage: "macro-successors", current: root, states: [{...solved, pushes: 2, path}]});
  tracker.observe({stage: "solved", state: solved});
  assert.equal(tracker.report().furthestRetainedPush, 2);
  assert.equal(tracker.report().frontierLoss.category, "reference-solution-generated");
});

test("physical repeated-box identity and intermediate push order cannot be collapsed", () => {
  const repeated = {...puzzle, boxes: 2, rows: ["OOOOOOOO", "OR X S O", "O  X S O", "OOOOOOOO"]};
  const names: Record<string, string> = {R: "Right", L: "Left", D: "Down", U: "Up"};
  const route = [..."RRRLLDRR"].map(code => names[code]);
  const frames = referenceStates(repeated, route);
  const tracker = createRouteRecoverabilityTracker(repeated, route);
  tracker.observe({stage: "root", states: [frames[0]]});
  tracker.observe({stage: "retained", states: [{...frames[1], boxes: [...frames[1].boxes].reverse()}]});
  tracker.observe({stage: "macro-successors", current: frames[0], states: [{...frames.at(-1)!, pushes: 4,
    path: [..."DRRRLLURRD"].map(code => names[code])}]});
  assert.equal(tracker.report().furthestRetainedPush, 0);
  assert.equal(tracker.report().records.length, 1);
});

test("invalid references fail closed and a capped trace never claims a search failure", () => {
  assert.throws(() => createRouteRecoverabilityTracker(puzzle, ["Left"]), /blocked/);
  assert.throws(() => createRouteRecoverabilityTracker(puzzle, ["Right"]), /solve/);
  const tracker = createRouteRecoverabilityTracker(puzzle, path, 1);
  const [root] = referenceStates();
  tracker.observe({stage: "root", states: [root]});
  tracker.observe({stage: "expand", state: root});
  assert.equal(tracker.report().frontierLoss.category, "trace-limit");
  assert.equal(tracker.report().truncated, true);
});
