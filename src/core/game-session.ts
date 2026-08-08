import type {
  Box,
  DeadlockDetector,
  Direction,
  GameAction,
  GameHistory,
  GameHistoryEntry,
  GameSession,
  GameSnapshot,
  ParsedBoard,
  Position,
  PuzzleDefinition,
  SnapshotTransition,
} from "./model.ts";
import { ACTION_CODES, encodeDirection } from "./action-log.ts";
import { parsePuzzle, WALL } from "./puzzle.ts";

// Static assertion: undo relies on action codes being single characters.
// This executes once at module load and throws immediately if violated.
ACTION_CODES.forEach((c) => {
  if (c.length !== 1) throw new Error(`Action code ${JSON.stringify(c)} must be a single character`);
});

import {
  directionDelta,
  freezeBox,
  freezePosition,
  numericPositionKey,
  translate,
} from "./position.ts";

function clonePuzzle(puzzle: PuzzleDefinition): PuzzleDefinition {
  return Object.freeze({
    id: puzzle.id,
    title: puzzle.title,
    difficulty: puzzle.difficulty,
    boxes: puzzle.boxes,
    ...(puzzle.hint === undefined ? {} : { hint: puzzle.hint }),
    ...(puzzle.collection === undefined
      ? {}
      : { collection: puzzle.collection }),
    rows: Object.freeze([...puzzle.rows]),
  });
}

const goalMapCache = new WeakMap<ParsedBoard, Map<number, string>>();
const boxIndexCache = new WeakMap<GameSnapshot, Map<number, number>>();

function boxIndexMapFor(
  snapshot: GameSnapshot,
  width: number,
): Map<number, number> {
  let map = boxIndexCache.get(snapshot);
  if (!map) {
    map = new Map(
      snapshot.boxes.map((box, i) => [
        numericPositionKey(box.position.row, box.position.column, width),
        i,
      ]),
    );
    boxIndexCache.set(snapshot, map);
  }
  return map;
}

function goalMapFor(board: ParsedBoard): Map<number, string> {
  let goals = goalMapCache.get(board);
  if (!goals) {
    goals = new Map(
      board.goals.map((goal) => [
        numericPositionKey(goal.position.row, goal.position.column, board.width),
        goal.label,
      ]),
    );
    goalMapCache.set(board, goals);
  }
  return goals;
}

function boxesAreSolved(board: ParsedBoard, boxes: readonly Box[]): boolean {
  const goals = goalMapFor(board);
  return boxes.every(
    (box) =>
      goals.get(numericPositionKey(box.position.row, box.position.column, board.width)) === box.label,
  );
}

function createSnapshot(
  puzzleId: string,
  board: ParsedBoard,
  robot: Position,
  boxes: readonly Box[],
  moves: number,
  pushes: number,
): GameSnapshot {
  const frozenBoxes = Object.isFrozen(boxes)
    ? boxes
    : Object.freeze(boxes.map(freezeBox));

  return Object.freeze({
    puzzleId,
    robot: freezePosition(robot),
    boxes: frozenBoxes,
    moves,
    pushes,
    solved: boxesAreSolved(board, frozenBoxes),
  });
}

function createSessionValue(
  puzzle: PuzzleDefinition,
  board: ParsedBoard,
  snapshot: GameSnapshot,
  history: GameHistory,
  actionLog: string,
): GameSession {
  return Object.freeze({
    puzzle,
    board,
    snapshot,
    history,
    actionLog,
    moves: snapshot.moves,
    pushes: snapshot.pushes,
    solved: snapshot.solved,
  });
}

const EMPTY_HISTORY: GameHistory = Object.freeze({
  head: null,
  length: 0,
});

function pushHistory(
  history: GameHistory,
  snapshot: GameSnapshot,
): GameHistory {
  const head: GameHistoryEntry = Object.freeze({
    snapshot,
    previous: history.head,
  });
  return Object.freeze({
    head,
    length: history.length + 1,
  });
}

function popHistory(history: GameHistory): GameHistory {
  if (!history.head) return history;
  if (history.length === 1) return EMPTY_HISTORY;
  return Object.freeze({
    head: history.head.previous,
    length: history.length - 1,
  });
}

function isFloor(board: ParsedBoard, position: Position): boolean {
  if (
    position.row < 0 ||
    position.column < 0 ||
    position.row >= board.height ||
    position.column >= board.width
  ) {
    return false;
  }
  return board.rows[position.row]?.[position.column] !== WALL;
}

export function createSession(puzzleDefinition: PuzzleDefinition): GameSession {
  const puzzle = clonePuzzle(puzzleDefinition);
  const board = parsePuzzle(puzzle);
  const snapshot = createSnapshot(
    puzzle.id,
    board,
    board.initialRobot,
    board.initialBoxes,
    0,
    0,
  );
  return createSessionValue(puzzle, board, snapshot, EMPTY_HISTORY, "");
}

