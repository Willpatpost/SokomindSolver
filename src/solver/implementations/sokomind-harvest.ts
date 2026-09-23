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
import { improveIncumbent, type ImprovedIncumbent, type SokomindImprovementOptions } from "./sokomind-improvement.ts";
import {
  CandidateArchive,
  type ArchivedCandidate,
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
// Operator context helpers for broader repair neighborhoods
// ---------------------------------------------------------------------------

function selectBoxPairs(
  request: SolverRequest,
  solution: SolverSolution,
): readonly (readonly [number, number])[] {
  const trace = semanticDiversityTrace(request, solution);
  if (!trace) return [];
  const pushEntries = trace.pushChain.split(";").filter(Boolean);
  if (pushEntries.length < 2) return [];
  const boxIndices = pushEntries.map((entry) => {
    const hash = entry.indexOf("#");
    const colon = entry.indexOf(":", hash);
    return hash >= 0 && colon > hash ? Number(entry.slice(hash + 1, colon)) : -1;
  }).filter((i) => i >= 0);
  const interactionScore = new Map<string, number>();
  for (let i = 0; i < boxIndices.length - 1; i++) {
    const a = boxIndices[i], b = boxIndices[i + 1];
    if (a === b) continue;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    interactionScore.set(key, (interactionScore.get(key) ?? 0) + 1);
  }
  return [...interactionScore]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([key]) => key.split(",").map(Number) as [number, number]);
}

function selectGoalReassignmentOverrides(
  request: SolverRequest,
  solution: SolverSolution,
): Readonly<Record<number, string>> | undefined {
  const trace = semanticDiversityTrace(request, solution);
  if (!trace) return undefined;
  const goalEntries = trace.boxGoals.split(";").filter(Boolean);
  const boxGoalMap = new Map<number, string>();
  for (const entry of goalEntries) {
    const hash = entry.indexOf("#");
    const arrow = entry.indexOf(">", hash);
    if (hash < 0 || arrow < 0) continue;
    const boxIndex = Number(entry.slice(hash + 1, arrow));
    const goalCell = entry.slice(arrow + 1);
    if (!Number.isFinite(boxIndex) || boxIndex < 0) continue;
    boxGoalMap.set(boxIndex, goalCell);
  }
  const boxes = request.snapshot.boxes;
  const labelGroups = new Map<string, number[]>();
  for (let i = 0; i < boxes.length; i++) {
    const group = labelGroups.get(boxes[i].label) ?? [];
    group.push(i);
    labelGroups.set(boxes[i].label, group);
  }
  for (const [, group] of labelGroups) {
    if (group.length < 2) continue;
    const a = group[0], b = group[1];
    const goalA = boxGoalMap.get(a), goalB = boxGoalMap.get(b);
    if (!goalA || !goalB || goalA === goalB) continue;
    return { [a]: goalB, [b]: goalA };
  }
  return undefined;
}

function analyzePushInteractions(
  request: SolverRequest,
  solution: SolverSolution,
): readonly { readonly startPush: number; readonly endPush: number; readonly maxVisited: number }[] {
  const trace = semanticDiversityTrace(request, solution);
  if (!trace) return [];
  const pushEntries = trace.pushChain.split(";").filter(Boolean);
  if (pushEntries.length < 4) return [];
  const boxIds = pushEntries.map((entry) => {
    const hash = entry.indexOf("#");
    const colon = entry.indexOf(":", hash);
    return hash >= 0 && colon > hash ? Number(entry.slice(hash + 1, colon)) : -1;
  });
  const windowSize = 6;
  const clusters: { startPush: number; endPush: number; maxVisited: number }[] = [];
  let clusterStart = -1;
  for (let i = 0; i < boxIds.length - 1; i++) {
    const boxA = boxIds[i];
    let interacting = false;
    for (let j = i + 1; j < Math.min(i + windowSize, boxIds.length); j++) {
      if (boxIds[j] !== boxA) { interacting = true; break; }
    }
    if (interacting) {
      if (clusterStart < 0) clusterStart = i;
    } else if (clusterStart >= 0) {
      clusters.push({ startPush: clusterStart, endPush: Math.min(i + 1, boxIds.length), maxVisited: 20_000 });
      clusterStart = -1;
    }
  }
  if (clusterStart >= 0) {
    clusters.push({ startPush: clusterStart, endPush: boxIds.length, maxVisited: 20_000 });
  }
  return clusters.slice(0, 8);
}

