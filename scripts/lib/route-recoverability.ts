import assert from "node:assert/strict";
import { createSession, stepSnapshot, type Direction, type GameSnapshot, type PuzzleDefinition } from "../../src/core/index.ts";
import type { PlanTraceEvent, PlanTraceState } from "./plan-trace-runtime.ts";

const snapshotKey = (snapshot: GameSnapshot) => JSON.stringify([
  [snapshot.robot.row, snapshot.robot.column],
  snapshot.boxes.map(box => [box.position.row, box.position.column, box.label]),
]);
const stateKey = (state: PlanTraceState) => JSON.stringify([state.robot, state.boxes]);

/** Match physical-box positions and exact keeper arrival at equal push depth.
 * Walking routes may differ. Macro segments must match every intervening push.
 * Only bounded summaries are retained; engine objects are never mutated/stored.
 */
export function createRouteRecoverabilityTracker(puzzle: PuzzleDefinition, path: readonly string[], maxEvents = 200000) {
  assert.ok(Number.isSafeInteger(maxEvents) && maxEvents > 0, "Invalid event limit");
  assert.ok(path.length <= 100000, "Reference exceeds the diagnostic move limit");
  const session = createSession(puzzle);
  const frames = [session.snapshot];
  let snapshot = session.snapshot;
  for (const move of path) {
    assert.ok(["Up", "Down", "Left", "Right"].includes(move), `Invalid reference direction: ${move}`);
    const next = stepSnapshot(session.board, snapshot, move.toLowerCase() as Direction);
    assert.ok(next.moved, "Reference contains a blocked move");
    snapshot = next.snapshot;
    if (next.pushed) frames.push(snapshot);
  }
  assert.ok(snapshot.solved, "Reference must solve the puzzle");
  const keys = frames.map(snapshotKey);
  const records = frames.map((frame, push) => ({ push, referenceMove: frame.moves,
    stages: {} as Record<string, number>, rejections: {} as Record<string, number> }));
  const selections = new Map<number, {generated?: number; rank?: number; score?: number;
    pushClass?: string; selectedCount?: number; sameBoxSelected?: boolean;
    selectedPushes?: (string | undefined)[]}>();
  const edges = new Map<number, Set<number>>();
  const returnedEdges = new Map<number, Set<number>>();
  const eventCounts: Record<string, number> = {};
  let eventCount = 0, truncated = false;
  const match = (state: PlanTraceState, depth = state.cost): number | undefined =>
    depth !== undefined && keys[depth] === stateKey(state) ? depth : undefined;
  const mark = (stage: string, push: number, segment = -1) => {
    records[push].stages[stage] = Math.min(records[push].stages[stage] ?? Infinity, segment + 1);
  };
  const macroMatch = (current: PlanTraceState, next: PlanTraceState): number | undefined => {
    const start = match(current);
    if (start === undefined || !next.path) return undefined;
    let frame = frames[start], push = start;
    for (const move of next.path) {
      const step = stepSnapshot(session.board, frame, move.toLowerCase() as Direction);
      if (!step.moved) return undefined;
      frame = step.snapshot;
      if (step.pushed && snapshotKey(frame) !== keys[++push]) return undefined;
    }
    return push > start && push - start === next.pushes && stateKey(next) === keys[push] ? push : undefined;
  };
  return {
    observe(event: PlanTraceEvent) {
      if (eventCount >= maxEvents) { truncated = true; return; }
      eventCount++;
      eventCounts[event.stage] = (eventCounts[event.stage] ?? 0) + 1;
      if (event.stage.startsWith("first-")) {
        if (!event.current || match(event.current) === undefined) return;
        const depth = event.current.cost! + 1;
        const summary = selections.get(depth) ?? {};
        selections.set(depth, summary);
        if (event.stage === "first-generated") summary.generated = event.states?.length;
        if (event.stage === "first-selected") {
          const before = frames[depth - 1], after = frames[depth];
          const moved = after?.boxes.findIndex((box, index) =>
            box.position.row !== before.boxes[index].position.row || box.position.column !== before.boxes[index].position.column);
          const from = moved !== undefined && moved >= 0 ? before.boxes[moved].position : undefined;
          summary.selectedCount = event.states?.length;
          summary.sameBoxSelected = from && event.states?.some(state => state.pushedFrom === `${from.row},${from.column}`);
          summary.selectedPushes = event.states?.slice(0, 32).map(state => state.pushClass);
        }
        for (const [index, state] of (event.states ?? []).entries()) {
          const push = match(state, event.current.cost! + 1);
          if (push !== undefined) {
            mark(event.stage, push, event.segment);
            if (event.stage === "first-ranked") {
              summary.rank = index + 1;
              summary.score = state.score;
              summary.pushClass = state.pushClass;
            }
          }
        }
      } else if (event.stage.startsWith("macro-") || event.stage === "reject-macro") {
        if (!event.current) return;
        for (const state of event.states ?? (event.state ? [event.state] : [])) {
          const push = macroMatch(event.current, state);
          if (push === undefined) continue;
          mark(event.stage, push, event.segment);
          if (event.reason) records[push].rejections[event.reason] = (records[push].rejections[event.reason] ?? 0) + 1;
          if (event.stage === "macro-successors" || event.stage === "macro-returned") {
            const start = event.current.cost!;
            const target = event.stage === "macro-successors" ? edges : returnedEdges;
            if (!target.has(start)) target.set(start, new Set());
            target.get(start)!.add(push);
          }
        }
      } else {
        for (const state of event.states ?? (event.state ? [event.state] : [])) {
          const push = match(state);
          if (push === undefined) continue;
          mark(event.stage, push, event.segment);
          if (event.reason) records[push].rejections[event.reason] = (records[push].rejections[event.reason] ?? 0) + 1;
        }
      }
    },
    report(terminationReason?: string) {
      const represented = records.filter(record => record.stages.retained !== undefined || record.stages.root !== undefined || record.stages.solved !== undefined);
      const furthest = represented.at(-1)?.push ?? 0;
      const solved = records.at(-1)!.stages.solved !== undefined;
      const next = records[furthest + 1];
      const extensions = [...(edges.get(furthest) ?? [])].map(push => records[push]);
      let category: string;
      if (truncated) category = "trace-limit";
      else if (solved) category = "reference-solution-generated";
      else if (records[furthest].stages.expand === undefined) category = "not-expanded-before-search-ended";
      else if (next?.stages["first-generated"] === undefined) category = "first-push-generation-or-parent-pruning";
      else if (next.stages["first-selected"] === undefined) category = "first-push-selection";
      else if (!extensions.length) category = returnedEdges.get(furthest)?.size
        ? "macro-successor-filter" : "macro-generation-or-endpoint-selection";
      else if (extensions.every(record => record.stages.candidates === undefined)) category = "candidate-pruning-or-search-cutoff";
      else if (extensions.every(record => record.stages.preselected === undefined)) category = "beam-preselection";
      else if (extensions.every(record => record.stages.eligible === undefined)) category = "region-pruning";
      else if (extensions.every(record => record.stages["arrival-bounded"] === undefined)) category = "keeper-arrival-bound";
      else category = "beam-selection";
      return {schemaVersion: 1, referenceMoves: path.length, referencePushes: frames.length - 1,
        identity: "physical box order and exact keeper at equal push depth; macro push prefixes replayed through core",
        eventCount, eventCounts, truncated, terminationReason, furthestRetainedPush: furthest,
        frontierLoss: {category, afterPush: furthest, nextPush: next?.push,
          nextPushStages: next?.stages, selection: selections.get(furthest + 1),
          extensions: extensions.map(record => ({push: record.push, stages: record.stages, rejections: record.rejections}))},
        records: records.filter(record => Object.keys(record.stages).length),
      };
    },
  };
}
