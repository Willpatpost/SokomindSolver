import type {
  SolverResult,
  SolverSolution,
} from "../contracts.ts";
import { isSolutionBetter } from "./sokomind-incumbents.ts";
import { extractSokomindOptions, type SokomindRequestOptions } from "./sokomind-options.ts";
import {
  MEMORY_TIER_LOW,
  MEMORY_TIER_MEDIUM,
  configuredBudget,
  defaultImprovementMaxVisited,
  DEFAULT_IMPROVEMENT_MAX_ELAPSED_MS,
  DEFAULT_IMPROVEMENT_MINIMUM_MOVES,
  DEFAULT_REWRITE_BUDGET_ALLOCATION,
  dependencyWindowImprovementPlan,
  solutionImprovementPlan,
  solutionReschedulingPlan,
  solutionTwoBoxReschedulingPlan,
  type RewriteBudgetAllocation,
} from "./sokomind-plans.ts";
import type { SokomindEngineWorker } from "./sokomind-phase-runner.ts";
import { runPhase } from "./sokomind-phase-runner.ts";
import {
  aggregate,
  elapsed,
  invalidateAggregate,
  metrics,
  report,
  withRemainingLimits,
  type SearchRunState,
} from "./sokomind-run-state.ts";

export interface SokomindImprovementOptions {
  readonly improvementMaxVisited?: number;
  readonly improvementMaxElapsedMs?: number;
  readonly improvementMaxPasses?: number;
  readonly improvementMinimumMoves?: number;
  readonly improvementMaxMemoryBytes?: number;
  readonly onCandidatePublished?: (solution: SolverSolution) => void;
}

export type { TaskEndReason } from "./sokomind-candidate-archive.ts";
import type { RepairOperator, TaskEndReason } from "./sokomind-candidate-archive.ts";

export interface ImprovedIncumbent {
  readonly solution: SolverSolution;
  readonly cancelled: boolean;
  readonly improved: boolean;
  readonly endReason: TaskEndReason;
  readonly expandedWork: number;
  readonly generatedWork: number;
}

