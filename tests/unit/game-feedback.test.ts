import assert from "node:assert/strict";
import test from "node:test";

import {
  createSession,
  move,
  type Direction,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import {
  classifyMove,
  describeMoveExperience,
} from "../../src/features/game/game-feedback.ts";

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

  const blocked = move(start, "up");
  const moved = move(start, "right");

  assert.equal(classifyMove(start, blocked), "blocked");
  assert.deepEqual(describeMoveExperience(start, blocked, "up"), {
    kind: "blocked",
    direction: "up",
    movedBox: undefined,
    matchedGoalsBefore: 0,
    matchedGoalsAfter: 0,
    totalGoals: 1,
  });

  assert.equal(classifyMove(start, moved), "move");
  assert.deepEqual(describeMoveExperience(start, moved, "right"), {
    kind: "move",
    direction: "right",
    movedBox: undefined,
    matchedGoalsBefore: 0,
    matchedGoalsAfter: 0,
    totalGoals: 1,
  });
});

test("distinguishes pushes from pushes onto matching goals", () => {
  const start = session([
    "OOOOOO",
    "ORX SO",
    "OOOOOO",
  ]);

  const pushed = move(start, "right");
  assert.equal(classifyMove(start, pushed), "push");
  assert.deepEqual(
    describeMoveExperience(start, pushed, "right").movedBox,
    {
      id: start.snapshot.boxes[0].id,
      label: start.snapshot.boxes[0].label,
      from: start.snapshot.boxes[0].position,
      to: pushed.snapshot.boxes[0].position,
    },
  );

  const onGoal = apply(pushed, ["right"]);
  assert.equal(classifyMove(pushed, onGoal), "solved");
  assert.deepEqual(describeMoveExperience(pushed, onGoal, "right"), {
    kind: "solved",
    direction: "right",
    movedBox: {
      id: pushed.snapshot.boxes[0].id,
      label: pushed.snapshot.boxes[0].label,
      from: pushed.snapshot.boxes[0].position,
      to: onGoal.snapshot.boxes[0].position,
    },
    matchedGoalsBefore: 0,
    matchedGoalsAfter: 1,
    totalGoals: 1,
  });
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
  const event = describeMoveExperience(beforeGoal, onGoal, "right");
  assert.equal(event.kind, "goal");
  assert.equal(event.matchedGoalsBefore, 0);
  assert.equal(event.matchedGoalsAfter, 1);
  assert.equal(event.totalGoals, 2);
  assert.deepEqual(event.movedBox?.to, onGoal.snapshot.boxes[0].position);
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
  const event = describeMoveExperience(onGoal, pushedOffGoal, "right");
  assert.equal(event.kind, "goal-leave");
  assert.equal(event.matchedGoalsBefore, 1);
  assert.equal(event.matchedGoalsAfter, 0);
  assert.equal(event.movedBox?.id, onGoal.snapshot.boxes[0].id);
});
