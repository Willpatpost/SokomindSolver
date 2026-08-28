import type { Direction } from "@/src/core";
import type {
  AudioCue,
  AudioCueOptions,
  AudioCueVariant,
} from "@/src/features/experience";
import type { GameExperienceEvent } from "@/src/features/game/game-feedback";
import type { PuzzleRecord } from "@/src/shared/progress";

export interface AudioPresentation {
  readonly cue: AudioCue;
  readonly options?: AudioCueOptions;
}

const DIRECTION_PITCH: Readonly<Record<Direction, number>> = {
  up: 1.5,
  right: 0.5,
  down: -1.5,
  left: -0.5,
};

function progressPitch(event: GameExperienceEvent): number {
  if (event.totalGoals <= 1) return 0;
  return (event.matchedGoalsAfter / event.totalGoals) * 2;
}

/**
 * Translate the presentation-neutral movement event into one audio request.
 * Visual feedback, game rules, and Web Audio remain independent consumers.
 */
export function createMovementAudioPresentation(
  event: GameExperienceEvent,
): AudioPresentation {
  const pitchOffset = DIRECTION_PITCH[event.direction];

  switch (event.kind) {
    case "blocked":
      return { cue: "blocked", options: { pitchOffset } };
    case "move":
      return { cue: "step", options: { pitchOffset } };
    case "push":
      return { cue: "push", options: { pitchOffset } };
    case "goal":
      return {
        cue: "goal-enter",
        options: {
          pitchOffset: pitchOffset + progressPitch(event),
          variant: "progress",
        },
      };
    case "goal-leave":
      return {
        cue: "goal-leave",
        options: { pitchOffset, variant: "progress" },
      };
    case "solved":
      return { cue: "solve", options: { pitchOffset } };
  }
}

export function solveAudioVariant(
  previousBest: PuzzleRecord | undefined,
  moves: number,
  optimal: boolean,
): AudioCueVariant {
  if (optimal) return "optimal";
  if (!previousBest) return "first-clear";
  if (moves < previousBest.moves) return "personal-best";
  return "default";
}

