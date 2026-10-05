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
  SMALL_BOARD_PROOF_ENGINE_MEMORY_SHARE,
  SMALL_BOARD_PROOF_HEAD_START_MS,
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
import {
  improveIncumbent,
  qualityRepairOperators,
  type ImprovedIncumbent,
  type SokomindImprovementOptions,
} from "./sokomind-improvement.ts";
import {
  CandidateArchive,
  type ArchivedCandidate,
  type RepairOperator,
} from "./sokomind-candidate-archive.ts";
import {
  aggregate,
  elapsed,
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
import {
  COORDINATOR_MEMORY_RESERVATION_BYTES,
  WORKER_MEMORY_RESERVATION_BYTES,
} from "./sokomind-worker-limits.ts";

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
      run.context.reportProgress(publishedBoundsProgress(run, progress, relabel));
    },
  };
}

/** A proof's progress without its bounds; see publishedBoundsContext. */
function publishedBoundsProgress(
  run: SearchRunState,
  progress: SolverProgress,
  relabel: Pick<SolverProgress, "phase" | "detail"> | undefined,
): SolverProgress {
  const forwarded: { -readonly [K in keyof SolverProgress]: SolverProgress[K] } = {
    ...progress,
  };
  delete forwarded.lowerBound;
  delete forwarded.gap;
  delete forwarded.incumbent;
  delete forwarded.upperBound;
  return { ...forwarded, ...relabel, ...incumbentProgress(run) };
}

// ---------------------------------------------------------------------------
// Engines beside a small-board proof
// ---------------------------------------------------------------------------

/**
 * Engine workers the route improvement may run now: the proof running beside
 * it holds some worker threads and memory (see launchBesideProof), and each
 * engine needs its reservation from what is left.
 */
function engineWorkerCount(run: SearchRunState, maxWorkers: number): number {
  const workers = Math.max(1, maxWorkers - run.budget.reservedWorkers);
  const reserved = run.budget.reservedMemoryBytes;
  const maxMemory = run.request.limits?.maxMemoryBytes;
  if (reserved === 0 || maxMemory === undefined || !Number.isFinite(maxMemory)) {
    return workers;
  }
  return Math.max(1, Math.min(
    workers,
    Math.floor(
      Math.max(0, maxMemory - COORDINATOR_MEMORY_RESERVATION_BYTES - reserved) /
        WORKER_MEMORY_RESERVATION_BYTES,
    ),
  ));
}

/** The memory limit the route improvement may plan with now. */
function engineMemoryLimit(run: SearchRunState): number | undefined {
  const maxMemory = run.request.limits?.maxMemoryBytes;
  return maxMemory === undefined
    ? undefined
    : Math.max(0, maxMemory - run.budget.reservedMemoryBytes);
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
      : engineWorkerCount(run, maxWorkers);
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
  const laneCapMs = qualityExactLaneCapMs(run, sokomindOptions);
  const split = proofSplit(run, sokomindOptions, undefined, laneCapMs);
  // A lane whose cap ends with its head start has no time beside the repair.
  if (split !== undefined && split.headStartMs < laneCapMs) {
    return qualityLaneBesideRepair(
      run, state, firstIncumbent, engineWorkers, options, sokomindOptions,
      tuning, maxWorkers, analysisPlan, proofWorkers, split, laneCapMs,
    );
  }
  const exactLane = await proveSmallBoardFirst(
    run, firstIncumbent, sokomindOptions, proofWorkers,
    laneCapMs, QUALITY_EXACT_LANE_LABEL,
  );
  if (exactLane.result?.status === "solved") {
    return qualityExactLaneResult(run, exactLane.result.solution, exactLane.incumbent);
  }
  if (exactLane.result) return exactLane.result;
  return qualityRepair(
    run, state, exactLane.incumbent, engineWorkers, options, sokomindOptions,
    tuning, maxWorkers, analysisPlan,
  );
}

/**
 * Quality's route repair: harvest, a parallel rewrite wave, then the anytime
 * slot loop until the deadline. `lane` is the exact lane running beside it:
 * once it ends, its route (when it hands one back) joins the archive. Engine
 * slots follow engineWorkerCount, so they grow when the lane releases its
 * workers and memory.
 */
