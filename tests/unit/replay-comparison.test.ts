import assert from "node:assert/strict";
import test from "node:test";
import type { PuzzleDefinition } from "../../src/core/model.ts";
import {
  buildReplayTrace,
  compareReplayTraces,
  replayStepDescription,
  replayTraceSession,
} from "../../src/features/replay/replay-comparison.ts";

const PUZZLE: PuzzleDefinition = Object.freeze({
  id: "replay-comparison",
  title: "Replay comparison",
  difficulty: "tutorial",
  boxes: 1,
  rows: Object.freeze([
    "OOOOOO",
    "O RXS O",
    "O    O",
    "OOOOOO",
  ]),
});

test("buildReplayTrace produces one canonical frame per action plus the start", () => {
  const trace = buildReplayTrace(PUZZLE, "LRR");
  assert.equal(trace.frames.length, 4);
  assert.deepEqual(trace.pushedSteps, [false, false, true]);
  assert.equal(trace.frames[0]?.moves, 0);
  assert.equal(trace.frames.at(-1)?.moves, 3);
  assert.equal(trace.frames.at(-1)?.pushes, 1);
  assert.equal(trace.frames.at(-1)?.solved, true);
  const view = replayTraceSession(trace, 2);
  assert.equal(view.actionLog, "LR");
  assert.equal(view.history.length, 0);
  assert.equal(view.snapshot, trace.frames[2]);
});

test("buildReplayTrace rejects blocked actions instead of inventing frames", () => {
  assert.throws(
    () => buildReplayTrace(PUZZLE, "U"),
    (error: unknown) =>
      error instanceof Error && error.message.includes("blocked"),
  );
});

test("comparison identifies direction, push, and finish differences in words", () => {
  const short = buildReplayTrace(PUZZLE, "R");
  const long = buildReplayTrace(PUZZLE, "LRR");
  const comparison = compareReplayTraces(short, long);

  assert.equal(comparison.commonPrefixMoves, 0);
  assert.equal(comparison.firstActionDifference, 1);
  assert.equal(comparison.firstPushDifference, 1);
  assert.equal(comparison.moveDelta, -2);
  assert.equal(comparison.pushDelta, 0);
  assert.deepEqual(
    comparison.markers.map((marker) => marker.symbol),
    ["D", "F"],
  );
  assert.match(comparison.summary, /goes right while the comparison goes left/u);
  assert.match(comparison.summary, /2 moves fewer/u);
});

test("identical routes report no divergence markers", () => {
  const first = buildReplayTrace(PUZZLE, "LRR");
  const second = buildReplayTrace(PUZZLE, "LRR");
  const comparison = compareReplayTraces(first, second);
  assert.equal(comparison.firstActionDifference, undefined);
  assert.equal(comparison.firstPushDifference, undefined);
  assert.deepEqual(comparison.markers, []);
  assert.match(comparison.summary, /same directions/u);
});

test("step descriptions expose position, counters, and solved state", () => {
  const trace = buildReplayTrace(PUZZLE, "R");
  assert.equal(
    replayStepDescription(trace, 1, "Personal best"),
    "Personal best, move 1 of 1. Keeper at row 2, column 4. 1 push. Puzzle solved.",
  );
});
