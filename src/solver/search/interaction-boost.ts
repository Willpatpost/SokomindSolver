import type { CompiledSearchBoard } from "./compiled-board.ts";
import { maximumDisjointSelection } from "./disjoint-selection.ts";
import type { DenseBox } from "./model.ts";
import { PairConflictHeuristic } from "./pair-conflict-heuristic.ts";
import { RoomPatternHeuristic } from "./room-pattern-heuristic.ts";
import type { BoardTopology } from "./topology.ts";

const BOOST_CACHE_LIMIT = 50_000;

export interface InteractionBoostStats {
  evaluations: number;
  roomBoostTotal: number;
  pairBoostTotal: number;
  cacheHits: number;
}

export class InteractionBoostEvaluator {
  readonly stats: InteractionBoostStats = {
    evaluations: 0,
    roomBoostTotal: 0,
    pairBoostTotal: 0,
    cacheHits: 0,
  };
  readonly #roomHeuristic: RoomPatternHeuristic;
  readonly #pairHeuristic: PairConflictHeuristic;
  readonly #cache = new Map<bigint, number>();
  readonly #roomCoveredLabels: ReadonlySet<string>;

  constructor(board: CompiledSearchBoard, topology: BoardTopology) {
    this.#roomHeuristic = new RoomPatternHeuristic(board, topology);
    this.#pairHeuristic = new PairConflictHeuristic(board, topology);
    this.#roomCoveredLabels = this.#roomHeuristic.coveredLabels();
  }

  get roomPatternStats() {
    return this.#roomHeuristic.stats;
  }

  get pairConflictStats() {
    return this.#pairHeuristic.stats;
  }

  evaluate(
    boxes: readonly DenseBox[],
    labelCosts: ReadonlyMap<string, number>,
    boxKey?: bigint,
  ): number {
    this.stats.evaluations++;

    if (boxKey !== undefined) {
      const cached = this.#cache.get(boxKey);
      if (cached !== undefined) {
        this.stats.cacheHits++;
        this.#cache.delete(boxKey);
        this.#cache.set(boxKey, cached);
        return cached;
      }
    }

    const roomCandidates = this.#roomHeuristic.candidates(boxes, labelCosts);
    const pairCandidates = this.#pairHeuristic.candidates(
      boxes,
      labelCosts,
      this.#roomCoveredLabels,
    );

    const selected = maximumDisjointSelection([
      ...roomCandidates,
      ...pairCandidates,
    ]);

    let total = 0;
    for (const candidate of selected) {
      total += candidate.boost;
      if (candidate.kind === "room") {
        this.stats.roomBoostTotal += candidate.boost;
      } else {
        this.stats.pairBoostTotal += candidate.boost;
      }
    }

    if (boxKey !== undefined) {
      this.#cache.set(boxKey, total);
      if (this.#cache.size > BOOST_CACHE_LIMIT) {
        const first = this.#cache.keys().next().value;
        if (first !== undefined) this.#cache.delete(first);
      }
    }

    return total;
  }
}