async function qualityRepair(
  run: SearchRunState,
  state: LegacyState,
  firstIncumbent: SolverSolution,
  engineWorkers: EngineWorkerSource,
  options: SokomindImprovementOptions,
  sokomindOptions: SokomindRequestOptions,
  tuning: Readonly<Record<string, number>>,
  maxWorkers: number,
  analysisPlan: SokomindAnalysisPlan | undefined,
  lane?: Promise<SolverSolution | undefined>,
): Promise<SolverResult> {
  let laneEnded = false;
  let laneRoute: SolverSolution | undefined;
  let laneWake: Promise<undefined> | undefined = lane?.then(
    (route) => {
      laneEnded = true;
      laneRoute = route;
      return undefined;
    },
    () => {
      laneEnded = true;
      return undefined;
    },
  );

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

  // Once the exact lane ends, its route joins the archive like any other.
  function takeLaneRoute(): void {
    if (!laneEnded || laneWake === undefined) return;
    laneWake = undefined;
    const route = laneRoute;
    if (route === undefined) return;
    const published = run.publishedIncumbent;
    const improves = published === undefined || isSolutionBetter(route, published);
    if (improves) run.solutionImprovements += 1;
    const accepted = offerArchived(route, {
      sourceOperator: "discovery",
      parentCandidateId: undefined,
      taskId: undefined,
      acceptedAt: run.context.now(),
    });
    if (!accepted && improves) {
      run.bestSolutionMoves = Math.min(run.bestSolutionMoves, route.moves);
      invalidateAggregate(run);
      publishIncumbent(run, route, `Found a ${route.moves}-move route.`);
    }
  }
  takeLaneRoute();

  // ── Initial parallel rewrite wave on all diverse candidates ──────────
  const rewriteCandidates = selectForRewrite(collector.incumbents);
  const rewriteCount = rewriteCandidates.length;
  const rewriteConcurrency = (): number => sokomindRewriteConcurrency(
    engineWorkerCount(run, maxWorkers), engineMemoryLimit(run), rewriteCount,
  );

  if (rewriteCount > 0 && rewriteConcurrency() > 0 && !run.context.signal.aborted) {
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

      const concurrency = rewriteConcurrency();
      const waveSize = Math.min(concurrency, pending.length);
      const remainingWaves = Math.ceil(pending.length / concurrency);
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
  takeLaneRoute();

  const best0 = archive.globalBest;
  if (best0) {
    run.bestSolutionMoves = Math.min(run.bestSolutionMoves, best0.solution.moves);
    invalidateAggregate(run);
  }

  run.progressPhase = "improving";
  report(run, `Starting anytime improvement loop (best=${archive.globalBest?.solution.moves ?? "?"} moves, archive=${archive.size} candidates).`, true);

  // ── Anytime loop: parallel task-slot coordinator ─────────────────────
  const archiveSizeAtStart = archive.size;
  const slotCap = (): number => Math.max(1, sokomindRewriteConcurrency(
    engineWorkerCount(run, maxWorkers), engineMemoryLimit(run), archiveSizeAtStart,
  ));
  let sliceIndex = 0;
  const enabledOperators = qualityRepairOperators(state, sokomindOptions.experimentalOperators);
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
  const taskMemoryBase = configuredMemory !== undefined && Number.isFinite(configuredMemory)
    ? configuredMemory -
      run.budget.coordinatorEstimatedMemoryBytes -
      run.budget.preparedBoardEstimatedMemoryBytes -
      archive.estimatedMemoryBytes
    : undefined;
  const taskMemoryBytes = (): number | undefined => taskMemoryBase === undefined
    ? undefined
    : Math.max(1, Math.floor(
        Math.max(0, taskMemoryBase - run.budget.reservedMemoryBytes) / slotCap(),
      ));
  const initialBoxPortfolio = rescheduleEligible
    ? evenlySpacedCandidates(archive.candidates, Math.min(slotCap(), archive.size))
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
    const slots = slotCap();
    const slotsToFill = Math.max(1, slots - activeSlots.size);
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
    const repairContext = operator === "dependency-window"
      ? { prioritizedWindows: analyzePushInteractions(run.request, target.solution) }
      : undefined;
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
        improvementMaxMemoryBytes: taskMemoryBytes(),
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
      slots,
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

    takeLaneRoute();
    const allExhausted = enabledOperators.every((op) => archive.allNeighborhoodsExhausted(op));
    if (allExhausted && activeSlots.size === 0) break;

    while (activeSlots.size < slotCap() && !run.context.signal.aborted) {
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

    const result = await Promise.race([
      ...(laneWake === undefined ? [] : [laneWake]),
      ...activeSlots.values(),
    ]);
    if (result === undefined) continue;
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
  /** Shown during silence while the proof runs beside the route improvement. */
  readonly besideDetail: string;
}

const OPTIMAL_PROOF_FIRST_LABEL: SmallBoardProofLabel = Object.freeze({
  phase: "proving",
  detail: "Proving the small board first",
  relabelProof: false,
  besideDetail: "The proof runs beside the route improvement.",
});

const QUALITY_EXACT_LANE_LABEL: SmallBoardProofLabel = Object.freeze({
  phase: "improving",
  detail: "Searching the small board exactly",
  relabelProof: true,
  besideDetail: "The exact search runs beside the route repair.",
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
  return { incumbent: adoptProofRoute(run, result, firstIncumbent) };
}

/**
 * The route an unfinished proof hands back, unproven, when it beats
 * `incumbent` and replays; otherwise undefined.
 */
function verifiedProofRoute(
  run: SearchRunState,
  result: SolverResult,
  incumbent: SolverSolution,
): SolverSolution | undefined {
  if (
    result.status !== "solved" ||
    !isSolutionBetter(result.solution, incumbent) ||
    !verifySolverSolution(run.request, result.solution).valid
  ) {
    return undefined;
  }
  return Object.freeze({ ...result.solution, optimality: "unknown" as const });
}

/**
 * Adopts the route an unfinished proof hands back (see verifiedProofRoute) as
 * the run's incumbent. Returns the route the run continues from.
 */
function adoptProofRoute(
  run: SearchRunState,
  result: SolverResult,
  incumbent: SolverSolution,
): SolverSolution {
  const improved = verifiedProofRoute(run, result, incumbent);
  if (improved === undefined) return incumbent;
  run.bestSolutionMoves = Math.min(run.bestSolutionMoves, improved.moves);
  run.solutionImprovements += 1;
  invalidateAggregate(run);
  recordIncumbent(run, improved);
  return improved;
}

function cancelledResult(run: SearchRunState): SolverResult {
  return Object.freeze({ status: "cancelled", metrics: metrics(run) });
}

// ---------------------------------------------------------------------------
// Small boards: the proof beside the route improvement
// ---------------------------------------------------------------------------

/** While the improvement runs, the proof reports only after this much silence. */
const ANYTIME_PROOF_QUIET_MS = 1_000;

/**
 * How a parallel small-board proof shares the run with the route improvement.
 * The proof keeps the lane plan a proof with all of the memory would pick;
 * its lanes leave SMALL_BOARD_PROOF_ENGINE_MEMORY_SHARE to the engines.
 */
interface ProofSplit {
  /** How long the proof runs alone before the improvement joins it. */
  readonly headStartMs: number;
  /** Memory for the proof's lanes; undefined without a memory limit. */
  readonly laneBytes: number | undefined;
  /** Memory the lane plan is chosen from; undefined without a memory limit. */
  readonly planBytes: number | undefined;
}

/**
 * The split for a small-board proof capped at `capMs` (0 skips it), or
 * undefined to keep the proof alone and the improvement after it. A
 * single-lane proof runs on the coordinator's thread, where the engines'
 * messages would slow it. Checkpoint hooks belong to the pipeline's own
 * proof. A memory limit whose engine share cannot hold one engine worker
 * keeps the sequence too.
 */
function proofSplit(
  run: SearchRunState,
  sokomindOptions: SokomindRequestOptions,
  checkpointOptions: ProofCheckpointOptions | undefined,
  capMs: number,
): ProofSplit | undefined {
  if (
    capMs === 0 ||
    sokomindOptions.proofParallelism < 2 ||
    checkpointOptions !== undefined
  ) {
    return undefined;
  }
  const headStartMs = Math.min(SMALL_BOARD_PROOF_HEAD_START_MS, capMs);
  const maxMemory = run.request.limits?.maxMemoryBytes;
  if (maxMemory === undefined || !Number.isFinite(maxMemory)) {
    return { headStartMs, laneBytes: undefined, planBytes: undefined };
  }
  const planBytes = Math.max(0, maxMemory - COORDINATOR_MEMORY_RESERVATION_BYTES);
  const engineBytes = Math.floor(planBytes * SMALL_BOARD_PROOF_ENGINE_MEMORY_SHARE);
  if (engineBytes < WORKER_MEMORY_RESERVATION_BYTES) return undefined;
  return { headStartMs, laneBytes: planBytes - engineBytes, planBytes };
}

/**
 * How the proof's progress reaches the caller: alone, as a capped proof's
 * (publishedBoundsContext); quietly while the improvement reports; after the
 * improvement, with Optimal's bounds held to the published route and
 * Quality's still left out.
 */
type BesideProofMode = "alone" | "quiet" | "after";

interface BesideProof {
  /** The proof's result, once its work is charged to the run. */
  readonly outcome: Promise<SolverResult>;
  setMode(mode: BesideProofMode): void;
  abort(): void;
}

/**
 * Launches the unmodified proof from `firstIncumbent`, as the pipeline's own
 * proof starts, within the split's lane memory and capped at `capMs` past now
 * (undefined: the run's own time limit). Each route the improvement publishes
 * is offered to it; the proof replays it and lowers its bound only when it is
 * shorter. Its lanes' worker threads and memory are reserved from the engines
 * until it ends, and its work counts against the run's limits while it runs.
 */
function launchBesideProof(
  run: SearchRunState,
  outer: SolverExecutionContext,
  firstIncumbent: SolverSolution,
  sokomindOptions: SokomindRequestOptions,
  proofWorkers: ProofWorkerSource,
  split: ProofSplit,
  label: SmallBoardProofLabel,
  capMs: number | undefined,
): BesideProof {
  const proofAbort = new AbortController();
  const launchResult: SolverResult = Object.freeze({
    status: "solved" as const,
    solution: firstIncumbent,
    metrics: metrics(run),
  });
  const limits = run.request.limits;
  const cappedElapsedMs = capMs === undefined
    ? undefined
    : Math.floor(launchResult.metrics.elapsedMs + capMs);
  const request: SolverRequest = Object.freeze({
    ...run.request,
    limits: Object.freeze({
      ...limits,
      ...(split.laneBytes === undefined ? {} : {
        maxMemoryBytes: split.laneBytes + COORDINATOR_MEMORY_RESERVATION_BYTES,
      }),
      ...(cappedElapsedMs === undefined ? {} : {
        maxElapsedMs: limits?.maxElapsedMs === undefined
          ? cappedElapsedMs
          : Math.min(limits.maxElapsedMs, cappedElapsedMs),
      }),
    }),
  });

  let heldBytes = split.laneBytes ?? 0;
  let heldWorkers = 0;
  run.budget.reservedMemoryBytes += heldBytes;
  const release = (): void => {
    run.budget.reservedMemoryBytes -= heldBytes;
    run.budget.reservedWorkers -= heldWorkers;
    heldBytes = 0;
    heldWorkers = 0;
  };

  const baseExpanded = launchResult.metrics.expandedStates ?? 0;
  const baseGenerated = launchResult.metrics.generatedStates ?? 0;
  const startedAt = outer.now();
  const chargeProof = (expandedStates: number, generatedStates: number): void => {
    const previous = run.proofFirstWork;
    run.proofFirstWork = Object.freeze({
      expandedStates: Math.max(previous?.expandedStates ?? 0, expandedStates),
      generatedStates: Math.max(previous?.generatedStates ?? 0, generatedStates),
      elapsedMs: Math.max(0, outer.now() - startedAt),
    });
    invalidateAggregate(run);
  };

  const relabel = label.relabelProof
    ? { phase: label.phase, detail: label.detail }
    : undefined;
  let mode: BesideProofMode = "alone";
  const proofContext: SolverExecutionContext = {
    signal: proofAbort.signal,
    now: outer.now,
    reportProgress(progress) {
      chargeProof(
        Math.max(0, (progress.expandedStates ?? baseExpanded) - baseExpanded),
        Math.max(0, (progress.generatedStates ?? baseGenerated) - baseGenerated),
      );
      if (mode === "alone") {
        outer.reportProgress(publishedBoundsProgress(run, progress, relabel));
        return;
      }
      if (mode === "quiet") {
        if (outer.now() - run.lastProgressAt >= ANYTIME_PROOF_QUIET_MS) {
          report(run, label.besideDetail, true);
        }
        return;
      }
      run.lastProgressAt = outer.now();
      const snapshot = aggregate(run);
      const counted: SolverProgress = {
        ...progress,
        elapsedMs: elapsed(run),
        expandedStates: snapshot.expandedStates,
        generatedStates: snapshot.generatedStates,
        counters: { ...progress.counters, ...snapshot.counters },
      };
      outer.reportProgress(relabel === undefined
        ? { ...heldToPublished(run, counted), phase: label.phase }
        : publishedBoundsProgress(run, counted, relabel));
    },
  };

  const settle = (result: SolverResult): SolverResult => {
    release();
    const counters = result.metrics.counters ?? {};
    chargeProof(counters.proofExpandedStates ?? 0, counters.proofGeneratedStates ?? 0);
    run.budget.peakEstimatedMemoryBytes = Math.max(
      run.budget.peakEstimatedMemoryBytes,
      counters.peakEstimatedMemoryBytes ?? 0,
    );
    invalidateAggregate(run);
    return result;
  };
  const outcome = runConcurrentProof(
    request,
    proofContext,
    sokomindOptions,
    launchResult,
    {
      createProofWorker: proofWorkers,
      proofParallelism: sokomindOptions.proofParallelism,
      planMemoryBytes: split.planBytes,
      onLanePlan(plan) {
        heldWorkers = plan.lanes;
        run.budget.reservedWorkers += plan.lanes;
      },
      outsideIncumbents: {
        subscribe(offer) {
          run.incumbentListener = offer;
          return () => {
            if (run.incumbentListener === offer) run.incumbentListener = undefined;
          };
        },
      },
    },
  ).then(settle, (error: unknown) => {
    release();
    throw error;
  });
  return {
    outcome,
    setMode(next) {
      mode = next;
    },
    abort() {
      proofAbort.abort();
    },
  };
}

/**
 * Quality on a small board with a parallel exact lane: the lane starts from
 * the first route at once and searches alone for the split's head start. A
 * lane done by then ends as the sequence would (a completed lane returns its
 * route, unproven; otherwise the repair follows on every core). Otherwise the
 * repair runs beside the same lane on the engines' share; a completed lane
 * stops it, and an unfinished lane's shorter route joins the repair's
 * archive. Quality never proves.
 */
async function qualityLaneBesideRepair(
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
  split: ProofSplit,
  capMs: number,
): Promise<SolverResult> {
  const outer = run.context;
  if (outer.signal.aborted) return cancelledResult(run);

  run.initialSolutionMoves ||= firstIncumbent.moves;
  run.bestSolutionMoves =
    run.bestSolutionMoves === 0
      ? firstIncumbent.moves
      : Math.min(run.bestSolutionMoves, firstIncumbent.moves);
  invalidateAggregate(run);
  recordIncumbent(run, firstIncumbent);
  run.progressPhase = QUALITY_EXACT_LANE_LABEL.phase;
  report(run, `${QUALITY_EXACT_LANE_LABEL.detail} (${capMs}ms budget).`, true);

  const repairAbort = new AbortController();
  const lane = launchBesideProof(
    run, outer, firstIncumbent, sokomindOptions, proofWorkers, split,
    QUALITY_EXACT_LANE_LABEL, capMs,
  );
  const onOuterAbort = (): void => {
    lane.abort();
    repairAbort.abort();
  };
  outer.signal.addEventListener("abort", onOuterAbort, { once: true });

  let headStartTimer: ReturnType<typeof setTimeout> | undefined;
  let repair: Promise<SolverResult> | undefined;
  try {
    const headStart = new Promise<"head-start">((resolve) => {
      headStartTimer = setTimeout(() => resolve("head-start"), split.headStartMs);
    });
    const early = await Promise.race([lane.outcome, headStart]);
    if (early !== "head-start") {
      if (outer.signal.aborted) return cancelledResult(run);
      if (early.status === "solved" && early.proof?.kind === "optimal") {
        return qualityExactLaneResult(run, early.solution, firstIncumbent);
      }
      return await qualityRepair(
        run, state, adoptProofRoute(run, early, firstIncumbent), engineWorkers,
        options, sokomindOptions, tuning, maxWorkers, analysisPlan,
      );
    }

    run.context = {
      signal: repairAbort.signal,
      now: outer.now,
      reportProgress: outer.reportProgress,
    };
    lane.setMode("quiet");
    const laneRoute = lane.outcome.then(
      (result) => result.proof?.kind === "optimal"
        ? undefined
        : verifiedProofRoute(run, result, run.publishedIncumbent ?? firstIncumbent),
      () => undefined,
    );
    repair = qualityRepair(
      run, state, firstIncumbent, engineWorkers, options, sokomindOptions,
      tuning, maxWorkers, analysisPlan, laneRoute,
    ).finally(() => {
      run.context = outer;
    });

    const first = await Promise.race([
      lane.outcome.then((result) => ({ kind: "lane" as const, result })),
      repair.then((result) => ({ kind: "repair" as const, result })),
    ]);

    if (first.kind === "lane") {
      const laneResult = first.result;
      if (
        outer.signal.aborted ||
        (laneResult.status === "solved" && laneResult.proof?.kind === "optimal")
      ) {
        repairAbort.abort();
        await repair.catch(() => undefined);
        if (outer.signal.aborted || laneResult.status !== "solved") {
          return cancelledResult(run);
        }
        return qualityExactLaneResult(
          run, laneResult.solution, run.publishedIncumbent ?? firstIncumbent,
        );
      }
      // The repair took the lane's route, unless it was already finishing.
      const repaired = await repair;
      if (repaired.status !== "solved") return repaired;
      const route = adoptProofRoute(run, laneResult, repaired.solution);
      if (route === repaired.solution) return repaired;
      return Object.freeze({
        status: "solved" as const,
        solution: route,
        metrics: metrics(run),
      });
    }

    const repaired = first.result;
    if (repaired.status !== "solved" || outer.signal.aborted) {
      lane.abort();
      await lane.outcome.catch(() => undefined);
      return cancelledResult(run);
    }
    // The repair ran out of work first: the lane continues to its cap.
    lane.setMode("after");
    run.progressPhase = QUALITY_EXACT_LANE_LABEL.phase;
    report(run, `${QUALITY_EXACT_LANE_LABEL.detail}.`, true);
    const laneResult = await lane.outcome;
    if (outer.signal.aborted) return cancelledResult(run);
    const published = run.publishedIncumbent;
    const best = published !== undefined && isSolutionBetter(published, repaired.solution)
      ? published
      : repaired.solution;
    if (laneResult.status === "solved" && laneResult.proof?.kind === "optimal") {
      return qualityExactLaneResult(run, laneResult.solution, best);
    }
    const route = adoptProofRoute(run, laneResult, best);
    return Object.freeze({
      status: "solved" as const,
      solution: Object.freeze({ ...route, optimality: "unknown" as const }),
      metrics: metrics(run),
    });
  } finally {
    clearTimeout(headStartTimer);
    lane.abort();
    repairAbort.abort();
    await Promise.allSettled([lane.outcome, repair ?? Promise.resolve()]);
    run.context = outer;
    outer.signal.removeEventListener("abort", onOuterAbort);
  }
}

// ---------------------------------------------------------------------------
// Optimal: route improvement, then the pipeline's own proof
// ---------------------------------------------------------------------------

/**
 * Harvests diverse routes, then runs the quick rewrite and reschedule passes.
 * Engines follow engineWorkerCount, so a proof running beside them keeps its
 * workers and memory. Returns the best route found; `cancelled` once the run's
 * signal stopped it.
 */
async function improveOptimalIncumbent(
  run: SearchRunState,
  state: LegacyState,
  firstIncumbent: SolverSolution,
  engineWorkers: EngineWorkerSource,
  options: SokomindImprovementOptions,
  sokomindOptions: SokomindRequestOptions,
  tuning: Readonly<Record<string, number>>,
  maxWorkers: number,
  analysisPlan: SokomindAnalysisPlan | undefined,
): Promise<{ readonly best: SolverSolution; readonly cancelled: boolean }> {
  const requestTimeMs = run.request.limits?.maxElapsedMs;
  const harvestMs = Math.min(
    DEFAULT_OPTIMAL_HARVEST_MS,
    computeHarvestMs(sokomindOptions.harvestElapsedMs, requestTimeMs),
  );

  const { collector, cancelled } = await harvestIncumbents(
    run, state, firstIncumbent, engineWorkers, sokomindOptions,
    tuning, maxWorkers, analysisPlan, harvestMs,
  );
  if (cancelled) return { best: firstIncumbent, cancelled: true };

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
        if (improved.cancelled) return { best, cancelled: true };
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
        if (improved.cancelled) return { best, cancelled: true };
        if (improved.improved) {
          best = improved.solution;
          run.bestSolutionMoves = Math.min(run.bestSolutionMoves, best.moves);
          invalidateAggregate(run);
        }
      }
    }
  }

  return { best, cancelled: run.context.signal.aborted };
}

