/**
 * Quality gate — Sprint 11
 *
 * Prevents technically valid but uninteresting puzzles from entering any high
 * tier.  Applies **before** difficulty classification so that a Master puzzle
 * that is bad is rejected rather than classified Master.
 *
 * The gate computes a multi-dimensional quality profile and enforces:
 *   1. A tier-independent quality floor (every puzzle must pass).
 *   2. Tier-specific quality floors (harder tiers require stronger evidence).
 */

import type { Difficulty } from "../../../core/model.ts";
import type { PuzzleEvaluationVector } from "./puzzle-evaluator.ts";

// ---------------------------------------------------------------------------
// Quality profile
// ---------------------------------------------------------------------------

export interface PuzzleQualityProfile {
  /** How much of the geometry is used purposefully by the solution. */
  readonly purposefulGeometry: number;
  /** Degree of multi-box interaction (shared routes, causal events). */
  readonly interactionQuality: number;
  /** Depth of causal chains (enable/disable, dependency depth). */
  readonly causalDepth: number;
  /** Decision richness — branching, non-forced choices. */
  readonly decisionQuality: number;
  /** Mechanism integrity — staging, non-monotonic, vacancy evidence. */
  readonly mechanismIntegrity: number;
  /** Elegance — compact, purposeful, low waste. */
  readonly elegance: number;
  /** Tedium — walking, repetition, forced sequences (lower is better). */
  readonly tedium: number;
  /** Overall pass / fail. */
  readonly passed: boolean;
  /** Human-readable rejection reasons (empty if passed). */
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// Tier-specific quality floor thresholds
// ---------------------------------------------------------------------------

export interface QualityFloor {
  readonly minPurposefulGeometry: number;
  readonly minInteractionQuality: number;
  readonly minCausalDepth: number;
  readonly minDecisionQuality: number;
  readonly minMechanismIntegrity: number;
  readonly minElegance: number;
  readonly maxTedium: number;
}

/**
 * Quality floors by tier.  Every tier has a baseline; higher tiers raise the
 * bar.  tutorial/beginner are intentionally lenient.
 */
export const QUALITY_FLOORS: Readonly<Record<Difficulty, QualityFloor>> = {
  tutorial:     { minPurposefulGeometry: 0,    minInteractionQuality: 0,    minCausalDepth: 0,    minDecisionQuality: 0,    minMechanismIntegrity: 0,    minElegance: 0,    maxTedium: 1.0  },
  beginner:     { minPurposefulGeometry: 0,    minInteractionQuality: 0,    minCausalDepth: 0,    minDecisionQuality: 0,    minMechanismIntegrity: 0,    minElegance: 0,    maxTedium: 0.9  },
  intermediate: { minPurposefulGeometry: 0.15, minInteractionQuality: 0.05, minCausalDepth: 0,    minDecisionQuality: 0.1,  minMechanismIntegrity: 0,    minElegance: 0.05, maxTedium: 0.8  },
  advanced:     { minPurposefulGeometry: 0.25, minInteractionQuality: 0.15, minCausalDepth: 0.05, minDecisionQuality: 0.2,  minMechanismIntegrity: 0.1,  minElegance: 0.1,  maxTedium: 0.7  },
  expert:       { minPurposefulGeometry: 0.35, minInteractionQuality: 0.3,  minCausalDepth: 0.15, minDecisionQuality: 0.3,  minMechanismIntegrity: 0.25, minElegance: 0.15, maxTedium: 0.6  },
  master:       { minPurposefulGeometry: 0.45, minInteractionQuality: 0.45, minCausalDepth: 0.3,  minDecisionQuality: 0.4,  minMechanismIntegrity: 0.4,  minElegance: 0.2,  maxTedium: 0.5  },
};

// ---------------------------------------------------------------------------
// Dimension scoring helpers (0..1 scale)
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Purposeful geometry: how much of the floor the solution actually uses,
 * combined with structural features that serve the puzzle.
 */
export function computePurposefulGeometry(ev: PuzzleEvaluationVector): number {
  // solution floor coverage (0..1)
  const coverageScore = ev.solutionFloorCoverage;
  // low unused floor is good — invert unusedFloorRatio
  const compactScore = 1 - ev.solutionUnusedFloorRatio;
  // structural purpose: regions and chokepoints relative to board scale
  const structuralPurpose = clamp01(
    (ev.regionCount * 0.15 + ev.chokepoints * 0.2 + ev.articulationPoints * 0.1) /
    Math.max(ev.boxCount, 1),
  );
  return clamp01(coverageScore * 0.4 + compactScore * 0.3 + structuralPurpose * 0.3);
}

/**
 * Interaction quality: multi-box causal interaction evidence.
 */
export function computeInteractionQuality(ev: PuzzleEvaluationVector): number {
  if (ev.boxCount <= 1) return 0;

  const sharedRouteScore = clamp01(ev.sharedRouteCells / (ev.boxCount * 2));
  const sharedSupportScore = clamp01(ev.sharedSupportCells / ev.boxCount);
  const switchScore = ev.boxSwitchRate;
  const independenceInverse = 1 - ev.boxIndependenceRatio;
  const interactionEventScore = clamp01(ev.boxInteractionEvents / (ev.boxCount * 2));

  return clamp01(
    sharedRouteScore * 0.2 +
    sharedSupportScore * 0.2 +
    switchScore * 0.2 +
    independenceInverse * 0.2 +
    interactionEventScore * 0.2,
  );
}

/**
 * Causal depth: enable/disable events and dependency depth.
 */
export function computeCausalDepth(ev: PuzzleEvaluationVector): number {
  const enableScore = clamp01(ev.causalEnableCount / 3);
  const disableScore = clamp01(ev.causalDisableCount / 3);
  const depthScore = clamp01(ev.estimatedDependencyDepth / 4);
  const orderScore = clamp01(ev.goalOrderConstraints / 3);

  return clamp01(
    enableScore * 0.3 + disableScore * 0.2 + depthScore * 0.3 + orderScore * 0.2,
  );
}

/**
 * Decision quality: branching, non-forced choices, high-branch points.
 */
export function computeDecisionQuality(ev: PuzzleEvaluationVector): number {
  const branchScore = clamp01(
    Math.log2(Math.max(ev.avgReachablePushes, 1) + 1) / 3.5,
  );
  const highBranchScore = clamp01(ev.reachableHighBranchCount / 5);
  const nonForcedScore = 1 - ev.reachableForcedPushRatio;
  const nonSingleChoiceScore = 1 - ev.reachableSingleChoiceRatio;

  return clamp01(
    branchScore * 0.3 +
    highBranchScore * 0.2 +
    nonForcedScore * 0.3 +
    nonSingleChoiceScore * 0.2,
  );
}

/**
 * Mechanism integrity: staging, non-monotonic progress, goal vacancy, box reuse.
 */
export function computeMechanismIntegrity(ev: PuzzleEvaluationVector): number {
  const nonMonoScore = clamp01(ev.nonMonotonicBoxMoves / 3);
  const stagingScore = clamp01(ev.stagingOperations / 2);
  const vacancyScore = clamp01(ev.temporaryGoalVacancies / 2);
  const multiMoveScore = clamp01(ev.multiMoveBoxCount / Math.max(ev.boxCount, 1));
  const depthScore = clamp01(ev.estimatedDependencyDepth / 3);

  return clamp01(
    nonMonoScore * 0.25 +
    stagingScore * 0.2 +
    vacancyScore * 0.2 +
    multiMoveScore * 0.15 +
    depthScore * 0.2,
  );
}

/**
 * Elegance: compact, purposeful, low ratio of wasted space and actions.
 */
export function computeElegance(ev: PuzzleEvaluationVector): number {
  const compactness = 1 - ev.unusedFloorRatio;
  const pushEfficiency = ev.pushRatio;
  const lowRepetition = 1 - ev.repetitivePushRatio;
  const lowEmptyWalk = 1 - ev.emptyWalkRatio;

  return clamp01(
    compactness * 0.3 + pushEfficiency * 0.2 + lowRepetition * 0.25 + lowEmptyWalk * 0.25,
  );
}

/**
 * Tedium: walking, repetition, forced sequences. 0 = no tedium, 1 = maximum.
 */
export function computeTedium(ev: PuzzleEvaluationVector): number {
  const walkTedium = ev.emptyWalkRatio;
  const repetitiveTedium = ev.repetitivePushRatio;
  const longWalkTedium = clamp01(ev.longestWalkStreak / 30);
  const movesPerPushTedium = clamp01(ev.movesPerPush / 15);
  const forcedTedium = ev.reachableForcedPushRatio;

  return clamp01(
    walkTedium * 0.25 +
    repetitiveTedium * 0.25 +
    longWalkTedium * 0.2 +
    movesPerPushTedium * 0.15 +
    forcedTedium * 0.15,
  );
}

// ---------------------------------------------------------------------------
// Main quality assessment
// ---------------------------------------------------------------------------

/**
 * Assess the quality of a puzzle from its evaluation vector.
 *
 * @param ev  The evaluation vector (from evaluatePuzzle).
 * @param tier  The *intended* difficulty tier — used to select the quality floor.
 *              This is the tier the puzzle was generated for, not the V4 classification.
 * @returns  A quality profile with dimension scores and pass/fail status.
 */
export function assessQuality(
  ev: PuzzleEvaluationVector,
  tier: Difficulty,
): PuzzleQualityProfile {
  const purposefulGeometry = computePurposefulGeometry(ev);
  const interactionQuality = computeInteractionQuality(ev);
  const causalDepth = computeCausalDepth(ev);
  const decisionQuality = computeDecisionQuality(ev);
  const mechanismIntegrity = computeMechanismIntegrity(ev);
  const elegance = computeElegance(ev);
  const tedium = computeTedium(ev);

  const floor = QUALITY_FLOORS[tier];
  const reasons: string[] = [];

  if (purposefulGeometry < floor.minPurposefulGeometry)
    reasons.push(`purposefulGeometry ${purposefulGeometry.toFixed(3)} < ${floor.minPurposefulGeometry}`);
  if (interactionQuality < floor.minInteractionQuality)
    reasons.push(`interactionQuality ${interactionQuality.toFixed(3)} < ${floor.minInteractionQuality}`);
  if (causalDepth < floor.minCausalDepth)
    reasons.push(`causalDepth ${causalDepth.toFixed(3)} < ${floor.minCausalDepth}`);
  if (decisionQuality < floor.minDecisionQuality)
    reasons.push(`decisionQuality ${decisionQuality.toFixed(3)} < ${floor.minDecisionQuality}`);
  if (mechanismIntegrity < floor.minMechanismIntegrity)
    reasons.push(`mechanismIntegrity ${mechanismIntegrity.toFixed(3)} < ${floor.minMechanismIntegrity}`);
  if (elegance < floor.minElegance)
    reasons.push(`elegance ${elegance.toFixed(3)} < ${floor.minElegance}`);
  if (tedium > floor.maxTedium)
    reasons.push(`tedium ${tedium.toFixed(3)} > ${floor.maxTedium}`);

  return {
    purposefulGeometry,
    interactionQuality,
    causalDepth,
    decisionQuality,
    mechanismIntegrity,
    elegance,
    tedium,
    passed: reasons.length === 0,
    reasons,
  };
}
