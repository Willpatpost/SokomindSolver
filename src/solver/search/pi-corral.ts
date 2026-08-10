import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { KeeperReachabilityResult } from "./reachability.ts";
import type { DenseBox } from "./model.ts";
import {
  createsFullyBlockedTwoByTwoDeadlock,
  hasFreezeDeadlock,
} from "./deadlocks.ts";

const OPPOSITE = [1, 0, 3, 2] as const;
const MAX_BOUNDARY_BOXES = 6;

export interface PiCorralStats {
  readonly sealedDeadlocks: number;
  readonly piDeadlocks: number;
  readonly checks: number;
}

interface BoundaryPush {
  readonly boxIndex: number;
  readonly direction: number;
  readonly destination: number;
}

export class PiCorralDetector {
  readonly #componentId: Int32Array;
  readonly #componentQueue: Int32Array;
  readonly #tempOccupancy: Int32Array;
  #sealedDeadlocks = 0;
  #piDeadlocks = 0;
  #checks = 0;

  constructor(cellCount: number) {
    this.#componentId = new Int32Array(cellCount);
    this.#componentQueue = new Int32Array(cellCount);
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

    const { cellCount } = board;
    const componentId = this.#componentId;
    const queue = this.#componentQueue;
    componentId.fill(-1);

    const boxByCell = new Map<number, number>();
    for (let i = 0; i < boxes.length; i++) {
      boxByCell.set(boxes[i].cell, i);
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

      const boundaryPushes: BoundaryPush[] = [];
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

          boundaryPushes.push({ boxIndex: bi, direction: d, destination: dest });
        }
      }

      if (boundaryPushes.length === 0) {
        this.#sealedDeadlocks += 1;
        return true;
      }

      if (componentBoxIndices.length > MAX_BOUNDARY_BOXES) continue;

      if (this.#allPushesDeadlock(board, boxes, boundaryPushes)) {
        this.#piDeadlocks += 1;
        return true;
      }
    }

    return false;
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