export async function improveIncumbent(
  run: SearchRunState,
  state: import("./sokomind-legacy.ts").LegacyState,
  incumbent: SolverSolution,
  createWorker: () => SokomindEngineWorker,
  options: SokomindImprovementOptions,
  candidateIndex = 0,
  reservedGenerated = Infinity,
  memoryConcurrency = 1,
  allocation: RewriteBudgetAllocation = DEFAULT_REWRITE_BUDGET_ALLOCATION,
  repair: RepairOperator = "window",
  repairContext?: Readonly<{
    boxPairs?: readonly (readonly [number, number])[];
    targetOverrides?: Readonly<Record<number, string>>;
    prioritizedWindows?: readonly { readonly startPush: number; readonly endPush: number; readonly maxVisited: number }[];
  }>,
): Promise<ImprovedIncumbent> {
  run.initialSolutionMoves ||= incumbent.moves;
  run.bestSolutionMoves =
    run.bestSolutionMoves === 0
      ? incumbent.moves
      : Math.min(run.bestSolutionMoves, incumbent.moves);
  invalidateAggregate(run);

  const minimumMoves = configuredBudget(
    options.improvementMinimumMoves,
    DEFAULT_IMPROVEMENT_MINIMUM_MOVES,
  );
  const memoryLimit = run.request.limits?.maxMemoryBytes ?? Infinity;
  const scaledDefault = defaultImprovementMaxVisited(run.request.limits?.maxMemoryBytes);
  const liveMemoryRescheduling = (repair === "box" || repair === "two-box") &&
    extractSokomindOptions(run.request).mode === "quality";
  const memoryVisitedCap =
    liveMemoryRescheduling
      ? Infinity
      : memoryLimit <= MEMORY_TIER_LOW
      ? 20_000
      : memoryLimit <= MEMORY_TIER_MEDIUM
        ? 35_000
        : scaledDefault;
  const configuredVisited = Math.min(
    configuredBudget(
      options.improvementMaxVisited,
      scaledDefault,
    ),
    memoryVisitedCap,
  );
  const maxElapsedMs = configuredBudget(
    options.improvementMaxElapsedMs,
    DEFAULT_IMPROVEMENT_MAX_ELAPSED_MS,
  );
  const requestedElapsedMs = run.request.limits?.maxElapsedMs;
  const defaultPasses =
    requestedElapsedMs !== undefined && requestedElapsedMs >= 90_000 ? 2 : 1;
  const maxPasses = configuredBudget(
    options.improvementMaxPasses,
    defaultPasses,
  );
  if (
    incumbent.moves < minimumMoves ||
    configuredVisited === 0 ||
    maxElapsedMs === 0 ||
    maxPasses === 0
  ) {
    return Object.freeze({
      solution: incumbent, cancelled: false, improved: false,
      endReason: "ineligible" as TaskEndReason, expandedWork: 0, generatedWork: 0,
    });
  }

  run.progressPhase = "improving";
  const snapshot = aggregate(run);
  run.context.reportProgress({
    phase: "improving",
    elapsedMs: elapsed(run),
    expandedStates: snapshot.expandedStates,
    generatedStates: snapshot.generatedStates,
    frontierSize: snapshot.frontierSize,
    counters: snapshot.counters,
    incumbent: {
      moves: incumbent.moves,
      pushes: incumbent.pushes,
      objectiveScore: incumbent.objectiveScore,
    },
    detail: `Improving the ${incumbent.moves}-move route within the remaining quality budget.`,
  });

  let best = incumbent;
  let endReason: TaskEndReason = "completed-pass";
  let expandedWork = 0;
  let generatedWork = 0;
  const improvementDeadline = Math.min(
    run.deadline,
    run.context.now() + maxElapsedMs,
  );
  const singlePassRepair = repair === "box" || repair === "two-box" || repair === "goal-reassignment";
  for (let pass = 1; pass <= (singlePassRepair ? 1 : maxPasses); pass += 1) {
    const remainingImprovementMs = Math.max(
      0,
      improvementDeadline - run.context.now(),
    );
    if (remainingImprovementMs < 1) break;
    const remainingRequest = withRemainingLimits(run);
    if (!remainingRequest) break;
    const maxVisited = Math.min(
      configuredVisited,
      remainingRequest.limits?.maxExpandedStates ?? Infinity,
    );
    const finiteGeneratedBudget = Number.isFinite(reservedGenerated)
      ? reservedGenerated
      : Math.max(maxVisited, maxVisited * 8);
    const maxGenerated = Math.min(
      finiteGeneratedBudget,
      remainingRequest.limits?.maxGeneratedStates ?? Infinity,
    );
    if (maxVisited < 1 || maxGenerated < 1) break;

    try {
      const outcome = await runPhase(
        run,
        [
          repair === "box" || repair === "goal-reassignment"
            ? solutionReschedulingPlan(
                state, best, Math.floor(maxVisited), Math.floor(maxGenerated),
                Math.floor(remainingImprovementMs), candidateIndex,
                extractSokomindOptions(run.request).diagnostics,
                repairContext?.targetOverrides,
                extractSokomindOptions(run.request).mode === "quality" ? 8 : 2,
              )
            : repair === "two-box"
              ? solutionTwoBoxReschedulingPlan(
                  state, best, Math.floor(maxVisited), Math.floor(maxGenerated),
                  Math.floor(remainingImprovementMs), candidateIndex,
                  repairContext?.boxPairs ?? [],
                  repairContext?.targetOverrides,
                )
              : repair === "dependency-window"
                ? dependencyWindowImprovementPlan(
                    state, best, Math.floor(maxVisited), Math.floor(maxGenerated),
                    candidateIndex,
                    repairContext?.prioritizedWindows ?? [],
                  )
                : solutionImprovementPlan(
                    state,
                    best,
                    Math.floor(maxVisited),
                    pass,
                    run.profile,
                    candidateIndex,
                    Math.floor(maxGenerated),
                    allocation,
                  ),
        ],
        createWorker,
        1,
        Math.max(1, Math.floor(remainingImprovementMs)),
        {
          memoryConcurrency,
          memoryLimitBytes: options.improvementMaxMemoryBytes,
          onSolutionPublished: options.onCandidatePublished,
        },
      );
      expandedWork += outcome.expandedWork;
      generatedWork += outcome.generatedWork;
      if (
        outcome.stopReason === "cancelled" ||
        run.context.signal.aborted
      ) {
        endReason = "cancelled";
        return Object.freeze({
          solution: best,
          cancelled: true,
          improved: isSolutionBetter(best, incumbent),
          endReason,
          expandedWork,
          generatedWork,
        });
      }
      const cutoffReason: TaskEndReason | undefined =
        outcome.phaseTimedOut ? "time-cutoff" :
        outcome.stopReason === "expanded" || outcome.localStopReason === "expanded" ? "expanded-cutoff" :
        outcome.stopReason === "generated" || outcome.localStopReason === "generated" ? "generated-cutoff" :
        outcome.stopReason === "memory" || outcome.localStopReason === "memory" ? "memory-cutoff" :
        outcome.stopReason === "elapsed" || outcome.localStopReason === "elapsed" ? "time-cutoff" :
        undefined;
      const candidate = outcome.solution;
      if (!candidate || !isSolutionBetter(candidate, best)) {
        endReason = cutoffReason ?? "exhausted";
        break;
      }
      best = candidate;
      run.solutionImprovements += 1;
      invalidateAggregate(run);
      run.bestSolutionMoves =
        run.bestSolutionMoves === 0
          ? candidate.moves
          : Math.min(run.bestSolutionMoves, candidate.moves);
      if (cutoffReason) { endReason = cutoffReason; break; }
      if (outcome.stopReason) break;
    } catch (error) {
      run.suppressedImprovementErrors += 1;
      report(
        run,
        `Improvement pass suppressed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
      endReason = "failed";
      break;
    }
  }
  return Object.freeze({
    solution: best,
    cancelled: false,
    improved: isSolutionBetter(best, incumbent),
    endReason,
    expandedWork,
    generatedWork,
  });
}

export async function solvedWithImprovement(
  run: SearchRunState,
  state: import("./sokomind-legacy.ts").LegacyState,
  incumbent: SolverSolution,
  createWorker: () => SokomindEngineWorker,
  options: SokomindImprovementOptions,
  sokomindOptions: SokomindRequestOptions,
  improveByMode: (
    run: SearchRunState,
    state: import("./sokomind-legacy.ts").LegacyState,
    firstIncumbent: SolverSolution,
    createWorker: () => SokomindEngineWorker,
    options: SokomindImprovementOptions,
    sokomindOptions: SokomindRequestOptions,
    tuning: Readonly<Record<string, number>>,
    maxWorkers: number,
    analysisPlan?: import("./sokomind-legacy.ts").SokomindAnalysisPlan,
  ) => Promise<SolverResult>,
  tuning: Readonly<Record<string, number>>,
  maxWorkers: number,
  analysisPlan?: import("./sokomind-legacy.ts").SokomindAnalysisPlan,
): Promise<SolverResult> {
  if (sokomindOptions.mode === "fast") {
    run.initialSolutionMoves ||= incumbent.moves;
    run.bestSolutionMoves =
      run.bestSolutionMoves === 0
        ? incumbent.moves
        : Math.min(run.bestSolutionMoves, incumbent.moves);
    invalidateAggregate(run);
    return Object.freeze({
      status: "solved" as const,
      solution: incumbent,
      metrics: metrics(run),
    });
  }

  return improveByMode(
    run,
    state,
    incumbent,
    createWorker,
    options,
    sokomindOptions,
    tuning,
    maxWorkers,
    analysisPlan,
  );
}
