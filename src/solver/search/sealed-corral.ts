import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { KeeperReachabilityResult } from "./reachability.ts";
import type { DenseBox } from "./model.ts";
import { CorralFlood } from "./corral-flood.ts";

export interface SealedCorralStats {
  readonly checks: number;
  readonly deadlocks: number;
}

export class SealedCorralDetector {
  readonly #flood: CorralFlood;
  #checks = 0;
  #deadlocks = 0;

  constructor(cellCount: number) {
    this.#flood = new CorralFlood(cellCount);
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

    const found = this.#flood.scan(board, boxes, occupancy, reachable, (component) => {
      if (component.boundaryPushes.length === 0) {
        this.#deadlocks += 1;
        return true;
      }
    });

    return found;
  }
}

export function hasSealedCorralDeadlock(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  occupancy: Uint8Array,
  reachable: KeeperReachabilityResult,
  detector: SealedCorralDetector,
): boolean {
  return detector.check(board, boxes, occupancy, reachable);
}