/** Runs the pipeline's own proof from `best`, or from the published route when it is better. */
function finalProof(
  run: SearchRunState,
  best: SolverSolution,
  sokomindOptions: SokomindRequestOptions,
  proofWorkers: ProofWorkerSource,
  context: SolverExecutionContext,
  checkpointOptions?: ProofCheckpointOptions,
): Promise<SolverResult> {
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
    run.request, context, sokomindOptions, discoveryResult,
    proofWorkers, checkpointOptions,
  );
}

// ---------------------------------------------------------------------------
// Optimal on small boards: the proof beside the route improvement
// ---------------------------------------------------------------------------

/** The small-board proof's result with the whole run's metrics. */
function anytimeResult(run: SearchRunState, result: SolverResult): SolverResult {
  const runMetrics = metrics(run);
  const work = run.proofFirstWork;
  return Object.freeze({
    ...result,
    metrics: Object.freeze({
      ...runMetrics,
      peakFrontierSize: Math.max(
        runMetrics.peakFrontierSize ?? 0,
        result.metrics.peakFrontierSize ?? 0,
      ),
      counters: Object.freeze({
        ...result.metrics.counters,
        ...runMetrics.counters,
        ...(work === undefined ? {} : proofFirstCounters(work)),
      }),
    }),
  });
}

