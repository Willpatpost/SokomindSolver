import type { Position } from "@/src/core/model";

export function positionLabel(position: Position): string {
  return `row ${position.row + 1}, column ${position.column + 1}`;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export interface MoveAnnouncementState {
  readonly robot: Position;
  readonly matchedBoxes: number;
  readonly totalBoxes: number;
  readonly moves: number;
  readonly pushes: number;
  readonly solved: boolean;
}

/** The board state read out after a move, kept short for repeated moves. */
export function moveAnnouncement({
  robot,
  matchedBoxes,
  totalBoxes,
  moves,
  pushes,
  solved,
}: MoveAnnouncementState): string {
  const text = [
    `Keeper at ${positionLabel(robot)}.`,
    `${matchedBoxes} of ${countLabel(totalBoxes, "box", "boxes")} on matching goals.`,
    `${countLabel(moves, "move", "moves")}, ${countLabel(pushes, "push", "pushes")}.`,
  ].join(" ");
  return solved ? `${text} Puzzle solved.` : text;
}
