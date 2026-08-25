import type { SolutionStep } from "../../../solver/contracts.ts";
import { directionDelta } from "../../../core/position.ts";

export interface SolutionUsageMetrics {
  readonly solutionFloorCoverage: number;
  readonly solutionUnusedFloorRatio: number;
  readonly cellsUsedBySolution: number;
}

const WALL = "O";

export function analyzeSolutionUsage(
  grid: readonly (readonly string[])[],
  steps: readonly SolutionStep[],
  totalFloor: number,
): SolutionUsageMetrics {
  if (totalFloor <= 0) {
    return { solutionFloorCoverage: 0, solutionUnusedFloorRatio: 0, cellsUsedBySolution: 0 };
  }

  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  let robot = { row: 0, column: 0 };
  const boxes: Array<{ row: number; column: number }> = [];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (ch === "R") robot = { row: r, column: c };
      if (ch === "X" || (ch >= "A" && ch <= "Z" && ch !== "O" && ch !== "R" && ch !== "S")) {
        boxes.push({ row: r, column: c });
      }
    }
  }

  const usedCells = new Set<string>();

  usedCells.add(`${robot.row},${robot.column}`);
  for (const b of boxes) usedCells.add(`${b.row},${b.column}`);

  for (const step of steps) {
    const delta = directionDelta(step.direction);
    const nr = robot.row + delta.row;
    const nc = robot.column + delta.column;

    if (step.kind === "push") {
      usedCells.add(`${robot.row},${robot.column}`);

      const bi = boxes.findIndex((b) => b.row === nr && b.column === nc);
      if (bi >= 0) {
        const destR = nr + delta.row;
        const destC = nc + delta.column;
        boxes[bi] = { row: destR, column: destC };
        usedCells.add(`${destR},${destC}`);
      }
    }

    robot = { row: nr, column: nc };
    usedCells.add(`${nr},${nc}`);
  }

  let floorUsed = 0;
  for (const key of usedCells) {
    const [rs, cs] = key.split(",");
    const r = Number(rs);
    const c = Number(cs);
    if (r >= 0 && r < h && c >= 0 && c < w && grid[r][c] !== WALL) {
      floorUsed++;
    }
  }

  const coverage = floorUsed / totalFloor;
  return {
    solutionFloorCoverage: Math.min(1, coverage),
    solutionUnusedFloorRatio: Math.max(0, 1 - coverage),
    cellsUsedBySolution: floorUsed,
  };
}
