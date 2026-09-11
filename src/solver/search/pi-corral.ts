import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { KeeperReachabilityResult } from "./reachability.ts";
import type { DenseBox } from "./model.ts";
import {
  createsFullyBlockedTwoByTwoDeadlock,
  hasFreezeDeadlock,
} from "./deadlocks.ts";
import { CorralFlood, type BoundaryPush } from "./corral-flood.ts";

const MAX_BOUNDARY_BOXES = 6;

export interface PiCorralStats {
  readonly sealedDeadlocks: number;
  readonly piDeadlocks: number;
  readonly checks: number;
}

export class PiCorralDetector {
  readonly #flood: CorralFlood;
  readonly #tempOccupancy: Int32Array;
  #sealedDeadlocks = 0;
  #piDeadlocks = 0;
  #checks = 0;

  constructor(cellCount: number) {
    this.#flood = new CorralFlood(cellCount);
    this.#tempOccupancy = new Int32Array(cellCount);
  }

  get stats(): PiCorralStats {
    return {
      sealedDeadlocks: this.#sealedDeadlocks,
      piDeadlocks: this.#piDeadlocks,
      checks: this.#checks,
    };
  }

  check(
    board: CompiledSearchBoard,
    boxes: readonly DenseBox[],
    occupancy: Uint8Array,
    reachable: KeeperReachabilityResult,
  ): boolean {
    this.#checks += 1;

    return this.#flood.scan(board, boxes, occupancy, reachable, (component) => {
      if (component.boundaryPushes.length === 0) {
        this.#sealedDeadlocks += 1;
        return true;
      }

      if (component.boundaryPushes.length > MAX_BOUNDARY_BOXES) return;

      if (this.#allPushesDeadlock(board, boxes, component.boundaryPushes)) {
        this.#piDeadlocks += 1;
        return true;
      }
    });
  }

  #allPushesDeadlock(
    board: CompiledSearchBoard,
    boxes: readonly DenseBox[],
    pushes: readonly BoundaryPush[],
  ): boolean {
    for (const push of pushes) {
      if (!this.#pushCreatesDeadlock(board, boxes, push)) {
        return false;
      }
    }
    return true;
  }

  #pushCreatesDeadlock(
    board: CompiledSearchBoard,
    boxes: readonly DenseBox[],
    push: BoundaryPush,
  ): boolean {
    const tempBoxes: DenseBox[] = boxes.map((box, i) =>
      i === push.boxIndex
        ? { ...box, cell: push.destination }
        : box,
    );

    const occ = this.#tempOccupancy;
    occ.fill(-1);
    for (let i = 0; i < tempBoxes.length; i++) {
      occ[tempBoxes[i].cell] = i;
    }

    if (createsFullyBlockedTwoByTwoDeadlock(board, tempBoxes, push.destination, occ)) {
      return true;
    }

    if (hasFreezeDeadlock(board, tempBoxes, occ)) {
      return true;
    }

    return false;
  }
}

export function hasPiCorralDeadlock(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  occupancy: Uint8Array,
  reachable: KeeperReachabilityResult,
  detector: PiCorralDetector,
): boolean {
  return detector.check(board, boxes, occupancy, reachable);
}
