import type { Box, GameSnapshot, ParsedBoard } from "../core/model.ts";
import { compileSearchBoard, type CompiledSearchBoard } from "./search/compiled-board.ts";
import type { DenseBox } from "./search/model.ts";
import {
  isStaticDeadCell,
  createsFullyBlockedTwoByTwoDeadlock,
  hasFreezeDeadlock,
} from "./search/deadlocks.ts";

export type DeadlockSeverity = "none" | "warning" | "deadlock";

export interface DeadlockResult {
  readonly isDeadlocked: boolean;
  readonly severity: DeadlockSeverity;
  readonly deadlockedBoxIds: readonly string[];
}

const NO_DEADLOCK: DeadlockResult = Object.freeze({
  isDeadlocked: false,
  severity: "none" as const,
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

function buildOccupancy(
  compiled: CompiledSearchBoard,
  denseBoxes: readonly DenseBox[],
): Int32Array {
  const occupancy = new Int32Array(compiled.cellCount);
  occupancy.fill(-1);
  for (let i = 0; i < denseBoxes.length; i++) {
    occupancy[denseBoxes[i].cell] = i;
  }
  return occupancy;
}

function hasAxisBlocked(
  compiled: CompiledSearchBoard,
  cell: number,
  occupancy: Int32Array,
): boolean {
  const neighbors = compiled.neighbors[cell];
  if (!neighbors) return false;

  const up = neighbors[0];
  const down = neighbors[1];
  const left = neighbors[2];
  const right = neighbors[3];

  const verticalBlocked =
    (up < 0 || occupancy[up] >= 0) && (down < 0 || occupancy[down] >= 0);
  const horizontalBlocked =
    (left < 0 || occupancy[left] >= 0) && (right < 0 || occupancy[right] >= 0);

  return verticalBlocked || horizontalBlocked;
}

export function detectDeadlock(
  board: ParsedBoard,
  snapshot: GameSnapshot,
  pushedBoxId?: string,
): DeadlockResult {
  if (snapshot.solved) return NO_DEADLOCK;
  if (!pushedBoxId) return NO_DEADLOCK;

  const compiled = getCompiledBoard(board);

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
      severity: "deadlock" as const,
      deadlockedBoxIds: Object.freeze([pushedDense.id]),
    });
  }

  const occupancy = buildOccupancy(compiled, denseBoxes);

  if (createsFullyBlockedTwoByTwoDeadlock(compiled, denseBoxes, pushedDense.cell, occupancy)) {
    return Object.freeze({
      isDeadlocked: true,
      severity: "deadlock" as const,
      deadlockedBoxIds: Object.freeze([pushedDense.id]),
    });
  }

  if (hasFreezeDeadlock(compiled, denseBoxes, occupancy)) {
    return Object.freeze({
      isDeadlocked: true,
      severity: "deadlock" as const,
      deadlockedBoxIds: Object.freeze([pushedDense.id]),
    });
  }

  const onGoal = compiled.goalLabelByCell[pushedDense.cell] === pushedDense.label;
  if (!onGoal && hasAxisBlocked(compiled, pushedDense.cell, occupancy)) {
    return Object.freeze({
      isDeadlocked: false,
      severity: "warning" as const,
      deadlockedBoxIds: Object.freeze([pushedDense.id]),
    });
  }

  return NO_DEADLOCK;
}
