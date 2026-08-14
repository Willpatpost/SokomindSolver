import type { CompiledSearchBoard } from "./compiled-board.ts";
import { throwIfSolverCancelled } from "../cancellation.ts";
import { maximumDisjointSelection } from "./disjoint-selection.ts";
import type { DenseBox } from "./model.ts";
import { PairConflictHeuristic } from "./pair-conflict-heuristic.ts";
import {
  hasPotentialRoomPattern,
  RoomPatternHeuristic,
} from "./room-pattern-heuristic.ts";
import type { BoardTopology } from "./topology.ts";
import {
  checkExactPreprocessingBudget,
  type ExactPreprocessingBudget,
} from "./preprocessing-budget.ts";

const BOOST_CACHE_LIMIT = 50_000;

export type ExactInteractionSearchLimitReason = "elapsed" | "memory";

export class ExactInteractionSearchLimitError extends Error {
  readonly reason: ExactInteractionSearchLimitReason;
  readonly estimatedMemoryBytes: number;

  constructor(
    reason: ExactInteractionSearchLimitReason,
    estimatedMemoryBytes: number,
  ) {
    super(
      reason === "elapsed"
        ? "Maximum elapsed time reached while building an interaction search cache."
        : "Estimated solver memory limit reached while building an interaction search cache.",
    );
    this.name = "ExactInteractionSearchLimitError";
    this.reason = reason;
    this.estimatedMemoryBytes = estimatedMemoryBytes;
  }
}

export interface InteractionSearchBudget {
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly deadline: number;
  readonly maxMemoryBytes?: number;
  readonly baseMemoryBytes: () => number;
}

export function isExactInteractionSearchLimitError(
  value: unknown,
): value is ExactInteractionSearchLimitError {
  return value instanceof ExactInteractionSearchLimitError;
}

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
  readonly #searchBudget?: InteractionSearchBudget;

  constructor(
    board: CompiledSearchBoard,
    topology: BoardTopology,
    budget?: ExactPreprocessingBudget,
    searchBudget?: InteractionSearchBudget,
  ) {
    checkExactPreprocessingBudget(budget);
    this.#roomHeuristic = new RoomPatternHeuristic(board, topology, budget);
    this.#searchBudget = searchBudget;
    this.#pairHeuristic = new PairConflictHeuristic(
      board,
      topology,
      (pairBytes) => this.#checkSearchBudget(pairBytes + this.#cache.size * 96),
    );
    this.#roomCoveredLabels = this.#roomHeuristic.coveredLabels();
    checkExactPreprocessingBudget(
      budget,
      this.#roomHeuristic.estimatedRetainedBytes,
    );
  }

  get preprocessingRetainedBytes(): number {
    return this.#roomHeuristic.estimatedRetainedBytes;
  }

  get searchCacheRetainedBytes(): number {
    return this.#pairHeuristic.estimatedRetainedBytes +
      this.#cache.size * 96;
  }

  get estimatedRetainedBytes(): number {
    return this.preprocessingRetainedBytes + this.searchCacheRetainedBytes;
  }

  #checkSearchBudget(searchCacheBytes: number): void {
    const budget = this.#searchBudget;
    if (!budget) return;
    throwIfSolverCancelled(budget.signal);
    const estimatedMemoryBytes =
      budget.baseMemoryBytes() + Math.max(0, searchCacheBytes);
    if (
      budget.maxMemoryBytes !== undefined &&
      estimatedMemoryBytes > budget.maxMemoryBytes
    ) {
      throw new ExactInteractionSearchLimitError(
        "memory",
        estimatedMemoryBytes,
      );
    }
    if (budget.now() >= budget.deadline) {
      throw new ExactInteractionSearchLimitError(
        "elapsed",
        estimatedMemoryBytes,
      );
    }
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
      this.#checkSearchBudget(
        this.#pairHeuristic.estimatedRetainedBytes +
          (this.#cache.size + 1) * 96,
      );
      this.#cache.set(boxKey, total);
      if (this.#cache.size > BOOST_CACHE_LIMIT) {
        const first = this.#cache.keys().next().value;
        if (first !== undefined) this.#cache.delete(first);
      }
    }

    return total;
  }
}

/**
 * Cheap static preflight used before constructing reverse-push tables.
 * A room table needs an eligible multi-goal partition; a pair table needs at
 * least two labels that each own exactly one goal (box labels are invariant).
 */
export function hasPotentialInteractionBoost(
  board: CompiledSearchBoard,
  topology: BoardTopology,
): boolean {
  if (hasPotentialRoomPattern(board, topology)) return true;
  let singletonLabels = 0;
  for (const goals of board.goalCellsByLabel.values()) {
    if (goals.length === 1 && ++singletonLabels >= 2) return true;
  }
  return false;
}
