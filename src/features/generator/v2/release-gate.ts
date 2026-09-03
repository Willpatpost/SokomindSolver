/**
 * Release gate -- Sprint 12
 *
 * Checks whether a review catalog meets release criteria before it can be
 * promoted to production.  Enforces:
 *
 *   1. Coverage -- minimum puzzles per tier, minimum total puzzles.
 *   2. Quality -- every candidate passed the quality gate; no unverified
 *      mechanism claims; no duplicate boards or symmetry duplicates.
 *   3. Diversity -- topology, generation mode, box-count buckets, and motif
 *      distributions are not excessively concentrated.
 *   4. Difficulty integrity -- V4 classification agrees with intended tier
 *      within allowed gap, no quota-sensitive difficulty.
 *
 * The gate never lowers quality thresholds; a short catalog is an honest
 * short catalog rather than a padded one.
 */

import { DIFFICULTIES, type Difficulty } from "../../../core/model.ts";
import type {
  ReviewCatalog,
  ReviewCandidatePack,
} from "./catalog-manifest-types.ts";
import { REVIEW_CATALOG_SCHEMA_VERSION } from "./catalog-manifest-types.ts";
import { QUALITY_FLOORS } from "./quality-gate.ts";
import { classifyDifficultyByBoxCount } from "./difficulty-model.ts";
import { checkStoryQualityForRelease } from "./story-quality-policy.ts";
import {
  checkStoryDiversityForRelease, summarizeStoryDiversity, storyDiversityLimits,
  type StoryCatalogDiversity,
} from "./story-diversity.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ReleaseGateTierQuota {
  /** Minimum number of puzzles required for this tier. */
  readonly min: number;
  /** Ideal target (shortfall is a warning, not a failure). */
  readonly target: number;
}

export interface ReleaseGateConfig {
  /** Minimum total puzzles across all tiers. */
  readonly minTotalPuzzles: number;
  /** Per-tier minimum quotas.  Missing tiers use defaults. */
  readonly tierQuotas: Readonly<Partial<Record<Difficulty, ReleaseGateTierQuota>>>;
  /** Maximum fraction of puzzles from a single topology family (0..1). */
  readonly maxTopologyConcentration: number;
  /** Maximum fraction of puzzles from a single generation mode (0..1). */
  readonly maxModeConcentration: number;
  /** Maximum allowed gap between intended and classified difficulty tiers. */
  readonly maxDifficultyGap: number;
  /** Minimum number of distinct topology families across the entire catalog. */
  readonly minDistinctTopologies: number;
  /** Minimum number of distinct generation modes across the entire catalog. */
  readonly minDistinctModes: number;
  /** Minimum number of distinct box-count values across the entire catalog. */
  readonly minDistinctBoxCounts: number;
}

export const DEFAULT_RELEASE_GATE_CONFIG: ReleaseGateConfig = {
  minTotalPuzzles: 10,
  tierQuotas: {
    tutorial: { min: 0, target: 0 },
    beginner: { min: 2, target: 10 },
    intermediate: { min: 2, target: 15 },
    advanced: { min: 1, target: 10 },
    expert: { min: 1, target: 5 },
    master: { min: 1, target: 3 },
  },
  maxTopologyConcentration: 0.60,
  maxModeConcentration: 0.70,
  maxDifficultyGap: 0,
  minDistinctTopologies: 2,
  minDistinctModes: 2,
  minDistinctBoxCounts: 2,
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ReleaseGateVerdict {
  readonly storyDiversity?: StoryCatalogDiversity;
  /** True only if every check passed. */
  readonly passed: boolean;
  /** Hard failures -- any of these blocks release. */
  readonly errors: readonly string[];
  /** Soft issues -- release is not blocked but quality could be better. */
  readonly warnings: readonly string[];
  /** Per-tier coverage breakdown. */
  readonly tierCoverage: Readonly<Record<string, {
    readonly actual: number;
    readonly min: number;
    readonly target: number;
    readonly metMin: boolean;
    readonly metTarget: boolean;
  }>>;
  /** Diversity metrics. */
  readonly diversity: {
    readonly distinctTopologies: number;
    readonly distinctModes: number;
    readonly distinctBoxCounts: number;
    readonly topologyConcentration: number;
    readonly modeConcentration: number;
  };
  /** Total puzzle count across all tiers. */
  readonly totalPuzzles: number;
}

// ---------------------------------------------------------------------------
// Gate implementation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === "string" &&
    (DIFFICULTIES as readonly string[]).includes(value);
}

