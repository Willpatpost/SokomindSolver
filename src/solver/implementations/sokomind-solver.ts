import type {
  SolverAdapter,
  SolverExecutionContext,
  SolverMetadata,
  SolverRequest,
  SolverResult,
  SolverRunMetrics,
  SolverSolution,
} from "../contracts.ts";
import { runClassicSearch } from "../search/engine.ts";
import { BudgetTracker } from "./sokomind-budget-tracker.ts";
import { harvestAndImprove, runProof } from "./sokomind-harvest.ts";
import { solvedWithImprovement, type SokomindImprovementOptions } from "./sokomind-improvement.ts";
import {
  finiteNonNegative,
  preparedBoardMemoryEstimate,
  toLegacyState,
  withPreparedBoard,
  type LegacySearchCheckpoint,
  type LegacyState,
  type SokomindAnalysisPlan,
} from "./sokomind-legacy.ts";
import { extractSokomindOptions } from "./sokomind-options.ts";
import type { SokomindEngineWorker } from "./sokomind-phase-runner.ts";
import { runPhase } from "./sokomind-phase-runner.ts";
import {
  DEFAULT_MAX_ENGINE_WORKERS,
  MEMORY_TIER_HIGH,
  MEMORY_TIER_MEDIUM,
  bidirectionalPlans,
  checkpointContinuationPlans,
  discoveryPlans,
  preparationPlan,
  reverseLaneCount,
  structuralPlan,
} from "./sokomind-plans.ts";
import type { ProofCheckpointOptions, SokomindProofWorker } from "./sokomind-proof.ts";
import {
  aggregate,
  elapsed,
  metrics,
  reachedLimit,
  withRemainingLimits,
  WORKER_SILENCE_WATCHDOG_MS,
  type PhaseStopReason,
  type SearchRunState,
} from "./sokomind-run-state.ts";
import {
  resolveSokomindTuning,
  sokomindTuningPayload,
  type SokomindTuningOverrides,
} from "./sokomind-tuning.ts";
import { WorkerExecutionRegistry } from "./sokomind-worker-registry.ts";
export type { SokomindEngineWorker } from "./sokomind-phase-runner.ts";
export {
  reconstructBidirectionalPath,
  semanticDiversityTrace,
  solutionFromLegacyPath,
  toLegacyState,
} from "./sokomind-legacy.ts";
export {
  allocateParallelRewriteBudgets,
  sokomindDiscoveryBeamWidth,
  sokomindRewriteConcurrency,
  solutionImprovementPlan,
  type ParallelRewriteBudget,
} from "./sokomind-plans.ts";

const STRUCTURAL_BOX_THRESHOLD = 10;
const STRUCTURAL_FLOOR_THRESHOLD = 100;

export interface SokomindSolverAdapterOptions {
  readonly createWorker?: () => SokomindEngineWorker;
  readonly createProofWorker?: () => SokomindProofWorker;
  readonly hardwareConcurrency?: number;
  readonly deviceMemoryGb?: number;
  readonly workerSilenceTimeoutMs?: number;
  readonly structuralHeadStartMs?: number;
  readonly tuning?: SokomindTuningOverrides;
  readonly improvementMaxVisited?: number;
  readonly improvementMaxElapsedMs?: number;
  readonly improvementMaxPasses?: number;
  readonly improvementMinimumMoves?: number;
  readonly checkpointOptions?: ProofCheckpointOptions;
}

function defaultCreateWorker(): SokomindEngineWorker {
  return new Worker(
    new URL(
      "./sokomind-engine/sokomind-engine.worker.ts",
      import.meta.url,
    ),
    {
      type: "module",
      name: "sokomind-engine",
    },
  ) as unknown as SokomindEngineWorker;
}

function defaultCreateProofWorker(): SokomindProofWorker {
  return new Worker(
    new URL(
      "./sokomind-proof-worker.ts",
      import.meta.url,
    ),
    {
      type: "module",
      name: "sokomind-proof",
    },
  ) as unknown as SokomindProofWorker;
}

function isStructuralPuzzle(request: SolverRequest): boolean {
  return (
    request.snapshot.boxes.length >= STRUCTURAL_BOX_THRESHOLD ||
    request.board.floor.length >= STRUCTURAL_FLOOR_THRESHOLD
  );
}