function proofGap(result: SolverResult): number {
  const proof = result.proof;
  if (proof === undefined) return Infinity;
  if (proof.lowerBound !== undefined && proof.upperBound !== undefined) {
    return proof.upperBound - proof.lowerBound;
  }
  return proof.gap ?? Infinity;
}

/**
 * Picks between an unproven small-board proof and the final proof that
 * followed it. The final proof stands unless the earlier one holds a replaying
 * route no longer than the final route and a strictly smaller gap. Their
 * bounds are never merged; the final proof's metrics cover the whole run.
 */
function chooseResult(
  run: SearchRunState,
  anytime: SolverResult,
  final: SolverResult,
): SolverResult {
  if (
    final.proof?.kind === "optimal" ||
    final.status !== "solved" ||
    anytime.status !== "solved" ||
    anytime.solution.moves > final.solution.moves ||
    !verifySolverSolution(run.request, anytime.solution).valid
  ) {
    return final;
  }
  return proofGap(anytime) < proofGap(final)
    ? Object.freeze({ ...anytime, metrics: final.metrics })
    : final;
}

/**
 * Below the published route's length, the most a small-board proof's lower
 * bound may show. A bound meeting a route the proof did not find would close
 * the gap that only the proof's own completion closes.
 */
function lowerBoundBelow(upperBound: number, lowerBound: number): number {
  return Math.min(lowerBound, Math.max(0, upperBound - 1));
}

