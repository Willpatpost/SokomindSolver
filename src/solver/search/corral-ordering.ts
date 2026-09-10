import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { KeeperReachabilityResult } from "./reachability.ts";
import type { DenseBox } from "./model.ts";

const OPPOSITE = [1, 0, 3, 2] as const;

export interface CorralOrderingStats {
  readonly checks: number;
  readonly reorders: number;
}

export interface CorralOrderingResult {
  readonly hasCorral: boolean;
  isCorralBoundaryPush(boxIndex: number, directionIndex: number): boolean;
}

const EMPTY_RESULT: CorralOrderingResult = Object.freeze({
  hasCorral: false,
  isCorralBoundaryPush() { return false; },
});

export class CorralOrderingAnalyzer {
  readonly #componentId: Int32Array;
  readonly #componentQueue: Int32Array;
  #boundaryFlags: Uint8Array;
  #checks = 0;
  #reorders = 0;

  constructor(cellCount: number) {
    this.#componentId = new Int32Array(cellCount);
    this.#componentQueue = new Int32Array(cellCount);
    this.#boundaryFlags = new Uint8Array(0);
  }

  get stats(): CorralOrderingStats {
    return { checks: this.#checks, reorders: this.#reorders };
  }

  analyze(
    board: CompiledSearchBoard,
    boxes: readonly DenseBox[],
    occupancy: Uint8Array,
    reachable: KeeperReachabilityResult,
  ): CorralOrderingResult {
    this.#checks += 1;

    const { cellCount } = board;
    const componentId = this.#componentId;
    const queue = this.#componentQueue;
    componentId.fill(-1);

    const boxByCell = new Map<number, number>();
    for (let i = 0; i < boxes.length; i++) {
      boxByCell.set(boxes[i].cell, i);
    }

    const flagsLength = boxes.length * 4;
    let flags = this.#boundaryFlags;
    if (flags.length < flagsLength) {
      flags = new Uint8Array(flagsLength);
      this.#boundaryFlags = flags;
    } else {
      flags.fill(0, 0, flagsLength);
    }

    let hasCorral = false;
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

      const componentBoxIndices: number[] = [];

      while (head < tail) {
        const cell = queue[head++];
        const bi = boxByCell.get(cell);
        if (bi !== undefined) componentBoxIndices.push(bi);

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

      if (componentBoxIndices.length === 0) continue;

      const allOnGoals = componentBoxIndices.every((bi) => {
        const box = boxes[bi];
        return board.goalLabelByCell[box.cell] === box.label;
      });
      if (allOnGoals) continue;

      for (const bi of componentBoxIndices) {
        const box = boxes[bi];
        const neighbors = board.neighbors[box.cell];
        for (let d = 0; d < 4; d++) {
          const supportDir = OPPOSITE[d];
          const support = neighbors[supportDir];
          if (support < 0) continue;
          if (!reachable.isReachable(support)) continue;

          const dest = neighbors[d];
          if (dest < 0) continue;
          if (occupancy[dest] !== 0) continue;

          flags[bi * 4 + d] = 1;
          hasCorral = true;
        }
      }
    }

    if (!hasCorral) return EMPTY_RESULT;

    this.#reorders += 1;
    const snapshot = flags.slice(0, flagsLength);
    return {
      hasCorral: true,
      isCorralBoundaryPush(boxIndex: number, directionIndex: number): boolean {
        return snapshot[boxIndex * 4 + directionIndex] === 1;
      },
    };
  }
}

export function buildCorralChildOrder(
  boxCount: number,
  directionCount: number,
  result: CorralOrderingResult,
): Uint16Array {
  const totalChildren = boxCount * directionCount;
  const order = new Uint16Array(totalChildren);
  let head = 0;
  let tail = totalChildren;

  for (let cursor = 0; cursor < totalChildren; cursor++) {
    const boxIndex = Math.floor(cursor / directionCount);
    const directionIndex = cursor % directionCount;
    if (result.isCorralBoundaryPush(boxIndex, directionIndex)) {
      order[head++] = cursor;
    } else {
      order[--tail] = cursor;
    }
  }

  // Reverse the non-boundary portion so it's in natural order
  for (let left = head, right = totalChildren - 1; left < right; left++, right--) {
    const tmp = order[left];
    order[left] = order[right];
    order[right] = tmp;
  }

  return order;
}