function validateReviewCatalogShape(value: unknown): {
  readonly catalog?: ReviewCatalog;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: ["Review catalog must be a JSON object"] };
  }
  if (value.schemaVersion !== REVIEW_CATALOG_SCHEMA_VERSION) {
    errors.push(
      `Review catalog schemaVersion must be ${REVIEW_CATALOG_SCHEMA_VERSION}`,
    );
  }
  if (typeof value.generatorVersion !== "string" || value.generatorVersion.length === 0) {
    errors.push("Review catalog generatorVersion must be a non-empty string");
  }
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
    errors.push("Review catalog generatedAt must be a valid timestamp");
  }
  if (!isRecord(value.tierSummaries)) {
    errors.push("Review catalog tierSummaries must be an object");
    return { errors };
  }

  for (const [tier, rawSummary] of Object.entries(value.tierSummaries)) {
    if (!isDifficulty(tier)) {
      errors.push(`Unknown review tier "${tier}"`);
      continue;
    }
    if (!isRecord(rawSummary)) {
      errors.push(`Tier "${tier}" summary must be an object`);
      continue;
    }
    if (!Number.isInteger(rawSummary.target) || (rawSummary.target as number) < 0) {
      errors.push(`Tier "${tier}" target must be a non-negative integer`);
    }
    if (!Number.isInteger(rawSummary.actual) || (rawSummary.actual as number) < 0) {
      errors.push(`Tier "${tier}" actual must be a non-negative integer`);
    }
    if (!Array.isArray(rawSummary.candidates)) {
      errors.push(`Tier "${tier}" candidates must be an array`);
      continue;
    }

    rawSummary.candidates.forEach((rawPack, index) => {
      const label = `Tier "${tier}" candidate ${index}`;
      if (!isRecord(rawPack)) {
        errors.push(`${label} must be an object`);
        return;
      }
      for (const field of ["id", "boardHash", "symmetryHash", "family", "mode"] as const) {
        if (typeof rawPack[field] !== "string" || rawPack[field].length === 0) {
          errors.push(`${label} ${field} must be a non-empty string`);
        }
      }
      for (const field of ["difficulty", "intendedDifficulty", "classifiedDifficulty"] as const) {
        if (!isDifficulty(rawPack[field])) {
          errors.push(`${label} ${field} is invalid`);
        }
      }
      for (const field of [
        "difficultyGap",
        "boxCount",
        "genericBoxCount",
        "typedBoxCount",
        "minPushesPerBox",
        "inactiveBoxCount",
        "onePushBoxCount",
        "crossTypeInteractionCount",
      ] as const) {
        if (typeof rawPack[field] !== "number" || !Number.isFinite(rawPack[field])) {
          errors.push(`${label} ${field} must be finite`);
        }
      }
      for (const field of [
        "qualityPurposefulGeometry",
        "qualityInteraction",
        "qualityCausalDepth",
        "qualityDecision",
        "qualityMechanismIntegrity",
        "qualityElegance",
        "qualityTedium",
      ] as const) {
        if (typeof rawPack[field] !== "number" || !Number.isFinite(rawPack[field])) {
          errors.push(`${label} ${field} must be finite`);
        }
      }
      if (typeof rawPack.qualityPassed !== "boolean") {
        errors.push(`${label} qualityPassed must be boolean`);
      }
      if (!Array.isArray(rawPack.qualityReasons) ||
        !rawPack.qualityReasons.every((reason) => typeof reason === "string")) {
        errors.push(`${label} qualityReasons must be a string array`);
      }
      if (rawPack.mechanismEvidencePassed !== undefined &&
        typeof rawPack.mechanismEvidencePassed !== "boolean") {
        errors.push(`${label} mechanismEvidencePassed must be boolean when present`);
      }
      if (rawPack.mechanismEvidenceMissing !== undefined &&
        (!Array.isArray(rawPack.mechanismEvidenceMissing) ||
          !rawPack.mechanismEvidenceMissing.every((item) => typeof item === "string"))) {
        errors.push(`${label} mechanismEvidenceMissing must be a string array when present`);
      }
      for (const field of [
        "dependencyEdges",
        "dependencyRealized",
        "dependencyRealizationRate",
        "counterfactualEdges",
        "counterfactualTotal",
      ] as const) {
        if (rawPack[field] !== undefined &&
          (typeof rawPack[field] !== "number" || !Number.isFinite(rawPack[field]))) {
          errors.push(`${label} ${field} must be finite when present`);
        }
      }
    });
  }

  return errors.length > 0
    ? { errors }
    : { catalog: value as unknown as ReviewCatalog, errors };
}

