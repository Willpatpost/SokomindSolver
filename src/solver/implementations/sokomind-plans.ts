// Pure worker-plan construction and disjoint rewrite-budget allocation.
import type { SolverRequest, SolverSolution } from "../contracts.ts";
import type { EngineCommand } from "./sokomind-engine/engine-protocol.ts";
import {
  finiteNonNegative,
  legacyPathFromSolution,
  optionalFiniteNonNegative,
  type LegacySearchCheckpoint,
  type LegacyState,
  type SokomindAnalysisPlan,
} from "./sokomind-legacy.ts";
import type { SokomindRequestOptions } from "./sokomind-options.ts";
import type { SokomindTuningProfile } from "./sokomind-tuning.ts";

export const DEFAULT_MAX_ENGINE_WORKERS = 3;

export function defaultImprovementMaxVisited(maxMemoryBytes?: number): number {
  if (maxMemoryBytes === undefined || !Number.isFinite(maxMemoryBytes)) {
    return 50_000;
  }
  const availableMB = maxMemoryBytes / (1024 * 1024);
  return Math.max(50_000, Math.min(500_000, Math.floor(availableMB * 200)));
}

export const DEFAULT_IMPROVEMENT_MAX_ELAPSED_MS = 45_000;
export const DEFAULT_IMPROVEMENT_MINIMUM_MOVES = 100;

export interface EnginePlan {
  readonly id: string;
  readonly label: string;
  readonly mode: EngineCommand["mode"];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly capturesPreparedBoard?: boolean;
  /** Verified prefix from the original request to a continuation state. */
  readonly pathPrefix?: readonly unknown[];
}

function remainingStateBudget(
  request: SolverRequest,
  fallback: number,
  divisor = 1,
): number {
  const limit = request.limits?.maxExpandedStates;
  if (limit === undefined) return fallback;
  return Math.max(0, Math.min(fallback, Math.floor(limit / divisor)));
}

function remainingGeneratedBudget(
  request: SolverRequest,
  fallback: number,
  divisor = 1,
): number {
  const limit = request.limits?.maxGeneratedStates;
  if (limit === undefined) return fallback;
  return Math.max(0, Math.min(fallback, Math.floor(limit / divisor)));
}

export function preparationPlan(state: LegacyState): EnginePlan {
  return Object.freeze({
    id: "prepare-board",
    label: "Typed board analysis",
    mode: "search",
    capturesPreparedBoard: true,
    payload: Object.freeze({
      algorithm: "analyze-puzzle",
      state,
    }),
  });
}

export function structuralPlan(
  state: LegacyState,
  request: SolverRequest,
  tuning: Readonly<Record<string, number>>,
  mode: SokomindRequestOptions["mode"],
  budgetDivisor = 1,
): EnginePlan {
  const memoryLimit = request.limits?.maxMemoryBytes ?? Infinity;
  const transpositionLimit =
    memoryLimit <= 384 * 1024 * 1024
      ? 24_000
      : memoryLimit <= 768 * 1024 * 1024
        ? 36_000
        : memoryLimit <= 1_536 * 1024 * 1024
          ? 48_000
          : 60_000;
  return Object.freeze({
    id: "structural-plan",
    label: "Structural plan search",
    mode: "search",
    payload: Object.freeze({
      algorithm: "plan-macro-beam",
      state,
      maxDepth: 460,
      maxVisited: remainingStateBudget(request, 6_000, budgetDivisor),
      maxGenerated: remainingGeneratedBudget(
        request,
        60_000,
        budgetDivisor,
      ),
      transpositionLimit,
      sequenceMacroExplored: 48,
      sequenceMacroResults: 4,
      targetedMacroExplored: 64,
      progressIntervalMs: 1_000,
      ...tuning,
      ...(mode === "fast" ? { planSolutionComparisonBudget: 0 } : {}),
    }),
  });
}

export function sokomindDiscoveryBeamWidth(
  boxCount: number,
  floorCount: number,
  maxMemoryBytes = Infinity,
): number {
  const moderate = boxCount >= 5 || floorCount >= 45;
  if (!moderate) return 320;
  if (maxMemoryBytes <= 384 * 1024 * 1024) {
    return boxCount >= 8 ? 32 : 128;
  }
  if (maxMemoryBytes <= 768 * 1024 * 1024) {
    return boxCount >= 8 ? 64 : 256;
  }
  if (maxMemoryBytes <= 1_536 * 1024 * 1024) {
    return boxCount >= 8 ? 128 : 384;
  }
  return boxCount >= 8 ? 256 : 700;
}

