import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";

export interface GoalRoomOrder {
  readonly gate: number;
  readonly roomCells: ReadonlySet<number>;
  readonly goalsByDepth: readonly number[];
  readonly depthByGoal: ReadonlyMap<number, number>;
}

export interface GoalMacroAnalysis {
  readonly roomOrders: readonly GoalRoomOrder[];
  readonly goalToRoom: ReadonlyMap<number, number>;
}

export function analyzeGoalMacros(
  board: CompiledSearchBoard,
): GoalMacroAnalysis {
  const roomOrders: GoalRoomOrder[] = [];
  const goalToRoom = new Map<number, number>();

  for (const room of board.topology.rooms) {
    if (room.goals.length < 2) continue;

    const depthByGoal = new Map<number, number>();
    const visited = new Uint8Array(board.cellCount);
    const queue: number[] = [];

    visited[room.gate] = 1;
    for (let d = 0; d < 4; d++) {
      const neighbor = board.neighbors[room.gate][d];
      if (neighbor < 0) continue;
      if (!room.cells.has(neighbor)) continue;
      if (visited[neighbor]) continue;
      visited[neighbor] = 1;
      queue.push(neighbor);
    }

    let depth = 0;
    let start = 0;
    while (start < queue.length) {
      const end = queue.length;
      for (let i = start; i < end; i++) {
        const cell = queue[i];
        if (room.goals.includes(cell)) {
          depthByGoal.set(cell, depth);
        }
        const neighbors = board.neighbors[cell];
        for (let d = 0; d < 4; d++) {
          const next = neighbors[d];
          if (next < 0) continue;
          if (!room.cells.has(next)) continue;
          if (visited[next]) continue;
          visited[next] = 1;
          queue.push(next);
        }
      }
      start = end;
      depth++;
    }

    if (depthByGoal.size < 2) continue;

    const goalsByDepth = [...depthByGoal.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cell]) => cell);

    const roomIndex = roomOrders.length;
    roomOrders.push({
      gate: room.gate,
      roomCells: room.cells,
      goalsByDepth,
      depthByGoal,
    });

    for (const goalCell of goalsByDepth) {
      goalToRoom.set(goalCell, roomIndex);
    }
  }

  return { roomOrders, goalToRoom };
}

function isStaticallyImmovable(
  board: CompiledSearchBoard,
  cell: number,
): boolean {
  const neighbors = board.neighbors[cell];
  const up = neighbors[0];
  const down = neighbors[1];
  const left = neighbors[2];
  const right = neighbors[3];
  const verticalOpen = up >= 0 && down >= 0;
  const horizontalOpen = left >= 0 && right >= 0;
  return !verticalOpen && !horizontalOpen;
}

export function isGoalMacroViolation(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  movedCell: number,
  analysis: GoalMacroAnalysis,
): boolean {
  const roomIndex = analysis.goalToRoom.get(movedCell);
  if (roomIndex === undefined) return false;

  const movedLabel = board.goalLabelByCell[movedCell];
  if (movedLabel === null) return false;

  const boxAtMoved = boxes.find((b) => b.cell === movedCell);
  if (!boxAtMoved || boxAtMoved.label !== movedLabel) return false;

  if (!isStaticallyImmovable(board, movedCell)) return false;

  const roomOrder = analysis.roomOrders[roomIndex];
  const movedDepth = roomOrder.depthByGoal.get(movedCell);
  if (movedDepth === undefined) return false;

  const occupiedGoals = new Set<number>();
  for (const box of boxes) {
    if (board.goalLabelByCell[box.cell] === box.label) {
      occupiedGoals.add(box.cell);
    }
  }

  for (const [goalCell, goalDepth] of roomOrder.depthByGoal) {
    if (goalDepth > movedDepth && !occupiedGoals.has(goalCell)) {
      return true;
    }
  }

  return false;
}
