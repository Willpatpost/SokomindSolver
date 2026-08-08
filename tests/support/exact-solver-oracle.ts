/**
 * Exhaustive move-cost oracle for tiny Sokoban boards.
 *
 * Enumerates all legal game states using step-level BFS where every
 * individual walk step and every push each cost exactly 1 move. Uses
 * the real core game engine's `stepSnapshot()` transition function
 * rather than reimplementing physics, satisfying spec section 21.1:
 * "Use the real stepSnapshot() transition."
 *
 * This oracle is intentionally independent of the solver's heuristics,
 * deadlock detectors, and compiled board's neighbor tables. It provides
 * ground truth for admissibility and optimality tests.
 */

import {
  DIRECTIONS,
  stepSnapshot,
  type Box,
  type GameSnapshot,
  type Position,
} from "../../src/core/index.ts";
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

// ---------------------------------------------------------------------------
// Bridging helpers: convert between dense cell indices and core types
// ---------------------------------------------------------------------------

/** Convert dense cell index to core Position using the compiled board's position table. */
function cellToPosition(board: CompiledSearchBoard, cell: number): Position {
  return board.positions[cell];
}

/** Convert DenseBox[] to core Box[] for use with stepSnapshot. */
function denseBoxesToCoreBoxes(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
): readonly Box[] {
  return boxes.map((box) => ({
    id: box.id,
    label: box.label,
    position: cellToPosition(board, box.cell),
  }));
}

/** Convert core Position to dense cell index. Returns -1 for walls/outside. */
function positionToCell(board: CompiledSearchBoard, pos: Position): number {
  return board.cellAt(pos.row, pos.column);
}

/** Convert a core GameSnapshot's boxes back to DenseBox[]. */
function snapshotBoxesToDense(
  board: CompiledSearchBoard,
  coreBoxes: readonly Box[],
): readonly DenseBox[] {
  return coreBoxes.map((box) => ({
    id: box.id,
    label: box.label,
    cell: positionToCell(board, box.position),
  }));
}

/**
 * Build a GameSnapshot from dense oracle state for use with stepSnapshot.
 * The puzzleId is fixed to "oracle" since it is only used for snapshot identity.
 */
function buildSnapshot(
  board: CompiledSearchBoard,
  robotCell: number,
  boxes: readonly DenseBox[],
  moves: number,
  pushes: number,
): GameSnapshot {
  const robotPos = cellToPosition(board, robotCell);
  const coreBoxes = denseBoxesToCoreBoxes(board, boxes);
  // We need to check solved status using the compiled board's goal data
  // (which is what callers expect) rather than the core engine's solved check,
  // but stepSnapshot will compute it from the ParsedBoard anyway.
  // We construct a minimal snapshot — stepSnapshot only reads robot, boxes,
  // moves, and pushes from it.
  return Object.freeze({
    puzzleId: "oracle",
    robot: Object.freeze({ row: robotPos.row, column: robotPos.column }),
    boxes: Object.freeze(coreBoxes.map((box) => Object.freeze(box))),
    moves,
    pushes,
    solved: isSolved(board, boxes),
  });
}

/**
 * Find the exact minimum number of moves (walk steps + pushes) to solve
 * the puzzle from the given state. Returns null if unsolvable.
 *
 * Uses BFS with cost 1 per action (walk or push). This is a step-level
 * search, not a push-macro search. Transitions are computed via the
 * core engine's `stepSnapshot()` function.
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

    // Build a core GameSnapshot for the current state
    const snapshot = buildSnapshot(
      board,
      current.robot,
      current.boxes,
      current.moves,
      current.pushes,
    );

    // Use stepSnapshot for each of the 4 directions
    for (const direction of DIRECTIONS) {
      const transition = stepSnapshot(board.source, snapshot, direction);
      if (!transition.moved) continue;

      const nextRobot = positionToCell(board, transition.snapshot.robot);
      const nextBoxes = snapshotBoxesToDense(board, transition.snapshot.boxes);
      const newMoves = current.moves + 1;
      const newPushes = transition.pushed
        ? current.pushes + 1
        : current.pushes;
      const newKey = oracleStateKey(nextRobot, nextBoxes);

      if (newMoves < (bestMoves.get(newKey) ?? Infinity)) {
        bestMoves.set(newKey, newMoves);

        if (isSolved(board, nextBoxes)) {
          return {
            exactMoves: newMoves,
            exactPushes: newPushes,
            statesExplored: bestMoves.size,
          };
        }

        queue.push({
          robot: nextRobot,
          boxes: nextBoxes,
          moves: newMoves,
          pushes: newPushes,
        });
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

    // Build a core GameSnapshot for successor enumeration
    const snapshot = buildSnapshot(board, current.robot, current.boxes, 0, 0);

    // Use stepSnapshot for each of the 4 directions
    for (const direction of DIRECTIONS) {
      const transition = stepSnapshot(board.source, snapshot, direction);
      if (!transition.moved) continue;

      const nextRobot = positionToCell(board, transition.snapshot.robot);
      const nextBoxes = snapshotBoxesToDense(board, transition.snapshot.boxes);
      const newKey = oracleStateKey(nextRobot, nextBoxes);

      if (!visited.has(newKey)) {
        visited.add(newKey);
        const entry = { robot: nextRobot, boxes: nextBoxes };
        reachable.set(newKey, entry);
        queue.push(entry);
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
