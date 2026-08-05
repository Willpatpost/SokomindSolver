import type {
  Direction,
  ParsedBoard,
  Position,
} from "../../core/model.ts";

/**
 * Search direction order is part of the compiled-board contract.
 *
 * Keeping one deterministic order makes successor generation, tie-breaking,
 * tests, and replay output stable across every solver.
 */
export const SEARCH_DIRECTIONS = Object.freeze([
  Object.freeze({
    direction: "up",
    rowDelta: -1,
    columnDelta: 0,
    oppositeIndex: 1,
  }),
  Object.freeze({
    direction: "down",
    rowDelta: 1,
    columnDelta: 0,
    oppositeIndex: 0,
  }),
  Object.freeze({
    direction: "left",
    rowDelta: 0,
    columnDelta: -1,
    oppositeIndex: 3,
  }),
  Object.freeze({
    direction: "right",
    rowDelta: 0,
    columnDelta: 1,
    oppositeIndex: 2,
  }),
] as const satisfies readonly Readonly<{
  direction: Direction;
  rowDelta: number;
  columnDelta: number;
  oppositeIndex: number;
}>[]);

export const SEARCH_DIRECTION_COUNT = SEARCH_DIRECTIONS.length;

/**
 * Immutable geometry prepared for search.
 *
 * Typed arrays are exposed for hot-loop reads. Callers must treat them as
 * immutable; JavaScript cannot freeze a non-empty TypedArray.
 */
export interface CompiledSearchBoard {
  readonly source: ParsedBoard;
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  /** Dense cell id -> position, in row-major order. */
  readonly positions: readonly Position[];
  /** Dense cell id -> [up, down, left, right] cell ids; -1 means wall/outside. */
  readonly neighbors: readonly Int32Array[];
  /** Rectangular row-major offset -> dense cell id; -1 means wall. */
  readonly cellByOffset: Int32Array;
  readonly cellAt: (row: number, column: number) => number;
  readonly goalCellsByLabel: ReadonlyMap<string, readonly number[]>;
  readonly goalLabelByCell: readonly (string | null)[];
  /** Goal cell id -> relaxed, wall-aware reverse-push distances. */
  readonly reversePushDistancesByGoal: ReadonlyMap<number, Int32Array>;
}

function positionOrder(left: Position, right: Position): number {
  return left.row - right.row || left.column - right.column;
}

function assertBoardPosition(
  board: ParsedBoard,
  position: Position,
  description: string,
): void {
  if (
    !Number.isInteger(position.row) ||
    !Number.isInteger(position.column) ||
    position.row < 0 ||
    position.column < 0 ||
    position.row >= board.height ||
    position.column >= board.width
  ) {
    throw new RangeError(
      `${description} (${position.row}, ${position.column}) is outside the board.`,
    );
  }
}

function buildReversePushDistances(
  goalCell: number,
  positions: readonly Position[],
  cellAt: (row: number, column: number) => number,
): Int32Array {
  const distances = new Int32Array(positions.length);
  distances.fill(-1);
  distances[goalCell] = 0;

  const queue = new Int32Array(positions.length);
  queue[0] = goalCell;
  let head = 0;
  let tail = 1;

  while (head < tail) {
    const currentCell = queue[head];
    head += 1;
    const current = positions[currentCell];
    const nextDistance = distances[currentCell] + 1;

    for (const { rowDelta, columnDelta } of SEARCH_DIRECTIONS) {
      // In reverse, `previous` is where the box stood before it was pushed
      // into `current`. The player support cell must also be floor.
      const previousCell = cellAt(
        current.row - rowDelta,
        current.column - columnDelta,
      );
      const supportCell = cellAt(
        current.row - 2 * rowDelta,
        current.column - 2 * columnDelta,
      );
      if (
        previousCell < 0 ||
        supportCell < 0 ||
        distances[previousCell] >= 0
      ) {
        continue;
      }

      distances[previousCell] = nextDistance;
      queue[tail] = previousCell;
      tail += 1;
    }
  }

  return distances;
}

/**
 * Compile static puzzle geometry once per solver job.
 *
 * Reverse-push tables remove other boxes and allow the player to occupy any
 * geometrically valid support square. They therefore underestimate—or equal—
 * the pushes required in the real puzzle and are safe inputs to A*.
 */
export function compileSearchBoard(board: ParsedBoard): CompiledSearchBoard {
  if (
    !Number.isInteger(board.width) ||
    !Number.isInteger(board.height) ||
    board.width <= 0 ||
    board.height <= 0
  ) {
    throw new RangeError("Board dimensions must be positive integers.");
  }

  const positions = [...board.floor]
    .map((position) => {
      assertBoardPosition(board, position, "Floor cell");
      return Object.freeze({
        row: position.row,
        column: position.column,
      });
    })
    .sort(positionOrder);

  const cellByOffset = new Int32Array(board.width * board.height);
  cellByOffset.fill(-1);
  positions.forEach((position, cell) => {
    const offset = position.row * board.width + position.column;
    if (cellByOffset[offset] >= 0) {
      throw new Error(
        `Duplicate floor cell at (${position.row}, ${position.column}).`,
      );
    }
    cellByOffset[offset] = cell;
  });

  const cellAt = (row: number, column: number): number => {
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      row < 0 ||
      column < 0 ||
      row >= board.height ||
      column >= board.width
    ) {
      return -1;
    }
    return cellByOffset[row * board.width + column];
  };

  const neighbors = positions.map((position) => {
    const adjacent = new Int32Array(SEARCH_DIRECTION_COUNT);
    SEARCH_DIRECTIONS.forEach(({ rowDelta, columnDelta }, directionIndex) => {
      adjacent[directionIndex] = cellAt(
        position.row + rowDelta,
        position.column + columnDelta,
      );
    });
    return adjacent;
  });

  const goalLabelByCell = Array<string | null>(positions.length).fill(null);
  const mutableGoalCellsByLabel = new Map<string, number[]>();
  for (const goal of board.goals) {
    assertBoardPosition(board, goal.position, "Goal");
    const goalCell = cellAt(goal.position.row, goal.position.column);
    if (goalCell < 0) {
      throw new Error(
        `Goal (${goal.position.row}, ${goal.position.column}) is not on floor.`,
      );
    }
    if (goalLabelByCell[goalCell] !== null) {
      throw new Error(
        `Multiple goals occupy (${goal.position.row}, ${goal.position.column}).`,
      );
    }
    goalLabelByCell[goalCell] = goal.label;
    const cells = mutableGoalCellsByLabel.get(goal.label) ?? [];
    cells.push(goalCell);
    mutableGoalCellsByLabel.set(goal.label, cells);
  }

  const goalCellsByLabel = new Map<string, readonly number[]>(
    [...mutableGoalCellsByLabel]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, cells]) => [
        label,
        Object.freeze([...cells].sort((left, right) => left - right)),
      ]),
  );
  const reversePushDistancesByGoal = new Map<number, Int32Array>();
  for (const goalCells of goalCellsByLabel.values()) {
    for (const goalCell of goalCells) {
      reversePushDistancesByGoal.set(
        goalCell,
        buildReversePushDistances(goalCell, positions, cellAt),
      );
    }
  }

  return Object.freeze({
    source: board,
    width: board.width,
    height: board.height,
    cellCount: positions.length,
    positions: Object.freeze(positions),
    neighbors: Object.freeze(neighbors),
    cellByOffset,
    cellAt,
    goalCellsByLabel,
    goalLabelByCell: Object.freeze(goalLabelByCell),
    reversePushDistancesByGoal,
  });
}
