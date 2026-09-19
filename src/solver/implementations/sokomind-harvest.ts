import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
  SolverSolution,
} from "../contracts.ts";
import {
  IncumbentCollector,
  computeHarvestMs,
  isSolutionBetter,
  selectBest,
  selectForRewrite,
} from "./sokomind-incumbents.ts";
import {
  semanticDiversityTrace,
  type LegacyState,
  type SokomindAnalysisPlan,
} from "./sokomind-legacy.ts";
import type { SokomindRequestOptions } from "./sokomind-options.ts";
import {
  DEFAULT_IMPROVEMENT_MAX_ELAPSED_MS,
  DEFAULT_OPTIMAL_HARVEST_MS,
  QUALITY_ANYTIME_SLICE_CAP_MS,
  QUALITY_INITIAL_SLICE_MS,
  QUALITY_INITIAL_WAVE_CAP_MS,
  OPTIMAL_RESCHEDULE_TIME_SHARE,
  OPTIMAL_REWRITE_TIME_SHARE,
  adaptiveRewriteAllocation,
  configuredBudget,
  defaultImprovementMaxVisited,
  diversifiedHarvestPlans,
  dividedIntegerBudget,
  sokomindRewriteConcurrency,
  supportsBoxRescheduling,
} from "./sokomind-plans.ts";
import type { SokomindEngineWorker } from "./sokomind-phase-runner.ts";
import { runPhase } from "./sokomind-phase-runner.ts";
import {
  runConcurrentProof,
  runSequentialProof,
  type ProofCheckpointOptions,
  type SokomindProofWorker,
} from "./sokomind-proof.ts";
import { predictRescheduleValue } from "./sokomind-reschedule-predictor.ts";
import { improveIncumbent, type SokomindImprovementOptions } from "./sokomind-improvement.ts";
import {
  aggregate,
  invalidateAggregate,
  metrics,
  report,
  withRemainingLimits,
  type SearchRunState,
} from "./sokomind-run-state.ts";

export function runProof(
  request: SolverRequest,
  context: SolverExecutionContext,
  sokomindOptions: SokomindRequestOptions,
  discoveryResult: SolverResult,
  createProofWorker: () => SokomindProofWorker,
  checkpointOptions?: ProofCheckpointOptions,
): Promise<SolverResult> {
  if (sokomindOptions.proofParallelism > 1) {
    return runConcurrentProof(
      request,
      context,
      sokomindOptions,
      discoveryResult,
      {
        createProofWorker,
        proofParallelism: sokomindOptions.proofParallelism,
      },
    );
  }
  return runSequentialProof(
    request,
    context,
    sokomindOptions,
    discoveryResult,
    checkpointOptions,
  );
}