/**
 * The small-board proof's progress with its upper bound held to the published
 * route when that route is shorter than the proof's incumbent.
 */
function heldToPublished(run: SearchRunState, progress: SolverProgress): SolverProgress {
  const published = run.publishedIncumbent;
  if (
    published === undefined ||
    progress.upperBound === undefined ||
    progress.upperBound <= published.moves
  ) {
    return progress;
  }
  const held: { -readonly [K in keyof SolverProgress]: SolverProgress[K] } = {
    ...progress,
    ...incumbentProgress(run),
  };
  delete held.gap;
  if (held.lowerBound !== undefined) {
    held.lowerBound = lowerBoundBelow(published.moves, held.lowerBound);
    held.gap = published.moves - held.lowerBound;
  }
  return held;
}

/**
 * An unproven small-board proof's result, moved onto `route` when that route
 * is shorter than the proof's own and replays. The proof's lower bound still
 * holds, below the route's length; it stays a bounded result.
 */
function boundedAtRoute(
  run: SearchRunState,
  result: SolverResult,
  route: SolverSolution | undefined,
): SolverResult {
  if (
    route === undefined ||
    result.status !== "solved" ||
    result.proof?.kind !== "bounded" ||
    result.proof.lowerBound === undefined ||
    route.moves >= result.solution.moves ||
    !verifySolverSolution(run.request, route).valid
  ) {
    return result;
  }
  const lowerBound = lowerBoundBelow(route.moves, result.proof.lowerBound);
  return Object.freeze({
    ...result,
    solution: Object.freeze({ ...route, optimality: "unknown" as const }),
    proof: Object.freeze({
      ...result.proof,
      lowerBound,
      upperBound: route.moves,
      gap: route.moves - lowerBound,
    }),
  });
}

