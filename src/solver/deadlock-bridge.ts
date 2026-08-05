import type { Box, GameSnapshot, ParsedBoard } from "../core/model.ts";
import { compileSearchBoard, type CompiledSearchBoard } from "./search/compiled-board.ts";
import type { DenseBox } from "./search/model.ts";
import { isStaticDeadCell, createsFullyBlockedTwoByTwoDeadlock } from "./search/deadlocks.ts";

export interface DeadlockResult {
  readonly isDeadlocked: boolean;
  readonly deadlockedBoxIds: readonly string[];
}

const NO_DEADLOCK: DeadlockResult = Object.freeze({
  isDeadlocked: false,
  deadlockedBoxIds: Object.freeze([]),
});

const boardCache = new WeakMap<ParsedBoard, CompiledSearchBoard>();

function getCompiledBoard(board: ParsedBoard): CompiledSearchBoard {
  let compiled = boardCache.get(board);
  if (!compiled) {
    compiled = compileSearchBoard(board);
    boardCache.set(board, compiled);
  }
  return compiled;
}

export function findPushedBox(
  previousBoxes: readonly Box[],
  nextBoxes: readonly Box[],
): Box | undefined {
  for (let i = 0; i < nextBoxes.length; i++) {
    const prev = previousBoxes[i];
    const next = nextBoxes[i];
    if (
      prev.position.row !== next.position.row ||
      prev.position.column !== next.position.column
    ) {
      return next;
    }
  }
  return undefined;
}

export function detectDeadlock(
  board: ParsedBoard,
  snapshot: GameSnapshot,
  pushedBoxId?: string,
): DeadlockResult {
  if (snapshot.solved) return NO_DEADLOCK;
  if (!pushedBoxId) return NO_DEADLOCK;

  const compiled = getCompiledBoard(board);

  // Single pass: convert boxes to dense coords and locate the pushed box by id.
  let pushedDense: DenseBox | undefined;
  const denseBoxes: DenseBox[] = new Array(snapshot.boxes.length);
  for (let i = 0; i < snapshot.boxes.length; i++) {
    const box = snapshot.boxes[i];
    const cell = compiled.cellAt(box.position.row, box.position.column);
    if (cell < 0) {
      throw new RangeError(
        `Box ${JSON.stringify(box.id)} is not on a floor cell.`,
      );
    }
    const dense: DenseBox = { id: box.id, label: box.label, cell };
    denseBoxes[i] = dense;
    if (box.id === pushedBoxId) pushedDense = dense;
  }

  if (!pushedDense) return NO_DEADLOCK;

  if (isStaticDeadCell(compiled, pushedDense.cell, pushedDense.label)) {
    return Object.freeze({
      isDeadlocked: true,
      deadlockedBoxIds: Object.freeze([pushedDense.id]),
    });
  }

  if (createsFullyBlockedTwoByTwoDeadlock(compiled, denseBoxes, pushedDense.cell)) {
    return Object.freeze({
      isDeadlocked: true,
      deadlockedBoxIds: Object.freeze([pushedDense.id]),
    });
  }

  return NO_DEADLOCK;
}