function evenlySpacedCandidates(
  candidates: readonly ArchivedCandidate[],
  count: number,
): readonly ArchivedCandidate[] {
  if (count <= 0 || candidates.length === 0) return [];
  if (count >= candidates.length) return [...candidates];
  if (count === 1) return [candidates[0]];
  const selected: ArchivedCandidate[] = [];
  for (let index = 0; index < count; index += 1) {
    selected.push(candidates[Math.round(
      index * (candidates.length - 1) / (count - 1),
    )]);
  }
  return selected;
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

  // ── Seed archive with harvested incumbents ────────────────────────────
  const archiveCapacity = Math.max(sokomindOptions.maximumIncumbents * 8, 32);
  const configuredMemory = run.request.limits?.maxMemoryBytes;
  const archiveByteLimit = configuredMemory !== undefined && Number.isFinite(configuredMemory)
    ? Math.max(1, Math.min(64 * 1024 * 1024, Math.floor(configuredMemory * 0.02)))
    : 32 * 1024 * 1024;
  const archive = new CandidateArchive(archiveCapacity, archiveByteLimit);
  for (const incumbent of collector.incumbents) {
    archive.offer(
      incumbent.solution,
      { sourceOperator: "harvest", parentCandidateId: undefined, taskId: undefined, acceptedAt: run.context.now() },
      semanticDiversityTrace(run.request, incumbent.solution),
    );
  }
  run.budget.retainPersistent(archive.estimatedMemoryBytes);
  const improvementStarted = aggregate(run);
  const localVisitedCap = configuredBudget(
    options.improvementMaxVisited,
    defaultImprovementMaxVisited(run.request.limits?.maxMemoryBytes),
  );
  const qualityVisitedBudget = options.improvementMaxVisited === undefined
    ? Infinity
    : configuredBudget(options.improvementMaxVisited, localVisitedCap);

  function offerArchived(
    solution: SolverSolution,
    provenance: Parameters<CandidateArchive["offer"]>[1],
  ): boolean {
    const oldBytes = archive.estimatedMemoryBytes;
    const accepted = archive.offer(
      solution,
      provenance,
      semanticDiversityTrace(run.request, solution),
    );
    run.budget.updatePersistent(oldBytes, archive.estimatedMemoryBytes);
    if (accepted) {
      run.bestSolutionMoves = run.bestSolutionMoves === 0
        ? solution.moves
        : Math.min(run.bestSolutionMoves, solution.moves);
      invalidateAggregate(run);
    }
    return accepted;
  }

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
      initialWaveRequest?.limits?.maxExpandedStates ?? localVisitedCap,
      localVisitedCap,
      qualityVisitedBudget,
    );
    const totalRewriteGenerated =
      initialWaveRequest?.limits?.maxGeneratedStates ?? Infinity;
    // Keep the initial rewrite from consuming the entire short-run remainder.
    // Verified publications are archived during the wave; reserve most of the
    // remaining time for complementary box/window repairs over those basins.
    const initialWaveBudgetMs = Number.isFinite(run.deadline)
      ? Math.min(
          QUALITY_INITIAL_WAVE_CAP_MS,
          Math.max(0, Math.floor((run.deadline - run.context.now()) * 0.35)),
        )
      : QUALITY_INITIAL_WAVE_CAP_MS;
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
      const perWorkerElapsed = Math.max(1, Math.min(
        Math.floor(remainingElapsed / remainingWaves),
        configuredBudget(options.improvementMaxElapsedMs, QUALITY_INITIAL_WAVE_CAP_MS),
      ));
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
            onCandidatePublished: (solution) => {
              offerArchived(solution, {
                sourceOperator: "window",
                parentCandidateId: archiveId,
                taskId: `wave-${candidateIndex}`,
                acceptedAt: run.context.now(),
              });
            },
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
          offerArchived(
            improved.solution,
            { sourceOperator: "window", parentCandidateId: archiveId, taskId: `wave-${candidateIndex}`, acceptedAt: run.context.now() },
          );
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

  // ── Anytime loop: parallel task-slot coordinator ─────────────────────
  const maxSlots = Math.max(1, sokomindRewriteConcurrency(
    maxWorkers, run.request.limits?.maxMemoryBytes, archive.size,
  ));
  let sliceIndex = 0;
  const enabledOperators: RepairOperator[] = ["window"];
  if (rescheduleEligible) enabledOperators.push("box");
  for (const exp of sokomindOptions.experimentalOperators) {
    if (exp === "two-box" && rescheduleEligible) enabledOperators.push("two-box");
    else if (exp === "goal-reassignment" && rescheduleEligible) enabledOperators.push("goal-reassignment");
    else if (exp === "dependency-window") enabledOperators.push("dependency-window");
    else if (exp === "perturb-and-repair") enabledOperators.push("perturb-and-repair");
  }
  let nextOpIndex = rewriteCount > 0 && enabledOperators.length > 1 ? 1 : 0;
  let slotCancelled = false;

  interface SlotResult {
    readonly taskId: string;
    readonly candidateId: string;
    readonly operator: RepairOperator;
    readonly improved: ImprovedIncumbent;
    readonly leasedExpanded: number;
    readonly leasedGenerated: number;
  }

  const activeSlots = new Map<string, Promise<SlotResult>>();
  let leasedExpanded = 0;
  let leasedGenerated = 0;
  const taskMemoryBytes = configuredMemory !== undefined && Number.isFinite(configuredMemory)
    ? Math.max(1, Math.floor(Math.max(
        0,
        configuredMemory -
          run.budget.coordinatorEstimatedMemoryBytes -
          run.budget.preparedBoardEstimatedMemoryBytes -
          archive.estimatedMemoryBytes,
      ) / maxSlots))
    : undefined;
  const initialBoxPortfolio = rescheduleEligible
    ? evenlySpacedCandidates(archive.candidates, Math.min(maxSlots, archive.size))
    : [];
  const initialBoxPortfolioSize = initialBoxPortfolio.length;
  let initialBoxPortfolioDispatched = 0;

  function selectNextTask(): {
    target: ArchivedCandidate; operator: RepairOperator;
  } | undefined {
    if (initialBoxPortfolioDispatched < initialBoxPortfolioSize) {
      const target = archive.candidateById(
        initialBoxPortfolio[initialBoxPortfolioDispatched].id,
      );
      if (target) return { target, operator: "box" };
      initialBoxPortfolioDispatched += 1;
      return selectNextTask();
    }
    for (let i = 0; i < enabledOperators.length; i++) {
      const op = enabledOperators[(nextOpIndex + i) % enabledOperators.length];
      const target = archive.selectForRepair(op);
      if (target) return { target, operator: op };
    }
    return undefined;
  }

  function computeSliceMs(extended = false): number {
    const remainingMs = Number.isFinite(run.deadline)
      ? run.deadline - run.context.now()
      : Infinity;
    if (Number.isFinite(remainingMs) && remainingMs < 1) return 0;
    if (extended) {
      const configuredCap = configuredBudget(
        options.improvementMaxElapsedMs,
        Number.isFinite(remainingMs) ? remainingMs : QUALITY_INITIAL_WAVE_CAP_MS,
      );
      return Number.isFinite(remainingMs)
        ? Math.min(configuredCap, Math.max(1, Math.floor(remainingMs)))
        : configuredCap;
    }
    const progressiveCap = Math.min(
      QUALITY_ANYTIME_SLICE_CAP_MS,
      QUALITY_INITIAL_SLICE_MS * (2 ** Math.min(sliceIndex, 4)),
      configuredBudget(options.improvementMaxElapsedMs, QUALITY_ANYTIME_SLICE_CAP_MS),
    );
    return Number.isFinite(remainingMs)
      ? Math.min(progressiveCap, Math.floor(remainingMs / 2))
      : progressiveCap;
  }

  function dispatchTask(
    target: ArchivedCandidate,
    operator: RepairOperator,
  ): boolean {
    const taskId = `slice-${sliceIndex}`;
    const currentSliceIndex = sliceIndex;
    sliceIndex += 1;

    const initialPortfolioTask =
      operator === "box" &&
      initialBoxPortfolioDispatched < initialBoxPortfolioSize;
    const sliceMs = computeSliceMs(initialPortfolioTask);
    if (sliceMs < 1) return false;

    const remainingRequest = withRemainingLimits(run);
    if (!remainingRequest) return false;
    const defaultVisited = operator === "window"
      ? Math.min(50_000, localVisitedCap)
      : localVisitedCap;
    const remainingExpanded = remainingRequest.limits?.maxExpandedStates;
    const slotsToFill = Math.max(1, maxSlots - activeSlots.size);
    const usedImprovement = Math.max(
      0,
      aggregate(run).expandedStates - improvementStarted.expandedStates,
    );
    const remainingQualityVisited = Number.isFinite(qualityVisitedBudget)
      ? Math.max(0, qualityVisitedBudget - usedImprovement - leasedExpanded)
      : Infinity;
    const perSliceVisited = Math.min(
      remainingExpanded === undefined
        ? defaultVisited
        : Math.floor(Math.max(0, remainingExpanded - leasedExpanded) / slotsToFill),
      defaultVisited,
      Number.isFinite(remainingQualityVisited)
        ? Math.floor(remainingQualityVisited / slotsToFill)
        : defaultVisited,
    );
    const remainingGenerated = remainingRequest.limits?.maxGeneratedStates;
    const defaultGenerated = Math.max(perSliceVisited, perSliceVisited * 8);
    const maxGenerated = Math.min(
      remainingGenerated === undefined
        ? defaultGenerated
        : Math.floor(Math.max(0, remainingGenerated - leasedGenerated) / slotsToFill),
      defaultGenerated,
    );
    if (perSliceVisited < 1 || maxGenerated < 1) return false;

    archive.markInFlight(target.id, operator);

    report(
      run,
      `Slice ${currentSliceIndex + 1} (${operator} on ${target.id}, ${sliceMs}ms, best=${archive.globalBest?.solution.moves ?? "?"}).`,
      true,
    );

    const sliceStart = run.context.now();
    const repairContext = operator === "two-box"
      ? { boxPairs: selectBoxPairs(run.request, target.solution) }
      : operator === "goal-reassignment"
        ? { targetOverrides: selectGoalReassignmentOverrides(run.request, target.solution) }
        : operator === "dependency-window"
          ? { prioritizedWindows: analyzePushInteractions(run.request, target.solution) }
          : undefined;
    if (operator === "goal-reassignment" && !repairContext?.targetOverrides) {
      archive.recordOutcome({
        taskId, reason: "ineligible", operator, candidateId: target.id,
        expanded: 0, generated: 0, elapsedMs: 0, improved: false,
      });
      archive.clearInFlight(target.id, operator);
      return true;
    }
    if (operator === "dependency-window" && (!repairContext?.prioritizedWindows || repairContext.prioritizedWindows.length === 0)) {
      archive.recordOutcome({
        taskId, reason: "ineligible", operator, candidateId: target.id,
        expanded: 0, generated: 0, elapsedMs: 0, improved: false,
      });
      archive.clearInFlight(target.id, operator);
      return true;
    }
    leasedExpanded += perSliceVisited;
    leasedGenerated += maxGenerated;
    const promise = improveIncumbent(
      run, state, target.solution, createWorker,
      {
        ...options,
        improvementMaxVisited: perSliceVisited,
        improvementMaxElapsedMs: sliceMs,
        improvementMaxPasses: 1,
        improvementMaxMemoryBytes: taskMemoryBytes,
        onCandidatePublished: (solution) => {
          offerArchived(solution, {
            sourceOperator: operator,
            parentCandidateId: target.id,
            taskId,
            acceptedAt: run.context.now(),
          });
        },
      },
      currentSliceIndex,
      maxGenerated,
      maxSlots,
      rewriteAllocation,
      operator,
      repairContext,
    ).then((improved): SlotResult => ({
      taskId,
      candidateId: target.id,
      operator,
      improved: { ...improved, expandedWork: improved.expandedWork, generatedWork: improved.generatedWork },
      leasedExpanded: perSliceVisited,
      leasedGenerated: maxGenerated,
    })).then((result) => {
      archive.recordOutcome({
        taskId: result.taskId,
        reason: result.improved.endReason,
        operator: result.operator,
        candidateId: result.candidateId,
        expanded: result.improved.expandedWork,
        generated: result.improved.generatedWork,
        elapsedMs: run.context.now() - sliceStart,
        improved: result.improved.improved,
      });
      archive.clearInFlight(result.candidateId, result.operator);
      return result;
    });

    activeSlots.set(taskId, promise);
    return true;
  }

  function processResult(result: SlotResult): void {
    activeSlots.delete(result.taskId);
    leasedExpanded = Math.max(0, leasedExpanded - result.leasedExpanded);
    leasedGenerated = Math.max(0, leasedGenerated - result.leasedGenerated);
    run.qualitySlicesCompleted += 1;

    if (result.improved.cancelled) {
      slotCancelled = true;
      return;
    }

    if (result.improved.improved) {
      offerArchived(
        result.improved.solution,
        { sourceOperator: result.operator, parentCandidateId: result.candidateId, taskId: result.taskId, acceptedAt: run.context.now() },
      );
      run.bestSolutionMoves = Math.min(run.bestSolutionMoves, result.improved.solution.moves);
      invalidateAggregate(run);
      report(run, `Improved to ${result.improved.solution.moves} moves (${result.operator} on ${result.candidateId}).`, true);
    } else {
      run.qualityOperatorStalls += 1;
    }

    const currentIndex = enabledOperators.indexOf(result.operator);
    if (currentIndex >= 0) {
      nextOpIndex = (currentIndex + 1) % enabledOperators.length;
    }
  }

  while (!run.context.signal.aborted && !slotCancelled) {
    const remainingMs = Number.isFinite(run.deadline)
      ? run.deadline - run.context.now()
      : Infinity;
    if (Number.isFinite(remainingMs) && remainingMs < 1) break;

    const allExhausted = enabledOperators.every((op) => archive.allNeighborhoodsExhausted(op));
    if (allExhausted && activeSlots.size === 0) break;

    while (activeSlots.size < maxSlots && !run.context.signal.aborted) {
      const next = selectNextTask();
      if (!next) break;
      if (!dispatchTask(next.target, next.operator)) break;
      if (
        next.operator === "box" &&
        initialBoxPortfolioDispatched < initialBoxPortfolioSize
      ) {
        initialBoxPortfolioDispatched += 1;
      }
      const dispatched = enabledOperators.indexOf(next.operator);
      if (dispatched >= 0) nextOpIndex = (dispatched + 1) % enabledOperators.length;
    }

    if (activeSlots.size === 0) break;

    const result = await Promise.race(activeSlots.values());
    processResult(result);
  }

  for (const pending of activeSlots.values()) {
    const result = await pending;
    processResult(result);
  }
  activeSlots.clear();

  run.budget.releasePersistent(archive.estimatedMemoryBytes);

  if (slotCancelled || run.context.signal.aborted) {
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
