import assert from "node:assert/strict";
import { createSession, stepSnapshot } from "../../src/core/game-session.ts";
import { DIRECTIONS, type Direction, type GameSnapshot, type ParsedBoard } from "../../src/core/model.ts";
import { directionDelta } from "../../src/core/position.ts";
import type { SolutionStep } from "../../src/solver/contracts.ts";
import { buildCanonicalSolutionTrace } from "../../src/features/generator/v2/solution-trace.ts";
import type { TracePushOption } from "../../src/features/generator/v2/solution-trace.ts";
import type { CounterfactualFixture } from "../fixtures/generator/counterfactual-stories.ts";
import type { CounterfactualProbeEvidence } from "../../src/features/generator/v2/counterfactual-analysis.ts";

/** Independently replay every search witness through the game engine. */
export function replayPushes(
  board: ParsedBoard,
  initial: GameSnapshot,
  pushes: readonly Pick<TracePushOption, "boxId" | "direction">[],
) {
  let snapshot = initial;
  const steps: SolutionStep[] = [];
  const apply = (direction: Direction, kind: "push" | "walk") => {
    const next = stepSnapshot(board, snapshot, direction);
    assert.ok(next.moved, `blocked ${direction}`);
    assert.equal(next.pushed, kind === "push");
    snapshot = next.snapshot;
    steps.push({ direction, kind });
  };
  for (const push of pushes) {
    const box = snapshot.boxes[push.boxId].position;
    const delta = directionDelta(push.direction);
    const support = { row: box.row - delta.row, column: box.column - delta.column };
    const blocked = new Set([...board.walls, ...snapshot.boxes.map((item) => item.position)]
      .map((position) => `${position.row},${position.column}`));
    const queue = [{ ...snapshot.robot, path: [] as Direction[] }];
    const seen = new Set<string>();
    let path: Direction[] | undefined;
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      if (current.row === support.row && current.column === support.column) {
        path = current.path;
        break;
      }
      for (const direction of DIRECTIONS) {
        const d = directionDelta(direction);
        const row = current.row + d.row;
        const column = current.column + d.column;
        const key = `${row},${column}`;
        if (row < 0 || row >= board.height || column < 0 || column >= board.width ||
          blocked.has(key) || seen.has(key)) continue;
        seen.add(key);
        queue.push({ row, column, path: [...current.path, direction] });
      }
    }
    assert.ok(path, `unreachable support for box ${push.boxId} ${push.direction}`);
    for (const direction of path) apply(direction, "walk");
    const before = snapshot.boxes[push.boxId].position;
    apply(push.direction, "push");
    assert.deepEqual(snapshot.boxes[push.boxId].position, {
      row: before.row + delta.row, column: before.column + delta.column,
    });
  }
  return { snapshot, steps };
}

export function fixtureTrace(fixture: CounterfactualFixture) {
  const session = createSession(fixture.puzzle);
  const pushes = fixture.pushes.flatMap(([boxId, direction, count]) =>
    Array.from({ length: count }, () => ({ boxId, direction })));
  const replay = replayPushes(session.board, session.snapshot, pushes);
  assert.ok(replay.snapshot.solved);
  const grid = fixture.puzzle.rows.map((row) => [...row]);
  const result = buildCanonicalSolutionTrace(grid, replay.steps, { requireSolved: true });
  assert.ok(result.ok, result.ok ? undefined : result.error.message);
  return { grid, trace: result.trace, session };
}

/** Tiny independent step-level BFS; no push macros, region merging, or pruning. */
export function oracleProbe(fixture: CounterfactualFixture, probe: CounterfactualProbeEvidence): boolean {
  const { board, snapshot } = createSession(fixture.puzzle);
  let initial = {
    ...snapshot, robot: probe.state.robot,
    boxes: snapshot.boxes.map((box, id) => ({ ...box, position: probe.state.boxes[id] })),
  } as GameSnapshot;
  if (probe.alternative) initial = replayPushes(board, initial, [probe.alternative]).snapshot;
  const queue = [initial];
  const seen = new Set<string>();
  const fixedBox = snapshot.boxes[probe.boxId].id;
  const targetBox = probe.targetBoxId === undefined ? undefined : snapshot.boxes[probe.targetBoxId].id;
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current.solved) {
      if (probe.kind !== "freeze-enabler") return true;
      continue;
    }
    for (const direction of DIRECTIONS) {
      const next = stepSnapshot(board, current, direction);
      if (!next.moved) continue;
      if (probe.kind !== "alternative-push" && next.pushedBoxId === fixedBox) continue;
      if (probe.kind === "freeze-enabler" && next.pushedBoxId === targetBox) return true;
      const state = next.snapshot;
      const key = `${state.robot.row},${state.robot.column}|` + state.boxes.map((box) =>
        `${box.id}:${box.position.row},${box.position.column}`).join(";");
      if (seen.has(key)) continue;
      seen.add(key);
      assert.ok(seen.size < 200000, "tiny-fixture oracle must finish without an artificial cutoff");
      queue.push(state);
    }
  }
  return false;
}
