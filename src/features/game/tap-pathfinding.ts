import type { Direction, GameSession, Position } from "@/src/core/model";
import { numericPositionKey, positionKey } from "@/src/core/position";

const DIRECTIONS: readonly { dir: Direction; dr: number; dc: number }[] = [
  { dir: "up", dr: -1, dc: 0 },
  { dir: "down", dr: 1, dc: 0 },
  { dir: "left", dr: 0, dc: -1 },
  { dir: "right", dr: 0, dc: 1 },
];

export function findWalkPath(
  session: GameSession,
  target: Position,
): readonly Direction[] | null {
  const { board, snapshot } = session;
  const { width, height } = board;

  const wallSet = new Set(board.walls.map(positionKey));
  const boxSet = new Set(snapshot.boxes.map((b) => positionKey(b.position)));

  const startKey = numericPositionKey(snapshot.robot.row, snapshot.robot.column, width);
  const targetKey = numericPositionKey(target.row, target.column, width);

  if (startKey === targetKey) return [];
  if (wallSet.has(positionKey(target)) || boxSet.has(positionKey(target))) return null;

  const cameFrom = new Map<number, { parent: number; direction: Direction }>();
  const queue: number[] = [startKey];
  cameFrom.set(startKey, { parent: -1, direction: "up" });

  while (queue.length > 0) {
    const current = queue.shift()!;
    const row = Math.floor(current / width);
    const col = current % width;

    for (const { dir, dr, dc } of DIRECTIONS) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;

      const nk = numericPositionKey(nr, nc, width);
      if (cameFrom.has(nk)) continue;

      const pk = positionKey({ row: nr, column: nc });
      if (wallSet.has(pk) || boxSet.has(pk)) continue;

      cameFrom.set(nk, { parent: current, direction: dir });

      if (nk === targetKey) {
        const path: Direction[] = [];
        let step = nk;
        while (step !== startKey) {
          const entry = cameFrom.get(step)!;
          path.push(entry.direction);
          step = entry.parent;
        }
        path.reverse();
        return path;
      }

      queue.push(nk);
    }
  }

  return null;
}

export function cellFromBoardClick(
  event: { clientX: number; clientY: number },
  boardElement: HTMLElement,
  columns: number,
  rows: number,
): Position | null {
  const rect = boardElement.getBoundingClientRect();
  const style = getComputedStyle(boardElement);
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padTop = parseFloat(style.paddingTop) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  const padBottom = parseFloat(style.paddingBottom) || 0;

  const innerWidth = rect.width - padLeft - padRight;
  const innerHeight = rect.height - padTop - padBottom;

  const x = event.clientX - rect.left - padLeft;
  const y = event.clientY - rect.top - padTop;

  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;

  const column = Math.floor((x / innerWidth) * columns);
  const row = Math.floor((y / innerHeight) * rows);

  if (column < 0 || column >= columns || row < 0 || row >= rows) return null;

  return { row, column };
}
