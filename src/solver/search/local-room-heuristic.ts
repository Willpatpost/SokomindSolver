import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";
import {
  relaxedReversePushTable,
  patternSignature,
  type PatternBox,
  type ReversePushTableResult,
} from "./relaxed-reverse-push.ts";
import type { BoardTopology, Room } from "./topology.ts";

const LOCAL_ROOM_MAX_STATES = 12_000;

interface RoomTable {
  readonly room: Room;
  /** Goal labels present in this table (one entry per label). */
  readonly goalLabels: ReadonlySet<string>;
  /** Number of goals per label in this room. */
  readonly goalCountByLabel: ReadonlyMap<string, number>;
  readonly result: ReversePushTableResult;
}

export interface LocalRoomLowerBoundStats {
  readonly evaluations: number;
  readonly positiveResults: number;
}

export class LocalRoomLowerBound {
  readonly #board: CompiledSearchBoard;
  readonly #tables: readonly RoomTable[];
  #evaluations = 0;
  #positiveResults = 0;

  constructor(board: CompiledSearchBoard, topology: BoardTopology) {
    this.#board = board;

    const tables: RoomTable[] = [];
    for (const room of topology.rooms) {
      if (room.goals.length === 0) continue;

      // Group goals by label.
      const goalsByLabel = new Map<string, number[]>();
      for (const goalCell of room.goals) {
        const label = board.goalLabelByCell[goalCell];
        if (label === null) continue;
        const group = goalsByLabel.get(label) ?? [];
        group.push(goalCell);
        goalsByLabel.set(label, group);
      }

      // Build one table per label group.
      for (const [label, goalCells] of goalsByLabel) {
        const targetBoxes: PatternBox[] = goalCells.map((cell) => ({
          cell,
          label,
        }));
        const result = relaxedReversePushTable(
          board,
          targetBoxes,
          LOCAL_ROOM_MAX_STATES,
        );
        if (result.states.size > 0) {
          const goalCountByLabel = new Map<string, number>([[label, goalCells.length]]);
          tables.push({
            room,
            goalLabels: new Set([label]),
            goalCountByLabel,
            result,
          });
        }
      }
    }
    this.#tables = tables;
  }

  get stats(): LocalRoomLowerBoundStats {
    return {
      evaluations: this.#evaluations,
      positiveResults: this.#positiveResults,
    };
  }

  evaluate(boxes: readonly DenseBox[]): number {
    this.#evaluations++;
    let maxBound = 0;

    for (const table of this.#tables) {
      const bound = this.#evaluateTable(table, boxes);
      if (bound > maxBound) {
        maxBound = bound;
        this.#positiveResults++;
      }
    }

    return maxBound;
  }

  #evaluateTable(table: RoomTable, boxes: readonly DenseBox[]): number {
    // Find boxes currently in the room whose labels match the table's goal labels.
    const matchingBoxes: PatternBox[] = [];
    const boxCountByLabel = new Map<string, number>();

    for (const box of boxes) {
      if (!table.room.cells.has(box.cell)) continue;
      if (!table.goalLabels.has(box.label)) continue;
      matchingBoxes.push({ cell: box.cell, label: box.label });
      boxCountByLabel.set(box.label, (boxCountByLabel.get(box.label) ?? 0) + 1);
    }

    if (matchingBoxes.length === 0) return 0;

    // Check that the count of matching boxes per label equals the goal count per label.
    for (const [label, goalCount] of table.goalCountByLabel) {
      const boxCount = boxCountByLabel.get(label) ?? 0;
      if (boxCount !== goalCount) return 0;
    }

    // Look up the pattern signature in the precomputed table.
    const sig = patternSignature(matchingBoxes, this.#board.cellCount);
    const distance = table.result.states.get(sig);
    return distance ?? 0;
  }
}

export interface LocalRoomDeadlockStats {
  readonly checks: number;
  readonly deadlocks: number;
}

export class LocalRoomDeadlockDetector {
  readonly #board: CompiledSearchBoard;
  readonly #tables: readonly RoomTable[];
  #checks = 0;
  #deadlocks = 0;

  constructor(board: CompiledSearchBoard, topology: BoardTopology) {
    this.#board = board;

    const tables: RoomTable[] = [];
    for (const room of topology.rooms) {
      if (room.goals.length === 0) continue;

      // Group goals by label.
      const goalsByLabel = new Map<string, number[]>();
      for (const goalCell of room.goals) {
        const label = board.goalLabelByCell[goalCell];
        if (label === null) continue;
        const group = goalsByLabel.get(label) ?? [];
        group.push(goalCell);
        goalsByLabel.set(label, group);
      }

      for (const [label, goalCells] of goalsByLabel) {
        const targetBoxes: PatternBox[] = goalCells.map((cell) => ({
          cell,
          label,
        }));
        const result = relaxedReversePushTable(
          board,
          targetBoxes,
          LOCAL_ROOM_MAX_STATES,
        );
        if (result.states.size > 0) {
          const goalCountByLabel = new Map<string, number>([[label, goalCells.length]]);
          tables.push({
            room,
            goalLabels: new Set([label]),
            goalCountByLabel,
            result,
          });
        }
      }
    }
    this.#tables = tables;
  }

  get stats(): LocalRoomDeadlockStats {
    return {
      checks: this.#checks,
      deadlocks: this.#deadlocks,
    };
  }

  check(
    boxes: readonly DenseBox[],
    occupancy: Uint8Array,
  ): boolean {
    this.#checks++;

    for (const table of this.#tables) {
      if (this.#isRoomDeadlocked(table, boxes, occupancy)) {
        this.#deadlocks++;
        return true;
      }
    }

    return false;
  }

  #isRoomDeadlocked(
    table: RoomTable,
    boxes: readonly DenseBox[],
    occupancy: Uint8Array,
  ): boolean {
    const room = table.room;

    // Find boxes in the room whose labels match room goal labels.
    const matchingBoxes: PatternBox[] = [];
    const boxCountByLabel = new Map<string, number>();

    for (const box of boxes) {
      if (!room.cells.has(box.cell)) continue;
      if (!table.goalLabels.has(box.label)) continue;
      matchingBoxes.push({ cell: box.cell, label: box.label });
      boxCountByLabel.set(box.label, (boxCountByLabel.get(box.label) ?? 0) + 1);
    }

    // If the reverse-push table was complete (ready) AND the exact number
    // of matching boxes per label equals goals per label, check if the
    // configuration is reachable from the goal state.
    if (table.result.status === "ready") {
      let exactMatch = true;
      for (const [label, goalCount] of table.goalCountByLabel) {
        const boxCount = boxCountByLabel.get(label) ?? 0;
        if (boxCount !== goalCount) {
          exactMatch = false;
          break;
        }
      }

      if (exactMatch && matchingBoxes.length > 0) {
        const sig = patternSignature(matchingBoxes, this.#board.cellCount);
        if (!table.result.states.has(sig)) {
          return true;
        }
      }
    }

    return false;
  }
}
