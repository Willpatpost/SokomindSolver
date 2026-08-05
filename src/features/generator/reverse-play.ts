import type {
  GridPosition,
  SolvedTemplate,
  ScrambledState,
} from "./generator-types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReversePull {
  readonly boxIndex: number;
  readonly newBoxPosition: GridPosition;
  readonly newRobotPosition: GridPosition;
}

// ---------------------------------------------------------------------------
// Direction deltas (up, down, left, right)
// ---------------------------------------------------------------------------

const DIRECTIONS: readonly GridPosition[] = [
  { row: -1, column: 0 },
  { row: 1, column: 0 },
  { row: 0, column: -1 },
  { row: 0, column: 1 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function posKey(row: number, column: number): string {
  return `${row},${column}`;
}

function isInBounds(
  grid: readonly (readonly string[])[],
  row: number,
  column: number,
): boolean {
  return row >= 0 && row < grid.length && column >= 0 && column < grid[0].length;
}

function isFloor(
  grid: readonly (readonly string[])[],
  row: number,
  column: number,
): boolean {
  return grid[row][column] !== "O";
}

// ---------------------------------------------------------------------------
// canRobotReach
// ---------------------------------------------------------------------------

/**
 * BFS from `robotPos` through floor cells, treating box positions as
 * impassable walls. Returns true if `target` is reachable.
 */
export function canRobotReach(
  grid: readonly (readonly string[])[],
  robotPos: GridPosition,
  target: GridPosition,
  boxPositions: readonly GridPosition[],
): boolean {
  if (robotPos.row === target.row && robotPos.column === target.column) {
    return true;
  }

  const boxSet = new Set<string>(
    boxPositions.map((b) => posKey(b.row, b.column)),
  );

  const visited = new Set<string>();
  const startKey = posKey(robotPos.row, robotPos.column);
  visited.add(startKey);

  const queue: GridPosition[] = [robotPos];

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const d of DIRECTIONS) {
      const nr = current.row + d.row;
      const nc = current.column + d.column;
      const key = posKey(nr, nc);

      if (visited.has(key)) continue;
      if (!isInBounds(grid, nr, nc)) continue;
      if (!isFloor(grid, nr, nc)) continue;
      if (boxSet.has(key)) continue;

      if (nr === target.row && nc === target.column) {
        return true;
      }

      visited.add(key);
      queue.push({ row: nr, column: nc });
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// enumerateReversePulls
// ---------------------------------------------------------------------------

/**
 * For each box and each of the 4 directions, check whether a reverse pull
 * is valid (robot can reach the pull position, and both pull position and
 * retreat position are passable and unoccupied).
 */
export function enumerateReversePulls(
  grid: readonly (readonly string[])[],
  boxPositions: readonly GridPosition[],
  robotPosition: GridPosition,
): ReversePull[] {
  const pulls: ReversePull[] = [];

  const boxSet = new Set<string>(
    boxPositions.map((b) => posKey(b.row, b.column)),
  );

  for (let i = 0; i < boxPositions.length; i++) {
    const box = boxPositions[i];

    for (const d of DIRECTIONS) {
      // P = where the robot must stand to pull (adjacent to box in direction d)
      const pRow = box.row + d.row;
      const pCol = box.column + d.column;

      // P' = where the robot retreats to (one step further)
      const ppRow = pRow + d.row;
      const ppCol = pCol + d.column;

      // Validate P
      if (!isInBounds(grid, pRow, pCol)) continue;
      if (!isFloor(grid, pRow, pCol)) continue;
      if (boxSet.has(posKey(pRow, pCol))) continue;

      // Validate P'
      if (!isInBounds(grid, ppRow, ppCol)) continue;
      if (!isFloor(grid, ppRow, ppCol)) continue;
      if (boxSet.has(posKey(ppRow, ppCol))) continue;

      // Robot must be able to reach P from its current position
      if (!canRobotReach(grid, robotPosition, { row: pRow, column: pCol }, boxPositions)) {
        continue;
      }

      pulls.push({
        boxIndex: i,
        newBoxPosition: { row: pRow, column: pCol },
        newRobotPosition: { row: ppRow, column: ppCol },
      });
    }
  }

  return pulls;
}

// ---------------------------------------------------------------------------
// scrambleByReversePull
// ---------------------------------------------------------------------------

/**
 * Starting from the solved state (boxes on goals), apply `pullCount`
 * random reverse pulls to scramble the puzzle. Uses the provided `rng`
 * function (returns a number in [0, 1)) for deterministic randomness.
 */
export function scrambleByReversePull(
  template: SolvedTemplate,
  pullCount: number,
  rng: () => number,
): ScrambledState {
  // Mutable copy of box positions
  const boxPositions: GridPosition[] = template.goalPositions.map((g) => ({
    row: g.row,
    column: g.column,
  }));

  let robotPosition: GridPosition = {
    row: template.robotPosition.row,
    column: template.robotPosition.column,
  };

  let successfulPulls = 0;
  let staleCount = 0;
  const maxIterations = pullCount * 3;

  for (let iter = 0; iter < maxIterations; iter++) {
    if (successfulPulls >= pullCount) break;
    if (staleCount > pullCount * 2) break;

    const pulls = enumerateReversePulls(template.grid, boxPositions, robotPosition);

    if (pulls.length === 0) {
      staleCount++;
      continue;
    }

    const pull = pulls[Math.floor(rng() * pulls.length)];

    boxPositions[pull.boxIndex] = pull.newBoxPosition;
    robotPosition = pull.newRobotPosition;

    successfulPulls++;
    staleCount = 0;
  }

  return {
    template,
    boxPositions,
    robotPosition,
    reversePulls: successfulPulls,
  };
}