/**
 * Apply one direction to a snapshot without creating session history.
 *
 * Successful pushes leave the robot on the box's former cell, which is the
 * exact post-push position required by future deadlock and corral analysis.
 *
 * When a `deadlockDetector` callback is provided and a box is pushed, the
 * detector is invoked on the resulting state.  The returned transition will
 * include `deadlocked: true` if the detector fires.  Callers that omit the
 * detector see no change in behavior — the field is simply absent.
 */
export function stepSnapshot(
  board: ParsedBoard,
  snapshot: GameSnapshot,
  direction: Direction,
  deadlockDetector?: DeadlockDetector,
): SnapshotTransition {
  const delta = directionDelta(direction);
  const destination = translate(snapshot.robot, delta);
  if (!isFloor(board, destination)) {
    return Object.freeze({ snapshot, moved: false, pushed: false });
  }

  const boxMap = boxIndexMapFor(snapshot, board.width);
  const destKey = numericPositionKey(destination.row, destination.column, board.width);
  const pushedBoxIndex = boxMap.get(destKey);
  let boxes = snapshot.boxes;
  let pushes = snapshot.pushes;
  let pushed = false;

  if (pushedBoxIndex !== undefined) {
    const boxDestination = translate(destination, delta);
    const boxDestKey = numericPositionKey(boxDestination.row, boxDestination.column, board.width);
    if (!isFloor(board, boxDestination) || boxMap.has(boxDestKey)) {
      return Object.freeze({ snapshot, moved: false, pushed: false });
    }

    boxes = Object.freeze(
      snapshot.boxes.map((box, index) =>
        index === pushedBoxIndex
          ? freezeBox({ ...box, position: boxDestination })
          : box,
      ),
    );
    pushes += 1;
    pushed = true;
  }

  const nextSnapshot = pushed
    ? createSnapshot(
        snapshot.puzzleId,
        board,
        destination,
        boxes,
        snapshot.moves + 1,
        pushes,
      )
    : Object.freeze({
        puzzleId: snapshot.puzzleId,
        robot: freezePosition(destination),
        boxes: snapshot.boxes,
        moves: snapshot.moves + 1,
        pushes: snapshot.pushes,
        solved: snapshot.solved,
      });

  // Only invoke the detector after a push and when the puzzle is not already solved.
  const deadlocked =
    pushed && deadlockDetector && !nextSnapshot.solved
      ? deadlockDetector(board, nextSnapshot)
      : undefined;

  return Object.freeze({
    snapshot: nextSnapshot,
    moved: true,
    pushed,
    ...(pushedBoxIndex !== undefined
      ? { pushedBoxId: snapshot.boxes[pushedBoxIndex].id }
      : {}),
    ...(deadlocked !== undefined ? { deadlocked } : {}),
  });
}

/**
 * Apply one player step. Blocked steps and steps after completion are no-ops
 * and return the same session.
 */
export function move(session: GameSession, direction: Direction): GameSession {
  if (session.solved) return session;

  const transition = stepSnapshot(session.board, session.snapshot, direction);
  if (!transition.moved) return session;

  return createSessionValue(
    session.puzzle,
    session.board,
    transition.snapshot,
    pushHistory(session.history, session.snapshot),
    `${session.actionLog}${encodeDirection(direction)}`,
  );
}

export function undo(session: GameSession): GameSession {
  const previous = session.history.head;
  if (!previous) return session;
  return createSessionValue(
    session.puzzle,
    session.board,
    previous.snapshot,
    popHistory(session.history),
    session.actionLog.slice(0, -1),
  );
}

export function undoN(session: GameSession, count: number): GameSession {
  let result = session;
  for (let i = 0; i < count; i++) {
    const previous = result.history.head;
    if (!previous) break;
    result = createSessionValue(
      result.puzzle,
      result.board,
      previous.snapshot,
      popHistory(result.history),
      result.actionLog.slice(0, -1),
    );
  }
  return result;
}

export function reset(session: GameSession): GameSession {
  const snapshot = createSnapshot(
    session.puzzle.id,
    session.board,
    session.board.initialRobot,
    session.board.initialBoxes,
    0,
    0,
  );
  return createSessionValue(
    session.puzzle,
    session.board,
    snapshot,
    EMPTY_HISTORY,
    "",
  );
}

/** Selector kept explicit so UI and solver consumers need not inspect fields. */
export function isSolved(snapshot: GameSnapshot): boolean {
  return snapshot.solved;
}

export function sessionReducer(
  session: GameSession,
  action: GameAction,
): GameSession {
  switch (action.type) {
    case "move":
      return move(session, action.direction);
    case "undo":
      return undo(session);
    case "reset":
      return reset(session);
  }
}
