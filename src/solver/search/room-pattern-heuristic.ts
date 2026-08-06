import { minimumAssignmentCost } from "./assignment.ts";
import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";
import {
  relaxedReversePushTable,
  patternSignature,
  type PatternBox,
  type ReversePushTableResult,
} from "./relaxed-reverse-push.ts";
import type { BoardTopology, Room } from "./topology.ts";

const ROOM_PATTERN_MAX_STATES = 12_000;
const ROOM_PATTERN_SELECTION_LIMIT = 512;
const MIN_PARTITION_GOALS = 2;
const MAX_PARTITION_GOALS = 4;

export interface PatternTable {
  readonly labels: ReadonlySet<string>;
  readonly targetBoxes: readonly PatternBox[];
  readonly result: ReversePushTableResult;
  readonly room: Room;
}

export interface HeuristicCandidate {
  readonly labels: ReadonlySet<string>;
  readonly boost: number;
  readonly kind: "room" | "pair";
}

export interface RoomPatternStats {
  builds: number;
  states: number;
  hits: number;
}

export class RoomPatternHeuristic {
  readonly tables: readonly PatternTable[];
  readonly stats: RoomPatternStats = { builds: 0, states: 0, hits: 0 };
  readonly #board: CompiledSearchBoard;

  constructor(board: CompiledSearchBoard, topology: BoardTopology) {
    this.#board = board;
    const tables: PatternTable[] = [];
    for (const room of topology.rooms) {
      for (const partition of roomPatternGoalPartitions(room, board)) {
        const targetBoxes: PatternBox[] = partition.map((goalCell) => ({
          cell: goalCell,
          label: board.goalLabelByCell[goalCell]!,
        }));
        const labels = new Set(targetBoxes.map((b) => b.label));
        const result = relaxedReversePushTable(
          board,
          targetBoxes,
          ROOM_PATTERN_MAX_STATES,
        );
        this.stats.builds++;
        this.stats.states += result.visited;
        if (result.states.size > 0) {
          tables.push({ labels, targetBoxes, result, room });
        }
      }
    }
    this.tables = tables;
  }

  candidates(
    boxes: readonly DenseBox[],
    labelCosts: ReadonlyMap<string, number>,
  ): readonly HeuristicCandidate[] {
    const candidates: HeuristicCandidate[] = [];
    for (const table of this.tables) {
      if (!table.result.states.size) continue;
      const replacement = compatiblePatternReplacementCost(
        boxes,
        this.#board,
        table,
      );
      if (replacement === null) continue;
      this.stats.hits++;
      let assignment = 0;
      for (const label of table.labels) {
        assignment += labelCosts.get(label) ?? Infinity;
      }
      const boost = replacement - assignment;
      if (boost > 0 && Number.isFinite(boost)) {
        candidates.push({ labels: table.labels, boost, kind: "room" });
      }
    }
    return candidates;
  }

  coveredLabels(): ReadonlySet<string> {
    const labels = new Set<string>();
    for (const table of this.tables) {
      if (table.result.states.size > 0) {
        for (const label of table.labels) labels.add(label);
      }
    }
    return labels;
  }
}

function roomPatternGoalPartitions(
  room: Room,
  board: CompiledSearchBoard,
): number[][] {
  const byLabel = new Map<string, number[]>();
  for (const goal of room.goals) {
    const label = board.goalLabelByCell[goal]!;
    const group = byLabel.get(label) ?? [];
    group.push(goal);
    byLabel.set(label, group);
  }

  const groups = [...byLabel.values()]
    .filter((goals) => goals.length <= MAX_PARTITION_GOALS)
    .sort((a, b) => b.length - a.length);

  const totalGoals = groups.reduce((t, g) => t + g.length, 0);
  const partitions: number[][] = Array.from(
    { length: Math.max(1, Math.ceil(totalGoals / MAX_PARTITION_GOALS)) },
    () => [],
  );

  for (const goals of groups) {
    const partition = partitions
      .filter((p) => p.length + goals.length <= MAX_PARTITION_GOALS)
      .sort((a, b) => a.length - b.length)[0];
    if (!partition) continue;
    partition.push(...goals);
  }

  return partitions.filter((p) => p.length >= MIN_PARTITION_GOALS);
}

interface BoxEntry {
  readonly cell: number;
  readonly index: number;
}

