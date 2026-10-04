import type {
  SolverExecutionContext,
  SolverProgress,
  SolverRequest,
  SolverResult,
  SolverSolution,
} from "../contracts.ts";
import { verifySolverSolution } from "../verification.ts";
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
  OPTIMAL_PROOF_FIRST_TIME_SHARE,
  OPTIMAL_RESCHEDULE_TIME_SHARE,
  OPTIMAL_REWRITE_TIME_SHARE,
  PROOF_FIRST_MAX_BOXES,
  PROOF_FIRST_MAX_FLOOR_CELLS,
  PROOF_FIRST_MINIMUM_MS,
  QUALITY_EXACT_LANE_TIME_SHARE,
  adaptiveRewriteAllocation,
  configuredBudget,
  defaultImprovementMaxVisited,
  diversifiedHarvestPlans,
  dividedIntegerBudget,
  sokomindRewriteConcurrency,
  supportsBoxRescheduling,
} from "./sokomind-plans.ts";
import type { EngineWorkerSource } from "./sokomind-engine-pool.ts";
import { runPhase } from "./sokomind-phase-runner.ts";
import {
  runConcurrentProof,
  runSequentialProof,
  type ProofCheckpointOptions,
} from "./sokomind-proof.ts";
import type { ProofWorkerSource } from "./sokomind-proof-pool.ts";
import { improveIncumbent, type ImprovedIncumbent, type SokomindImprovementOptions } from "./sokomind-improvement.ts";
import {
  CandidateArchive,
  type ArchivedCandidate,
  type RepairOperator,
} from "./sokomind-candidate-archive.ts";
import {
  aggregate,
  incumbentProgress,
  invalidateAggregate,
  metrics,
  publishIncumbent,
  recordIncumbent,
  report,
  withRemainingLimits,
  type ProofFirstWork,
  type SearchRunState,
} from "./sokomind-run-state.ts";

