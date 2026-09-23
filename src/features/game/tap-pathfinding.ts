import type { Direction, GameSession, Position } from "../../core/model.ts";
import { numericPositionKey, positionKey } from "../../core/index.ts";

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

export interface BoardGrid {
  /** Content-box size of the board in its own, untransformed pixels. */
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly columnGap: number;
  readonly rowGap: number;
  readonly columns: number;
  readonly rows: number;
}

/**
 * Maps a point in the board's content box, in untransformed pixels, to a
 * cell. Each cell owns the gap after it, so gap pixels map to the cell on
 * their left or above.
 */
export function cellFromLocalPoint(
  x: number,
  y: number,
  { innerWidth, innerHeight, columnGap, rowGap, columns, rows }: BoardGrid,
): Position | null {
  if (columns <= 0 || rows <= 0) return null;
  if (!(x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)) return null;
  const pitchX = (innerWidth + columnGap) / columns;
  const pitchY = (innerHeight + rowGap) / rows;
  const column = Math.min(columns - 1, Math.floor(x / pitchX));
  const row = Math.min(rows - 1, Math.floor(y / pitchY));
  return { row, column };
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Maps a click to a board cell. The board may sit inside a scaled layer (pinch
 * zoom), where its bounding rect is scaled but its padding, border and gaps
 * are not, so the click is first converted back to the board's own pixels.
 */
export function cellFromBoardClick(
  event: { clientX: number; clientY: number },
  boardElement: HTMLElement,
  columns: number,
  rows: number,
): Position | null {
  const { offsetWidth, offsetHeight } = boardElement;
  if (offsetWidth <= 0 || offsetHeight <= 0) return null;
  const rect = boardElement.getBoundingClientRect();
  const scaleX = rect.width / offsetWidth;
  const scaleY = rect.height / offsetHeight;
  if (!(scaleX > 0 && scaleY > 0)) return null;

  const style = getComputedStyle(boardElement);
  const padLeft = pixels(style.paddingLeft);
  const padTop = pixels(style.paddingTop);
  const x = (event.clientX - rect.left) / scaleX - boardElement.clientLeft - padLeft;
  const y = (event.clientY - rect.top) / scaleY - boardElement.clientTop - padTop;

  return cellFromLocalPoint(x, y, {
    innerWidth: boardElement.clientWidth - padLeft - pixels(style.paddingRight),
    innerHeight: boardElement.clientHeight - padTop - pixels(style.paddingBottom),
    columnGap: pixels(style.columnGap),
    rowGap: pixels(style.rowGap),
    columns,
    rows,
  });
}
