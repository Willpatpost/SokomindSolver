/**
 * Exhaustive move-cost oracle for tiny Sokoban boards.
 *
 * Enumerates all legal game states using step-level BFS where every
 * individual walk step and every push each cost exactly 1 move. Uses
 * the real core game engine's collision semantics (box positions
 * blocking movement, walls blocking everything).
 *
 * This oracle is intentionally independent of the solver's heuristics,
 * deadlock detectors, and compiled board. It provides ground truth for
 * admissibility and optimality tests.
 */

import type { CompiledSearchBoard } from "../../src/solver/search/compiled-board.ts";
import type { DenseBox } from "../../src/solver/search/model.ts";

export interface OracleState {
  readonly robot: number;
  readonly boxes: readonly DenseBox[];
}

export interface OracleResult {
  readonly exactMoves: number | null;
  readonly exactPushes: number | null;
  readonly statesExplored: number;
}

function oracleStateKey(robot: number, boxes: readonly DenseBox[]): string {
  const boxParts = boxes
    .map(({ label, cell }) => `${label}@${cell}`)
    .sort()
    .join(",");
  return `${robot}|${boxParts}`;
}

function isSolved(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
): boolean {
  return boxes.every(
    (box) => board.goalLabelByCell[box.cell] === box.label,
  );
}

/**
 * Find the exact minimum number of moves (walk steps + pushes) to solve
 * the puzzle from the given state. Returns null if unsolvable.
 *
 * Uses Dijkstra/BFS with cost 1 per action (walk or push). This is a
 * step-level search, not a push-macro search.
 */
export function exactRemainingMoves(
  board: CompiledSearchBoard,
  robot: number,
  initialBoxes: readonly DenseBox[],
): OracleResult {
  interface QueueEntry {
    readonly robot: number;
    readonly boxes: readonly DenseBox[];
    readonly moves: number;
    readonly pushes: number;
  }

  const initial: QueueEntry = {
    robot,
    boxes: initialBoxes,
    moves: 0,
    pushes: 0,
  };
  const initialKey = oracleStateKey(robot, initialBoxes);

  if (isSolved(board, initialBoxes)) {
    return { exactMoves: 0, exactPushes: 0, statesExplored: 1 };
  }

  const bestMoves = new Map<string, number>([[initialKey, 0]]);
  const queue: QueueEntry[] = [initial];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    const currentKey = oracleStateKey(current.robot, current.boxes);

    if ((bestMoves.get(currentKey) ?? Infinity) < current.moves) continue;

    const boxIndexByCell = new Map<number, number>();
    current.boxes.forEach(({ cell }, index) => {
      boxIndexByCell.set(cell, index);
    });

    const neighbors = board.neighbors[current.robot];
    if (!neighbors) continue;

    for (let d = 0; d < 4; d++) {
      const dest = neighbors[d];
      if (dest === undefined || dest < 0) continue;

      const pushedBoxIndex = boxIndexByCell.get(dest);

      if (pushedBoxIndex !== undefined) {
        const boxNeighbors = board.neighbors[dest];
        if (!boxNeighbors) continue;
        const boxDest = boxNeighbors[d];
        if (boxDest === undefined || boxDest < 0) continue;
        if (boxIndexByCell.has(boxDest)) continue;

        const newBoxes = current.boxes.map((box, index) =>
          index === pushedBoxIndex
            ? { ...box, cell: boxDest }
            : box,
        );
        const newMoves = current.moves + 1;
        const newKey = oracleStateKey(dest, newBoxes);

        if (newMoves < (bestMoves.get(newKey) ?? Infinity)) {
          bestMoves.set(newKey, newMoves);

          if (isSolved(board, newBoxes)) {
            return {
              exactMoves: newMoves,
              exactPushes: current.pushes + 1,
              statesExplored: bestMoves.size,
            };
          }

          queue.push({
            robot: dest,
            boxes: newBoxes,
            moves: newMoves,
            pushes: current.pushes + 1,
          });
        }
      } else {
        const newMoves = current.moves + 1;
        const newKey = oracleStateKey(dest, current.boxes);

        if (newMoves < (bestMoves.get(newKey) ?? Infinity)) {
          bestMoves.set(newKey, newMoves);

          queue.push({
            robot: dest,
            boxes: current.boxes,
            moves: newMoves,
            pushes: current.pushes,
          });
        }
      }
    }
  }

  return {
    exactMoves: null,
    exactPushes: null,
    statesExplored: bestMoves.size,
  };
}

/**
 * Compute exact remaining moves for every reachable state from the
 * initial configuration. Used for exhaustive admissibility tests.
 */
export function allReachableStates(
  board: CompiledSearchBoard,
  robot: number,
  initialBoxes: readonly DenseBox[],
): Map<string, { robot: number; boxes: readonly DenseBox[]; exactMoves: number | null }> {
  interface QueueEntry {
    readonly robot: number;
    readonly boxes: readonly DenseBox[];
  }

  const initial: QueueEntry = { robot, boxes: initialBoxes };
  const initialKey = oracleStateKey(robot, initialBoxes);
  const reachable = new Map<string, QueueEntry>();
  const visited = new Set<string>([initialKey]);
  reachable.set(initialKey, initial);
  const queue: QueueEntry[] = [initial];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    const boxIndexByCell = new Map<number, number>();
    current.boxes.forEach(({ cell }, index) => {
      boxIndexByCell.set(cell, index);
    });

    const neighbors = board.neighbors[current.robot];
    if (!neighbors) continue;

    for (let d = 0; d < 4; d++) {
      const dest = neighbors[d];
      if (dest === undefined || dest < 0) continue;

      const pushedBoxIndex = boxIndexByCell.get(dest);

      if (pushedBoxIndex !== undefined) {
        const boxNeighbors = board.neighbors[dest];
        if (!boxNeighbors) continue;
        const boxDest = boxNeighbors[d];
        if (boxDest === undefined || boxDest < 0) continue;
        if (boxIndexByCell.has(boxDest)) continue;

        const newBoxes = current.boxes.map((box, index) =>
          index === pushedBoxIndex ? { ...box, cell: boxDest } : box,
        );
        const newKey = oracleStateKey(dest, newBoxes);
        if (!visited.has(newKey)) {
          visited.add(newKey);
          const entry = { robot: dest, boxes: newBoxes };
          reachable.set(newKey, entry);
          queue.push(entry);
        }
      } else {
        const newKey = oracleStateKey(dest, current.boxes);
        if (!visited.has(newKey)) {
          visited.add(newKey);
          const entry = { robot: dest, boxes: current.boxes };
          reachable.set(newKey, entry);
          queue.push(entry);
        }
      }
    }
  }

  const results = new Map<string, {
    robot: number;
    boxes: readonly DenseBox[];
    exactMoves: number | null;
  }>();

  for (const [key, state] of reachable) {
    const result = exactRemainingMoves(board, state.robot, state.boxes);
    results.set(key, {
      robot: state.robot,
      boxes: state.boxes,
      exactMoves: result.exactMoves,
    });
  }

  return results;
}
