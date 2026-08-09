import type { CompiledSearchBoard } from "./compiled-board.ts";
import { buildGoalRegion } from "./pattern-database.ts";

export interface GoalPartition {
  readonly goalCells: readonly number[];
  readonly labels: readonly string[];
  readonly regionCells: readonly number[];
}

const MAX_PARTITION_SIZE = 5;
const REGION_MAX_DISTANCE = 8;

export function partitionGoals(
  board: CompiledSearchBoard,
): readonly GoalPartition[] {
  const allGoalCells: number[] = [];
  const goalLabels = new Map<number, string>();

  for (const [label, cells] of board.goalCellsByLabel) {
    for (const cell of cells) {
      allGoalCells.push(cell);
      goalLabels.set(cell, label);
    }
  }

  if (allGoalCells.length === 0) return [];

  const groups = groupByLabel(board, allGoalCells, goalLabels);

  const partitions: GoalPartition[] = [];
  for (const group of groups) {
    if (group.goalCells.length <= MAX_PARTITION_SIZE) {
      const regionCells = buildGoalRegion(board, group.goalCells, REGION_MAX_DISTANCE);
      partitions.push({
        goalCells: group.goalCells,
        labels: group.labels,
        regionCells,
      });
    } else {
      const splits = splitByProximity(board, group.goalCells, group.labels);
      for (const split of splits) {
        const regionCells = buildGoalRegion(board, split.goalCells, REGION_MAX_DISTANCE);
        partitions.push({
          goalCells: split.goalCells,
          labels: split.labels,
          regionCells,
        });
      }
    }
  }

  return partitions;
}

interface GoalGroup {
  readonly goalCells: number[];
  readonly labels: string[];
}

function groupByLabel(
  board: CompiledSearchBoard,
  allGoalCells: readonly number[],
  goalLabels: ReadonlyMap<number, string>,
): GoalGroup[] {
  const byLabel = new Map<string, number[]>();
  for (const cell of allGoalCells) {
    const label = goalLabels.get(cell)!;
    const group = byLabel.get(label) ?? [];
    group.push(cell);
    byLabel.set(label, group);
  }

  const groups: GoalGroup[] = [];
  for (const [label, cells] of [...byLabel].sort(([a], [b]) => a.localeCompare(b))) {
    groups.push({
      goalCells: cells.sort((a, b) => a - b),
      labels: cells.map(() => label),
    });
  }
  return groups;
}

function splitByProximity(
  board: CompiledSearchBoard,
  goalCells: readonly number[],
  labels: readonly string[],
): GoalGroup[] {
  if (goalCells.length <= MAX_PARTITION_SIZE) {
    return [{ goalCells: [...goalCells], labels: [...labels] }];
  }

  const n = goalCells.length;
  const used = new Uint8Array(n);
  const partitions: GoalGroup[] = [];

  while (true) {
    let seed = -1;
    for (let i = 0; i < n; i++) {
      if (!used[i]) { seed = i; break; }
    }
    if (seed < 0) break;

    const group: number[] = [seed];
    used[seed] = 1;

    while (group.length < MAX_PARTITION_SIZE) {
      let bestIdx = -1;
      let bestDist = Infinity;

      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        let minDist = Infinity;
        for (const gi of group) {
          const dist = manhattanDistance(board, goalCells[gi], goalCells[i]);
          if (dist < minDist) minDist = dist;
        }
        if (minDist < bestDist) {
          bestDist = minDist;
          bestIdx = i;
        }
      }

      if (bestIdx < 0) break;
      group.push(bestIdx);
      used[bestIdx] = 1;
    }

    partitions.push({
      goalCells: group.map((i) => goalCells[i]).sort((a, b) => a - b),
      labels: group.map((i) => labels[i]),
    });
  }

  return partitions;
}

function manhattanDistance(
  board: CompiledSearchBoard,
  cellA: number,
  cellB: number,
): number {
  const posA = board.positions[cellA];
  const posB = board.positions[cellB];
  return Math.abs(posA.row - posB.row) + Math.abs(posA.column - posB.column);
}
