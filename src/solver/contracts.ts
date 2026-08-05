import type {
  Direction,
  GameSnapshot,
  ParsedBoard,
} from "../core/model.ts";

/**
 * Values accepted in solver-specific options. Keeping this JSON-safe makes a
 * request portable across the worker boundary.
 */
export type SolverOptionValue =
  | boolean
  | number
  | string
  | null
  | readonly SolverOptionValue[]
  | { readonly [key: string]: SolverOptionValue };

export type SolverOptions = Readonly<Record<string, SolverOptionValue>>;

export type SolverObjectiveKind = "moves";

/**
 * Sokomind searches minimize total movement. Pushes are still reported as a
 * route statistic, but never alter search cost or state dominance.
 */
export interface SolverObjective {
  readonly kind: "moves";
}

export interface SolverLimits {
  readonly maxElapsedMs?: number;
  readonly maxExpandedStates?: number;
  readonly maxGeneratedStates?: number;
  readonly maxMemoryBytes?: number;
}

/**
 * A complete, immutable solving input. `board` is static geometry and
 * `snapshot` is the exact dynamic state from which solving begins.
 */
export interface SolverRequest {
  readonly board: ParsedBoard;
  readonly snapshot: GameSnapshot;
  readonly objective: SolverObjective;
  readonly limits?: SolverLimits;
  readonly options?: SolverOptions;
}

export type SolverExecutionTarget = "main-thread" | "web-worker";
export type SolverRuntime = "javascript" | "webassembly" | "hybrid";
export type SolverQuality = "first-found" | "bounded" | "optimal";

export interface SolverCapabilities {
  readonly executionTargets: readonly SolverExecutionTarget[];
  readonly runtime: SolverRuntime;
  readonly objectives: readonly SolverObjectiveKind[];
  readonly quality: SolverQuality;
  readonly labeledBoxes: boolean;
  readonly genericBoxes: boolean;
  readonly partialState: boolean;
  readonly reportsProgress: boolean;
  readonly cooperativeCancellation: boolean;
  readonly deterministic: boolean;
}

export interface SolverMetadata {
  /**
   * Stable, URL-safe identifier. It is persisted in settings and used on the
   * worker protocol, so it must not be a translated display label.
   */
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly capabilities: SolverCapabilities;
}

/**
 * A step deliberately contains only facts needed to replay it. The core
 * engine remains authoritative for player and box positions after each move.
 */
export interface SolutionStep {
  readonly direction: Direction;
  readonly kind: "walk" | "push";
}

export interface SolverSolution {
  readonly steps: readonly SolutionStep[];
  readonly moves: number;
  readonly pushes: number;
  readonly objective: SolverObjective;
  readonly objectiveScore: number;
  readonly optimality: "unknown" | "proven";
}

export interface SolverRunMetrics {
  readonly elapsedMs: number;
  readonly expandedStates?: number;
  readonly generatedStates?: number;
  readonly peakFrontierSize?: number;
  readonly counters?: Readonly<Record<string, number>>;
}

export type SolverPhase =
  | "preparing"
  | "searching"
  | "improving"
  | "verifying";

export interface SolverProgress {
  readonly phase: SolverPhase;
  readonly elapsedMs: number;
  readonly expandedStates?: number;
  readonly generatedStates?: number;
  readonly frontierSize?: number;
  /**
   * Algorithm-specific monotonic counters such as duplicate states, deadlock
   * prunes, or heuristic cache hits.
   */
  readonly counters?: Readonly<Record<string, number>>;
  /**
   * Present only when the adapter can calculate meaningful bounded progress.
   */
  readonly fraction?: number;
  readonly incumbent?: Readonly<{
    moves: number;
    pushes: number;
    objectiveScore: number;
  }>;
  readonly detail?: string;
}

export type SolverResult =
  | {
      readonly status: "solved";
      readonly solution: SolverSolution;
      readonly metrics: SolverRunMetrics;
    }
  | {
      readonly status: "unsolved";
      readonly reason: "exhausted" | "limit-reached" | "unsupported";
      readonly metrics: SolverRunMetrics;
      readonly detail?: string;
    }
  | {
      readonly status: "cancelled";
      readonly metrics: SolverRunMetrics;
    };

export interface SolverExecutionContext {
  readonly signal: AbortSignal;
  readonly reportProgress: (progress: SolverProgress) => void;
  /**
   * An injectable monotonic clock, normally `performance.now`.
   */
  readonly now: () => number;
}

/**
 * Algorithms implement this one interface. They must not import UI state,
 * browser storage, React, or worker globals.
 */
export interface SolverAdapter {
  readonly metadata: SolverMetadata;
  solve(
    request: SolverRequest,
    context: SolverExecutionContext,
  ): Promise<SolverResult>;
}
