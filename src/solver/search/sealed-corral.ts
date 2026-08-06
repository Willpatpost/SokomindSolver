import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { KeeperReachabilityResult } from "./reachability.ts";
import type { DenseBox } from "./model.ts";

export interface SealedCorralStats {
  readonly checks: number;
  readonly deadlocks: number;
}

export class SealedCorralDetector {
  readonly #componentId: Int32Array;
  readonly #componentQueue: Int32Array;
  #checks = 0;
  #deadlocks = 0;

  constructor(cellCount: number) {
    this.#componentId = new Int32Array(cellCount);
    this.#componentQueue = new Int32Array(cellCount);
  }

  get stats(): SealedCorralStats {
    return {
      checks: this.#checks,
      deadlocks: this.#deadlocks,
    };
  }

  check(
    board: CompiledSearchBoard,
    boxes: readonly DenseBox[],
    occupancy: Uint8Array,
    reachable: KeeperReachabilityResult,
  ): boolean {
    this.#checks += 1;

    const { cellCount } = board;
    const componentId = this.#componentId;
    const queue = this.#componentQueue;
    componentId.fill(-1);

    const boxByCell = new Map<number, DenseBox>();
    for (const box of boxes) {
      boxByCell.set(box.cell, box);
    }

    let nextComponentId = 0;

    for (let seed = 0; seed < cellCount; seed++) {
      if (reachable.isReachable(seed)) continue;
      if (componentId[seed] >= 0) continue;
      if (occupancy[seed] !== 0 && !boxByCell.has(seed)) continue;

      const cid = nextComponentId++;
      let head = 0;
      let tail = 0;
      componentId[seed] = cid;
      queue[tail++] = seed;

      const componentCells: number[] = [];
      const componentBoxes: DenseBox[] = [];

      while (head < tail) {
        const cell = queue[head++];
        componentCells.push(cell);
        const box = boxByCell.get(cell);
        if (box) componentBoxes.push(box);

        const neighbors = board.neighbors[cell];
        for (let d = 0; d < 4; d++) {
          const next = neighbors[d];
          if (next < 0) continue;
          if (componentId[next] >= 0) continue;
          if (reachable.isReachable(next)) continue;
          componentId[next] = cid;
          queue[tail++] = next;
        }
      }

      if (componentBoxes.length === 0) continue;

      const allOnGoals = componentBoxes.every(
        (box) => board.goalLabelByCell[box.cell] === box.label,
      );
      if (allOnGoals) continue;

      let canBeOpened = false;
      for (const box of componentBoxes) {
        const neighbors = board.neighbors[box.cell];
        for (let d = 0; d < 4; d++) {
          const supportDir = OPPOSITE[d];
          const support = neighbors[supportDir];
          if (support < 0) continue;
          if (!reachable.isReachable(support)) continue;

          const dest = neighbors[d];
          if (dest < 0) continue;
          if (occupancy[dest] !== 0) continue;

          canBeOpened = true;
          break;
        }
        if (canBeOpened) break;
      }

      if (!canBeOpened) {
        this.#deadlocks += 1;
        return true;
      }
    }

    return false;
  }
}

const OPPOSITE = [1, 0, 3, 2] as const;

export function hasSealedCorralDeadlock(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  occupancy: Uint8Array,
  reachable: KeeperReachabilityResult,
  detector: SealedCorralDetector,
): boolean {
  return detector.check(board, boxes, occupancy, reachable);
}
