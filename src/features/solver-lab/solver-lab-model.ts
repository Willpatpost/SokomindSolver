import { encodeDirection } from "../../core/action-log.ts";
import type { SolverMetadata, SolverProgress, SolverResult } from "../../solver/contracts.ts";

export interface SolverLabRunConfiguration {
  readonly solverId: string;
  readonly solverName: string;
  readonly mode: "fast" | "quality" | "optimal";
  readonly timeLimitMs: number;
  readonly memoryLimitMiB: number;
}

export interface SolverLabRunRecord {
  readonly id: string;
  readonly puzzleId: string;
  readonly actionLog: string;
  readonly configuration: SolverLabRunConfiguration;
  readonly result: SolverResult;
  readonly capturedAt: string;
  readonly verifiedActionLog?: string;
}

export interface SearchPopulationMetric {
  readonly id: "generated" | "visited" | "frontier" | "pruned";
  readonly label: string;
  readonly value: number;
  readonly description: string;
}

export interface SolverLabComparison {
  readonly sameInput: boolean;
  readonly sameLimits: boolean;
  readonly elapsedDeltaMs?: number;
  readonly expandedDelta?: number;
  readonly generatedDelta?: number;
  readonly moveDelta?: number;
  readonly pushDelta?: number;
}

function finiteCounter(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function countersFor(
  progress: SolverProgress | null,
  result: SolverResult | null,
): Readonly<Record<string, number>> | undefined {
  return result?.metrics.counters ?? progress?.counters;
}

/**
 * Converts worker telemetry into four explicitly defined populations. These
 * values describe counts, not spatial coordinates or a complete search graph.
 */
export function buildSearchPopulation(
  progress: SolverProgress | null,
  result: SolverResult | null,
): readonly SearchPopulationMetric[] {
  const counters = countersFor(progress, result);
  const generated = finiteCounter(
    result?.metrics.generatedStates ?? progress?.generatedStates,
  );
  const visited = finiteCounter(
    result?.metrics.expandedStates ?? progress?.expandedStates,
  );
  const frontier = finiteCounter(progress?.frontierSize);
  const pruned = finiteCounter(counters?.deadlockPrunes)
    + finiteCounter(counters?.infeasiblePrunes);
  return Object.freeze([
    Object.freeze({
      id: "generated",
      label: "Generated",
      value: generated,
      description: "Successor states produced before duplicate and pruning decisions.",
    }),
    Object.freeze({
      id: "visited",
      label: "Visited",
      value: visited,
      description: "States removed from the frontier and expanded by the algorithm.",
    }),
    Object.freeze({
      id: "frontier",
      label: "Frontier",
      value: frontier,
      description: "Queued states still waiting to be expanded at the latest update.",
    }),
    Object.freeze({
      id: "pruned",
      label: "Pruned",
      value: pruned,
      description: "States rejected by reported deadlock and infeasibility checks.",
    }),
  ]);
}

export function solutionActionLog(result: SolverResult): string | undefined {
  if (result.status !== "solved") return undefined;
  return result.solution.steps.map(({ direction }) => encodeDirection(direction)).join("");
}

export function compareSolverLabRuns(
  primary: SolverLabRunRecord,
  reference: SolverLabRunRecord,
): SolverLabComparison {
  const primarySolved = primary.result.status === "solved" ? primary.result : null;
  const referenceSolved = reference.result.status === "solved" ? reference.result : null;
  const primaryMetrics = primary.result.metrics;
  const referenceMetrics = reference.result.metrics;
  const primaryMode = primary.configuration.solverId === "sokomind-solver"
    ? primary.configuration.mode
    : "fixed";
  const referenceMode = reference.configuration.solverId === "sokomind-solver"
    ? reference.configuration.mode
    : "fixed";
  const sameLimits =
    primary.configuration.timeLimitMs === reference.configuration.timeLimitMs &&
    primary.configuration.memoryLimitMiB === reference.configuration.memoryLimitMiB &&
    primaryMode === referenceMode;
  return Object.freeze({
    sameInput:
      primary.puzzleId === reference.puzzleId &&
      primary.actionLog === reference.actionLog,
    sameLimits,
    elapsedDeltaMs: primaryMetrics.elapsedMs - referenceMetrics.elapsedMs,
    ...(primaryMetrics.expandedStates === undefined || referenceMetrics.expandedStates === undefined
      ? {}
      : { expandedDelta: primaryMetrics.expandedStates - referenceMetrics.expandedStates }),
    ...(primaryMetrics.generatedStates === undefined || referenceMetrics.generatedStates === undefined
      ? {}
      : { generatedDelta: primaryMetrics.generatedStates - referenceMetrics.generatedStates }),
    ...(!primarySolved || !referenceSolved
      ? {}
      : {
          moveDelta: primarySolved.solution.moves - referenceSolved.solution.moves,
          pushDelta: primarySolved.solution.pushes - referenceSolved.solution.pushes,
        }),
  });
}

export interface AlgorithmLesson {
  readonly strategy: string;
  readonly heuristic: string;
  readonly guarantee: string;
}

export function algorithmLesson(metadata: SolverMetadata): AlgorithmLesson {
  switch (metadata.id) {
    case "classic-dfs":
      return Object.freeze({
        strategy: "Follow one deterministic branch deeply before backtracking.",
        heuristic: "No cost heuristic chooses the next state; successor order drives exploration.",
        guarantee: "Returns a verified first route, not necessarily the shortest.",
      });
    case "classic-greedy":
      return Object.freeze({
        strategy: "Expand the state that currently appears closest to the goals.",
        heuristic: "Label-aware reverse-push assignment estimate; path cost is not part of priority.",
        guarantee: "Often finds a route quickly, without a shortest-route proof.",
      });
    case "classic-astar":
      return Object.freeze({
        strategy: "Balance exact moves already spent with an admissible remaining-cost bound.",
        heuristic: "Label-aware reverse-push assignment plus proof-safe search refinements.",
        guarantee: "Proves the minimum total-move route when allowed to finish.",
      });
    case "classic-ida-star":
      return Object.freeze({
        strategy: "Repeat depth-first contours under increasing estimated-cost thresholds.",
        heuristic: "The same admissible move bound used by exact A*, with lower frontier memory.",
        guarantee: "Proves the minimum total-move route when allowed to finish.",
      });
    case "sokomind-solver":
      return Object.freeze({
        strategy: "Coordinate structural, direct, and improvement searches within one portfolio.",
        heuristic: "Structural ordering and assignment guidance vary by Fast, Quality, or Optimal mode.",
        guarantee: "Every returned route is verified; only an explicit proof marks it optimal.",
      });
    default:
      return Object.freeze({
        strategy: "Run this adapter's documented search strategy in the shared worker contract.",
        heuristic: "This adapter does not publish a dedicated Solver Lab heuristic description yet.",
        guarantee: "Every returned route is replay-verified; consult the adapter metadata for stronger guarantees.",
      });
  }
}