/**
 * Ends a run whose small-board proof stopped unproven once the improvement is
 * done. With the time for a PDB build left, the final proof runs from the best
 * route and chooseResult picks; otherwise the small-board proof's result
 * stands.
 */
async function settleUnprovenAnytime(
  run: SearchRunState,
  anytime: SolverResult,
  best: SolverSolution,
  sokomindOptions: SokomindRequestOptions,
  proofWorkers: ProofWorkerSource,
  context: SolverExecutionContext,
): Promise<SolverResult> {
  const atRoute = boundedAtRoute(run, anytime, run.publishedIncumbent);
  if (run.deadline - run.context.now() < PROOF_FIRST_MINIMUM_MS) {
    return anytimeResult(run, atRoute);
  }
  const final = await finalProof(run, best, sokomindOptions, proofWorkers, context);
  return chooseResult(run, atRoute, final);
}

/**
 * Optimal on a small board with a parallel proof: the proof starts from the
 * first route at once, with the lane plan proof-first would use, and runs
 * alone for the split's head start. A proof done by then stands, and one that
 * stopped short leaves the improvement every core before the final proof, as
 * proof-first does. Otherwise the route improvement runs beside the same proof
 * on the engines' share, and each route it publishes lowers the proof's bound
 * once the proof has replayed it. A completed proof stands at once. When the
 * improvement ends, the same proof continues: it already holds the
 * improvement's best route, and a fresh proof would redo its work. Its bounds
 * then reach progress, held to the published route. A proof that ends
 * unproven is followed by the final proof when time allows (see
 * settleUnprovenAnytime).
 */
