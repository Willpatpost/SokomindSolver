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
  readonly minBoxes?: number;
  readonly minPushes?: number;
}

export const V4_TIER_THRESHOLDS: Readonly<Record<Difficulty, V4DifficultyThresholds>> = {
  tutorial:      { minComposite: 0,    minStructural: 0,   minDepth: 0,   minReasoning: 0,    maxTedium: 1.0 },
  beginner:      { minComposite: 4.0,  minStructural: 2.0, minDepth: 2.0, minReasoning: 2.0,  maxTedium: 0.8,  minBoxes: 2, minPushes: 4 },
  intermediate:  { minComposite: 8.0,  minStructural: 3.5, minDepth: 3.5, minReasoning: 3.5,  maxTedium: 0.7,  minBoxes: 3, minPushes: 8 },
  advanced:      { minComposite: 14.0, minStructural: 5.0, minDepth: 5.0, minReasoning: 5.5,  maxTedium: 0.6,  minBoxes: 4, minPushes: 12 },
  expert:        { minComposite: 22.0, minStructural: 7.0, minDepth: 8.0, minReasoning: 8.0,  maxTedium: 0.55, minBoxes: 6, minPushes: 18 },
  master:        { minComposite: 32.0, minStructural: 9.0, minDepth: 12.0, minReasoning: 12.0, maxTedium: 0.55, minBoxes: 8, minPushes: 30 },
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

  // Dampen ratio-based terms for small puzzles — ratios inflate on compact boards
  const sizeDamping = Math.min(ev.totalFloor / 40, 1.0);

  const deadlockPressure = Math.min(ev.deadlockDensity * 5.0, 3.0) * sizeDamping;

  const orderConstraints = Math.log2(Math.max(ev.goalOrderConstraints, 0) + 1) * 0.5;
  const depthBonus = ev.estimatedDependencyDepth * 0.4;

  const criticalMoveBonus =
    ev.criticalMoveCount * 0.5 +
    ev.criticalMoveRatio * 3.0 * sizeDamping;

  return branchingScore + highBranchBonus + nonForcedBonus + interactionScore +
    causalScore + crossingScore + deadlockPressure + orderConstraints + depthBonus +
    criticalMoveBonus;
}

