import { positionKey, type GameSession } from "../../core/index.ts";

export type GameFeedback =
  | "blocked"
  | "move"
  | "push"
  | "goal"
  | "goal-leave"
  | "solved";

function matchedBoxCount(session: GameSession): number {
  const goals = new Map(
    session.board.goals.map((goal) => [positionKey(goal.position), goal.label]),
  );

  return session.snapshot.boxes.filter(
    (box) => goals.get(positionKey(box.position)) === box.label,
  ).length;
}

/**
 * Describe a movement transition without performing presentation side effects.
 *
 * Keeping this classifier pure lets animation and sound consume the same event
 * while the game engine remains entirely unaware of either system.
 */
export function classifyMove(
  previous: GameSession,
  next: GameSession,
): GameFeedback {
  if (previous === next) return "blocked";
  if (!previous.solved && next.solved) return "solved";
  if (next.pushes === previous.pushes) return "move";
  if (matchedBoxCount(next) > matchedBoxCount(previous)) return "goal";
  if (matchedBoxCount(next) < matchedBoxCount(previous)) return "goal-leave";
  return "push";
}
