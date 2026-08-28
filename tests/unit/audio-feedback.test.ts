import assert from "node:assert/strict";
import test from "node:test";
import type { GameExperienceEvent } from "../../src/features/game/game-feedback.ts";
import {
  createMovementAudioPresentation,
  solveAudioVariant,
} from "../../src/features/play/audio-feedback.ts";
import type { PuzzleRecord } from "../../src/shared/progress.ts";

function event(
  overrides: Partial<GameExperienceEvent> = {},
): GameExperienceEvent {
  return {
    kind: "move",
    direction: "up",
    matchedGoalsBefore: 0,
    matchedGoalsAfter: 0,
    totalGoals: 3,
    ...overrides,
  };
}

function record(moves: number): PuzzleRecord {
  return {
    moves,
    pushes: 4,
    completedAt: "2026-08-28T12:00:00.000Z",
  };
}

test("movement audio uses direction to create restrained pitch variants", () => {
  assert.deepEqual(
    createMovementAudioPresentation(event({ direction: "up" })),
    { cue: "step", options: { pitchOffset: 1.5 } },
  );
  assert.deepEqual(
    createMovementAudioPresentation(event({ kind: "push", direction: "down" })),
    { cue: "push", options: { pitchOffset: -1.5 } },
  );
});

test("goal audio reflects progress while goal-leave remains distinct", () => {
  assert.deepEqual(
    createMovementAudioPresentation(event({
      kind: "goal",
      direction: "right",
      matchedGoalsAfter: 2,
    })),
    {
      cue: "goal-enter",
      options: {
        pitchOffset: 0.5 + (2 / 3) * 2,
        variant: "progress",
      },
    },
  );
  assert.deepEqual(
    createMovementAudioPresentation(event({ kind: "goal-leave", direction: "left" })),
    {
      cue: "goal-leave",
      options: { pitchOffset: -0.5, variant: "progress" },
    },
  );
});

test("blocked and solved movements still flow through the same presenter", () => {
  assert.equal(
    createMovementAudioPresentation(event({ kind: "blocked" })).cue,
    "blocked",
  );
  assert.equal(
    createMovementAudioPresentation(event({ kind: "solved" })).cue,
    "solve",
  );
});

test("solve audio prioritizes verified and personal milestones", () => {
  assert.equal(solveAudioVariant(undefined, 12, false), "first-clear");
  assert.equal(solveAudioVariant(record(20), 18, false), "personal-best");
  assert.equal(solveAudioVariant(record(18), 18, false), "default");
  assert.equal(solveAudioVariant(undefined, 12, true), "optimal");
});
