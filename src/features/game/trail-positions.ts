import type { GameHistoryEntry, Position } from "../../core/model.ts";
import { positionKey } from "../../core/index.ts";

export interface TrailEntry {
  readonly position: Position;
  readonly age: number;
}

const TRAIL_LENGTH = 6;

export function extractTrailPositions(
  head: GameHistoryEntry | null,
  currentRobot: Position,
  maxLength: number = TRAIL_LENGTH,
): readonly TrailEntry[] {
  const positions: TrailEntry[] = [];
  let entry = head;
  let previousKey = positionKey(currentRobot);
  let age = 0;
  while (entry && age < maxLength) {
    const key = positionKey(entry.snapshot.robot);
    if (key !== previousKey) {
      positions.push({ position: entry.snapshot.robot, age });
      previousKey = key;
      age++;
    }
    entry = entry.previous;
  }
  return positions;
}