export function discoveryPlans(
  state: LegacyState,
  request: SolverRequest,
  maxWorkers: number,
  tuning: Readonly<Record<string, number>>,
  budgetDivisor = maxWorkers,
  analysisPlan?: SokomindAnalysisPlan,
  firstSolutionOnly = false,
): readonly EnginePlan[] {
  const boxes = request.snapshot.boxes.length;
  const moderate = boxes >= 5 || request.board.floor.length >= 45;
  const memoryLimit = request.limits?.maxMemoryBytes ?? Infinity;
  const directVisitedFallback = moderate
    ? memoryLimit <= 384 * 1024 * 1024
      ? 60_000
      : memoryLimit <= 768 * 1024 * 1024
        ? 120_000
        : 180_000
    : memoryLimit <= 384 * 1024 * 1024
      ? 40_000
      : 80_000;
  const recommendedVisited = analysisPlan?.recommendations.beamVisited;
  const directVisitedLimit = recommendedVisited === undefined
    ? directVisitedFallback
    : Math.max(
        1,
        Math.min(directVisitedFallback, Math.floor(recommendedVisited)),
      );
  const directGeneratedFallback = moderate
    ? memoryLimit <= 384 * 1024 * 1024
      ? 200_000
      : memoryLimit <= 768 * 1024 * 1024
        ? 600_000
        : memoryLimit <= 1_536 * 1024 * 1024
          ? 900_000
          : 1_200_000
    : memoryLimit <= 384 * 1024 * 1024
      ? 150_000
      : 300_000;
  const directBudget = remainingStateBudget(
    request,
    directVisitedLimit,
    budgetDivisor,
  );
  const directGeneratedBudget = remainingGeneratedBudget(
    request,
    directGeneratedFallback,
    budgetDivisor,
  );
  const memoryBeamWidth = sokomindDiscoveryBeamWidth(
    boxes,
    request.board.floor.length,
    request.limits?.maxMemoryBytes,
  );
  const recommendedBeamWidth = analysisPlan?.recommendations.beamWidth;
  const beamWidth = recommendedBeamWidth === undefined
    ? memoryBeamWidth
    : Math.max(1, Math.min(memoryBeamWidth, Math.floor(recommendedBeamWidth)));
  const checkpointLimit = Math.max(
    1,
    Math.floor(analysisPlan?.recommendations.checkpointLimit ?? 8),
  );
  const transpositionLimit = !moderate
    ? 30_000
    : memoryLimit <= 384 * 1024 * 1024
      ? 24_000
      : memoryLimit <= 768 * 1024 * 1024
        ? 36_000
        : memoryLimit <= 1_536 * 1024 * 1024
          ? 48_000
          : 60_000;
  const direct: EnginePlan = Object.freeze({
    id: "direct-portfolio",
    label: "Guided push portfolio",
    mode: "search",
    payload: Object.freeze({
      algorithm: "ultimate",
      state,
      maxDepth: moderate ? 360 : 180,
      maxVisited: directBudget,
      maxGenerated: directGeneratedBudget,
      transpositionLimit,
      beamWidth,
      beamProfile: analysisPlan?.phases.includes("milestone-reverse")
        ? "milestone"
        : "balanced",
      sequenceMacros:
        moderate && analysisPlan?.recommendations.useSequenceMacros !== false,
      checkpointLimit,
      progressInterval: 1_000,
      progressIntervalMs: 1_000,
      ...tuning,
      ...(firstSolutionOnly ? { beamSolutionComparisonBudget: 0 } : {}),
    }),
  });

  if (maxWorkers < 3) return Object.freeze([direct]);
  const bidirectional = bidirectionalPlans(
    state,
    request,
    budgetDivisor,
    analysisPlan,
  );
  return Object.freeze([
    direct,
    ...bidirectional,
  ]);
}

export function reverseLaneCount(analysisPlan?: SokomindAnalysisPlan): number {
  const recommended = analysisPlan?.recommendations.reverseWorkerLimit;
  if (recommended === undefined) return 1;
  // The current adapter owns one reverse meeting map. Honor analysis that
  // disables the lane, while capping positive recommendations at the one lane
  // that can be scheduled without silently dropping reverse-start shards or
  // diluting every portfolio budget.
  return Math.min(1, Math.max(0, Math.floor(recommended)));
}

