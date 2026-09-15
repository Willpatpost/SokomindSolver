import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { LabelAssignmentState } from "./heuristic.ts";
import type { BoardTopology } from "./topology.ts";

export interface GoalCutStats {
  evaluations: number;
  cutTotal: number;
}

export class GoalCutEvaluator {
  readonly #board: CompiledSearchBoard;
  readonly #bottleneckCells: ReadonlySet<number>;
  readonly stats: GoalCutStats = { evaluations: 0, cutTotal: 0 };

  constructor(board: CompiledSearchBoard, topology: BoardTopology) {
    this.#board = board;
    const bottlenecks = new Set<number>();
    for (const cell of topology.articulations) bottlenecks.add(cell);
    for (const cell of topology.tunnels) bottlenecks.add(cell);
    this.#bottleneckCells = bottlenecks;
  }

  evaluate(
    assignmentStates: ReadonlyMap<string, LabelAssignmentState>,
  ): number {
    this.stats.evaluations++;

    const demand = new Map<number, number>();

    for (const [, state] of assignmentStates) {
      const n = state.boxCells.length;
      for (let i = 0; i < n; i++) {
        const boxCell = state.boxCells[i];
        const goalCell = state.goalCells[state.columns[i]];
        if (boxCell === goalCell) continue;

        const distances = this.#board.reversePushDistancesByGoal.get(goalCell);
        if (!distances || distances[boxCell] < 0) continue;

        this.#collectBottlenecks(boxCell, distances, demand);
      }
    }

    let maxSurplus = 0;
    for (const count of demand.values()) {
      if (count > 1) {
        const surplus = (count - 1) * 2;
        if (surplus > maxSurplus) maxSurplus = surplus;
      }
    }

    this.stats.cutTotal += maxSurplus;
    return maxSurplus;
  }

  #collectBottlenecks(
    boxCell: number,
    distances: Int32Array,
    demand: Map<number, number>,
  ): void {
    const board = this.#board;
    const bottlenecks = this.#bottleneckCells;
    const seen = new Set<number>([boxCell]);
    const queue = [boxCell];

    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      const dist = distances[current];

      if (bottlenecks.has(current)) {
        demand.set(current, (demand.get(current) ?? 0) + 1);
      }

      if (dist === 0) continue;

      const neighbors = board.neighbors[current];
      for (let d = 0; d < neighbors.length; d++) {
        const next = neighbors[d];
        if (next < 0 || seen.has(next)) continue;
        if (distances[next] !== dist - 1) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
}

export function hasPotentialGoalCut(
  _board: CompiledSearchBoard,
  topology: BoardTopology,
): boolean {
  return topology.articulations.size > 0 || topology.tunnels.size > 0;
}
