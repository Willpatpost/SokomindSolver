import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";
import {
  relaxedReversePushTable,
  patternSignature,
  type PatternBox,
  type ReversePushTableResult,
} from "./relaxed-reverse-push.ts";
import type { BoardTopology } from "./topology.ts";
import type { HeuristicCandidate } from "./room-pattern-heuristic.ts";

const PAIR_CONFLICT_MAX_STATES = 4_000;
const PAIR_CONFLICT_DISTANCE_LIMIT = 18;

interface PairTable {
  readonly labels: ReadonlySet<string>;
  readonly result: ReversePushTableResult;
}

export interface PairConflictStats {
  builds: number;
  states: number;
  candidates: number;
  hits: number;
}

export class PairConflictHeuristic {
  readonly stats: PairConflictStats = {
    builds: 0,
    states: 0,
    candidates: 0,
    hits: 0,
  };
  readonly #board: CompiledSearchBoard;
  readonly #topology: BoardTopology;
  readonly #tableCache = new Map<string, PairTable>();

  constructor(board: CompiledSearchBoard, topology: BoardTopology) {
    this.#board = board;
    this.#topology = topology;
  }

  candidates(
    boxes: readonly DenseBox[],
    labelCosts: ReadonlyMap<string, number>,
    roomPatternLabels: ReadonlySet<string>,
  ): readonly HeuristicCandidate[] {
    const board = this.#board;
    const entries = singletonLabelEntries(boxes, board);
    const candidates: HeuristicCandidate[] = [];

    for (let i = 0; i < entries.length; i++) {
      const left = entries[i];
      const leftCritical = this.#criticalCells(left.cell, left.goalCell);
      if (leftCritical.size === 0) continue;

      for (let j = i + 1; j < entries.length; j++) {
        const right = entries[j];
        const assignment =
          (labelCosts.get(left.label) ?? Infinity) +
          (labelCosts.get(right.label) ?? Infinity);
        if (assignment > PAIR_CONFLICT_DISTANCE_LIMIT) continue;

        if (
          roomPatternLabels.has(left.label) &&
          roomPatternLabels.has(right.label)
        )
          continue;

        const rightCritical = this.#criticalCells(right.cell, right.goalCell);
        let hasOverlap = false;
        for (const cell of leftCritical) {
          if (rightCritical.has(cell)) {
            hasOverlap = true;
            break;
          }
        }
        if (!hasOverlap) continue;

        this.stats.candidates++;
        const table = this.#getOrBuildTable(left.label, right.label);
        const patternBoxes: PatternBox[] = [
          { cell: left.cell, label: left.label },
          { cell: right.cell, label: right.label },
        ];
        const sig = patternSignature(patternBoxes, board.cellCount);
        const distance = table.result.states.get(sig);
        if (distance === undefined) continue;

        this.stats.hits++;
        const boost = distance - assignment;
        if (boost > 0 && Number.isFinite(boost)) {
          candidates.push({ labels: table.labels, boost, kind: "pair" });
        }
      }
    }

    return candidates;
  }

  #criticalCellCache = new Map<string, ReadonlySet<number>>();

  #criticalCells(boxCell: number, goalCell: number): ReadonlySet<number> {
    const key = `${boxCell}>${goalCell}`;
    const cached = this.#criticalCellCache.get(key);
    if (cached) return cached;

    const result = shortestPushCriticalCells(
      this.#board,
      boxCell,
      goalCell,
      this.#topology,
    );
    this.#criticalCellCache.set(key, result);
    return result;
  }

  #getOrBuildTable(leftLabel: string, rightLabel: string): PairTable {
    const labels = [leftLabel, rightLabel].sort();
    const cacheKey = labels.join("|");
    const cached = this.#tableCache.get(cacheKey);
    if (cached) return cached;

    const board = this.#board;
    const leftGoals = board.goalCellsByLabel.get(leftLabel) ?? [];
    const rightGoals = board.goalCellsByLabel.get(rightLabel) ?? [];
    const targetBoxes: PatternBox[] = [
      { cell: leftGoals[0], label: leftLabel },
      { cell: rightGoals[0], label: rightLabel },
    ];
    const result = relaxedReversePushTable(
      board,
      targetBoxes,
      PAIR_CONFLICT_MAX_STATES,
    );
    this.stats.builds++;
    this.stats.states += result.visited;

    const table: PairTable = {
      labels: new Set(labels),
      result,
    };
    this.#tableCache.set(cacheKey, table);
    return table;
  }
}

interface SingletonEntry {
  readonly label: string;
  readonly cell: number;
  readonly goalCell: number;
}

function singletonLabelEntries(
  boxes: readonly DenseBox[],
  board: CompiledSearchBoard,
): SingletonEntry[] {
  const byLabel = new Map<string, DenseBox[]>();
  for (const box of boxes) {
    const group = byLabel.get(box.label) ?? [];
    group.push(box);
    byLabel.set(box.label, group);
  }

  const entries: SingletonEntry[] = [];
  for (const [label, group] of byLabel) {
    if (group.length !== 1) continue;
    const goals = board.goalCellsByLabel.get(label) ?? [];
    if (goals.length !== 1) continue;
    entries.push({ label, cell: group[0].cell, goalCell: goals[0] });
  }
  return entries;
}

function shortestPushCriticalCells(
  board: CompiledSearchBoard,
  boxCell: number,
  goalCell: number,
  topology: BoardTopology,
): ReadonlySet<number> {
  const distances = board.reversePushDistancesByGoal.get(goalCell);
  if (!distances) return new Set();

  const initialDist = distances[boxCell];
  if (initialDist < 0) return new Set();

  const critical = new Set<number>();
  const seen = new Set<number>([boxCell]);
  const queue = [boxCell];

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    const dist = distances[current];
    if (topology.articulations.has(current) || topology.tunnels.has(current)) {
      critical.add(current);
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

  return critical;
}
