import type { GridPosition, SolvedTemplate } from "./generator-types.ts";

const WALL = "O";
const FLOOR = " ";

/**
 * Mulberry32 PRNG seeded with a 32-bit integer.
 * Returns a closure that produces values in [0, 1) on each call.
 */
export function createRng(seed: number): () => number {
  return function (): number {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * BFS flood fill on 4-connected floor cells (cells whose value is not WALL).
 * Returns a set of "row,column" string keys for all reachable floor cells.
 */
export function floodFill(
  grid: readonly (readonly string[])[],
  start: GridPosition,
): Set<string> {
  const visited = new Set<string>();
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;

  const startKey = `${start.row},${start.column}`;
  if (
    start.row < 0 ||
    start.row >= height ||
    start.column < 0 ||
    start.column >= width ||
    grid[start.row][start.column] === WALL
  ) {
    return visited;
  }

  const queue: GridPosition[] = [start];
  visited.add(startKey);

  const directions: readonly GridPosition[] = [
    { row: -1, column: 0 },
    { row: 1, column: 0 },
    { row: 0, column: -1 },
    { row: 0, column: 1 },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dir of directions) {
      const nr = current.row + dir.row;
      const nc = current.column + dir.column;
      const key = `${nr},${nc}`;
      if (
        nr >= 0 &&
        nr < height &&
        nc >= 0 &&
        nc < width &&
        !visited.has(key) &&
        grid[nr][nc] !== WALL
      ) {
        visited.add(key);
        queue.push({ row: nr, column: nc });
      }
    }
  }

  return visited;
}

/**
 * Generates a random floor layout using cellular automata with connectivity
 * enforcement via flood fill. Retries up to 20 times until the largest
 * connected floor component meets the minimum cell count.
 */
export function generateFloorLayout(
  width: number,
  height: number,
  minFloorCells: number,
  rng: () => number,
): string[][] {
  const MAX_RETRIES = 20;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Step 1: Create grid filled with walls
    const grid: string[][] = [];
    for (let r = 0; r < height; r++) {
      grid.push(new Array<string>(width).fill(WALL));
    }

    // Steps 2-3: Fill interior with random floor/wall (borders stay as walls)
    for (let r = 1; r < height - 1; r++) {
      for (let c = 1; c < width - 1; c++) {
        grid[r][c] = rng() < 0.58 ? FLOOR : WALL;
      }
    }

    // Step 4: Cellular automata smoothing (3 iterations, 8-connected neighborhood)
    for (let iter = 0; iter < 3; iter++) {
      const snapshot: string[][] = grid.map((row) => [...row]);

      for (let r = 1; r < height - 1; r++) {
        for (let c = 1; c < width - 1; c++) {
          let floorNeighbors = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              if (snapshot[r + dr][c + dc] !== WALL) {
                floorNeighbors++;
              }
            }
          }

          if (snapshot[r][c] !== WALL && floorNeighbors < 3) {
            grid[r][c] = WALL;
          } else if (snapshot[r][c] === WALL && floorNeighbors > 4) {
            grid[r][c] = FLOOR;
          }
        }
      }
    }

    // Step 5: Find all connected components of floor cells
    const visited = new Set<string>();
    let largestComponent = new Set<string>();

    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const key = `${r},${c}`;
        if (grid[r][c] !== WALL && !visited.has(key)) {
          const component = floodFill(grid, { row: r, column: c });
          for (const k of component) {
            visited.add(k);
          }
          if (component.size > largestComponent.size) {
            largestComponent = component;
          }
        }
      }
    }

    // Step 6: Keep only the largest component; set all other floor to walls
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        if (grid[r][c] !== WALL && !largestComponent.has(`${r},${c}`)) {
          grid[r][c] = WALL;
        }
      }
    }

    // Step 7: Check if the largest component is big enough
    if (largestComponent.size >= minFloorCells) {
      return grid;
    }
  }

  // Step 9: All retries exhausted
  throw new Error(
    `Failed to generate a floor layout with at least ${minFloorCells} floor cells after ${MAX_RETRIES} attempts`,
  );
}

/**
 * Places goal positions and a robot on the floor layout.
 * Avoids dead corners and dead-end alcoves when possible.
 */
export function placeGoalsAndRobot(
  grid: readonly (readonly string[])[],
  boxCount: number,
  rng: () => number,
): { goalPositions: GridPosition[]; robotPosition: GridPosition } {
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;

  // Step 1: Collect all floor cells
  const allFloor: GridPosition[] = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (grid[r][c] === FLOOR) {
        allFloor.push({ row: r, column: c });
      }
    }
  }

  // Step 2: Filter out dead corner cells
  // A dead corner has BOTH horizontal neighbors as walls AND BOTH vertical neighbors as walls
  const nonCorner = allFloor.filter((pos) => {
    const up = pos.row > 0 ? grid[pos.row - 1][pos.column] : WALL;
    const down = pos.row < height - 1 ? grid[pos.row + 1][pos.column] : WALL;
    const left = pos.column > 0 ? grid[pos.row][pos.column - 1] : WALL;
    const right =
      pos.column < width - 1 ? grid[pos.row][pos.column + 1] : WALL;

    const bothVerticalWalls = up === WALL && down === WALL;
    const bothHorizontalWalls = left === WALL && right === WALL;
    return !(bothVerticalWalls && bothHorizontalWalls);
  });

  // Step 3: Filter out dead-end alcoves (cells with <= 1 floor neighbor in 4-connected)
  const candidates = nonCorner.filter((pos) => {
    let floorNeighborCount = 0;
    const dirs: readonly GridPosition[] = [
      { row: -1, column: 0 },
      { row: 1, column: 0 },
      { row: 0, column: -1 },
      { row: 0, column: 1 },
    ];
    for (const d of dirs) {
      const nr = pos.row + d.row;
      const nc = pos.column + d.column;
      if (nr >= 0 && nr < height && nc >= 0 && nc < width && grid[nr][nc] === FLOOR) {
        floorNeighborCount++;
      }
    }
    return floorNeighborCount > 1;
  });

  // Step 4: Fall back to all floor cells if not enough candidates
  const pool = candidates.length >= boxCount + 1 ? [...candidates] : [...allFloor];

  // Step 5: Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  // Step 6: Select goal positions
  const goalPositions = pool.slice(0, boxCount);

  // Step 7: Find robot position reachable from all goals
  const remaining = pool.slice(boxCount);
  let robotPosition: GridPosition | undefined;

  for (const candidate of remaining) {
    const reachable = floodFill(grid, candidate);
    const allGoalsReachable = goalPositions.every((g) =>
      reachable.has(`${g.row},${g.column}`),
    );
    if (allGoalsReachable) {
      robotPosition = candidate;
      break;
    }
  }

  // Step 8: Fallback to any remaining floor cell
  if (!robotPosition) {
    robotPosition = remaining.length > 0 ? remaining[0] : allFloor[0];
  }

  return { goalPositions, robotPosition };
}

/**
 * Top-level entry point: generates a complete board template with walls,
 * floor, goal positions, and robot placement.
 */
export function generateBoardTemplate(
  width: number,
  height: number,
  boxCount: number,
  rng: () => number,
): SolvedTemplate {
  const minFloorCells = boxCount * 3 + 5;
  const grid = generateFloorLayout(width, height, minFloorCells, rng);
  const { goalPositions, robotPosition } = placeGoalsAndRobot(
    grid,
    boxCount,
    rng,
  );

  return { width, height, grid, goalPositions, robotPosition };
}
