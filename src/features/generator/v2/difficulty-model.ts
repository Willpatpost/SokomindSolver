import type { Difficulty } from "../../../core/model.ts";
import type { PuzzleEvaluationVector } from "./puzzle-evaluator.ts";

export interface V4DifficultyProfile {
  readonly structuralScale: number;
  readonly solutionDepth: number;
  readonly humanReasoningComplexity: number;
  readonly tediumPenalty: number;
  readonly composite: number;
  readonly classification: Difficulty;
  readonly confidenceNote: string;
}

export interface V4DifficultyThresholds {
  readonly minComposite: number;
  readonly minStructural: number;
  readonly minDepth: number;
  readonly minReasoning: number;
  readonly maxTedium: number;
}

export const V4_TIER_THRESHOLDS: Readonly<Record<Difficulty, V4DifficultyThresholds>> = {
  tutorial:      { minComposite: 0,    minStructural: 0,   minDepth: 0,   minReasoning: 0,    maxTedium: 1.0 },
  beginner:      { minComposite: 4.0,  minStructural: 2.0, minDepth: 2.0, minReasoning: 2.0,  maxTedium: 0.8 },
  intermediate:  { minComposite: 8.0,  minStructural: 3.5, minDepth: 3.5, minReasoning: 3.5,  maxTedium: 0.7 },
  advanced:      { minComposite: 14.0, minStructural: 5.0, minDepth: 5.0, minReasoning: 5.5,  maxTedium: 0.6 },
  expert:        { minComposite: 22.0, minStructural: 7.0, minDepth: 8.0, minReasoning: 8.0,  maxTedium: 0.5 },
  master:        { minComposite: 32.0, minStructural: 9.0, minDepth: 12.0, minReasoning: 12.0, maxTedium: 0.45 },
};

const TIER_ORDER: readonly Difficulty[] = [
  "tutorial",
  "beginner",
  "intermediate",
  "advanced",
  "expert",
  "master",
];

export function computeStructuralScale(ev: PuzzleEvaluationVector): number {
  const boxScale = Math.log2(Math.max(ev.boxCount, 1) + 1);
  const floorScale = Math.log2(Math.max(ev.totalFloor, 1) + 1);
  const regionBonus = Math.max(0, ev.regionCount - 1) * 0.5;
  const articulationBonus = ev.articulationPoints * 0.3;
  const chokepointBonus = ev.chokepoints * 0.4;
  const tunnelBonus = Math.min(ev.tunnelCells * 0.2, 2.0);

  return boxScale + floorScale * 0.3 + regionBonus + articulationBonus +
    chokepointBonus + tunnelBonus;
}

export function computeSolutionDepthScore(ev: PuzzleEvaluationVector): number {
  const pushScale = Math.log2(Math.max(ev.solutionPushes, 1) + 1);
  const pushesPerBox = ev.boxCount > 0 ? ev.solutionPushes / ev.boxCount : 0;
  const pushPerBoxScale = Math.log2(Math.max(pushesPerBox, 1) + 1);

  const nonMonoBonus = ev.nonMonotonicBoxMoves * 0.8;
  const stagingBonus = ev.stagingOperations * 1.2;
  const vacancyBonus = ev.temporaryGoalVacancies * 1.5;
  const switchBonus = ev.boxSwitchRate * 2.0;
  const multiMoveBonus = ev.multiMoveBoxCount * 0.5;
  const depthEstimate = ev.estimatedDependencyDepth * 0.6;

  return pushScale * 0.5 + pushPerBoxScale * 0.5 + nonMonoBonus + stagingBonus +
    vacancyBonus + switchBonus + multiMoveBonus + depthEstimate;
}

export function computeHumanReasoningComplexity(ev: PuzzleEvaluationVector): number {
  const branchingScore = Math.log2(Math.max(ev.avgReachablePushes, 1) + 1) * 1.5;
  const highBranchBonus = ev.reachableHighBranchCount * 0.3;
  const nonForcedBonus = (1 - ev.reachableForcedPushRatio) * 2.0;

  const interactionScore =
    ev.sharedRouteCells * 0.2 +
    ev.sharedSupportCells * 0.3 +
    ev.sharedChokepointUses * 0.5;
  const causalScore =
    Math.log2(Math.max(ev.causalEnableCount, 0) + 1) * 0.8 +
    Math.log2(Math.max(ev.causalDisableCount, 0) + 1) * 0.8;

  const crossingScore = Math.log2(Math.max(ev.roomCrossingsInSolution, 0) + 1) * 0.6;

  const deadlockPressure = Math.min(ev.deadlockDensity * 5.0, 3.0);

  const orderConstraints = Math.log2(Math.max(ev.goalOrderConstraints, 0) + 1) * 0.5;
  const depthBonus = ev.estimatedDependencyDepth * 0.4;

  return branchingScore + highBranchBonus + nonForcedBonus + interactionScore +
    causalScore + crossingScore + deadlockPressure + orderConstraints + depthBonus;
}