function configuredWorkerCount(
  options: SokomindSolverAdapterOptions,
  request: SolverRequest,
): number {
  const hardware = Math.max(
    1,
    Math.floor(
      options.hardwareConcurrency ??
        globalThis.navigator?.hardwareConcurrency ??
        2,
    ),
  );
  const memoryGb =
    options.deviceMemoryGb ??
    (
      globalThis.navigator as Navigator & {
        readonly deviceMemory?: number;
      }
    )?.deviceMemory;
  const declaredMemoryBytes = request.limits?.maxMemoryBytes ?? Infinity;
  const memoryBound =
    declaredMemoryBytes <= MEMORY_TIER_MEDIUM ||
    (memoryGb !== undefined && memoryGb <= 4)
      ? 1
      : declaredMemoryBytes <= MEMORY_TIER_HIGH ||
          (memoryGb !== undefined && memoryGb <= 8)
        ? 2
        : DEFAULT_MAX_ENGINE_WORKERS;
  return Math.max(
    1,
    Math.min(DEFAULT_MAX_ENGINE_WORKERS, hardware - 1 || 1, memoryBound),
  );
}

function structuralHeadStartMs(run: SearchRunState): number {
  if (!Number.isFinite(run.deadline)) {
    return run.structuralHeadStartLimitMs;
  }
  const remaining = Math.max(0, run.deadline - run.context.now());
  return Math.min(
    run.structuralHeadStartLimitMs,
    remaining * run.profile.structuralTimeShare,
  );
}

function withStructuralStateBudget(
  request: SolverRequest,
  stateShare: number,
): SolverRequest | null {
  const availableExpanded = request.limits?.maxExpandedStates;
  const availableGenerated = request.limits?.maxGeneratedStates;
  if (
    (availableExpanded !== undefined && availableExpanded <= 1) ||
    (availableGenerated !== undefined && availableGenerated <= 1)
  ) {
    return null;
  }
  const structuralExpanded =
    availableExpanded === undefined
      ? undefined
      : Math.max(
          1,
          Math.min(
            availableExpanded - 1,
            Math.floor(
              availableExpanded * stateShare,
            ),
          ),
        );
  const structuralGenerated =
    availableGenerated === undefined
      ? undefined
      : Math.max(
          1,
          Math.min(
            availableGenerated - 1,
            Math.floor(
              availableGenerated * stateShare,
            ),
          ),
        );
  return Object.freeze({
    ...request,
    limits: Object.freeze({
      ...request.limits,
      ...(structuralExpanded === undefined
        ? {}
        : { maxExpandedStates: structuralExpanded }),
      ...(structuralGenerated === undefined
        ? {}
        : { maxGeneratedStates: structuralGenerated }),
    }),
  });
}

const ADDITIVE_FALLBACK_COUNTERS = new Set([
  "uniqueStates",
  "duplicateStates",
  "deadlockPrunes",
  "infeasiblePrunes",
  "heuristicCalls",
  "reachabilityFloods",
  "reopens",
  "identityFloods",
  "heuristicCacheHits",
]);

const MAXIMUM_FALLBACK_COUNTERS = new Set([
  "estimatedMemoryBytes",
  "maxDepth",
]);