export async function harvestAndImprove(
  run: SearchRunState,
  state: LegacyState,
  firstIncumbent: SolverSolution,
  createWorker: () => SokomindEngineWorker,
  options: SokomindImprovementOptions,
  sokomindOptions: SokomindRequestOptions,
  tuning: Readonly<Record<string, number>>,
  maxWorkers: number,
  analysisPlan: SokomindAnalysisPlan | undefined,
  createProofWorker: () => SokomindProofWorker,
  checkpointOptions?: ProofCheckpointOptions,
): Promise<SolverResult> {
  const requestTimeMs = run.request.limits?.maxElapsedMs;
  const harvestMs = computeHarvestMs(sokomindOptions.harvestElapsedMs, requestTimeMs);

  const { collector, cancelled } = await harvestIncumbents(
    run, state, firstIncumbent, createWorker, sokomindOptions,
    tuning, maxWorkers, analysisPlan, harvestMs,
  );
  if (cancelled) {
    return Object.freeze({ status: "cancelled", metrics: metrics(run) });
  }

  const rewriteCandidates = selectForRewrite(collector.incumbents);
  const rewriteCount = rewriteCandidates.length;
  const rescheduleEligible = supportsBoxRescheduling(state);
  const reschedule = rescheduleEligible &&
    (sokomindOptions.mode !== "quality" || rewriteCandidates.length === 0 ||
      predictRescheduleValue(state, selectBest(rewriteCandidates)).recommendation !== "skip");
  const rewriteAllocation = adaptiveRewriteAllocation(run.request);

  run.progressPhase = "improving";
  report(
    run,
    `Rewriting ${rewriteCount} diverse incumbent(s) with divided budget.`,
    true,
  );

  const remainingRewriteRequest = withRemainingLimits(run);
  const configuredRewriteVisited = configuredBudget(
    options.improvementMaxVisited,
    defaultImprovementMaxVisited(run.request.limits?.maxMemoryBytes),
  );
  const totalRewriteVisited = Math.min(
    configuredRewriteVisited,
    remainingRewriteRequest?.limits?.maxExpandedStates ?? Infinity,
  );
  const configuredRewriteElapsed = configuredBudget(
    options.improvementMaxElapsedMs,
    DEFAULT_IMPROVEMENT_MAX_ELAPSED_MS,
  );
  const totalRewriteGenerated =
    remainingRewriteRequest?.limits?.maxGeneratedStates ?? Infinity;
  const rewriteConcurrency = sokomindRewriteConcurrency(
    maxWorkers,
    run.request.limits?.maxMemoryBytes,
    rewriteCount,
  );
  const rewriteStarted = aggregate(run);
  const rewriteDeadline = Math.min(
    run.deadline,
    run.context.now() + configuredRewriteElapsed,
  );
  const windowDeadline = reschedule
    ? run.context.now() + Math.max(0, rewriteDeadline - run.context.now()) * 0.75
    : rewriteDeadline;
  const rewrittenCandidates: Array<{
    solution: SolverSolution;
    discoveryOrder: number;
    improved: boolean;
  }> = collector.incumbents.map((incumbent) => ({
    solution: incumbent.solution,
    discoveryOrder: incumbent.discoveryOrder,
    improved: false,
  }));
  const pending = rewriteCandidates.map((incumbent, candidateIndex) => ({
    incumbent,
    candidateIndex,
  }));
  while (pending.length && !run.context.signal.aborted && rewriteConcurrency > 0) {
    const usage = aggregate(run);
    const remainingVisited = Math.max(
      0,
      totalRewriteVisited - (usage.expandedStates - rewriteStarted.expandedStates),
    );
    const remainingGenerated = Math.max(
      0,
      totalRewriteGenerated - (usage.generatedStates - rewriteStarted.generatedStates),
    );
    const remainingElapsed = Math.max(0, windowDeadline - run.context.now());
    if (remainingVisited < 1 || remainingGenerated < 1 || remainingElapsed < 1) break;

    const waveSize = Math.min(rewriteConcurrency, pending.length);
    const remainingWaves = Math.ceil(pending.length / rewriteConcurrency);
    const visitedShares = dividedIntegerBudget(remainingVisited, pending.length);
    const generatedShares = dividedIntegerBudget(remainingGenerated, pending.length);
    const perWorkerElapsed = Math.max(
      1,
      Math.floor(remainingElapsed / remainingWaves),
    );
    const wave = pending.splice(0, waveSize);
    const results = await Promise.all(wave.map(async (
      { incumbent, candidateIndex },
      waveIndex,
    ) => {
      const maxVisited = Math.min(visitedShares[waveIndex] ?? 0, reschedule ? 50_000 : Infinity);
      const maxGenerated = generatedShares[waveIndex] ?? 0;
      if (maxVisited < 1 || maxGenerated < 1) {
        return {
          solution: incumbent.solution,
          discoveryOrder: incumbent.discoveryOrder,
          improved: false,
        };
      }
      const adaptiveOptions: SokomindImprovementOptions = {
        ...options,
        improvementMaxVisited: maxVisited,
        improvementMaxElapsedMs: perWorkerElapsed,
        improvementMaxPasses: 1,
      };
      const improved = await improveIncumbent(
        run,
        state,
        incumbent.solution,
        createWorker,
        adaptiveOptions,
        candidateIndex,
        maxGenerated,
        waveSize,
        rewriteAllocation,
      );
      return {
        solution: improved.solution,
        discoveryOrder: incumbent.discoveryOrder,
        improved: improved.improved,
      };
    }));
    rewrittenCandidates.push(...results);
  }

  const productive = rewrittenCandidates.filter((candidate) => candidate.improved);
  const refinementCandidates = reschedule ? rewrittenCandidates : productive;
  if (refinementCandidates.length && !run.context.signal.aborted) {
    const usage = aggregate(run);
    const remainingVisited = Math.max(
      0,
      totalRewriteVisited - (usage.expandedStates - rewriteStarted.expandedStates),
    );
    const remainingGenerated = Math.max(
      0,
      totalRewriteGenerated - (usage.generatedStates - rewriteStarted.generatedStates),
    );
    const remainingElapsed = Math.max(0, rewriteDeadline - run.context.now());
    if (remainingVisited >= 1 && remainingGenerated >= 1 && remainingElapsed >= 1) {
      const bestProductiveSolution = selectBest(refinementCandidates);
      const bestProductive = refinementCandidates.find(
        (candidate) => candidate.solution === bestProductiveSolution,
      ) ?? refinementCandidates[0];
      const refinement = await improveIncumbent(
        run,
        state,
        bestProductive.solution,
        createWorker,
        {
          ...options,
          improvementMaxVisited: remainingVisited,
          improvementMaxElapsedMs: remainingElapsed,
          improvementMaxPasses: 1,
        },
        100 + bestProductive.discoveryOrder,
        remainingGenerated,
        1,
        rewriteAllocation,
        reschedule ? "box" : "window",
      );
      if (refinement.improved) {
        rewrittenCandidates.push({
          solution: refinement.solution,
          discoveryOrder: bestProductive.discoveryOrder,
          improved: true,
        });
      }
    }
  }

  const bestSolution = selectBest(rewrittenCandidates);
  run.bestSolutionMoves = bestSolution.moves;
  invalidateAggregate(run);

  if (run.context.signal.aborted) {
    return Object.freeze({ status: "cancelled", metrics: metrics(run) });
  }

  const discoveryResult: SolverResult = Object.freeze({
    status: "solved" as const,
    solution: bestSolution,
    metrics: metrics(run),
  });
  return runProof(
    run.request,
    run.context,
    sokomindOptions,
    discoveryResult,
    createProofWorker,
    checkpointOptions,
  );
}

