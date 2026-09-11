import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { KeeperReachabilityResult } from "./reachability.ts";
import type { DenseBox } from "./model.ts";
import { CorralFlood } from "./corral-flood.ts";

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
  readonly #flood: CorralFlood;
  #boundaryFlags: Uint8Array;
  #checks = 0;
  #reorders = 0;

  constructor(cellCount: number) {
    this.#flood = new CorralFlood(cellCount);
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

    const flagsLength = boxes.length * 4;
    let flags = this.#boundaryFlags;
    if (flags.length < flagsLength) {
      flags = new Uint8Array(flagsLength);
      this.#boundaryFlags = flags;
    } else {
      flags.fill(0, 0, flagsLength);
    }

    let hasCorral = false;

    this.#flood.scan(board, boxes, occupancy, reachable, (component) => {
      for (const push of component.boundaryPushes) {
        flags[push.boxIndex * 4 + push.direction] = 1;
        hasCorral = true;
      }
    });

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

  for (let left = head, right = totalChildren - 1; left < right; left++, right--) {
    const tmp = order[left];
    order[left] = order[right];
    order[right] = tmp;
  }

  return order;
}
