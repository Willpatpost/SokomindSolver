import type { Direction } from "../../../core/model.ts";
import { DIRECTIONS } from "../../../core/model.ts";
import { directionDelta } from "../../../core/position.ts";
import { isWallChar } from "./tile-semantics.ts";

export interface ReachablePush {
  readonly boxIndex: number;
  readonly direction: Direction;
  readonly support: { readonly row: number; readonly column: number };
  readonly destination: { readonly row: number; readonly column: number };
}

export function floodKeeperReachable(
  grid: readonly (readonly string[])[],
  robot: { readonly row: number; readonly column: number },
  boxPositions: ReadonlySet<string>,
): Set<string> {
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;
  const visited = new Set<string>();
  const startKey = `${robot.row},${robot.column}`;

  if (
    robot.row < 0 || robot.row >= h ||
    robot.column < 0 || robot.column >= w ||
    isWallChar(grid[robot.row][robot.column])
  ) {
    return visited;
  }

  visited.add(startKey);
  const queue: Array<{ row: number; column: number }> = [{ row: robot.row, column: robot.column }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dir of DIRECTIONS) {
      const delta = directionDelta(dir);
      const nr = current.row + delta.row;
      const nc = current.column + delta.column;
      if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
      const key = `${nr},${nc}`;
      if (visited.has(key)) continue;
      if (isWallChar(grid[nr][nc])) continue;
      if (boxPositions.has(key)) continue;
      visited.add(key);
      queue.push({ row: nr, column: nc });
    }
  }

  return visited;
}

export function enumerateReachablePushes(
  grid: readonly (readonly string[])[],
  robot: { readonly row: number; readonly column: number },
  boxes: readonly { readonly row: number; readonly column: number }[],
): readonly ReachablePush[] {
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  const boxSet = new Set<string>();
  for (const b of boxes) boxSet.add(`${b.row},${b.column}`);

  const reachable = floodKeeperReachable(grid, robot, boxSet);
  const result: ReachablePush[] = [];

  for (let bi = 0; bi < boxes.length; bi++) {
    const box = boxes[bi];
    for (const dir of DIRECTIONS) {
      const delta = directionDelta(dir);
      const destR = box.row + delta.row;
      const destC = box.column + delta.column;
      const supportR = box.row - delta.row;
      const supportC = box.column - delta.column;

      if (destR < 0 || destR >= h || destC < 0 || destC >= w) continue;
      if (supportR < 0 || supportR >= h || supportC < 0 || supportC >= w) continue;

      if (isWallChar(grid[destR][destC])) continue;
      if (boxSet.has(`${destR},${destC}`)) continue;

      const supportKey = `${supportR},${supportC}`;
      if (!reachable.has(supportKey)) continue;

      result.push({
        boxIndex: bi,
        direction: dir,
        support: { row: supportR, column: supportC },
        destination: { row: destR, column: destC },
      });
    }
  }

  return result;
}
