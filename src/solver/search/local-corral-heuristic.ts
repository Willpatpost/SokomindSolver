import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";
import type { KeeperReachabilityResult } from "./reachability.ts";
import { minimumAssignmentCost } from "./assignment.ts";

export interface LocalCorralLowerBoundStats {
  readonly evaluations: number;
  readonly positiveResults: number;
}

const OPPOSITE = [1, 0, 3, 2] as const;

export class LocalCorralLowerBound {
  readonly #board: CompiledSearchBoard;
  readonly #componentId: Int32Array;
  readonly #componentQueue: Int32Array;
  #evaluations = 0;
  #positiveResults = 0;

  constructor(board: CompiledSearchBoard) {
    this.#board = board;
    this.#componentId = new Int32Array(board.cellCount);
    this.#componentQueue = new Int32Array(board.cellCount);
  }

  get stats(): LocalCorralLowerBoundStats {
    return {
      evaluations: this.#evaluations,
      positiveResults: this.#positiveResults,
    };
  }

  evaluate(
    boxes: readonly DenseBox[],
    occupancy: Uint8Array,
    reachable: KeeperReachabilityResult,
  ): number {
    this.#evaluations++;

    const board = this.#board;
    const { cellCount } = board;
    const componentId = this.#componentId;
    const queue = this.#componentQueue;
    componentId.fill(-1);

    // Build a map of box by cell for quick lookup.
    const boxByCell = new Map<number, DenseBox>();
    for (const box of boxes) {
      boxByCell.set(box.cell, box);
    }

    let nextComponentId = 0;
    let maxLowerBound = 0;

    for (let seed = 0; seed < cellCount; seed++) {
      if (reachable.isReachable(seed)) continue;
      if (componentId[seed] >= 0) continue;
      // Skip occupied cells that are not boxes (e.g., the robot).
      if (occupancy[seed] !== 0 && !boxByCell.has(seed)) continue;

      const cid = nextComponentId++;
      let head = 0;
      let tail = 0;
      componentId[seed] = cid;
      queue[tail++] = seed;

      const corralBoxes: DenseBox[] = [];
      const corralGoalCells: number[] = [];
      const corralGoalLabels: string[] = [];

      while (head < tail) {
        const cell = queue[head++];

        // Collect boxes in this corral.
        const box = boxByCell.get(cell);
        if (box) corralBoxes.push(box);

        // Collect goals in this corral.
        const goalLabel = board.goalLabelByCell[cell];
        if (goalLabel !== null) {
          corralGoalCells.push(cell);
          corralGoalLabels.push(goalLabel);
        }

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

      if (corralBoxes.length === 0) continue;

      // Check if all boxes are already on their matching goals.
      const allOnGoals = corralBoxes.every(
        (b) => board.goalLabelByCell[b.cell] === b.label,
      );
      if (allOnGoals) continue;

      // Compute a lower bound for this corral using optimal assignment.
      // Group boxes and goals by label, then compute assignment cost per label.
      const boxesByLabel = new Map<string, DenseBox[]>();
      for (const b of corralBoxes) {
        let arr = boxesByLabel.get(b.label);
        if (!arr) {
          arr = [];
          boxesByLabel.set(b.label, arr);
        }
        arr.push(b);
      }

      const goalsByLabel = new Map<string, number[]>();
      for (let i = 0; i < corralGoalCells.length; i++) {
        const label = corralGoalLabels[i];
        let arr = goalsByLabel.get(label);
        if (!arr) {
          arr = [];
          goalsByLabel.set(label, arr);
        }
        arr.push(corralGoalCells[i]);
      }

      let corralLB = 0;

      for (const [label, labelBoxes] of boxesByLabel) {
        const labelGoals = goalsByLabel.get(label);
        if (!labelGoals || labelGoals.length === 0) {
          // Boxes with no matching goals in the corral contribute nothing
          // to the lower bound (they must be pushed out eventually, but we
          // cannot quantify that here without breaking admissibility).
          continue;
        }

        // Build cost matrix: rows = boxes, columns = goals.
        // Use reverse-push distances as costs.
        const costMatrix: number[][] = [];
        for (const b of labelBoxes) {
          const row: number[] = [];
          for (const goalCell of labelGoals) {
            const distances = board.reversePushDistancesByGoal.get(goalCell);
            const dist = distances?.[b.cell] ?? -1;
            // -1 means unreachable; use Infinity for assignment.
            row.push(dist < 0 ? Number.POSITIVE_INFINITY : dist);
          }
          costMatrix.push(row);
        }

        // Use the Hungarian algorithm for optimal (admissible) assignment.
        const cost = minimumAssignmentCost(costMatrix);
        if (cost < Number.POSITIVE_INFINITY) {
          corralLB += cost;
        }
      }

      if (corralLB > maxLowerBound) {
        maxLowerBound = corralLB;
      }
    }

    if (maxLowerBound > 0) {
      this.#positiveResults++;
    }
    return maxLowerBound;
  }
}

export interface LocalCorralDeadlockStats {
  readonly checks: number;
  readonly deadlocks: number;
}

export class LocalCorralDeadlockDetector {
  readonly #board: CompiledSearchBoard;
  readonly #componentId: Int32Array;
  readonly #componentQueue: Int32Array;
  #checks = 0;
  #deadlocks = 0;

