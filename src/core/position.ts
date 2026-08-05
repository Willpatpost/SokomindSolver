import type { Box, Direction, Position } from "./model.ts";

const DELTAS: Readonly<Record<Direction, Position>> = Object.freeze({
  up: Object.freeze({ row: -1, column: 0 }),
  down: Object.freeze({ row: 1, column: 0 }),
  left: Object.freeze({ row: 0, column: -1 }),
  right: Object.freeze({ row: 0, column: 1 }),
});

/** @deprecated Use numericPositionKey instead */
export function positionKey(position: Position): string {
  return `${position.row},${position.column}`;
}

export function numericPositionKey(row: number, column: number, width: number): number {
  return row * width + column;
}

export function samePosition(left: Position, right: Position): boolean {
  return left.row === right.row && left.column === right.column;
}

export function directionDelta(direction: Direction): Position {
  const delta = DELTAS[direction];
  if (!delta) {
    throw new RangeError(`Unknown direction: ${String(direction)}`);
  }
  return delta;
}

export function translate(position: Position, delta: Position): Position {
  return {
    row: position.row + delta.row,
    column: position.column + delta.column,
  };
}

export function freezePosition(position: Position): Position {
  return Object.freeze({ row: position.row, column: position.column });
}

export function freezeBox(box: Box): Box {
  return Object.freeze({
    id: box.id,
    label: box.label,
    position: freezePosition(box.position),
  });
}