/**
 * Bind review evidence to the exact manifest being promoted. This prevents a
 * valid review file from being paired with a different production catalog.
 */
export function checkReviewManifestBinding(
  reviewValue: unknown,
  manifestValue: unknown,
): readonly string[] {
  const shape = validateReviewCatalogShape(reviewValue);
  if (!shape.catalog) return [...shape.errors];
  if (!isRecord(manifestValue) || !Array.isArray(manifestValue.puzzles)) {
    return ["Generated manifest puzzles must be an array"];
  }

  const errors: string[] = [];
  const packs = Object.values(shape.catalog.tierSummaries)
    .flatMap((summary) => summary.candidates);
  const packsById = new Map(packs.map((pack) => [pack.id, pack]));
  const manifestIds = new Set<string>();
  const boundFields = [
    "boardHash",
    "symmetryHash",
    "seed",
    "family",
    "mode",
    "boxCount",
    "typingMode",
    "genericBoxCount",
    "typedBoxCount",
    "minPushesPerBox",
    "inactiveBoxCount",
    "onePushBoxCount",
    "crossTypeInteractionCount",
    "intendedDifficulty",
    "classifiedDifficulty",
    "difficultyGap",
  ] as const;

  for (const rawEntry of manifestValue.puzzles) {
    if (!isRecord(rawEntry) || typeof rawEntry.id !== "string") {
      errors.push("Generated manifest contains an entry without a valid id");
      continue;
    }
    manifestIds.add(rawEntry.id);
    const pack = packsById.get(rawEntry.id);
    if (!pack) {
      errors.push(`Manifest puzzle "${rawEntry.id}" has no review evidence`);
      continue;
    }
    for (const field of boundFields) {
      if (rawEntry[field] !== pack[field]) {
        errors.push(
          `Manifest puzzle "${rawEntry.id}" ${field} does not match review evidence`,
        );
      }
    }
  }

  for (const pack of packs) {
    if (!manifestIds.has(pack.id)) {
      errors.push(`Review puzzle "${pack.id}" is absent from the manifest`);
    }
  }

  return errors;
}

/**
 * Check whether a ReviewCatalog meets release criteria.
 *
 * @param catalog  The review catalog to validate.
 * @param config   Release gate configuration (defaults to DEFAULT_RELEASE_GATE_CONFIG).
 * @returns  A verdict with pass/fail, errors, warnings, and metrics.
 */
