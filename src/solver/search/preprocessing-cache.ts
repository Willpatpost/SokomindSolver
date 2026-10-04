import type { SolverRequest } from "../contracts.ts";
import type { DeadlockTableLookup } from "./deadlock-tables.ts";
import {
  exactSearchFeatureFingerprint,
  type ExactSearchFeatures,
} from "./exact-search-features.ts";
import type { PdbHeuristicEvaluator } from "./pdb-heuristic.ts";
import type { RoomPatternTableSet } from "./room-pattern-heuristic.ts";

/** Board-only preprocessing one exact run built, for later runs on the same board. */
export interface ExactPreprocessingTables {
  readonly deadlockTables: DeadlockTableLookup | null;
  readonly roomTables: RoomPatternTableSet | null;
  /** Holds the tables; each run takes a view() for its own counters and cache. */
  readonly pdbEvaluator: PdbHeuristicEvaluator | null;
}

export type ExactPreprocessingAlgorithm = "astar" | "ida-star";

/**
 * Names everything the cached builds depend on apart from time: the whole
 * board (compared as text, so equal keys mean equal boards), the resolved
 * features, the algorithm and box count (they set the static memory base the
 * builds are budgeted against) and the memory limit. The snapshot is left out
 * because no build reads it, so the partitions of a proof share one entry.
 */
export function exactPreprocessingCacheKey(
  request: SolverRequest,
  algorithm: ExactPreprocessingAlgorithm,
  features: ExactSearchFeatures,
): string {
  return JSON.stringify([
    algorithm,
    exactSearchFeatureFingerprint(features),
    request.limits?.maxMemoryBytes ?? null,
    request.snapshot.boxes.length,
    request.board,
  ]);
}

/**
 * Keeps the preprocessing of the last exact run so the next run with the same
 * key skips the builds. A proof worker holds one across its partitions and
 * runs. It has one entry, and a miss evicts it before the new build, so a run
 * never holds tables its memory estimate does not count.
 */
export class ExactPreprocessingCache {
  #key: string | undefined;
  #tables: ExactPreprocessingTables | undefined;

  lookup(key: string): ExactPreprocessingTables | undefined {
    if (key === this.#key) return this.#tables;
    this.clear();
    return undefined;
  }

  /**
   * Stores tables only when a fresh build with the same key would give the
   * same ones. A build the deadline cut short depends on timing, so it is
   * refused; the work cap and the memory limit depend only on the key.
   */
  store(key: string, tables: ExactPreprocessingTables): boolean {
    if (
      tables.deadlockTables?.stats.truncatedBy === "elapsed" ||
      tables.pdbEvaluator?.deadlineLimited
    ) {
      this.clear();
      return false;
    }
    this.#key = key;
    this.#tables = tables;
    return true;
  }

  clear(): void {
    this.#key = undefined;
    this.#tables = undefined;
  }

  get retainedBytes(): number {
    const tables = this.#tables;
    if (!tables) return 0;
    return (tables.deadlockTables?.estimatedRetainedBytes ?? 0) +
      (tables.roomTables?.estimatedRetainedBytes ?? 0) +
      (tables.pdbEvaluator?.preprocessingRetainedBytes ?? 0);
  }
}