function fallbackCounterName(name: string): string {
  return `classicFallback${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function mergeFallbackCounters(
  legacy: Readonly<Record<string, number>>,
  fallback: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  const combined: Record<string, number> = { ...legacy };
  for (const [name, value] of Object.entries(fallback ?? {})) {
    const previous = combined[name];
    if (previous === undefined) {
      combined[name] = value;
    } else if (ADDITIVE_FALLBACK_COUNTERS.has(name)) {
      combined[name] = previous + value;
    } else if (MAXIMUM_FALLBACK_COUNTERS.has(name)) {
      combined[name] = Math.max(previous, value);
    } else {
      combined[fallbackCounterName(name)] = value;
    }
  }
  return Object.freeze(combined);
}

function combineClassicResult(
  run: SearchRunState,
  result: SolverResult,
): SolverResult {
  const legacy = aggregate(run);
  const combinedCounters = {
    ...mergeFallbackCounters(
      legacy.counters,
      result.metrics.counters,
    ),
    legacyExpandedStates: legacy.expandedStates,
    legacyGeneratedStates: legacy.generatedStates,
  };
  const combinedMetrics: SolverRunMetrics = Object.freeze({
    elapsedMs: elapsed(run),
    expandedStates:
      legacy.expandedStates + (result.metrics.expandedStates ?? 0),
    generatedStates:
      legacy.generatedStates + (result.metrics.generatedStates ?? 0),
    peakFrontierSize: Math.max(
      legacy.peakFrontierSize,
      result.metrics.peakFrontierSize ?? 0,
    ),
    counters: Object.freeze(combinedCounters),
  });
  return Object.freeze({
    ...result,
    metrics: combinedMetrics,
  }) as SolverResult;
}

async function runClassicFallback(
  run: SearchRunState,
): Promise<SolverResult | null> {
  const request = withRemainingLimits(run);
  if (!request) return null;
  const offset = elapsed(run);
  const legacy = aggregate(run);
  const context: SolverExecutionContext = {
    signal: run.context.signal,
    now: run.context.now,
    reportProgress(progress) {
      run.context.reportProgress({
        ...progress,
        elapsedMs: offset + progress.elapsedMs,
        expandedStates:
          legacy.expandedStates + (progress.expandedStates ?? 0),
        generatedStates:
          legacy.generatedStates + (progress.generatedStates ?? 0),
        counters: mergeFallbackCounters(
          legacy.counters,
          progress.counters,
        ),
        detail: progress.detail
          ? `Compatibility fallback: ${progress.detail}`
          : "Compatibility fallback is searching.",
      });
    },
  };
  const result = await runClassicSearch(request, context, {
    strategy: "greedy",
  });
  return combineClassicResult(run, result);
}

function stopDetail(reason: PhaseStopReason): string {
  switch (reason) {
    case "cancelled":
      return "Search cancelled.";
    case "elapsed":
      return "The time limit was reached.";
    case "expanded":
      return "The expanded-state limit was reached.";
    case "generated":
      return "The generated-state limit was reached.";
    case "memory":
      return "The estimated-memory limit was reached.";
  }
}

function emptySolution(request: SolverRequest): SolverSolution {
  return Object.freeze({
    steps: Object.freeze([]),
    moves: 0,
    pushes: 0,
    objective: request.objective,
    objectiveScore: 0,
    optimality: "unknown",
  });
}

export const sokomindSolverMetadata: SolverMetadata = Object.freeze({
  id: "sokomind-solver",
  displayName: "Sokomind Solver",
  description:
    "Typed-box Sokoban search with structural macros, compact bidirectional frontiers, and bounded move-count improvement.",
  version: "1.2.0",
  capabilities: Object.freeze({
    executionTargets: ["web-worker"] as const,
    runtime: "javascript",
    objectives: ["moves"] as const,
    quality: "bounded",
    labeledBoxes: true,
    genericBoxes: true,
    partialState: true,
    reportsProgress: true,
    cooperativeCancellation: true,
    deterministic: false,
  }),
});

export function createSokomindSolverAdapter(
  options: SokomindSolverAdapterOptions = {},
): SolverAdapter {
  const createWorker = options.createWorker ?? defaultCreateWorker;
  const profile = resolveSokomindTuning(options.tuning);
  const tuning = sokomindTuningPayload(profile);
  const proofWorkerFactory = options.createProofWorker ?? defaultCreateProofWorker;
  const proofCheckpointOptions = options.checkpointOptions;

  const boundHarvestAndImprove = (
    r: SearchRunState,
    s: LegacyState,
    first: SolverSolution,
    cw: () => SokomindEngineWorker,
    improvOpts: SokomindImprovementOptions,
    sokoOpts: import("./sokomind-options.ts").SokomindRequestOptions,
    t: Readonly<Record<string, number>>,
    mw: number,
    ap?: SokomindAnalysisPlan,
  ): Promise<SolverResult> =>
    harvestAndImprove(
      r, s, first, cw, improvOpts, sokoOpts, t, mw, ap,
      proofWorkerFactory, proofCheckpointOptions,
    );

  return Object.freeze({
    metadata: sokomindSolverMetadata,
    async solve(
      originalRequest: SolverRequest,
      context: SolverExecutionContext,
    ): Promise<SolverResult> {
      const originalOptions = extractSokomindOptions(originalRequest);
      const structural = isStructuralPuzzle(originalRequest);
      const autoStrategic =
        originalOptions.mode === "quality" &&
        structural &&
        !originalOptions.deterministic &&
        originalOptions.strategicAnalysisMs === 0;
      const request = autoStrategic
        ? Object.freeze({
            ...originalRequest,
            options: Object.freeze({
              ...originalRequest.options,
              "sokomind-solver": Object.freeze({
                ...(originalRequest.options?.["sokomind-solver"] as Record<string, unknown> | undefined),
                strategicAnalysisMs: 500,
                strategicPlanExecution: true,
              }),
            }),
          })
        : originalRequest;
      const sokomindOptions = extractSokomindOptions(request);
      const startedAt = context.now();
      const maxElapsed = request.limits?.maxElapsedMs;
      const run: SearchRunState = {
        startedAt,
        deadline:
          maxElapsed === undefined ? Infinity : startedAt + maxElapsed,
        request,
        context,
        profile,
        workerSilenceTimeoutMs:
          finiteNonNegative(options.workerSilenceTimeoutMs) ||
          WORKER_SILENCE_WATCHDOG_MS,
        structuralHeadStartLimitMs:
          finiteNonNegative(options.structuralHeadStartMs) ||
          profile.structuralHeadStartMs,
        registry: new WorkerExecutionRegistry(),
        budget: new BudgetTracker(),
        rejectedCandidates: 0,
        completedWorkers: 0,
        phaseTimeouts: 0,
        watchdogTimeouts: 0,
        lastProgressAt: -Infinity,
        progressPhase: "searching",
        initialSolutionMoves: 0,
        bestSolutionMoves: 0,
        solutionImprovements: 0,
        suppressedImprovementErrors: 0,
        suppressedHarvestErrors: 0,
      };

      if (context.signal.aborted) {
        return Object.freeze({ status: "cancelled", metrics: metrics(run) });
      }
      if (request.snapshot.solved) {
        return Object.freeze({
          status: "solved",
          solution: emptySolution(request),
          metrics: metrics(run),
        });
      }

      context.reportProgress({
        phase: "preparing",
        elapsedMs: 0,
        detail: "Compiling typed geometry and search plans.",
      });

      let state = toLegacyState(request);
      const maxWorkers = sokomindOptions.deterministic
        ? 1
        : configuredWorkerCount(options, request);
      let cutoff = false;
      let errors: string[] = [];
      let stopReason: PhaseStopReason | undefined;
      let engineWorkersStarted = 0;
      let engineWorkersFailed = 0;
      let analysisPlan: SokomindAnalysisPlan | undefined;
      let structuralCheckpoints: readonly LegacySearchCheckpoint[] =
        Object.freeze([]);

      if (structural) {
        const preparation = await runPhase(
          run,
          [preparationPlan(state, sokomindOptions.strategicAnalysisMs, request)],
          createWorker,
          1,
        );
        if (preparation.preparedBoard) {
          state = withPreparedBoard(state, preparation.preparedBoard);
          run.budget.preparedBoardEstimatedMemoryBytes =
            preparedBoardMemoryEstimate(preparation.preparedBoard);
        }
        analysisPlan = preparation.analysisPlan;
        errors = [...errors, ...preparation.errors];
        cutoff ||= preparation.cutoff;
        if (preparation.stopReason) {
          stopReason = preparation.stopReason;
        }
      }

      if (structural && !stopReason) {
        const remainingRequest = withRemainingLimits(run);
        if (!remainingRequest) {
          stopReason = reachedLimit(run) ?? "elapsed";
        } else {
          const structuralRequest =
            withStructuralStateBudget(remainingRequest, profile.structuralStateShare);
          if (structuralRequest) {
            const outcome = await runPhase(
              run,
              [
                structuralPlan(
                  state,
                  structuralRequest,
                  tuning,
                  sokomindOptions.mode,
                  1,
                  analysisPlan,
                ),
              ],
              createWorker,
              1,
              structuralHeadStartMs(run),
            );
            engineWorkersStarted += outcome.startedWorkers;
            engineWorkersFailed += outcome.failedWorkers;
            structuralCheckpoints = outcome.checkpoints ?? structuralCheckpoints;
            cutoff ||= outcome.cutoff || Boolean(outcome.phaseTimedOut);
            errors = [...errors, ...outcome.errors];
            if (outcome.solution) {
              return solvedWithImprovement(
                run, state, outcome.solution, createWorker, options,
                sokomindOptions, boundHarvestAndImprove,
                tuning, maxWorkers, analysisPlan,
              );
            }
            if (outcome.stopReason) stopReason = outcome.stopReason;
          }
        }
      }

      if (!stopReason) {
        const discoveryRequest = withRemainingLimits(run);
        if (!discoveryRequest) {
          stopReason = reachedLimit(run) ?? "elapsed";
        } else {
          const remainingExpanded =
            discoveryRequest.limits?.maxExpandedStates;
          const remainingGenerated =
            discoveryRequest.limits?.maxGeneratedStates;
          const remainingStateLaneBudget = Math.min(
            remainingExpanded ?? Infinity,
            remainingGenerated ?? Infinity,
          );
          const discoveryWorkers =
            !Number.isFinite(remainingStateLaneBudget)
              ? maxWorkers
              : Math.max(
                  1,
                  Math.min(
                    maxWorkers,
                    Math.floor(remainingStateLaneBudget),
                  ),
                );
          const rootPlanCount =
            discoveryWorkers >= 3 && reverseLaneCount(analysisPlan) > 0
              ? 3
              : 1;
          const checkpointPlanCount = Math.min(
            2,
            structuralCheckpoints.length,
          );
          const discoveryPlanCount = rootPlanCount + checkpointPlanCount;
          const rootPlans = discoveryPlans(
            state,
            discoveryRequest,
            discoveryWorkers,
            tuning,
            discoveryPlanCount,
            analysisPlan,
            sokomindOptions.mode === "fast",
          );
          const continuationPlans = checkpointContinuationPlans(
            structuralCheckpoints,
            state,
            discoveryRequest,
            tuning,
            discoveryPlanCount,
            analysisPlan,
            sokomindOptions.mode === "fast",
          );
          const outcome = await runPhase(
            run,
            Object.freeze([...rootPlans, ...continuationPlans]),
            createWorker,
            discoveryWorkers,
          );
          engineWorkersStarted += outcome.startedWorkers;
          engineWorkersFailed += outcome.failedWorkers;
          cutoff ||= outcome.cutoff;
          errors = [...errors, ...outcome.errors];
          if (outcome.solution) {
            return solvedWithImprovement(
              run, state, outcome.solution, createWorker, options,
              sokomindOptions, boundHarvestAndImprove,
              tuning, maxWorkers, analysisPlan,
            );
          }
          if (outcome.stopReason) stopReason = outcome.stopReason;
        }
      }

      if (!stopReason && maxWorkers === 2) {
        const bidirectionalRequest = withRemainingLimits(run);
        const remainingLaneBudget = Math.min(
          bidirectionalRequest?.limits?.maxExpandedStates ?? Infinity,
          bidirectionalRequest?.limits?.maxGeneratedStates ?? Infinity,
        );
        if (
          bidirectionalRequest &&
          (!Number.isFinite(remainingLaneBudget) ||
            remainingLaneBudget >= 2)
        ) {
          const outcome = await runPhase(
            run,
            bidirectionalPlans(state, bidirectionalRequest, 2, analysisPlan),
            createWorker,
            2,
          );
          engineWorkersStarted += outcome.startedWorkers;
          engineWorkersFailed += outcome.failedWorkers;
          cutoff ||= outcome.cutoff;
          errors = [...errors, ...outcome.errors];
          if (outcome.solution) {
            return solvedWithImprovement(
              run, state, outcome.solution, createWorker, options,
              sokomindOptions, boundHarvestAndImprove,
              tuning, maxWorkers, analysisPlan,
            );
          }
          if (outcome.stopReason) stopReason = outcome.stopReason;
        }
      }

      if (stopReason === "cancelled" || context.signal.aborted) {
        return Object.freeze({ status: "cancelled", metrics: metrics(run) });
      }
      if (stopReason) {
        return Object.freeze({
          status: "unsolved",
          reason: "limit-reached",
          detail: stopDetail(stopReason),
          metrics: metrics(run),
        });
      }

      const fallback = await runClassicFallback(run);
      if (fallback) {
        if (sokomindOptions.mode !== "fast" && fallback.status === "solved") {
          return runProof(
            run.request, run.context, sokomindOptions, fallback,
            proofWorkerFactory, proofCheckpointOptions,
          );
        }
        return fallback;
      }

      const allWorkersFailed =
        engineWorkersStarted === 0 ||
        (engineWorkersFailed > 0 &&
          engineWorkersFailed >= engineWorkersStarted);
      return Object.freeze({
        status: "unsolved",
        reason: allWorkersFailed || cutoff ? "limit-reached" : "exhausted",
        detail:
          errors.length > 0
            ? `Sokomind engine: ${errors.join(" ")}`
            : "The first-found portfolio completed without a verified route.",
        metrics: metrics(run),
      });
    },
  });
}

export const sokomindSolver = createSokomindSolverAdapter();