export function bidirectionalPlans(
  state: LegacyState,
  request: SolverRequest,
  budgetDivisor = 2,
  analysisPlan?: SokomindAnalysisPlan,
): readonly EnginePlan[] {
  if (reverseLaneCount(analysisPlan) === 0) return Object.freeze([]);
  const boxes = request.snapshot.boxes.length;
  const moderate = boxes >= 5 || request.board.floor.length >= 45;
  const sideFallback = analysisPlan?.recommendations.sideVisitedLimit ??
    (moderate ? 100_000 : 40_000);
  const sideBudget = remainingStateBudget(
    request,
    Math.max(1, Math.floor(sideFallback)),
    budgetDivisor,
  );
  return Object.freeze([
    Object.freeze({
      id: "bidirectional-forward",
      label: "Forward bidirectional search",
      mode: "bidir-forward",
      payload: Object.freeze({
        state,
        maxVisited: sideBudget,
        frontierLimit: 40_000,
      }),
    }),
    Object.freeze({
      id: "bidirectional-reverse",
      label: "Reverse bidirectional search",
      mode: "bidir-reverse",
      payload: Object.freeze({
        state,
        maxVisited: sideBudget,
        frontierLimit: 40_000,
        landmarkLimit: 64,
        reverseShard: Object.freeze({ index: 0, count: 1 }),
      }),
    }),
  ]);
}

export function checkpointContinuationPlans(
  checkpoints: readonly LegacySearchCheckpoint[],
  preparedState: LegacyState,
  request: SolverRequest,
  tuning: Readonly<Record<string, number>>,
  budgetDivisor: number,
  analysisPlan?: SokomindAnalysisPlan,
  firstSolutionOnly = false,
): readonly EnginePlan[] {
  return Object.freeze(
    [...checkpoints]
      .filter((checkpoint) => checkpoint.path.length > 0)
      .sort((left, right) =>
        (left.estimate ?? Infinity) - (right.estimate ?? Infinity) ||
        (right.cost ?? 0) - (left.cost ?? 0))
      .slice(0, 2)
      .flatMap((checkpoint, index) => {
        const checkpointState: LegacyState = Object.freeze({
          ...checkpoint.state,
          ...(preparedState.preparedBoard
            ? { preparedBoard: preparedState.preparedBoard }
            : {}),
        });
        const direct = discoveryPlans(
          checkpointState,
          request,
          1,
          tuning,
          budgetDivisor,
          analysisPlan,
          firstSolutionOnly,
        )[0];
        if (!direct) return [];
        const maxDepth = optionalFiniteNonNegative(direct.payload.maxDepth);
        const prefixCost = checkpoint.cost ?? 0;
        return [Object.freeze({
          ...direct,
          id: `checkpoint-continuation-${index}`,
          label: `Structural checkpoint continuation ${index + 1}`,
          pathPrefix: checkpoint.path,
          payload: Object.freeze({
            ...direct.payload,
            state: checkpointState,
            seed: 65_537 + index * 8_191,
            ...(maxDepth === undefined
              ? {}
              : { maxDepth: Math.max(1, maxDepth - prefixCost) }),
          }),
        })];
      }),
  );
}

export function diversifiedHarvestPlans(
  state: LegacyState,
  request: SolverRequest,
  workerCount: number,
  tuning: Readonly<Record<string, number>>,
  round: number,
  analysisPlan?: SokomindAnalysisPlan,
): readonly EnginePlan[] {
  const count = Math.max(1, Math.floor(workerCount));
  const direct = discoveryPlans(
    state,
    request,
    1,
    tuning,
    count,
    analysisPlan,
  )[0];
  if (!direct) return Object.freeze([]);
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const seed = ((round + 1) * 104_729 + index * 13_007) >>> 0;
    const profiles = Object.freeze([
      Object.freeze({
        beamProfile: "balanced",
        diversity: 1.25,
        planMoveWeight: 0.005,
      }),
      Object.freeze({
        beamProfile: "detour",
        diversity: 2.25,
        planMoveWeight: 0.003,
      }),
      Object.freeze({
        beamProfile: "milestone",
        diversity: 0.8,
        planMoveWeight: 0.008,
      }),
    ]);
    const profile = profiles[(round + index) % profiles.length];
    return Object.freeze({
      ...direct,
      id: `harvest-${round}-${index}`,
      label: `Diverse harvest ${round + 1}.${index + 1}`,
      payload: Object.freeze({ ...direct.payload, seed, ...profile }),
    });
  }));
}

