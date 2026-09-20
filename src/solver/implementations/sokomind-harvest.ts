import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
  SolverSolution,
} from "../contracts.ts";
import {
  IncumbentCollector,
  computeDiversitySignature,
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
  CandidateArchive,
  type RepairOperator,
} from "./sokomind-candidate-archive.ts";
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

  // ── Seed archive with harvested incumbents ────────────────────────────
  const archiveCapacity = Math.max(sokomindOptions.maximumIncumbents * 2, 8);
  const archive = new CandidateArchive(archiveCapacity);
  for (const incumbent of collector.incumbents) {
    archive.offer(
      incumbent.solution,
      { sourceOperator: "harvest", parentCandidateId: undefined, taskId: undefined, acceptedAt: run.context.now() },
      semanticDiversityTrace(run.request, incumbent.solution),
    );
  }
  run.budget.retainPersistent(archive.estimatedMemoryBytes);

  // ── Initial parallel rewrite wave on all diverse candidates ──────────
  const rewriteCandidates = selectForRewrite(collector.incumbents);
  const rewriteCount = rewriteCandidates.length;
  const rewriteConcurrency = sokomindRewriteConcurrency(
    maxWorkers, run.request.limits?.maxMemoryBytes, rewriteCount,
  );

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

    const archiveCandidates = archive.candidates.slice();
    const pending = rewriteCandidates.map((incumbent, candidateIndex) => {
      const archiveEntry = archiveCandidates.find((c) =>
        c.solution.moves === incumbent.solution.moves &&
        c.solution.pushes === incumbent.solution.pushes &&
        c.signature.pushChainKey === computeDiversitySignature(incumbent.solution, semanticDiversityTrace(run.request, incumbent.solution)).pushChainKey);
      return { incumbent, candidateIndex, archiveId: archiveEntry?.id ?? `wave-${candidateIndex}` };
    });
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
      await Promise.all(wave.map(async (
        { incumbent, candidateIndex, archiveId },
        waveIndex,
      ) => {
        const maxVisited = Math.min(
          visitedShares[waveIndex] ?? 0,
          rescheduleEligible ? 50_000 : Infinity,
        );
        const maxGenerated = generatedShares[waveIndex] ?? 0;
        if (maxVisited < 1 || maxGenerated < 1) return;
        const sliceStart = run.context.now();
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
        archive.recordOutcome({
          taskId: `wave-${candidateIndex}`,
          reason: improved.endReason,
          operator: "window",
          candidateId: archiveId,
          expanded: improved.expandedWork,
          generated: improved.generatedWork,
          elapsedMs: run.context.now() - sliceStart,
          improved: improved.improved,
        });
        if (improved.improved) {
          const oldBytes = archive.estimatedMemoryBytes;
          archive.offer(
            improved.solution,
            { sourceOperator: "window", parentCandidateId: archiveId, taskId: `wave-${candidateIndex}`, acceptedAt: run.context.now() },
            semanticDiversityTrace(run.request, improved.solution),
          );
          run.budget.updatePersistent(oldBytes, archive.estimatedMemoryBytes);
        }
      }));
    }
  }

  const best0 = archive.globalBest;
  if (best0) {
    run.bestSolutionMoves = Math.min(run.bestSolutionMoves, best0.solution.moves);
    invalidateAggregate(run);
  }

  run.progressPhase = "improving";
  report(run, `Starting anytime improvement loop (best=${archive.globalBest?.solution.moves ?? "?"} moves, archive=${archive.size} candidates).`, true);

  // ── Anytime loop: alternate between window-rewrite and box-reschedule ─
  const improvementDeadline = Number.isFinite(run.deadline)
    ? run.deadline
    : run.context.now() + configuredElapsed;
  let currentOp: RepairOperator = rewriteCount > 0 ? "box" : "window";
  let sliceIndex = 0;

  while (!run.context.signal.aborted) {
    const remainingMs = improvementDeadline - run.context.now();
    if (remainingMs < 1) break;

    // Check exhaustion across all archive candidates, not just stall count
    const windowExhausted = archive.allNeighborhoodsExhausted("window");
    const boxExhausted = !rescheduleEligible || archive.allNeighborhoodsExhausted("box");
    if (windowExhausted && boxExhausted) break;

    // Skip box reschedule if not eligible at all
    if (currentOp === "box" && !rescheduleEligible) {
      currentOp = "window";
      if (windowExhausted) break;
    }

    // Select a non-exhausted candidate for the current operator
    let target = archive.selectForRepair(currentOp);
    if (!target) {
      const other: RepairOperator = currentOp === "window" ? "box" : "window";
      if (other === "box" && !rescheduleEligible) break;
      target = archive.selectForRepair(other);
      if (!target) break;
      currentOp = other;
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
      `Slice ${sliceIndex + 1} (${currentOp} on ${target.id}, ${sliceMs}ms, best=${archive.globalBest?.solution.moves ?? "?"}).`,
      true,
    );

    const sliceStart = run.context.now();
    const improved = await improveIncumbent(
      run, state, target.solution, createWorker,
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

    archive.recordOutcome({
      taskId: `slice-${sliceIndex}`,
      reason: improved.endReason,
      operator: currentOp,
      candidateId: target.id,
      expanded: improved.expandedWork,
      generated: improved.generatedWork,
      elapsedMs: run.context.now() - sliceStart,
      improved: improved.improved,
    });

    sliceIndex += 1;
    run.qualitySlicesCompleted += 1;

    if (improved.cancelled) {
      run.budget.releasePersistent(archive.estimatedMemoryBytes);
      return Object.freeze({ status: "cancelled", metrics: metrics(run) });
    }

    if (improved.improved) {
      const oldBytes = archive.estimatedMemoryBytes;
      archive.offer(
        improved.solution,
        { sourceOperator: currentOp, parentCandidateId: target.id, taskId: `slice-${sliceIndex - 1}`, acceptedAt: run.context.now() },
        semanticDiversityTrace(run.request, improved.solution),
      );
      run.budget.updatePersistent(oldBytes, archive.estimatedMemoryBytes);
      run.bestSolutionMoves = Math.min(run.bestSolutionMoves, improved.solution.moves);
      invalidateAggregate(run);
      report(run, `Improved to ${improved.solution.moves} moves (${currentOp} on ${target.id}).`, true);
    } else {
      run.qualityOperatorStalls += 1;
    }

    // Alternate operator after each slice, picking whichever has non-exhausted work
    const other: RepairOperator = currentOp === "window" ? "box" : "window";
    if (other !== "box" || rescheduleEligible) {
      if (!archive.allNeighborhoodsExhausted(other)) {
        currentOp = other;
      }
    }
  }

  run.budget.releasePersistent(archive.estimatedMemoryBytes);

  if (run.context.signal.aborted) {
    return Object.freeze({ status: "cancelled", metrics: metrics(run) });
  }

  const best = archive.globalBest?.solution ?? firstIncumbent;
  return Object.freeze({
    status: "solved" as const,
    solution: Object.freeze({ ...best, optimality: "unknown" as const }),
    metrics: metrics(run),
  });
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