export function checkReleaseGate(
  value: unknown,
  config: ReleaseGateConfig = DEFAULT_RELEASE_GATE_CONFIG,
): ReleaseGateVerdict {
  const shape = validateReviewCatalogShape(value);
  const errors: string[] = [...shape.errors];
  const warnings: string[] = [];

  if (!shape.catalog) {
    return {
      passed: false,
      errors,
      warnings,
      tierCoverage: {},
      diversity: {
        distinctTopologies: 0,
        distinctModes: 0,
        distinctBoxCounts: 0,
        topologyConcentration: 0,
        modeConcentration: 0,
      },
      totalPuzzles: 0,
    };
  }
  const catalog = shape.catalog;

  // Collect all packs across tiers
  const allPacks: ReviewCandidatePack[] = [];
  for (const [tier, summary] of Object.entries(catalog.tierSummaries)) {
    allPacks.push(...summary.candidates);
    if (summary.actual !== summary.candidates.length) {
      errors.push(
        `Tier "${tier}": reported actual ${summary.actual} does not match ${summary.candidates.length} candidates`,
      );
    }
    for (const pack of summary.candidates) {
      if (pack.intendedDifficulty !== tier) {
        errors.push(
          `Puzzle "${pack.id}": intended tier ${pack.intendedDifficulty} is filed under ${tier}`,
        );
      }
    }
  }

  const totalPuzzles = allPacks.length;

  // ---- 1. Total puzzle count ----
  if (totalPuzzles < config.minTotalPuzzles) {
    errors.push(
      `Total puzzles ${totalPuzzles} < minimum ${config.minTotalPuzzles}`,
    );
  }

  // ---- 2. Per-tier coverage ----
  const tierCoverage: Record<string, {
    actual: number;
    min: number;
    target: number;
    metMin: boolean;
    metTarget: boolean;
  }> = {};

  const coverageTiers = new Set<string>([
    ...Object.keys(config.tierQuotas),
    ...Object.keys(catalog.tierSummaries),
  ]);
  for (const tier of coverageTiers) {
    const summary = catalog.tierSummaries[tier];
    const quota = config.tierQuotas[tier as Difficulty];
    const min = quota?.min ?? 0;
    const target = quota?.target ?? summary?.target ?? 0;
    // Quotas are filled by measured classifications, never by the requested
    // tier under which a candidate happened to be generated.
    const actual = allPacks.filter(
      (pack) => pack.classifiedDifficulty === tier,
    ).length;

    const metMin = actual >= min;
    const metTarget = actual >= target;

    tierCoverage[tier] = { actual, min, target, metMin, metTarget };

    if (!metMin) {
      errors.push(
        `Tier "${tier}": ${actual} puzzles < minimum ${min}`,
      );
    }
    if (!metTarget) {
      warnings.push(
        `Tier "${tier}": ${actual} puzzles < target ${target}`,
      );
    }
  }

  // ---- 3. Duplicate board hashes ----
  const boardHashes = new Map<string, string>();
  const symmetryHashes = new Map<string, string>();
  const ids = new Set<string>();
  for (const pack of allPacks) {
    if (ids.has(pack.id)) {
      errors.push(`Duplicate puzzle id: "${pack.id}"`);
    }
    ids.add(pack.id);

    const existing = boardHashes.get(pack.boardHash);
    if (existing) {
      errors.push(
        `Duplicate board hash: "${pack.id}" and "${existing}"`,
      );
    }
    boardHashes.set(pack.boardHash, pack.id);

    const symmetricExisting = symmetryHashes.get(pack.symmetryHash);
    if (symmetricExisting) {
      errors.push(
        `Symmetry duplicate: "${pack.id}" and "${symmetricExisting}"`,
      );
    }
    symmetryHashes.set(pack.symmetryHash, pack.id);
  }

  // ---- 4. Quality and mechanism evidence ----
  const storyPacks: ReviewCandidatePack[] = [];
  for (const pack of allPacks) {
    const boxCountTier = classifyDifficultyByBoxCount(pack.boxCount);
    const storyErrors = checkStoryQualityForRelease(pack.storyQuality, pack);
    for (const error of storyErrors) {
      errors.push(`Puzzle "${pack.id}": ${error}`);
    }
    if (storyErrors.length === 0) {
      const diversityErrors = checkStoryDiversityForRelease(pack.storyDiversity, pack.rows, pack.storyQuality!, pack.passiveStory);
      for (const error of diversityErrors) errors.push(`Puzzle "${pack.id}": ${error}`);
      if (diversityErrors.length === 0) storyPacks.push(pack);
    }
    if (boxCountTier === "tutorial") {
      errors.push(`Puzzle "${pack.id}": Tutorial puzzles must not be generator-produced`);
    }
    if (
      pack.difficulty !== boxCountTier ||
      pack.intendedDifficulty !== boxCountTier ||
      pack.classifiedDifficulty !== boxCountTier
    ) {
      errors.push(
        `Puzzle "${pack.id}": ${pack.boxCount} boxes requires tier ${boxCountTier}`,
      );
    }

    const minPerClass = boxCountTier === "beginner" ? 1 : 2;
    if (
      pack.typingMode !== "hybrid" ||
      (pack.genericBoxCount ?? 0) < minPerClass ||
      (pack.typedBoxCount ?? 0) < minPerClass ||
      (pack.genericBoxCount ?? 0) + (pack.typedBoxCount ?? 0) !== pack.boxCount
    ) {
      errors.push(
        `Puzzle "${pack.id}": requires hybrid typing with at least ${minPerClass} generic and ${minPerClass} typed boxes`,
      );
    }
    const minPushes = boxCountTier === "beginner" ? 1 : 2;
    const maxOnePush = boxCountTier === "beginner" ? 1 : 0;
    if (
      (pack.minPushesPerBox ?? 0) < minPushes ||
      (pack.inactiveBoxCount ?? 1) !== 0 ||
      (pack.onePushBoxCount ?? 1) > maxOnePush
    ) {
      errors.push(
        `Puzzle "${pack.id}": every box must participate with at least ${minPushes} pushes`,
      );
    }
    if ((pack.crossTypeInteractionCount ?? 0) < 1) {
      errors.push(
        `Puzzle "${pack.id}": lacks verified typed/generic interaction`,
      );
    }

    if (!pack.qualityPassed) {
      const reasons = pack.qualityReasons.length > 0
        ? `: ${pack.qualityReasons.join("; ")}`
        : "";
      errors.push(`Puzzle "${pack.id}": quality gate did not pass${reasons}`);
    }
    if (pack.qualityPassed && pack.qualityReasons.length > 0) {
      errors.push(`Puzzle "${pack.id}": passing quality evidence contains rejection reasons`);
    }
    const qualityValues = [
      pack.qualityPurposefulGeometry,
      pack.qualityInteraction,
      pack.qualityCausalDepth,
      pack.qualityDecision,
      pack.qualityMechanismIntegrity,
      pack.qualityElegance,
      pack.qualityTedium,
    ];
    if (qualityValues.some((metric) => metric < 0 || metric > 1)) {
      errors.push(`Puzzle "${pack.id}": quality metrics must stay within [0, 1]`);
    }
    const qualityFloor = QUALITY_FLOORS[pack.intendedDifficulty];
    const failedQualityDimensions = [
      pack.qualityPurposefulGeometry < qualityFloor.minPurposefulGeometry && "purposeful geometry",
      pack.qualityInteraction < qualityFloor.minInteractionQuality && "interaction",
      pack.qualityCausalDepth < qualityFloor.minCausalDepth && "causal depth",
      pack.qualityDecision < qualityFloor.minDecisionQuality && "decision quality",
      pack.qualityMechanismIntegrity < qualityFloor.minMechanismIntegrity && "mechanism integrity",
      pack.qualityElegance < qualityFloor.minElegance && "elegance",
      pack.qualityTedium > qualityFloor.maxTedium && "tedium",
    ].filter((dimension): dimension is string => typeof dimension === "string");
    if (failedQualityDimensions.length > 0) {
      errors.push(
        `Puzzle "${pack.id}": recorded quality metrics fail ${pack.intendedDifficulty} floors (${failedQualityDimensions.join(", ")})`,
      );
    }

    if (
      pack.dependencyEdges !== undefined &&
      pack.dependencyRealized !== undefined
    ) {
      if (
        pack.dependencyEdges < 0 ||
        pack.dependencyRealized < 0 ||
        pack.dependencyRealized > pack.dependencyEdges
      ) {
        errors.push(`Puzzle "${pack.id}": dependency evidence counts are inconsistent`);
      }
      if (pack.dependencyRealizationRate !== undefined) {
        if (pack.dependencyRealizationRate < 0 || pack.dependencyRealizationRate > 1) {
          errors.push(`Puzzle "${pack.id}": dependency realization rate must stay within [0, 1]`);
        }
        const expectedRate = pack.dependencyEdges === 0
          ? 1
          : pack.dependencyRealized / pack.dependencyEdges;
        if (Math.abs(pack.dependencyRealizationRate - expectedRate) > 1e-9) {
          errors.push(`Puzzle "${pack.id}": dependency realization rate is inconsistent`);
        }
      }
    }
    if (
      pack.counterfactualEdges !== undefined &&
      pack.counterfactualTotal !== undefined &&
      (pack.counterfactualEdges < 0 ||
        pack.counterfactualTotal < 0 ||
        pack.counterfactualEdges > pack.counterfactualTotal)
    ) {
      errors.push(`Puzzle "${pack.id}": counterfactual evidence counts are inconsistent`);
    }

    const claimsMechanism = pack.mode === "mechanism" ||
      pack.mechanismEvidencePassed !== undefined ||
      pack.mechanismEvidenceMissing !== undefined;
    if (claimsMechanism) {
      if (pack.mechanismEvidencePassed !== true) {
        errors.push(`Puzzle "${pack.id}": mechanism claim is not verified`);
      }
      if ((pack.mechanismEvidenceMissing?.length ?? 0) > 0) {
        errors.push(
          `Puzzle "${pack.id}": missing mechanism evidence: ${pack.mechanismEvidenceMissing!.join(", ")}`,
        );
      }
      // Legacy structural counters are not bounded-search proofs. The current
      // story policy checks realized mechanisms without penalizing unknown probes.
    }
  }

  // ---- 5. Difficulty gap ----
  for (const pack of allPacks) {
    const measuredGap = DIFFICULTIES.indexOf(pack.classifiedDifficulty) -
      DIFFICULTIES.indexOf(pack.intendedDifficulty);
    if (pack.difficultyGap !== measuredGap) {
      errors.push(
        `Puzzle "${pack.id}": reported difficulty gap ${pack.difficultyGap} does not match measured gap ${measuredGap}`,
      );
    }
    const gap = Math.abs(pack.difficultyGap);
    if (gap > config.maxDifficultyGap) {
      errors.push(
        `Puzzle "${pack.id}": difficulty gap ${pack.difficultyGap} exceeds max ${config.maxDifficultyGap}` +
        ` (intended=${pack.intendedDifficulty}, classified=${pack.classifiedDifficulty})`,
      );
    }
  }

  // ---- 6. Diversity metrics ----
  const topologyCounts = new Map<string, number>();
  const modeCounts = new Map<string, number>();
  const boxCountSet = new Set<number>();

  for (const pack of allPacks) {
    topologyCounts.set(pack.family, (topologyCounts.get(pack.family) ?? 0) + 1);
    modeCounts.set(pack.mode, (modeCounts.get(pack.mode) ?? 0) + 1);
    boxCountSet.add(pack.boxCount);
  }

  const distinctTopologies = topologyCounts.size;
  const distinctModes = modeCounts.size;
  const distinctBoxCounts = boxCountSet.size;

  const topologyConcentration = totalPuzzles > 0
    ? Math.max(...topologyCounts.values()) / totalPuzzles
    : 0;
  const modeConcentration = totalPuzzles > 0
    ? Math.max(...modeCounts.values()) / totalPuzzles
    : 0;

  if (totalPuzzles > 0) {
    if (distinctTopologies < config.minDistinctTopologies) {
      errors.push(
        `Only ${distinctTopologies} distinct topologies, need ${config.minDistinctTopologies}`,
      );
    }
    if (distinctModes < config.minDistinctModes) {
      errors.push(
        `Only ${distinctModes} distinct modes, need ${config.minDistinctModes}`,
      );
    }
    if (distinctBoxCounts < config.minDistinctBoxCounts) {
      warnings.push(
        `Only ${distinctBoxCounts} distinct box counts, want ${config.minDistinctBoxCounts}`,
      );
    }
    if (topologyConcentration > config.maxTopologyConcentration) {
      warnings.push(
        `Topology concentration ${(topologyConcentration * 100).toFixed(0)}% > ${(config.maxTopologyConcentration * 100).toFixed(0)}% max`,
      );
    }
    if (modeConcentration > config.maxModeConcentration) {
      warnings.push(
        `Mode concentration ${(modeConcentration * 100).toFixed(0)}% > ${(config.maxModeConcentration * 100).toFixed(0)}% max`,
      );
    }
  }

  const diversity = {
    distinctTopologies,
    distinctModes,
    distinctBoxCounts,
    topologyConcentration,
    modeConcentration,
  };

  // Recompute from verified packs rather than trusting cached catalog summaries.
  const storyDiversity = summarizeStoryDiversity(storyPacks.map((pack) => ({ id: pack.id, profile: pack.storyDiversity })));
  for (const ids of storyDiversity.cloneGroups) errors.push(`Label-insensitive layout clones: ${ids.join(", ")}`);
  if (storyDiversity.measured > 0 && storyDiversity.missingFamilies.length > 0) {
    warnings.push(`Story coverage gaps: ${storyDiversity.missingFamilies.join(", ")}`);
  }
  for (const tier of Object.keys(catalog.tierSummaries)) {
    const packs = storyPacks.filter((pack) => pack.classifiedDifficulty === tier);
    const measured = summarizeStoryDiversity(packs.map((pack) => ({ id: pack.id, profile: pack.storyDiversity })));
    // Review concentration in what would actually ship, not the unfilled target.
    const limits = storyDiversityLimits(packs.length);
    if (Object.values(measured.storyCounts).some((count) => count > limits.storyLimit)) {
      warnings.push(`Tier "${tier}": story concentration exceeds ${limits.storyLimit} per story basket`);
    }
    if (Object.values(measured.visualCounts).some((count) => count > limits.visualLimit)) {
      warnings.push(`Tier "${tier}": visual concentration exceeds ${limits.visualLimit} per wall/floor silhouette`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    tierCoverage,
    diversity,
    storyDiversity,
    totalPuzzles,
  };
}

// ---------------------------------------------------------------------------
// Human-readable verdict formatting
// ---------------------------------------------------------------------------

export function formatReleaseVerdict(verdict: ReleaseGateVerdict): string {
  const lines: string[] = [];

  lines.push("=".repeat(70));
  lines.push(verdict.passed ? "RELEASE GATE: PASSED" : "RELEASE GATE: FAILED");
  lines.push("=".repeat(70));
  lines.push(`Total puzzles: ${verdict.totalPuzzles}`);
  lines.push("");

  // Tier coverage
  lines.push("Tier Coverage:");
  lines.push(
    `${"Tier".padEnd(15)} ${"Actual".padStart(8)} ${"Min".padStart(8)} ${"Target".padStart(8)} ${"Status".padStart(10)}`,
  );
  lines.push("-".repeat(55));
  for (const [tier, cov] of Object.entries(verdict.tierCoverage)) {
    const status = !cov.metMin ? "FAIL" : !cov.metTarget ? "SHORT" : "OK";
    lines.push(
      `${tier.padEnd(15)} ${String(cov.actual).padStart(8)} ${String(cov.min).padStart(8)} ${String(cov.target).padStart(8)} ${status.padStart(10)}`,
    );
  }
  lines.push("");

  // Diversity
  lines.push("Diversity:");
  lines.push(`  Distinct topologies: ${verdict.diversity.distinctTopologies}`);
  lines.push(`  Distinct modes: ${verdict.diversity.distinctModes}`);
  lines.push(`  Distinct box counts: ${verdict.diversity.distinctBoxCounts}`);
  lines.push(`  Topology concentration: ${(verdict.diversity.topologyConcentration * 100).toFixed(0)}%`);
  lines.push(`  Mode concentration: ${(verdict.diversity.modeConcentration * 100).toFixed(0)}%`);
  if (verdict.storyDiversity) {
    lines.push(`  Distinct story baskets: ${Object.keys(verdict.storyDiversity.storyCounts).length}`);
    lines.push(`  Distinct visual layouts: ${Object.keys(verdict.storyDiversity.visualCounts).length}`);
    lines.push(`  Story coverage gaps: ${verdict.storyDiversity.missingFamilies.join(", ") || "none"}`);
    lines.push(`  Label-insensitive clone groups: ${verdict.storyDiversity.cloneGroups.length}`);
  }
  lines.push("");

  // Errors
  if (verdict.errors.length > 0) {
    lines.push(`Errors (${verdict.errors.length}):`);
    for (const err of verdict.errors) {
      lines.push(`  [ERROR] ${err}`);
    }
    lines.push("");
  }

  // Warnings
  if (verdict.warnings.length > 0) {
    lines.push(`Warnings (${verdict.warnings.length}):`);
    for (const w of verdict.warnings) {
      lines.push(`  [WARN] ${w}`);
    }
    lines.push("");
  }

  lines.push("=".repeat(70));
  return lines.join("\n");
}