// ---------------------------------------------------------------------------
// Shared harvest phase used by both Quality and Optimal anytime schedulers
// ---------------------------------------------------------------------------

async function harvestIncumbents(
  run: SearchRunState,
  state: LegacyState,
  firstIncumbent: SolverSolution,
  createWorker: () => SokomindEngineWorker,
  sokomindOptions: SokomindRequestOptions,
  tuning: Readonly<Record<string, number>>,
  maxWorkers: number,
  analysisPlan: SokomindAnalysisPlan | undefined,
  harvestBudgetMs: number,
): Promise<{ collector: IncumbentCollector; cancelled: boolean }> {
  const collector = new IncumbentCollector(sokomindOptions.maximumIncumbents);
  run.initialSolutionMoves ||= firstIncumbent.moves;
  run.bestSolutionMoves =
    run.bestSolutionMoves === 0
      ? firstIncumbent.moves
      : Math.min(run.bestSolutionMoves, firstIncumbent.moves);
  invalidateAggregate(run);
  collector.offer(
    firstIncumbent,
    semanticDiversityTrace(run.request, firstIncumbent),
  );

  run.progressPhase = "harvesting";
  report(run, `Harvesting diverse incumbents (${harvestBudgetMs}ms budget).`, true);

  const harvestDeadline = run.context.now() + harvestBudgetMs;
  let harvestRound = 0;
  let unproductiveRounds = 0;
  while (
    collector.incumbents.length < sokomindOptions.maximumIncumbents &&
    run.context.now() < harvestDeadline &&
    !run.context.signal.aborted
  ) {
    const remaining = harvestDeadline - run.context.now();
    if (remaining < 200) break;
    const harvestRequest = withRemainingLimits(run);
    if (!harvestRequest) break;
    const harvestWorkers = sokomindOptions.deterministic
      ? 1
      : Math.max(1, maxWorkers);
    const plans = diversifiedHarvestPlans(
      state, harvestRequest, harvestWorkers, tuning, harvestRound, analysisPlan,
    );
    try {
      const outcome = await runPhase(run, plans, createWorker, harvestWorkers, remaining, {
        collectSolutions: true,
        maxSolutions: plans.length,
      });
      const acceptedBefore = collector.stats.accepted;
      const bestBefore = collector.best?.solution;
      for (const solution of outcome.solutions ?? []) {
        collector.offer(solution, semanticDiversityTrace(run.request, solution));
      }
      const accepted = collector.stats.accepted - acceptedBefore;
      const bestAfter = collector.best?.solution;
      const improvedBest =
        bestAfter !== undefined &&
        (bestBefore === undefined || isSolutionBetter(bestAfter, bestBefore));
      if (bestAfter) {
        run.bestSolutionMoves = Math.min(run.bestSolutionMoves, bestAfter.moves);
        invalidateAggregate(run);
      }
      if (accepted > 0) {
        report(
          run,
          `Harvested ${collector.incumbents.length} incumbent(s) (${collector.stats.duplicatesRejected} duplicates rejected).`,
          true,
        );
      }
      const enoughRewriteChoices = collector.incumbents.length >= 3;
      const productive = accepted > 0 && (improvedBest || !enoughRewriteChoices);
      unproductiveRounds = productive ? 0 : unproductiveRounds + 1;
      harvestRound += 1;
      if (outcome.stopReason === "cancelled" || run.context.signal.aborted) break;
      if (unproductiveRounds >= 2) break;
    } catch (error) {
      run.suppressedHarvestErrors += 1;
      report(
        run,
        `Harvest round suppressed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
      break;
    }
  }
  return { collector, cancelled: run.context.signal.aborted };
}

// ---------------------------------------------------------------------------
// Quality: anytime improvement loop
// ---------------------------------------------------------------------------

export async function qualityAnytimeImprove(
  run: SearchRunState,
  state: LegacyState,
  firstIncumbent: SolverSolution,
  createWorker: () => SokomindEngineWorker,
  options: SokomindImprovementOptions,
  sokomindOptions: SokomindRequestOptions,
  tuning: Readonly<Record<string, number>>,
  maxWorkers: number,
  analysisPlan: SokomindAnalysisPlan | undefined,
  createProofWorker: () => SokomindProofWorker,
  checkpointOptions?: ProofCheckpointOptions,
): Promise<SolverResult> {
  const requestTimeMs = run.request.limits?.maxElapsedMs;
  const harvestMs = computeHarvestMs(sokomindOptions.harvestElapsedMs, requestTimeMs);

  const { collector, cancelled } = await harvestIncumbents(
    run, state, firstIncumbent, createWorker, sokomindOptions,
    tuning, maxWorkers, analysisPlan, harvestMs,
  );
  if (cancelled) {
    return Object.freeze({ status: "cancelled", metrics: metrics(run) });
  }

  const rewriteAllocation = adaptiveRewriteAllocation(run.request);
  const rescheduleEligible = supportsBoxRescheduling(state);
  const configuredRewriteVisited = configuredBudget(
    options.improvementMaxVisited,
    defaultImprovementMaxVisited(run.request.limits?.maxMemoryBytes),
  );
  const configuredElapsed = configuredBudget(
    options.improvementMaxElapsedMs,
    DEFAULT_IMPROVEMENT_MAX_ELAPSED_MS,
  );

  const improvementStartExpanded = aggregate(run).expandedStates;

  // ── Initial parallel rewrite wave on all diverse candidates ──────────
  const rewriteCandidates = selectForRewrite(collector.incumbents);
  const rewriteCount = rewriteCandidates.length;
  const rewriteConcurrency = sokomindRewriteConcurrency(
    maxWorkers, run.request.limits?.maxMemoryBytes, rewriteCount,
  );

  const rewrittenCandidates: Array<{
    solution: SolverSolution;
    discoveryOrder: number;
    improved: boolean;
  }> = collector.incumbents.map((incumbent) => ({
    solution: incumbent.solution,
    discoveryOrder: incumbent.discoveryOrder,
    improved: false,
  }));

  if (rewriteCount > 0 && rewriteConcurrency > 0 && !run.context.signal.aborted) {
    run.progressPhase = "improving";
    report(run, `Rewriting ${rewriteCount} diverse incumbent(s) in parallel.`, true);

    const initialWaveRequest = withRemainingLimits(run);
    const totalRewriteVisited = Math.min(
      configuredRewriteVisited,
      initialWaveRequest?.limits?.maxExpandedStates ?? Infinity,
    );
    const totalRewriteGenerated =
      initialWaveRequest?.limits?.maxGeneratedStates ?? Infinity;
    const initialWaveBudgetMs = Number.isFinite(run.deadline)
      ? Math.min(QUALITY_INITIAL_WAVE_CAP_MS, Math.floor((run.deadline - run.context.now()) * 0.4))
      : Math.min(QUALITY_INITIAL_WAVE_CAP_MS, configuredElapsed);
    const windowDeadline = Math.min(
      run.deadline,
      run.context.now() + initialWaveBudgetMs,
    );
    const rewriteStarted = aggregate(run);

    const pending = rewriteCandidates.map((incumbent, candidateIndex) => ({
      incumbent,
      candidateIndex,
    }));
    while (pending.length && !run.context.signal.aborted) {
      const usage = aggregate(run);
      const remainingVisited = Math.max(
        0,
        totalRewriteVisited - (usage.expandedStates - rewriteStarted.expandedStates),
      );
      const remainingGenerated = Math.max(
        0,
        totalRewriteGenerated - (usage.generatedStates - rewriteStarted.generatedStates),
      );
      const remainingElapsed = Math.max(0, windowDeadline - run.context.now());
      if (remainingVisited < 1 || remainingGenerated < 1 || remainingElapsed < 1) break;

      const waveSize = Math.min(rewriteConcurrency, pending.length);
      const remainingWaves = Math.ceil(pending.length / rewriteConcurrency);
      const visitedShares = dividedIntegerBudget(remainingVisited, pending.length);
      const generatedShares = dividedIntegerBudget(remainingGenerated, pending.length);
      const perWorkerElapsed = Math.max(1, Math.floor(remainingElapsed / remainingWaves));
      const wave = pending.splice(0, waveSize);
      const results = await Promise.all(wave.map(async (
        { incumbent, candidateIndex },
        waveIndex,
      ) => {
        const maxVisited = Math.min(
          visitedShares[waveIndex] ?? 0,
          rescheduleEligible ? 50_000 : Infinity,
        );
        const maxGenerated = generatedShares[waveIndex] ?? 0;
        if (maxVisited < 1 || maxGenerated < 1) {
          return {
            solution: incumbent.solution,
            discoveryOrder: incumbent.discoveryOrder,
            improved: false,
          };
        }
        const improved = await improveIncumbent(
          run, state, incumbent.solution, createWorker,
          {
            ...options,
            improvementMaxVisited: maxVisited,
            improvementMaxElapsedMs: perWorkerElapsed,
            improvementMaxPasses: 1,
          },
          candidateIndex,
          maxGenerated,
          waveSize,
          rewriteAllocation,
        );
        return {
          solution: improved.solution,
          discoveryOrder: incumbent.discoveryOrder,
          improved: improved.improved,
        };
      }));
      rewrittenCandidates.push(...results);
    }
  }

  let best = selectBest(rewrittenCandidates);
  run.bestSolutionMoves = Math.min(run.bestSolutionMoves, best.moves);
  invalidateAggregate(run);

  run.progressPhase = "improving";
  report(run, `Starting anytime improvement loop (best=${best.moves} moves from ${rewriteCount} rewritten candidates).`, true);

  // ── Anytime loop: alternate between window-rewrite and box-reschedule ─
  const improvementDeadline = Number.isFinite(run.deadline)
    ? run.deadline
    : run.context.now() + configuredElapsed;
  type Operator = "window" | "box";
  const stalls: Record<Operator, number> = { window: 0, box: 0 };
  const MAX_STALLS = 3;
  let currentOp: Operator = rewriteCount > 0 ? "box" : "window";
  let sliceIndex = 0;

  while (!run.context.signal.aborted) {
    const remainingMs = improvementDeadline - run.context.now();
    if (remainingMs < 1) break;

    // Both operators stalled — stop improving
    if (stalls.window >= MAX_STALLS && stalls.box >= MAX_STALLS) break;

    // Current operator stalled — try the other
    if (stalls[currentOp] >= 2) {
      const other: Operator = currentOp === "window" ? "box" : "window";
      if (stalls[other] < MAX_STALLS) {
        currentOp = other;
      } else {
        break;
      }
    }

    // Skip box reschedule if not eligible
    if (currentOp === "box" && !rescheduleEligible) {
      stalls.box = MAX_STALLS;
      currentOp = "window";
      if (stalls.window >= MAX_STALLS) break;
    }

    const progressiveCap = Math.min(
      QUALITY_ANYTIME_SLICE_CAP_MS,
      QUALITY_INITIAL_SLICE_MS * (2 ** Math.min(sliceIndex, 4)),
    );
    const sliceMs = Math.min(progressiveCap, Math.floor(remainingMs / 2));
    if (sliceMs < 1) break;

    const improvementConsumed = aggregate(run).expandedStates - improvementStartExpanded;
    const remainingImprovementBudget = Math.max(0, configuredRewriteVisited - improvementConsumed);
    if (remainingImprovementBudget < 1) break;

    const remainingRequest = withRemainingLimits(run);
    if (!remainingRequest) break;

    const perSliceVisited = Math.min(
      remainingImprovementBudget,
      remainingRequest.limits?.maxExpandedStates ?? Infinity,
      currentOp === "window" && rescheduleEligible ? 50_000 : Infinity,
    );
    const maxGenerated = remainingRequest.limits?.maxGeneratedStates ?? Infinity;
    if (perSliceVisited < 1 || maxGenerated < 1) break;

    report(
      run,
      `Improvement slice ${sliceIndex + 1} (${currentOp}, ${sliceMs}ms budget, best=${best.moves} moves).`,
      true,
    );

    const improved = await improveIncumbent(
      run, state, best, createWorker,
      {
        ...options,
        improvementMaxVisited: perSliceVisited,
        improvementMaxElapsedMs: sliceMs,
        improvementMaxPasses: 1,
      },
      sliceIndex,
      maxGenerated,
      1,
      rewriteAllocation,
      currentOp,
    );

    sliceIndex += 1;
    run.qualitySlicesCompleted += 1;

    if (improved.cancelled) {
      return Object.freeze({ status: "cancelled", metrics: metrics(run) });
    }

    if (improved.improved) {
      best = improved.solution;
      run.bestSolutionMoves = Math.min(run.bestSolutionMoves, best.moves);
      invalidateAggregate(run);
      stalls[currentOp] = 0;
      report(run, `Improved to ${best.moves} moves (${currentOp}).`, true);
    } else {
      stalls[currentOp] += 1;
      run.qualityOperatorStalls += 1;
    }

    // Alternate operator after each slice
    const other: Operator = currentOp === "window" ? "box" : "window";
    if (stalls[other] < MAX_STALLS && (other !== "box" || rescheduleEligible)) {
      currentOp = other;
    }
  }

  if (run.context.signal.aborted) {
    return Object.freeze({ status: "cancelled", metrics: metrics(run) });
  }

  const discoveryResult: SolverResult = Object.freeze({
    status: "solved" as const,
    solution: best,
    metrics: metrics(run),
  });
  return runProof(
    run.request, run.context, sokomindOptions, discoveryResult,
    createProofWorker, checkpointOptions,
  );
}

// ---------------------------------------------------------------------------
// Optimal: quick improvement then early proof
// ---------------------------------------------------------------------------

export async function optimalQuickImprove(
  run: SearchRunState,
  state: LegacyState,
  firstIncumbent: SolverSolution,
  createWorker: () => SokomindEngineWorker,
  options: SokomindImprovementOptions,
  sokomindOptions: SokomindRequestOptions,
  tuning: Readonly<Record<string, number>>,
  maxWorkers: number,
  analysisPlan: SokomindAnalysisPlan | undefined,
  createProofWorker: () => SokomindProofWorker,
  checkpointOptions?: ProofCheckpointOptions,
): Promise<SolverResult> {
  const requestTimeMs = run.request.limits?.maxElapsedMs;
  const harvestMs = Math.min(
    DEFAULT_OPTIMAL_HARVEST_MS,
    computeHarvestMs(sokomindOptions.harvestElapsedMs, requestTimeMs),
  );

  const { collector, cancelled } = await harvestIncumbents(
    run, state, firstIncumbent, createWorker, sokomindOptions,
    tuning, maxWorkers, analysisPlan, harvestMs,
  );
  if (cancelled) {
    return Object.freeze({ status: "cancelled", metrics: metrics(run) });
  }

  let best = selectBest(
    collector.incumbents.map((inc) => ({
      solution: inc.solution,
      discoveryOrder: inc.discoveryOrder,
    })),
  );

  const rewriteAllocation = adaptiveRewriteAllocation(run.request);
  const rescheduleEligible = supportsBoxRescheduling(state);
  const totalBudgetMs = requestTimeMs ?? Infinity;
  const configuredElapsed = configuredBudget(options.improvementMaxElapsedMs, DEFAULT_IMPROVEMENT_MAX_ELAPSED_MS);

  // Quick window-rewrite: 15% of total budget cap
  const rewriteMs = Math.min(
    Number.isFinite(totalBudgetMs) ? Math.floor(totalBudgetMs * OPTIMAL_REWRITE_TIME_SHARE) : configuredElapsed,
    Number.isFinite(run.deadline) ? Math.max(0, Math.floor(run.deadline - run.context.now() - 2000)) : configuredElapsed,
  );
  if (rewriteMs >= 500 && !run.context.signal.aborted) {
    run.progressPhase = "improving";
    report(run, `Quick rewrite (${rewriteMs}ms budget).`, true);

    const remainingRequest = withRemainingLimits(run);
    if (remainingRequest) {
      const maxVisited = Math.min(
        configuredBudget(options.improvementMaxVisited, defaultImprovementMaxVisited(run.request.limits?.maxMemoryBytes)),
        remainingRequest.limits?.maxExpandedStates ?? Infinity,
        rescheduleEligible ? 50_000 : Infinity,
      );
      const maxGenerated = remainingRequest.limits?.maxGeneratedStates ?? Infinity;
      if (maxVisited >= 1 && maxGenerated >= 1) {
        const improved = await improveIncumbent(
          run, state, best, createWorker,
          { ...options, improvementMaxVisited: maxVisited, improvementMaxElapsedMs: rewriteMs, improvementMaxPasses: 1 },
          0, maxGenerated, 1, rewriteAllocation, "window",
        );
        if (improved.cancelled) {
          return Object.freeze({ status: "cancelled", metrics: metrics(run) });
        }
        if (improved.improved) {
          best = improved.solution;
          run.bestSolutionMoves = Math.min(run.bestSolutionMoves, best.moves);
          invalidateAggregate(run);
        }
      }
    }
  }

  // Quick box-reschedule: 10% of total budget cap
  const rescheduleMs = Math.min(
    Number.isFinite(totalBudgetMs) ? Math.floor(totalBudgetMs * OPTIMAL_RESCHEDULE_TIME_SHARE) : configuredElapsed,
    Number.isFinite(run.deadline) ? Math.max(0, Math.floor(run.deadline - run.context.now() - 2000)) : configuredElapsed,
  );
  if (rescheduleEligible && rescheduleMs >= 500 && !run.context.signal.aborted) {
    report(run, `Quick reschedule (${rescheduleMs}ms budget).`, true);

    const remainingRequest = withRemainingLimits(run);
    if (remainingRequest) {
      const maxVisited = Math.min(
        configuredBudget(options.improvementMaxVisited, defaultImprovementMaxVisited(run.request.limits?.maxMemoryBytes)),
        remainingRequest.limits?.maxExpandedStates ?? Infinity,
      );
      const maxGenerated = remainingRequest.limits?.maxGeneratedStates ?? Infinity;
      if (maxVisited >= 1 && maxGenerated >= 1) {
        const improved = await improveIncumbent(
          run, state, best, createWorker,
          { ...options, improvementMaxVisited: maxVisited, improvementMaxElapsedMs: rescheduleMs, improvementMaxPasses: 1 },
          1, maxGenerated, 1, rewriteAllocation, "box",
        );
        if (improved.cancelled) {
          return Object.freeze({ status: "cancelled", metrics: metrics(run) });
        }
        if (improved.improved) {
          best = improved.solution;
          run.bestSolutionMoves = Math.min(run.bestSolutionMoves, best.moves);
          invalidateAggregate(run);
        }
      }
    }
  }

  if (run.context.signal.aborted) {
    return Object.freeze({ status: "cancelled", metrics: metrics(run) });
  }

  const discoveryResult: SolverResult = Object.freeze({
    status: "solved" as const,
    solution: best,
    metrics: metrics(run),
  });
  return runProof(
    run.request, run.context, sokomindOptions, discoveryResult,
    createProofWorker, checkpointOptions,
  );
}
