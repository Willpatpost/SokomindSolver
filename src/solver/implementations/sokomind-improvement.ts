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
  type EnginePlan,
  type RewriteBudgetAllocation,
} from "./sokomind-plans.ts";
import type { SokomindEngineWorker } from "./sokomind-phase-runner.ts";
import { runPhase } from "./sokomind-phase-runner.ts";
import {
  invalidateAggregate,
  metrics,
  publishIncumbent,
  recordIncumbent,
  report,
  withRemainingLimits,
  type SearchRunState,
} from "./sokomind-run-state.ts";
import type { SokomindTuningProfile } from "./sokomind-tuning.ts";

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

/** Operator-specific targets chosen by the anytime coordinator. */
export type RepairContext = Readonly<{
  boxPairs?: readonly (readonly [number, number])[];
  targetOverrides?: Readonly<Record<number, string>>;
  prioritizedWindows?: readonly { readonly startPush: number; readonly endPush: number; readonly maxVisited: number }[];
}>;

/** One repair pass's budgets and inputs; each operator reads only its own. */
export interface RepairPlanInput {
  readonly state: import("./sokomind-legacy.ts").LegacyState;
  readonly solution: SolverSolution;
  readonly maxVisited: number;
  readonly maxGenerated: number;
  readonly maxElapsedMs: number;
  readonly pass: number;
  readonly profile: SokomindTuningProfile;
  readonly candidateIndex: number;
  readonly allocation: RewriteBudgetAllocation;
  readonly diagnostics: boolean;
  readonly rescheduleRounds: number;
  readonly context?: RepairContext;
}

/**
 * Chooses the engine plan for a repair operator. The switch is exhaustive, so
 * a new operator does not typecheck until it is given a plan here.
 */
export function repairPlan(operator: RepairOperator, input: RepairPlanInput): EnginePlan {
  const { state, solution, maxVisited, maxGenerated, maxElapsedMs, candidateIndex, context } = input;
  switch (operator) {
    case "box":
    case "goal-reassignment":
      return solutionReschedulingPlan(
        state, solution, maxVisited, maxGenerated, maxElapsedMs, candidateIndex,
        input.diagnostics, context?.targetOverrides, input.rescheduleRounds,
      );
    case "two-box":
      return solutionTwoBoxReschedulingPlan(
        state, solution, maxVisited, maxGenerated, maxElapsedMs, candidateIndex,
        context?.boxPairs ?? [], context?.targetOverrides,
      );
    case "dependency-window":
      return dependencyWindowImprovementPlan(
        state, solution, maxVisited, maxGenerated, candidateIndex,
        context?.prioritizedWindows ?? [],
      );
    // perturb-and-repair has no engine operator of its own yet, so it runs the
    // window rewrite.
    case "perturb-and-repair":
    case "window":
      return solutionImprovementPlan(
        state, solution, maxVisited, input.pass, input.profile, candidateIndex,
        maxGenerated, input.allocation,
      );
    default: {
      const unhandled: never = operator;
      throw new Error(`sokomind-solver: no plan for repair operator '${String(unhandled)}'`);
    }
  }
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
  repairContext?: RepairContext,
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
  const requestOptions = extractSokomindOptions(run.request);
  const liveMemoryRescheduling = (repair === "box" || repair === "two-box") &&
    requestOptions.mode === "quality";
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
  recordIncumbent(run, incumbent);
  report(
    run,
    `Improving the ${incumbent.moves}-move route within the remaining quality budget.`,
    true,
  );

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
        [repairPlan(repair, {
          state,
          solution: best,
          maxVisited: Math.floor(maxVisited),
          maxGenerated: Math.floor(maxGenerated),
          maxElapsedMs: Math.floor(remainingImprovementMs),
          pass,
          profile: run.profile,
          candidateIndex,
          allocation,
          diagnostics: requestOptions.diagnostics,
          rescheduleRounds: requestOptions.mode === "quality" ? 8 : 2,
          context: repairContext,
        })],
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
      publishIncumbent(run, candidate, `Improved to ${candidate.moves} moves.`);
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
