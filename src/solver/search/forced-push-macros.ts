import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";
import type { KeeperReachabilityResult } from "./reachability.ts";

export interface ForcedPushMacroStats {
  readonly checks: number;
  readonly applications: number;
}

export interface ForcedPushResult {
  readonly forced: boolean;
  readonly direction?: number;
  readonly boxIndex?: number;
}

const OPPOSITE = [1, 0, 3, 2] as const;

export class ForcedPushMacroDetector {
  readonly #board: CompiledSearchBoard;
  #checks = 0;
  #applications = 0;

  constructor(board: CompiledSearchBoard) {
    this.#board = board;
  }

  get stats(): ForcedPushMacroStats {
    return {
      checks: this.#checks,
      applications: this.#applications,
    };
  }

  detect(
    boxes: readonly DenseBox[],
    occupancy: Uint8Array,
    reachable: KeeperReachabilityResult,
  ): ForcedPushResult {
    this.#checks++;
    const neighbors = this.#board.neighbors;

    let legalCount = 0;
    let forcedDirection = -1;
    let forcedBoxIndex = -1;

    for (let bi = 0; bi < boxes.length; bi++) {
      const boxCell = boxes[bi].cell;
      const boxNeighbors = neighbors[boxCell];

      for (let d = 0; d < 4; d++) {
        const support = boxNeighbors[OPPOSITE[d]];
        if (support < 0) continue;

        const destination = boxNeighbors[d];
        if (destination < 0) continue;

        if (!reachable.isReachable(support)) continue;
        if (occupancy[destination] !== 0) continue;

        legalCount++;
        if (legalCount > 1) {
          return { forced: false };
        }

        forcedDirection = d;
        forcedBoxIndex = bi;
      }
    }

    if (legalCount === 1) {
      this.#applications++;
      return { forced: true, direction: forcedDirection, boxIndex: forcedBoxIndex };
    }

    return { forced: false };
  }
}
