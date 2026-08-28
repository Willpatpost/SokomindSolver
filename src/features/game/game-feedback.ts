import {
  positionKey,
  type Direction,
  type GameSession,
  type Position,
} from "../../core/index.ts";

export type GameFeedback =
  | "blocked"
  | "move"
  | "push"
  | "goal"
  | "goal-leave"
  | "solved";

export interface MovedBoxExperience {
  readonly id: string;
  readonly label: string;
  readonly from: Position;
  readonly to: Position;
}

/** A presentation-neutral description of one attempted movement input. */
export interface GameExperienceEvent {
  readonly kind: GameFeedback;
  readonly direction: Direction;
  readonly movedBox?: MovedBoxExperience;
  readonly matchedGoalsBefore: number;
  readonly matchedGoalsAfter: number;
  readonly totalGoals: number;
}

/** A move event annotated with an identity suitable for transient UI effects. */
export interface PresentedGameExperienceEvent extends GameExperienceEvent {
  readonly sequence: number;
}

function matchedBoxCount(session: GameSession): number {
  const goals = new Map(
    session.board.goals.map((goal) => [positionKey(goal.position), goal.label]),
  );

  return session.snapshot.boxes.filter(
    (box) => goals.get(positionKey(box.position)) === box.label,
  ).length;
}

function findMovedBox(
  previous: GameSession,
  next: GameSession,
): MovedBoxExperience | undefined {
  const previousById = new Map(
    previous.snapshot.boxes.map((box) => [box.id, box]),
  );

  for (const box of next.snapshot.boxes) {
    const prior = previousById.get(box.id);
    if (
      prior &&
      (prior.position.row !== box.position.row ||
        prior.position.column !== box.position.column)
    ) {
      return {
        id: box.id,
        label: box.label,
        from: prior.position,
        to: box.position,
      };
    }
  }

  return undefined;
}

function classifyMovement(
  previous: GameSession,
  next: GameSession,
  matchedGoalsBefore: number,
  matchedGoalsAfter: number,
): GameFeedback {
  if (previous === next) return "blocked";
  if (!previous.solved && next.solved) return "solved";
  if (next.pushes === previous.pushes) return "move";
  if (matchedGoalsAfter > matchedGoalsBefore) return "goal";
  if (matchedGoalsAfter < matchedGoalsBefore) return "goal-leave";
  return "push";
}

/**
 * Describe one attempted movement without performing presentation side effects.
 *
 * Animation, audio, accessibility announcements, and future haptics can consume
 * this event while the game engine remains entirely unaware of those systems.
 */
export function describeMoveExperience(
  previous: GameSession,
  next: GameSession,
  direction: Direction,
): GameExperienceEvent {
  const matchedGoalsBefore = matchedBoxCount(previous);
  const matchedGoalsAfter = matchedBoxCount(next);
  const kind = classifyMovement(
    previous,
    next,
    matchedGoalsBefore,
    matchedGoalsAfter,
  );

  return {
    kind,
    direction,
    movedBox: findMovedBox(previous, next),
    matchedGoalsBefore,
    matchedGoalsAfter,
    totalGoals: next.board.goals.length,
  };
}

/**
 * Compatibility wrapper for consumers that only need the coarse event kind.
 */
export function classifyMove(
  previous: GameSession,
  next: GameSession,
): GameFeedback {
  return classifyMovement(
    previous,
    next,
    matchedBoxCount(previous),
    matchedBoxCount(next),
  );
}