export function computeTediumPenalty(ev: PuzzleEvaluationVector): number {
  const walkTedium = ev.emptyWalkRatio * 0.3;
  const repetitiveTedium = ev.repetitivePushRatio * 0.25;
  const longWalkTedium = Math.min(ev.longestWalkStreak / 50, 1) * 0.2;
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
    tediumPenalty * 7;

  const classification = classifyFromProfile(
    composite,
    structuralScale,
    solutionDepth,
    humanReasoningComplexity,
    tediumPenalty,
    ev.boxCount,
    ev.solutionPushes,
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
  boxCount: number,
  solutionPushes: number,
): Difficulty {
  for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
    const tier = TIER_ORDER[i];
    const t = V4_TIER_THRESHOLDS[tier];

    if (
      composite >= t.minComposite &&
      structural >= t.minStructural &&
      depth >= t.minDepth &&
      reasoning >= t.minReasoning &&
      tedium <= t.maxTedium &&
      boxCount >= (t.minBoxes ?? 0) &&
      solutionPushes >= (t.minPushes ?? 0)
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

// ---------------------------------------------------------------------------
// Handcrafted calibration report (Phase 11 — Sprint 11)
// ---------------------------------------------------------------------------

/**
 * Per-puzzle calibration entry with full V4 profile detail.
 */
export interface CalibrationEntry {
  readonly puzzleId: string;
  readonly expectedTier: Difficulty;
  readonly predictedTier: Difficulty;
  readonly structuralScore: number;
  readonly solutionDepthScore: number;
  readonly reasoningScore: number;
  readonly tedium: number;
  readonly composite: number;
  readonly tierMatch: boolean;
  readonly tierDelta: number;
  readonly withinOne: boolean;
}

/**
 * Confusion matrix cell: rows = expected, columns = predicted.
 */
export type ConfusionMatrix = Readonly<Record<Difficulty, Readonly<Record<Difficulty, number>>>>;

/**
 * Full calibration report produced from a handcrafted reference set.
 */
export interface CalibrationReport {
  readonly entries: readonly CalibrationEntry[];
  readonly confusionMatrix: ConfusionMatrix;
  readonly exactMatchAccuracy: number;
  readonly withinOneTierAccuracy: number;
  readonly worstOverclassification: CalibrationEntry | null;
  readonly worstUnderclassification: CalibrationEntry | null;
  readonly totalPuzzles: number;
  readonly perTierAccuracy: Readonly<Record<Difficulty, { total: number; matches: number; accuracy: number }>>;
}

/**
 * Build a calibration report from a set of puzzle evaluation vectors with
 * expected tier labels.
 *
 * This is the handcrafted calibration required by Phase 12 of the V4.1 plan,
 * integrated into Sprint 11 for delivery.
 */
export function buildCalibrationReport(
  data: readonly { puzzleId: string; expectedTier: Difficulty; vector: PuzzleEvaluationVector }[],
): CalibrationReport {
  // Build per-puzzle entries
  const entries: CalibrationEntry[] = data.map((d) => {
    const profile = computeV4Profile(d.vector);
    const expectedIdx = TIER_ORDER.indexOf(d.expectedTier);
    const predictedIdx = TIER_ORDER.indexOf(profile.classification);
    const delta = predictedIdx - expectedIdx;
    return {
      puzzleId: d.puzzleId,
      expectedTier: d.expectedTier,
      predictedTier: profile.classification,
      structuralScore: profile.structuralScale,
      solutionDepthScore: profile.solutionDepth,
      reasoningScore: profile.humanReasoningComplexity,
      tedium: profile.tediumPenalty,
      composite: profile.composite,
      tierMatch: delta === 0,
      tierDelta: delta,
      withinOne: Math.abs(delta) <= 1,
    };
  });

  // Confusion matrix
  const matrix: Record<Difficulty, Record<Difficulty, number>> = {} as Record<Difficulty, Record<Difficulty, number>>;
  for (const tier of TIER_ORDER) {
    matrix[tier] = {} as Record<Difficulty, number>;
    for (const t2 of TIER_ORDER) {
      matrix[tier][t2] = 0;
    }
  }
  for (const e of entries) {
    matrix[e.expectedTier][e.predictedTier]++;
  }

  // Accuracy metrics
  const totalMatches = entries.filter((e) => e.tierMatch).length;
  const totalWithinOne = entries.filter((e) => e.withinOne).length;
  const total = entries.length;

  // Worst misclassifications
  let worstOver: CalibrationEntry | null = null;
  let worstUnder: CalibrationEntry | null = null;
  for (const e of entries) {
    if (e.tierDelta > 0 && (worstOver === null || e.tierDelta > worstOver.tierDelta)) {
      worstOver = e;
    }
    if (e.tierDelta < 0 && (worstUnder === null || e.tierDelta < worstUnder.tierDelta)) {
      worstUnder = e;
    }
  }

  // Per-tier accuracy
  const perTierAccuracy: Record<Difficulty, { total: number; matches: number; accuracy: number }> = {} as Record<Difficulty, { total: number; matches: number; accuracy: number }>;
  for (const tier of TIER_ORDER) {
    const tierEntries = entries.filter((e) => e.expectedTier === tier);
    const tierMatches = tierEntries.filter((e) => e.tierMatch).length;
    perTierAccuracy[tier] = {
      total: tierEntries.length,
      matches: tierMatches,
      accuracy: tierEntries.length > 0 ? tierMatches / tierEntries.length : 0,
    };
  }

  return {
    entries,
    confusionMatrix: matrix as ConfusionMatrix,
    exactMatchAccuracy: total > 0 ? totalMatches / total : 0,
    withinOneTierAccuracy: total > 0 ? totalWithinOne / total : 0,
    worstOverclassification: worstOver,
    worstUnderclassification: worstUnder,
    totalPuzzles: total,
    perTierAccuracy,
  };
}

/**
 * Format a calibration report as a human-readable text report.
 */
export function formatCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = [];
  lines.push("=== V4 Handcrafted Calibration Report ===");
  lines.push("");
  lines.push(`Total puzzles: ${report.totalPuzzles}`);
  lines.push(`Exact-match accuracy: ${(report.exactMatchAccuracy * 100).toFixed(1)}%`);
  lines.push(`Within-one-tier accuracy: ${(report.withinOneTierAccuracy * 100).toFixed(1)}%`);
  lines.push("");

  // Per-tier accuracy
  lines.push("Per-tier accuracy:");
  for (const tier of TIER_ORDER) {
    const ta = report.perTierAccuracy[tier];
    if (ta.total > 0) {
      lines.push(`  ${tier}: ${ta.matches}/${ta.total} (${(ta.accuracy * 100).toFixed(1)}%)`);
    }
  }
  lines.push("");

  // Confusion matrix
  lines.push("Confusion matrix (rows = expected, columns = predicted):");
  const header = "             " + TIER_ORDER.map((t) => t.slice(0, 5).padStart(6)).join("");
  lines.push(header);
  for (const expected of TIER_ORDER) {
    const cells = TIER_ORDER.map((predicted) =>
      String(report.confusionMatrix[expected][predicted]).padStart(6),
    ).join("");
    lines.push(`  ${expected.padEnd(13)}${cells}`);
  }
  lines.push("");

  // Worst misclassifications
  if (report.worstOverclassification) {
    const w = report.worstOverclassification;
    lines.push(`Worst overclassification: ${w.puzzleId} (expected ${w.expectedTier}, predicted ${w.predictedTier}, delta +${w.tierDelta})`);
  }
  if (report.worstUnderclassification) {
    const w = report.worstUnderclassification;
    lines.push(`Worst underclassification: ${w.puzzleId} (expected ${w.expectedTier}, predicted ${w.predictedTier}, delta ${w.tierDelta})`);
  }
  lines.push("");

  // Per-puzzle detail
  lines.push("Per-puzzle detail:");
  lines.push("  id | expected | predicted | structural | depth | reasoning | tedium | composite");
  for (const e of report.entries) {
    const match = e.tierMatch ? " " : e.tierDelta > 0 ? "+" : "-";
    lines.push(
      `  ${match} ${e.puzzleId.padEnd(25)} ${e.expectedTier.padEnd(13)} ${e.predictedTier.padEnd(13)} ` +
      `${e.structuralScore.toFixed(2).padStart(10)} ${e.solutionDepthScore.toFixed(2).padStart(6)} ` +
      `${e.reasoningScore.toFixed(2).padStart(10)} ${e.tedium.toFixed(3).padStart(7)} ${e.composite.toFixed(2).padStart(10)}`,
    );
  }

  return lines.join("\n");
}
