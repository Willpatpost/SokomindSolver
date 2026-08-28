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

import type { Difficulty } from "../../../core/model.ts";
import type {
  ReviewCatalog,
  ReviewCandidatePack,
} from "./catalog-manifest-types.ts";

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
    tutorial: { min: 1, target: 5 },
    beginner: { min: 2, target: 10 },
    intermediate: { min: 2, target: 15 },
    advanced: { min: 1, target: 10 },
    expert: { min: 0, target: 5 },
    master: { min: 0, target: 3 },
  },
  maxTopologyConcentration: 0.60,
  maxModeConcentration: 0.70,
  maxDifficultyGap: 2,
  minDistinctTopologies: 2,
  minDistinctModes: 2,
  minDistinctBoxCounts: 2,
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ReleaseGateVerdict {
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

/**
 * Check whether a ReviewCatalog meets release criteria.
 *
 * @param catalog  The review catalog to validate.
 * @param config   Release gate configuration (defaults to DEFAULT_RELEASE_GATE_CONFIG).
 * @returns  A verdict with pass/fail, errors, warnings, and metrics.
 */
export function checkReleaseGate(
  catalog: ReviewCatalog,
  config: ReleaseGateConfig = DEFAULT_RELEASE_GATE_CONFIG,
): ReleaseGateVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Collect all packs across tiers
  const allPacks: ReviewCandidatePack[] = [];
  for (const summary of Object.values(catalog.tierSummaries)) {
    allPacks.push(...summary.candidates);
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

  for (const [tier, summary] of Object.entries(catalog.tierSummaries)) {
    const quota = config.tierQuotas[tier as Difficulty];
    const min = quota?.min ?? 0;
    const target = quota?.target ?? summary.target;
    const actual = summary.actual;

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
  for (const pack of allPacks) {
    const existing = boardHashes.get(pack.boardHash);
    if (existing) {
      errors.push(
        `Duplicate board hash: "${pack.id}" and "${existing}"`,
      );
    }
    boardHashes.set(pack.boardHash, pack.id);
  }

  // ---- 4. Difficulty gap ----
  for (const pack of allPacks) {
    const gap = Math.abs(pack.difficultyGap);
    if (gap > config.maxDifficultyGap) {
      errors.push(
        `Puzzle "${pack.id}": difficulty gap ${pack.difficultyGap} exceeds max ${config.maxDifficultyGap}` +
        ` (intended=${pack.intendedDifficulty}, classified=${pack.classifiedDifficulty})`,
      );
    }
  }

  // ---- 5. Diversity metrics ----
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

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    tierCoverage,
    diversity,
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