async function optimalAnytimeImprove(
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
  split: ProofSplit,
): Promise<SolverResult> {
  const outer = run.context;
  if (outer.signal.aborted) return cancelledResult(run);

  run.initialSolutionMoves ||= firstIncumbent.moves;
  run.bestSolutionMoves =
    run.bestSolutionMoves === 0
      ? firstIncumbent.moves
      : Math.min(run.bestSolutionMoves, firstIncumbent.moves);
  invalidateAggregate(run);
  recordIncumbent(run, firstIncumbent);
  run.progressPhase = OPTIMAL_PROOF_FIRST_LABEL.phase;
  report(run, `${OPTIMAL_PROOF_FIRST_LABEL.detail}.`, true);

  const improveAbort = new AbortController();
  const proof = launchBesideProof(
    run, outer, firstIncumbent, sokomindOptions, proofWorkers, split,
    OPTIMAL_PROOF_FIRST_LABEL, undefined,
  );
  const onOuterAbort = (): void => {
    proof.abort();
    improveAbort.abort();
  };
  outer.signal.addEventListener("abort", onOuterAbort, { once: true });

  let headStartTimer: ReturnType<typeof setTimeout> | undefined;
  let improvement:
    | Promise<{ readonly best: SolverSolution; readonly cancelled: boolean }>
    | undefined;
  try {
    const headStart = new Promise<"head-start">((resolve) => {
      headStartTimer = setTimeout(() => resolve("head-start"), split.headStartMs);
    });
    const early = await Promise.race([proof.outcome, headStart]);
    if (early !== "head-start") {
      if (outer.signal.aborted) return cancelledResult(run);
      if (early.proof?.kind === "optimal") return anytimeResult(run, early);
      const route = adoptProofRoute(run, early, firstIncumbent);
      const outcome = await improveOptimalIncumbent(
        run, state, route, engineWorkers, options, sokomindOptions,
        tuning, maxWorkers, analysisPlan,
      );
      if (outcome.cancelled) return cancelledResult(run);
      return await settleUnprovenAnytime(
        run, early, outcome.best, sokomindOptions, proofWorkers, outer,
      );
    }

    run.context = {
      signal: improveAbort.signal,
      now: outer.now,
      reportProgress: outer.reportProgress,
    };
    proof.setMode("quiet");
    improvement = improveOptimalIncumbent(
      run, state, firstIncumbent, engineWorkers, options, sokomindOptions,
      tuning, maxWorkers, analysisPlan,
    ).finally(() => {
      run.context = outer;
    });

    const first = await Promise.race([
      proof.outcome.then((result) => ({ kind: "proof" as const, result })),
      improvement.then((outcome) => ({ kind: "improvement" as const, outcome })),
    ]);

    if (first.kind === "proof") {
      const result = first.result;
      if (outer.signal.aborted || result.proof?.kind === "optimal") {
        improveAbort.abort();
        await improvement.catch(() => undefined);
        return outer.signal.aborted ? cancelledResult(run) : anytimeResult(run, result);
      }
      // Stopped short (memory, a lane failure or the deadline): keep its
      // route and let the improvement finish on the cores it releases.
      adoptProofRoute(run, result, run.publishedIncumbent ?? firstIncumbent);
      const outcome = await improvement;
      if (outcome.cancelled) return cancelledResult(run);
      return await settleUnprovenAnytime(
        run, result, outcome.best, sokomindOptions, proofWorkers, outer,
      );
    }

    const outcome = first.outcome;
    if (outcome.cancelled) {
      // Only the user's cancel stops the improvement before the proof ends.
      proof.abort();
      await proof.outcome.catch(() => undefined);
      return cancelledResult(run);
    }
    let best = outcome.best;
    const published = run.publishedIncumbent;
    if (published !== undefined && isSolutionBetter(published, best)) {
      best = published;
    }

    // The same proof continues; its bounds now reach progress.
    proof.setMode("after");
    run.progressPhase = OPTIMAL_PROOF_FIRST_LABEL.phase;
    report(run, "Proving the small board.", true);
    const result = await proof.outcome;
    if (outer.signal.aborted) return cancelledResult(run);
    if (result.proof?.kind === "optimal") return anytimeResult(run, result);
    best = adoptProofRoute(run, result, best);
    // Its lower bound was published, so the final proof reports none.
    return await settleUnprovenAnytime(
      run, result, best, sokomindOptions, proofWorkers, publishedBoundsContext(run),
    );
  } finally {
    clearTimeout(headStartTimer);
    proof.abort();
    improveAbort.abort();
    await Promise.allSettled([proof.outcome, improvement ?? Promise.resolve()]);
    run.context = outer;
    outer.signal.removeEventListener("abort", onOuterAbort);
  }
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
  const capMs = proofFirstCapMs(run, sokomindOptions, checkpointOptions);
  const split = proofSplit(run, sokomindOptions, checkpointOptions, capMs);
  if (split !== undefined) {
    return optimalAnytimeImprove(
      run, state, firstIncumbent, engineWorkers, options, sokomindOptions,
      tuning, maxWorkers, analysisPlan, proofWorkers, split,
    );
  }

  const proofFirst = await proveSmallBoardFirst(
    run, firstIncumbent, sokomindOptions, proofWorkers, capMs, OPTIMAL_PROOF_FIRST_LABEL,
  );
  if (proofFirst.result) return proofFirst.result;

  const outcome = await improveOptimalIncumbent(
    run, state, proofFirst.incumbent, engineWorkers, options, sokomindOptions,
    tuning, maxWorkers, analysisPlan,
  );
  if (outcome.cancelled) return cancelledResult(run);
  return finalProof(
    run, outcome.best, sokomindOptions, proofWorkers, run.context, checkpointOptions,
  );
}