export function runProof(
  request: SolverRequest,
  context: SolverExecutionContext,
  sokomindOptions: SokomindRequestOptions,
  discoveryResult: SolverResult,
  proofWorkers: ProofWorkerSource,
  checkpointOptions?: ProofCheckpointOptions,
): Promise<SolverResult> {
  if (sokomindOptions.proofParallelism > 1) {
    return runConcurrentProof(
      request,
      context,
      sokomindOptions,
      discoveryResult,
      {
        createProofWorker: proofWorkers,
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

/**
 * Runs the unmodified proof, starting from the discovery route's cost as the
 * pipeline's own proof does, with its time limit cut to `capMs` past the time
 * the discovery metrics already spent. Nothing it learns carries into a later
 * proof: only `proof.kind === "optimal"` on its result is a proof.
 */
export function runCappedProof(
  request: SolverRequest,
  context: SolverExecutionContext,
  sokomindOptions: SokomindRequestOptions,
  discoveryResult: SolverResult,
  proofWorkers: ProofWorkerSource,
  capMs: number,
): Promise<SolverResult> {
  const cappedElapsedMs = Math.floor(discoveryResult.metrics.elapsedMs + capMs);
  const requestElapsedMs = request.limits?.maxElapsedMs;
  const cappedRequest: SolverRequest = Object.freeze({
    ...request,
    limits: Object.freeze({
      ...request.limits,
      maxElapsedMs: requestElapsedMs === undefined
        ? cappedElapsedMs
        : Math.min(requestElapsedMs, cappedElapsedMs),
    }),
  });
  return runProof(
    cappedRequest, context, sokomindOptions, discoveryResult, proofWorkers,
  );
}

/**
 * Reports a capped proof's progress without its bounds. Its lower bound and
 * gap end with it, while worker-host compares each event only with the one
 * before, so a later proof's smaller bound would read as a decrease. The
 * incumbent and upper bound stay the run's published route, which only falls:
 * a route the proof drops on timeout was never published. `relabel` replaces
 * the proof's own phase and detail, for a lane that must not claim to prove.
 */
export function publishedBoundsContext(
  run: SearchRunState,
  relabel?: Pick<SolverProgress, "phase" | "detail">,
): SolverExecutionContext {
  return {
    signal: run.context.signal,
    now: run.context.now,
    reportProgress(progress) {
      const forwarded: { -readonly [K in keyof SolverProgress]: SolverProgress[K] } = {
        ...progress,
      };
      delete forwarded.lowerBound;
      delete forwarded.gap;
      delete forwarded.incumbent;
      delete forwarded.upperBound;
      run.context.reportProgress({ ...forwarded, ...relabel, ...incumbentProgress(run) });
    },
  };
}

// ---------------------------------------------------------------------------
// Shared harvest phase used by both Quality and Optimal anytime schedulers
// ---------------------------------------------------------------------------

async function harvestIncumbents(
  run: SearchRunState,
  state: LegacyState,
  firstIncumbent: SolverSolution,
  engineWorkers: EngineWorkerSource,
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

  // Publish the verified discovery route now, so the incumbent and upper
  // bound reach the caller before harvesting, rewriting, or proof work.
  recordIncumbent(run, firstIncumbent);
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
      const outcome = await runPhase(run, plans, engineWorkers, harvestWorkers, remaining, {
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
        recordIncumbent(run, bestAfter);
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
  engineWorkers: EngineWorkerSource,
  options: SokomindImprovementOptions,
  sokomindOptions: SokomindRequestOptions,
  tuning: Readonly<Record<string, number>>,
  maxWorkers: number,
  analysisPlan: SokomindAnalysisPlan | undefined,
  proofWorkers: ProofWorkerSource,
): Promise<SolverResult> {
  const exactLane = await proveSmallBoardFirst(
    run, firstIncumbent, sokomindOptions, proofWorkers,
    qualityExactLaneCapMs(run, sokomindOptions), QUALITY_EXACT_LANE_LABEL,
  );
  if (exactLane.result?.status === "solved") {
    return qualityExactLaneResult(run, exactLane.result.solution, exactLane.incumbent);
  }
  if (exactLane.result) return exactLane.result;
  firstIncumbent = exactLane.incumbent;

  const requestTimeMs = run.request.limits?.maxElapsedMs;
  const harvestMs = computeHarvestMs(sokomindOptions.harvestElapsedMs, requestTimeMs);

  const { collector, cancelled } = await harvestIncumbents(
    run, state, firstIncumbent, engineWorkers, sokomindOptions,
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
      publishIncumbent(run, solution, `Found a ${solution.moves}-move route.`);
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
          run, state, incumbent.solution, engineWorkers,
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
      run, state, target.solution, engineWorkers,
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

  // The archive can drop a route under memory pressure; the published
  // incumbent is the best verified route this run reported.
  const archived = archive.globalBest?.solution ?? firstIncumbent;
  const published = run.publishedIncumbent;
  const best = published !== undefined && isSolutionBetter(published, archived)
    ? published
    : archived;
  return Object.freeze({
    status: "solved" as const,
    solution: Object.freeze({ ...best, optimality: "unknown" as const }),
    metrics: metrics(run),
  });
}

// ---------------------------------------------------------------------------
// Small boards: a capped proof straight after discovery (Optimal proof-first,
// Quality exact lane)
// ---------------------------------------------------------------------------

/**
 * Whether a small board, which matches the classic exact profile, may run a
 * capped proof straight after discovery. Deterministic runs skip it so results
 * do not depend on timing, a resumed IDA* checkpoint already holds proof work
 * that only the pipeline's own proof continues, and a run without a time limit
 * has no share to cap. A run with an expanded- or generated-state limit also
 * skips it: the capped attempt would spend the shared state budget that the
 * pipeline's proof needs, because the cap limits only its time.
 */
function smallBoardProofEligible(
  run: SearchRunState,
  sokomindOptions: SokomindRequestOptions,
  checkpointOptions: ProofCheckpointOptions | undefined,
): boolean {
  const limits = run.request.limits;
  return !sokomindOptions.deterministic &&
    checkpointOptions?.checkpoint === undefined &&
    limits?.maxElapsedMs !== undefined &&
    limits.maxExpandedStates === undefined &&
    limits.maxGeneratedStates === undefined &&
    run.request.snapshot.boxes.length <= PROOF_FIRST_MAX_BOXES &&
    run.request.board.floor.length <= PROOF_FIRST_MAX_FLOOR_CELLS;
}

/** Optimal's proof-first cap, a share of the time limit, or 0 to skip it. */
function proofFirstCapMs(
  run: SearchRunState,
  sokomindOptions: SokomindRequestOptions,
  checkpointOptions: ProofCheckpointOptions | undefined,
): number {
  const requestTimeMs = run.request.limits?.maxElapsedMs;
  if (
    requestTimeMs === undefined ||
    !smallBoardProofEligible(run, sokomindOptions, checkpointOptions)
  ) {
    return 0;
  }
  const capMs = Math.min(
    Math.floor(requestTimeMs * OPTIMAL_PROOF_FIRST_TIME_SHARE),
    Math.floor(run.deadline - run.context.now()),
  );
  return capMs >= PROOF_FIRST_MINIMUM_MS ? capMs : 0;
}

/** Quality's exact-lane cap, a share of the time left, or 0 to skip it. */
function qualityExactLaneCapMs(
  run: SearchRunState,
  sokomindOptions: SokomindRequestOptions,
): number {
  if (!smallBoardProofEligible(run, sokomindOptions, undefined)) return 0;
  const capMs = Math.floor(
    (run.deadline - run.context.now()) * QUALITY_EXACT_LANE_TIME_SHARE,
  );
  return capMs >= PROOF_FIRST_MINIMUM_MS ? capMs : 0;
}

/** How a capped small-board proof appears in progress events. */
interface SmallBoardProofLabel {
  readonly phase: "proving" | "improving";
  readonly detail: string;
  /** Replaces the proof's own phase and detail, which speak of proving. */
  readonly relabelProof: boolean;
}

const OPTIMAL_PROOF_FIRST_LABEL: SmallBoardProofLabel = Object.freeze({
  phase: "proving",
  detail: "Proving the small board first",
  relabelProof: false,
});

const QUALITY_EXACT_LANE_LABEL: SmallBoardProofLabel = Object.freeze({
  phase: "improving",
  detail: "Searching the small board exactly",
  relabelProof: true,
});

/**
 * Quality's result once its exact lane completes: no shorter route exists, but
 * Quality never proves, so the route stays unproven and the result carries no
 * proof. The lane's route replaces the incumbent only once it replays.
 */
function qualityExactLaneResult(
  run: SearchRunState,
  laneSolution: SolverSolution,
  incumbent: SolverSolution,
): SolverResult {
  let best = incumbent;
  if (
    isSolutionBetter(laneSolution, incumbent) &&
    verifySolverSolution(run.request, laneSolution).valid
  ) {
    best = laneSolution;
    run.bestSolutionMoves = Math.min(run.bestSolutionMoves, best.moves);
    run.solutionImprovements += 1;
    invalidateAggregate(run);
  }
  const solution: SolverSolution = Object.freeze({ ...best, optimality: "unknown" as const });
  publishIncumbent(run, solution, `Found a ${solution.moves}-move route.`);
  return Object.freeze({
    status: "solved" as const,
    solution,
    metrics: metrics(run),
  });
}

function proofFirstCounters(work: ProofFirstWork): Readonly<Record<string, number>> {
  return {
    proofFirstExpandedStates: work.expandedStates,
    proofFirstGeneratedStates: work.generatedStates,
    proofFirstElapsedMs: work.elapsedMs,
  };
}

/**
 * Proves a small board straight after discovery, within `capMs` (0 skips it).
 * Returns the proof's result when it completes (or the run is cancelled);
 * otherwise the incumbent the run continues from, with the proof's work
 * charged to the run's limits.
 */
async function proveSmallBoardFirst(
  run: SearchRunState,
  firstIncumbent: SolverSolution,
  sokomindOptions: SokomindRequestOptions,
  proofWorkers: ProofWorkerSource,
  capMs: number,
  label: SmallBoardProofLabel,
): Promise<{ readonly result?: SolverResult; readonly incumbent: SolverSolution }> {
  if (capMs === 0 || run.context.signal.aborted) return { incumbent: firstIncumbent };

  run.initialSolutionMoves ||= firstIncumbent.moves;
  run.bestSolutionMoves =
    run.bestSolutionMoves === 0
      ? firstIncumbent.moves
      : Math.min(run.bestSolutionMoves, firstIncumbent.moves);
  invalidateAggregate(run);
  recordIncumbent(run, firstIncumbent);
  run.progressPhase = label.phase;
  report(run, `${label.detail} (${capMs}ms budget).`, true);

  const startedAt = run.context.now();
  const discoveryResult: SolverResult = Object.freeze({
    status: "solved" as const,
    solution: firstIncumbent,
    metrics: metrics(run),
  });
  const proofContext = publishedBoundsContext(
    run,
    label.relabelProof ? { phase: label.phase, detail: label.detail } : undefined,
  );
  const result = await runCappedProof(
    run.request, proofContext, sokomindOptions, discoveryResult,
    proofWorkers, capMs,
  );
  const counters = result.metrics.counters ?? {};
  const work: ProofFirstWork = Object.freeze({
    expandedStates: counters.proofExpandedStates ?? 0,
    generatedStates: counters.proofGeneratedStates ?? 0,
    elapsedMs: Math.max(0, run.context.now() - startedAt),
  });
  run.proofFirstWork = work;
  run.budget.peakEstimatedMemoryBytes = Math.max(
    run.budget.peakEstimatedMemoryBytes,
    counters.peakEstimatedMemoryBytes ?? 0,
  );
  invalidateAggregate(run);

  if (run.context.signal.aborted) {
    return {
      result: Object.freeze({ status: "cancelled", metrics: metrics(run) }),
      incumbent: firstIncumbent,
    };
  }
  if (result.status !== "solved") return { incumbent: firstIncumbent };
  if (result.proof?.kind === "optimal") {
    return {
      result: Object.freeze({
        ...result,
        metrics: Object.freeze({
          ...result.metrics,
          counters: Object.freeze({ ...counters, ...proofFirstCounters(work) }),
        }),
      }),
      incumbent: firstIncumbent,
    };
  }
  // A timed-out proof can still hand back a better route; it continues as an
  // unproven incumbent once it replays.
  if (
    isSolutionBetter(result.solution, firstIncumbent) &&
    verifySolverSolution(run.request, result.solution).valid
  ) {
    const improved: SolverSolution = Object.freeze({
      ...result.solution,
      optimality: "unknown" as const,
    });
    run.bestSolutionMoves = Math.min(run.bestSolutionMoves, improved.moves);
    run.solutionImprovements += 1;
    invalidateAggregate(run);
    recordIncumbent(run, improved);
    return { incumbent: improved };
  }
  return { incumbent: firstIncumbent };
}

export async function optimalQuickImprove(
  run: SearchRunState,
  state: LegacyState,
  firstIncumbent: SolverSolution,
  engineWorkers: EngineWorkerSource,
  options: SokomindImprovementOptions,
  sokomindOptions: SokomindRequestOptions,
  tuning: Readonly<Record<string, number>>,
  maxWorkers: number,
  analysisPlan: SokomindAnalysisPlan | undefined,
  proofWorkers: ProofWorkerSource,
  checkpointOptions?: ProofCheckpointOptions,
): Promise<SolverResult> {
  const proofFirst = await proveSmallBoardFirst(
    run, firstIncumbent, sokomindOptions, proofWorkers,
    proofFirstCapMs(run, sokomindOptions, checkpointOptions), OPTIMAL_PROOF_FIRST_LABEL,
  );
  if (proofFirst.result) return proofFirst.result;
  firstIncumbent = proofFirst.incumbent;

  const requestTimeMs = run.request.limits?.maxElapsedMs;
  const harvestMs = Math.min(
    DEFAULT_OPTIMAL_HARVEST_MS,
    computeHarvestMs(sokomindOptions.harvestElapsedMs, requestTimeMs),
  );

  const { collector, cancelled } = await harvestIncumbents(
    run, state, firstIncumbent, engineWorkers, sokomindOptions,
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
          run, state, best, engineWorkers,
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
          run, state, best, engineWorkers,
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

  // Proof progress reports its incumbent as the upper bound, which must not
  // rise above the bound already published.
  const published = run.publishedIncumbent;
  if (published !== undefined && isSolutionBetter(published, best)) {
    best = published;
  }
  const discoveryResult: SolverResult = Object.freeze({
    status: "solved" as const,
    solution: best,
    metrics: metrics(run),
  });
  return runProof(
    run.request, run.context, sokomindOptions, discoveryResult,
    proofWorkers, checkpointOptions,
  );
}