function boxesByLabelWithIndices(
  boxes: readonly DenseBox[],
): Map<string, BoxEntry[]> {
  const result = new Map<string, BoxEntry[]>();
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const entries = result.get(box.label) ?? [];
    entries.push({ cell: box.cell, index: i });
    result.set(box.label, entries);
  }
  return result;
}

function combinationCount(size: number, selected: number): number {
  if (selected < 0 || selected > size) return 0;
  selected = Math.min(selected, size - selected);
  let count = 1;
  for (let i = 1; i <= selected; i++) {
    count = (count * (size - selected + i)) / i;
    if (count > ROOM_PATTERN_SELECTION_LIMIT) return count;
  }
  return count;
}

function combinations<T>(values: readonly T[], selected: number): T[][] {
  if (selected === 0) return [[]];
  const result: T[][] = [];
  const visit = (start: number, current: T[]): void => {
    if (current.length === selected) {
      result.push([...current]);
      return;
    }
    for (
      let i = start;
      i <= values.length - (selected - current.length);
      i++
    ) {
      current.push(values[i]);
      visit(i + 1, current);
      current.pop();
    }
  };
  visit(0, []);
  return result;
}

function compatiblePatternReplacementCost(
  boxes: readonly DenseBox[],
  board: CompiledSearchBoard,
  table: PatternTable,
): number | null {
  const goalsByLabel = new Map<string, number[]>();
  for (const tb of table.targetBoxes) {
    const group = goalsByLabel.get(tb.label) ?? [];
    group.push(tb.cell);
    goalsByLabel.set(tb.label, group);
  }

  const boxesByLabel_ = boxesByLabelWithIndices(boxes);
  let selectionCount = 1;

  interface ChoiceGroup {
    label: string;
    targetGoals: number[];
    entries: BoxEntry[];
    selections: BoxEntry[][];
  }
  const choices: ChoiceGroup[] = [];

  for (const [label, targetGoals] of goalsByLabel) {
    const entries = boxesByLabel_.get(label) ?? [];
    const count = combinationCount(entries.length, targetGoals.length);
    selectionCount *= count;
    if (!count || selectionCount > ROOM_PATTERN_SELECTION_LIMIT) {
      return null;
    }
    choices.push({
      label,
      targetGoals,
      entries,
      selections: combinations(entries, targetGoals.length),
    });
  }

  let best = Infinity;
  const n = board.cellCount;

  const visit = (
    choiceIndex: number,
    selectedByLabel: Map<string, BoxEntry[]>,
  ): void => {
    if (choiceIndex < choices.length) {
      const choice = choices[choiceIndex];
      for (const selection of choice.selections) {
        selectedByLabel.set(choice.label, selection);
        visit(choiceIndex + 1, selectedByLabel);
      }
      selectedByLabel.delete(choice.label);
      return;
    }

    const patternBoxes: PatternBox[] = [];
    let outsideCost = 0;

    for (const choice of choices) {
      const selected = selectedByLabel.get(choice.label)!;
      const selectedIndices = new Set(selected.map((e) => e.index));
      for (const entry of selected) {
        patternBoxes.push({ cell: entry.cell, label: choice.label });
      }
      const outsideBoxCells = choice.entries
        .filter((e) => !selectedIndices.has(e.index))
        .map((e) => e.cell);
      const targetSet = new Set(choice.targetGoals);
      const outsideGoalCells = (
        board.goalCellsByLabel.get(choice.label) ?? []
      ).filter((g) => !targetSet.has(g));

      if (outsideBoxCells.length !== outsideGoalCells.length) return;
      if (outsideBoxCells.length > 0) {
        const costs = outsideBoxCells.map((boxCell) =>
          outsideGoalCells.map((goalCell) => {
            const dist =
              board.reversePushDistancesByGoal.get(goalCell)?.[boxCell] ?? -1;
            return dist < 0 ? Infinity : dist;
          }),
        );
        const assignment = minimumAssignmentCost(costs);
        if (!Number.isFinite(assignment)) return;
        outsideCost += assignment;
      }
    }

    const sig = patternSignature(patternBoxes, n);
    const distance = table.result.states.get(sig);
    if (distance !== undefined) {
      best = Math.min(best, distance + outsideCost);
    }
  };

  visit(0, new Map());
  return Number.isFinite(best) ? best : null;
}