export function sokomindRewriteConcurrency(
  maxWorkers: number,
  maxMemoryBytes: number | undefined,
  candidateCount: number,
): number {
  const workers = Math.max(1, Math.floor(maxWorkers));
  const candidates = Math.max(0, Math.floor(candidateCount));
  if (candidates === 0) return 0;
  const memory = maxMemoryBytes ?? Infinity;
  const memoryBound = memory <= 768 * 1024 * 1024
    ? 1
    : memory <= 1_536 * 1024 * 1024
      ? 2
      : DEFAULT_MAX_ENGINE_WORKERS;
  return Math.max(1, Math.min(workers, memoryBound, candidates));
}

export function configuredBudget(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  return Math.floor(finiteNonNegative(value));
}

export function solutionImprovementPlan(
  state: LegacyState,
  incumbent: SolverSolution,
  maxVisited: number,
  pass: number,
  rewriteProfile: SokomindTuningProfile,
  candidateIndex = 0,
  maxGenerated = Infinity,
  allocation: RewriteBudgetAllocation = DEFAULT_REWRITE_BUDGET_ALLOCATION,
): EnginePlan {
  const windowVisited = rewriteProfile.rewriteWindowVisited;
  const moveScale = rewriteProfile.rewriteMoveWindowScale;
  return Object.freeze({
    id: `solution-rewrite-c${candidateIndex}-p${pass}`,
    label: `Move-count solution rewrite c${candidateIndex} p${pass}`,
    mode: "search",
    payload: Object.freeze({
      algorithm: "solution-window-rewrite",
      state,
      solutionPath: legacyPathFromSolution(incumbent),
      maxVisited,
      maxGenerated,
      permutationVisited: Math.floor(maxVisited * allocation.permutationShare),
      permutationWindowPushes: Object.freeze([8, 16, 32]),
      perPermutationWindowVisited: 1_500,
      windowPushes: Object.freeze([8, 16, 32]),
      windowVisited,
      windowTotalVisited: Math.floor(maxVisited * allocation.pushWindowShare),
      frontierLimit: windowVisited,
      moveWindowVisited: Math.floor(
        maxVisited * allocation.moveWindowShare * moveScale,
      ),
      moveWindowPushes: Object.freeze([1, 2, 4]),
      moveWindowAttempts: 12,
      perMoveWindowVisited: Math.floor(4_000 * moveScale),
      moveWindowExtraPushes: 4,
      moveWindowMinimumOverhead: 6,
      adaptiveMoveWindows: state.boxes.length >= 10,
      adaptiveMoveMinimumPriorImprovements: 8,
      moveWindowMissLimit: 1,
      progressIntervalMs: 1_000,
    }),
  });
}

export interface RewriteBudgetAllocation {
  readonly permutationShare: number;
  readonly pushWindowShare: number;
  readonly moveWindowShare: number;
}

export const DEFAULT_REWRITE_BUDGET_ALLOCATION: RewriteBudgetAllocation = Object.freeze({
  permutationShare: 0.2,
  pushWindowShare: 0.3,
  moveWindowShare: 0.5,
});

export interface ParallelRewriteBudget {
  readonly maxVisited: number;
  readonly maxGenerated: number;
  readonly maxElapsedMs: number;
}

export function dividedIntegerBudget(total: number, count: number): readonly number[] {
  if (count <= 0) return Object.freeze([]);
  if (!Number.isFinite(total)) {
    return Object.freeze(Array.from({ length: count }, () => Infinity));
  }
  const safeTotal = Math.floor(finiteNonNegative(total));
  const base = Math.floor(safeTotal / count);
  const remainder = safeTotal % count;
  return Object.freeze(
    Array.from(
      { length: count },
      (_, index) => base + (index < remainder ? 1 : 0),
    ),
  );
}

/**
 * Reserves disjoint state and wall-clock shares before parallel rewrites start.
 * Taking the snapshot once prevents every concurrent candidate from observing
 * and spending the same global remainder.
 */
export function allocateParallelRewriteBudgets(
  candidateCount: number,
  maxVisited: number,
  maxGenerated: number | undefined,
  maxElapsedMs: number,
): readonly ParallelRewriteBudget[] {
  const count = Math.max(0, Math.floor(finiteNonNegative(candidateCount)));
  const visitedShares = dividedIntegerBudget(maxVisited, count);
  const generatedShares = dividedIntegerBudget(maxGenerated ?? Infinity, count);
  const elapsedShares = dividedIntegerBudget(maxElapsedMs, count);
  return Object.freeze(
    Array.from({ length: count }, (_, index) => Object.freeze({
      maxVisited: visitedShares[index],
      maxGenerated: generatedShares[index],
      maxElapsedMs: elapsedShares[index],
    })),
  );
}
