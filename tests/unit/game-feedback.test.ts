import assert from "node:assert/strict";
import test from "node:test";

import {
  createSession,
  move,
  type Direction,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import { classifyMove } from "../../src/features/game/game-feedback.ts";

function session(rows: readonly string[]) {
  const puzzle: PuzzleDefinition = {
    id: "feedback",
    title: "Feedback",
    difficulty: "tutorial",
    boxes: 1,
    rows,
  };
  return createSession(puzzle);
}

function apply(
  current: ReturnType<typeof session>,
  directions: readonly Direction[],
) {
  return directions.reduce((state, direction) => move(state, direction), current);
}

test("classifies blocked and ordinary keeper movement", () => {
  const start = session([
    "OOOOO",
    "OR  O",
    "O XSO",
    "OOOOO",
  ]);

  assert.equal(classifyMove(start, move(start, "up")), "blocked");
  assert.equal(classifyMove(start, move(start, "right")), "move");
});

test("distinguishes pushes from pushes onto matching goals", () => {
  const start = session([
    "OOOOOO",
    "ORX SO",
    "OOOOOO",
  ]);

  const pushed = move(start, "right");
  assert.equal(classifyMove(start, pushed), "push");

  const onGoal = apply(pushed, ["right"]);
  assert.equal(classifyMove(pushed, onGoal), "solved");
});

test("reports an intermediate matching-goal placement", () => {
  const puzzle: PuzzleDefinition = {
    id: "two-box-feedback",
    title: "Two Box Feedback",
    difficulty: "tutorial",
    boxes: 2,
    rows: [
      "OOOOOOO",
      "ORX S O",
      "O  X SO",
      "OOOOOOO",
    ],
  };
  const start = createSession(puzzle);
  const beforeGoal = apply(start, ["right"]);
  const onGoal = move(beforeGoal, "right");

  assert.equal(classifyMove(beforeGoal, onGoal), "goal");
  assert.equal(onGoal.solved, false);
});

test("reports when a box leaves its matching goal", () => {
  const initial = createSession({
    id: "goal-leave-feedback",
    title: "Goal Leave Feedback",
    difficulty: "tutorial",
    boxes: 2,
    rows: [
      "OOOOOOOO",
      "ORXS   O",
      "O X S  O",
      "OOOOOOOO",
    ],
  });
  const onGoal = move(initial, "right");
  const pushedOffGoal = move(onGoal, "right");

  assert.equal(classifyMove(onGoal, pushedOffGoal), "goal-leave");
});