  constructor(board: CompiledSearchBoard) {
    this.#board = board;
    this.#componentId = new Int32Array(board.cellCount);
    this.#componentQueue = new Int32Array(board.cellCount);
  }

  get stats(): LocalCorralDeadlockStats {
    return {
      checks: this.#checks,
      deadlocks: this.#deadlocks,
    };
  }

  check(
    boxes: readonly DenseBox[],
    occupancy: Uint8Array,
    reachable: KeeperReachabilityResult,
  ): boolean {
    this.#checks++;

    const board = this.#board;
    const { cellCount } = board;
    const componentId = this.#componentId;
    const queue = this.#componentQueue;
    componentId.fill(-1);

    // Build a map of box by cell for quick lookup.
    const boxByCell = new Map<number, DenseBox>();
    for (const box of boxes) {
      boxByCell.set(box.cell, box);
    }

    let nextComponentId = 0;

    for (let seed = 0; seed < cellCount; seed++) {
      if (reachable.isReachable(seed)) continue;
      if (componentId[seed] >= 0) continue;
      // Skip occupied cells that are not boxes (e.g., the robot).
      if (occupancy[seed] !== 0 && !boxByCell.has(seed)) continue;

      const cid = nextComponentId++;
      let head = 0;
      let tail = 0;
      componentId[seed] = cid;
      queue[tail++] = seed;

      const corralBoxes: DenseBox[] = [];
      const corralGoalLabels: string[] = [];

      while (head < tail) {
        const cell = queue[head++];

        // Collect boxes in this corral.
        const box = boxByCell.get(cell);
        if (box) corralBoxes.push(box);

        // Collect goal labels in this corral.
        const goalLabel = board.goalLabelByCell[cell];
        if (goalLabel !== null) {
          corralGoalLabels.push(goalLabel);
        }

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

      if (corralBoxes.length === 0) continue;

      // Check if all boxes are already on their matching goals.
      const allOnGoals = corralBoxes.every(
        (b) => board.goalLabelByCell[b.cell] === b.label,
      );
      if (allOnGoals) continue;

      // Check if any box can be pushed OUT of the corral.
      // A box can be pushed out if the keeper can reach the support side
      // (the cell opposite to the push direction) and the destination cell
      // is unoccupied.
      let canBeOpened = false;
      for (const box of corralBoxes) {
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
        // Sealed corral with unsolved boxes. Check for label mismatch deadlock.
        // Count boxes per label and goals per label in the corral.
        const boxCountByLabel = new Map<string, number>();
        for (const b of corralBoxes) {
          boxCountByLabel.set(b.label, (boxCountByLabel.get(b.label) ?? 0) + 1);
        }

        const goalCountByLabel = new Map<string, number>();
        for (const label of corralGoalLabels) {
          goalCountByLabel.set(
            label,
            (goalCountByLabel.get(label) ?? 0) + 1,
          );
        }

        // If any box label has more boxes than matching goals, it is a deadlock.
        // Boxes cannot be pushed out (sealed), so excess boxes are stuck.
        for (const [label, boxCount] of boxCountByLabel) {
          const goalCount = goalCountByLabel.get(label) ?? 0;
          if (boxCount > goalCount) {
            this.#deadlocks++;
            return true;
          }
        }

        // Also check if any box has no matching goal at all in the corral.
        for (const b of corralBoxes) {
          if (!goalCountByLabel.has(b.label)) {
            this.#deadlocks++;
            return true;
          }
        }
      }
    }

    return false;
  }
}
