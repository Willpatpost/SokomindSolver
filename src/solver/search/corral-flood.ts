import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { KeeperReachabilityResult } from "./reachability.ts";
import type { DenseBox } from "./model.ts";

const OPPOSITE = [1, 0, 3, 2] as const;

export interface BoundaryPush {
  readonly boxIndex: number;
  readonly direction: number;
  readonly destination: number;
}

export interface CorralComponent {
  readonly boxIndices: readonly number[];
  readonly boundaryPushes: readonly BoundaryPush[];
}

export type CorralVisitor = (component: CorralComponent) => boolean | void;

export class CorralFlood {
  readonly #componentId: Int32Array;
  readonly #componentQueue: Int32Array;

  constructor(cellCount: number) {
    this.#componentId = new Int32Array(cellCount);
    this.#componentQueue = new Int32Array(cellCount);
  }

  scan(
    board: CompiledSearchBoard,
    boxes: readonly DenseBox[],
    occupancy: Uint8Array,
    reachable: KeeperReachabilityResult,
    visitor: CorralVisitor,
  ): boolean {
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

      const boxIndices: number[] = [];

      while (head < tail) {
        const cell = queue[head++];
        const bi = boxByCell.get(cell);
        if (bi !== undefined) boxIndices.push(bi);

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

      if (boxIndices.length === 0) continue;

      const allOnGoals = boxIndices.every((bi) => {
        const box = boxes[bi];
        return board.goalLabelByCell[box.cell] === box.label;
      });
      if (allOnGoals) continue;

      const boundaryPushes: BoundaryPush[] = [];
      for (const bi of boxIndices) {
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

      const stop = visitor({ boxIndices, boundaryPushes });
      if (stop === true) return true;
    }

    return false;
  }
}