export function computeTediumPenalty(ev: PuzzleEvaluationVector): number {
  const walkTedium = ev.emptyWalkRatio * 0.3;
  const repetitiveTedium = ev.repetitivePushRatio * 0.25;
  const longWalkTedium = Math.min(ev.longestWalkStreak / 30, 1) * 0.2;
  const movesPerPushTedium = Math.min(ev.movesPerPush / 15, 1) * 0.15;
  const unusedFloorTedium = ev.solutionUnusedFloorRatio * 0.1;

  return walkTedium + repetitiveTedium + longWalkTedium + movesPerPushTedium +
    unusedFloorTedium;
}

export function computeV4Profile(ev: PuzzleEvaluationVector): V4DifficultyProfile {
  const structuralScale = computeStructuralScale(ev);
  const solutionDepth = computeSolutionDepthScore(ev);
  const humanReasoningComplexity = computeHumanReasoningComplexity(ev);
  const tediumPenalty = computeTediumPenalty(ev);

  const composite = structuralScale + solutionDepth + humanReasoningComplexity -
    tediumPenalty * 10;

  const classification = classifyFromProfile(
    composite,
    structuralScale,
    solutionDepth,
    humanReasoningComplexity,
    tediumPenalty,
  );

  const confidenceNote = buildConfidenceNote(
    classification,
    structuralScale,
    solutionDepth,
    humanReasoningComplexity,
    tediumPenalty,
  );

  return {
    structuralScale,
    solutionDepth,
    humanReasoningComplexity,
    tediumPenalty,
    composite,
    classification,
    confidenceNote,
  };
}

function classifyFromProfile(
  composite: number,
  structural: number,
  depth: number,
  reasoning: number,
  tedium: number,
): Difficulty {
  for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
    const tier = TIER_ORDER[i];
    const t = V4_TIER_THRESHOLDS[tier];

    if (
      composite >= t.minComposite &&
      structural >= t.minStructural &&
      depth >= t.minDepth &&
      reasoning >= t.minReasoning &&
      tedium <= t.maxTedium
    ) {
      return tier;
    }
  }
  return "tutorial";
}

function buildConfidenceNote(
  tier: Difficulty,
  structural: number,
  depth: number,
  reasoning: number,
  tedium: number,
): string {
  const t = V4_TIER_THRESHOLDS[tier];
  const notes: string[] = [];

  if (tier !== "tutorial") {
    if (structural < t.minStructural * 1.2)
      notes.push("structural scale near threshold");
    if (depth < t.minDepth * 1.2)
      notes.push("solution depth near threshold");
    if (reasoning < t.minReasoning * 1.2)
      notes.push("reasoning complexity near threshold");
    if (tedium > t.maxTedium * 0.85)
      notes.push("tedium approaching limit");
  }

  if (notes.length === 0) return "confident";
  return notes.join("; ");
}

export interface V4BenchmarkEntry {
  readonly puzzleId: string;
  readonly expectedTier: Difficulty;
  readonly profile: V4DifficultyProfile;
  readonly tierMatch: boolean;
  readonly tierDelta: number;
}

export function benchmarkAgainstExpected(
  entries: readonly { puzzleId: string; expectedTier: Difficulty; vector: PuzzleEvaluationVector }[],
): readonly V4BenchmarkEntry[] {
  return entries.map((e) => {
    const profile = computeV4Profile(e.vector);
    const expectedIdx = TIER_ORDER.indexOf(e.expectedTier);
    const actualIdx = TIER_ORDER.indexOf(profile.classification);
    return {
      puzzleId: e.puzzleId,
      expectedTier: e.expectedTier,
      profile,
      tierMatch: e.expectedTier === profile.classification,
      tierDelta: actualIdx - expectedIdx,
    };
  });
}

export function summarizeBenchmark(
  entries: readonly V4BenchmarkEntry[],
): {
  total: number;
  matches: number;
  accuracy: number;
  avgAbsDelta: number;
  worstOverclassified: V4BenchmarkEntry | null;
  worstUnderclassified: V4BenchmarkEntry | null;
} {
  if (entries.length === 0) {
    return {
      total: 0, matches: 0, accuracy: 0, avgAbsDelta: 0,
      worstOverclassified: null, worstUnderclassified: null,
    };
  }

  const matches = entries.filter((e) => e.tierMatch).length;
  const absDeltaSum = entries.reduce((s, e) => s + Math.abs(e.tierDelta), 0);

  let worstOver: V4BenchmarkEntry | null = null;
  let worstUnder: V4BenchmarkEntry | null = null;
  for (const e of entries) {
    if (e.tierDelta > 0 && (worstOver === null || e.tierDelta > worstOver.tierDelta)) {
      worstOver = e;
    }
    if (e.tierDelta < 0 && (worstUnder === null || e.tierDelta < worstUnder.tierDelta)) {
      worstUnder = e;
    }
  }

  return {
    total: entries.length,
    matches,
    accuracy: matches / entries.length,
    avgAbsDelta: absDeltaSum / entries.length,
    worstOverclassified: worstOver,
    worstUnderclassified: worstUnder,
  };
}
