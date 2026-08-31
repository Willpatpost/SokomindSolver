/**
 * Review catalog helpers for Phase 10:
 * - buildReviewPack: turn a ForgeCandidate + evaluation into a ReviewCandidatePack
 * - buildReviewCatalog: assemble a full ReviewCatalog from packs
 * - formatReviewSummary: human-readable summary with ASCII boards
 * - validateForAcceptance: validate a catalog+manifest pair before copying to production
 */

import type { Difficulty, PuzzleDefinition } from "../../../core/model.ts";
import { DIFFICULTIES } from "../../../core/model.ts";
import { validatePuzzle } from "../../../core/puzzle.ts";
import type { ForgeCandidate } from "./puzzle-forge.ts";
import { forgeCandidateToAscii, countBoxesAndGoals } from "./puzzle-forge.ts";
import type { FinalistEvaluation, FinalistEvaluationV4 } from "./finalist-evaluator.ts";
import type { V4DifficultyProfile } from "./difficulty-model.ts";
import { computeV4Profile } from "./difficulty-model.ts";
import { boardHash, symmetryHash } from "./puzzle-identity.ts";
import type {
  ReviewCandidatePack,
  ReviewCatalog,
  ReviewCatalogTierSummary,
} from "./catalog-manifest-types.ts";
import {
  CATALOG_GENERATOR_VERSION,
  REVIEW_CATALOG_SCHEMA_VERSION,
} from "./catalog-manifest-types.ts";

// ---------------------------------------------------------------------------
// buildReviewPack
// ---------------------------------------------------------------------------

export function buildReviewPack(
  candidate: ForgeCandidate,
  intendedDifficulty: Difficulty,
  classifiedDifficulty: Difficulty,
  gap: number,
  finalistEval?: FinalistEvaluation,
  v4Profile?: V4DifficultyProfile,
): ReviewCandidatePack {
  const p = candidate.provenance;
  const ev = candidate.evaluation;

  // Compute V4 profile if not provided
  const v4 = v4Profile ?? computeV4Profile(ev);

  return {
    id: candidate.puzzle.id,
    ascii: forgeCandidateToAscii(candidate),
    difficulty: candidate.puzzle.difficulty,
    intendedDifficulty,
    classifiedDifficulty,
    difficultyGap: gap,
    boxCount: p.boxCount,
    boardWidth: ev.boardWidth,
    boardHeight: ev.boardHeight,
    playableFloor: ev.totalFloor,
    typingMode: p.typingMode,
    genericBoxCount: p.genericBoxCount,
    typedBoxCount: p.typedBoxCount,
    solutionMoves: ev.solutionMoves,
    solutionPushes: ev.solutionPushes,
    minPushesPerBox: ev.minPushesPerBox ?? 0,
    inactiveBoxCount: ev.inactiveBoxCount ?? ev.boxCount,
    onePushBoxCount: ev.onePushBoxCount ?? ev.boxCount,
    crossTypeInteractionCount:
      (ev.crossTypeSharedRouteCells ?? 0) +
      (ev.crossTypeSharedSupportCells ?? 0) +
      (ev.crossTypeSharedChokepoints ?? 0) +
      (ev.crossTypeCausalEnableCount ?? 0) +
      (ev.crossTypeCausalDisableCount ?? 0),
    seed: p.seed,
    family: p.family,
    mode: p.mode,
    motifType: p.motifType,
    compositionType: p.compositionType,
    boardHash: boardHash(candidate.puzzle.rows),
    symmetryHash: symmetryHash(candidate.puzzle.rows),
    qualityPassed: candidate.qualityProfile?.passed ?? false,
    qualityReasons: candidate.qualityProfile?.reasons ?? [
      "candidate has no recorded quality-gate result",
    ],
    qualityPurposefulGeometry: candidate.qualityProfile?.purposefulGeometry ?? 0,
    qualityInteraction: candidate.qualityProfile?.interactionQuality ?? 0,
    qualityCausalDepth: candidate.qualityProfile?.causalDepth ?? 0,
    qualityDecision: candidate.qualityProfile?.decisionQuality ?? 0,
    qualityMechanismIntegrity: candidate.qualityProfile?.mechanismIntegrity ?? 0,
    qualityElegance: candidate.qualityProfile?.elegance ?? 0,
    qualityTedium: candidate.qualityProfile?.tedium ?? 1,
    // Structural metrics
    regionCount: ev.regionCount,
    chokepoints: ev.chokepoints,
    articulationPoints: ev.articulationPoints,
    tunnelCells: ev.tunnelCells,
    floorUtilization: ev.floorUtilization,
    // Solver evidence
    solversAttempted: finalistEval?.solversAttempted ?? 0,
    solversSucceeded: finalistEval?.solversSucceeded ?? 0,
    solverAgreement: finalistEval?.solverAgreement ?? false,
    avgExpandedStates: finalistEval?.avgExpandedStates ?? ev.solverExpandedStates,
    maxExpandedStates: finalistEval?.maxExpandedStates ?? ev.solverExpandedStates,
    // Mechanism evidence
    dependencyEdges: p.dependencyEdges,
    dependencyRealized: p.dependencyRealized,
    dependencyRealizationRate: p.dependencyRealizationRate,
    mechanismEvidencePassed: p.mechanismEvidencePassed,
    mechanismEvidenceMissing: p.mechanismEvidenceMissing,
    counterfactualEdges: p.counterfactualEdges,
    counterfactualTotal: p.counterfactualTotal,
    // V4 difficulty
    v4Composite: v4.composite,
    v4Classification: v4.classification,
    v4StructuralScale: v4.structuralScale,
    v4SolutionDepth: v4.solutionDepth,
    v4ReasoningComplexity: v4.humanReasoningComplexity,
    v4TediumPenalty: v4.tediumPenalty,
    v4ConfidenceNote: v4.confidenceNote,
    // Solution depth metrics
    nonMonotonicBoxMoves: ev.nonMonotonicBoxMoves,
    stagingOperations: ev.stagingOperations,
    temporaryGoalVacancies: ev.temporaryGoalVacancies,
    estimatedDependencyDepth: ev.estimatedDependencyDepth,
    goalOrderConstraints: ev.goalOrderConstraints,
  };
}

// ---------------------------------------------------------------------------
// buildReviewCatalog
// ---------------------------------------------------------------------------

export interface ReviewCatalogOptions {
  readonly generatorVersion?: string;
  readonly qualityPreset?: string;
  readonly tierFilter?: string;
}

export function buildReviewCatalog(
  tierPacks: ReadonlyMap<Difficulty, {
    readonly target: number;
    readonly packs: readonly ReviewCandidatePack[];
  }>,
  options: ReviewCatalogOptions = {},
): ReviewCatalog {
  const tierSummaries: Record<string, ReviewCatalogTierSummary> = {};
  for (const [tier, { target, packs }] of tierPacks) {
    tierSummaries[tier] = {
      target,
      actual: packs.length,
      candidates: packs,
    };
  }

  return {
    schemaVersion: REVIEW_CATALOG_SCHEMA_VERSION,
    generatorVersion: options.generatorVersion ?? CATALOG_GENERATOR_VERSION,
    generatedAt: new Date().toISOString(),
    qualityPreset: options.qualityPreset,
    tierFilter: options.tierFilter,
    tierSummaries,
  };
}

// ---------------------------------------------------------------------------
// buildFinalReviewCatalog
// ---------------------------------------------------------------------------

/**
 * Per-tier target specification for buildFinalReviewCatalog.
 */
export interface FinalReviewTierTarget {
  readonly difficulty: Difficulty;
  readonly target: number;
}

/**
 * Build a final review catalog directly from ForgeCandidate arrays, one per
 * tier.  This is the high-level entry point for producing a review catalog
 * from forge output suitable for human review and release-gate validation.
 *
 * For each tier, it:
 *   1. Classifies the candidate's V4 difficulty (if not already present).
 *   2. Computes the difficulty gap.
 *   3. Builds a ReviewCandidatePack with full provenance.
 *
 * @param tiers         Per-tier candidates and targets.
 * @param options       Generator version, quality preset, etc.
 * @returns             A complete ReviewCatalog ready for review and gate.
 */
export function buildFinalReviewCatalog(
  tiers: readonly FinalReviewTierTarget[],
  candidatesByTier: ReadonlyMap<Difficulty, readonly ForgeCandidate[]>,
  options: ReviewCatalogOptions = {},
): ReviewCatalog {
  const tierOrder: readonly Difficulty[] = [...DIFFICULTIES];
  const tierIndex = (d: Difficulty): number => tierOrder.indexOf(d);

  const tierPacks = new Map<Difficulty, {
    target: number;
    packs: ReviewCandidatePack[];
  }>();

  for (const spec of tiers) {
    const candidates = candidatesByTier.get(spec.difficulty) ?? [];
    const packs: ReviewCandidatePack[] = [];

    for (const candidate of candidates) {
      const intendedDifficulty = spec.difficulty;
      // Tier assignment is derived from the current box-count contract. Do
      // not trust cached provenance from an older difficulty policy.
      const v4Profile = computeV4Profile(candidate.evaluation);
      const classifiedDifficulty = v4Profile.classification;
      const gap = tierIndex(classifiedDifficulty) - tierIndex(intendedDifficulty);

      // Extract finalist evaluation, handling V4 shape
      const finalistEval = candidate.finalistEvaluation
        ? extractFinalistBase(candidate.finalistEvaluation)
        : undefined;

      packs.push(
        buildReviewPack(
          candidate,
          intendedDifficulty,
          classifiedDifficulty,
          gap,
          finalistEval,
          v4Profile,
        ),
      );
    }

    tierPacks.set(spec.difficulty, { target: spec.target, packs });
  }

  return buildReviewCatalog(tierPacks, options);
}

/**
 * Extract base FinalistEvaluation fields from either FinalistEvaluation or
 * FinalistEvaluationV4, since buildReviewPack expects the base type.
 */
function extractFinalistBase(
  eval_: FinalistEvaluation | FinalistEvaluationV4,
): FinalistEvaluation {
  return {
    solverEvidence: eval_.solverEvidence,
    solverAgreement: eval_.solverAgreement,
    minMoves: eval_.minMoves,
    maxMoves: eval_.maxMoves,
    minPushes: eval_.minPushes,
    maxPushes: eval_.maxPushes,
    avgExpandedStates: eval_.avgExpandedStates,
    maxExpandedStates: eval_.maxExpandedStates,
    solversSucceeded: eval_.solversSucceeded,
    solversAttempted: eval_.solversAttempted,
  };
}

// ---------------------------------------------------------------------------
// formatReviewSummary
// ---------------------------------------------------------------------------

export function formatReviewSummary(catalog: ReviewCatalog): string {
  const lines: string[] = [];

  lines.push("=".repeat(70));
  lines.push("REVIEW CATALOG SUMMARY");
  lines.push("=".repeat(70));
  lines.push(`Generator: ${catalog.generatorVersion}`);
  lines.push(`Generated: ${catalog.generatedAt}`);
  if (catalog.qualityPreset) lines.push(`Quality: ${catalog.qualityPreset}`);
  if (catalog.tierFilter) lines.push(`Tier filter: ${catalog.tierFilter}`);
  lines.push("");

  // Tier distribution table
  lines.push(`${"Tier".padEnd(15)} ${"Target".padStart(8)} ${"Actual".padStart(8)} ${"Status".padStart(10)}`);
  lines.push("-".repeat(45));

  let totalTarget = 0;
  let totalActual = 0;

  for (const [tier, summary] of Object.entries(catalog.tierSummaries)) {
    const status = summary.actual >= summary.target ? "OK" : `SHORT -${summary.target - summary.actual}`;
    lines.push(
      `${tier.padEnd(15)} ${String(summary.target).padStart(8)} ${String(summary.actual).padStart(8)} ${status.padStart(10)}`,
    );
    totalTarget += summary.target;
    totalActual += summary.actual;
  }
  lines.push("-".repeat(45));
  lines.push(
    `${"Total".padEnd(15)} ${String(totalTarget).padStart(8)} ${String(totalActual).padStart(8)}`,
  );
  lines.push("");

  // Per-tier candidate details with ASCII boards
  for (const [tier, summary] of Object.entries(catalog.tierSummaries)) {
    if (summary.candidates.length === 0) continue;

    lines.push("=".repeat(70));
    lines.push(`${tier.toUpperCase()} TIER (${summary.actual} candidates)`);
    lines.push("=".repeat(70));

    for (const pack of summary.candidates) {
      lines.push("");
      lines.push(`--- ${pack.id} ---`);
      lines.push(`Seed: ${pack.seed} | Family: ${pack.family} | Mode: ${pack.mode}`);
      lines.push(`Boxes: ${pack.boxCount} | Typing: ${pack.typingMode}`);
      lines.push(`Board: ${pack.boardWidth}x${pack.boardHeight} | Floor: ${pack.playableFloor}`);
      lines.push(`Moves: ${pack.solutionMoves} | Pushes: ${pack.solutionPushes}`);
      lines.push(
        `Difficulty: intended=${pack.intendedDifficulty}, classified=${pack.classifiedDifficulty}, gap=${pack.difficultyGap}`,
      );

      // V4 difficulty
      if (pack.v4Composite !== undefined) {
        lines.push(
          `V4: composite=${pack.v4Composite.toFixed(2)}, class=${pack.v4Classification}` +
          ` | S=${pack.v4StructuralScale?.toFixed(2)} D=${pack.v4SolutionDepth?.toFixed(2)}` +
          ` R=${pack.v4ReasoningComplexity?.toFixed(2)} T=${pack.v4TediumPenalty?.toFixed(3)}`,
        );
        if (pack.v4ConfidenceNote) lines.push(`    ${pack.v4ConfidenceNote}`);
      }

      // Structural
      lines.push(
        `Structure: regions=${pack.regionCount} choke=${pack.chokepoints}` +
        ` artic=${pack.articulationPoints} tunnels=${pack.tunnelCells}` +
        ` util=${pack.floorUtilization.toFixed(3)}`,
      );

      // Solver evidence
      lines.push(
        `Solvers: ${pack.solversSucceeded}/${pack.solversAttempted} agree=${pack.solverAgreement}` +
        ` avgStates=${pack.avgExpandedStates} maxStates=${pack.maxExpandedStates}`,
      );

      // Mechanism
      if (pack.dependencyEdges !== undefined) {
        lines.push(
          `Dependencies: ${pack.dependencyRealized ?? 0}/${pack.dependencyEdges} edges` +
          ` (${((pack.dependencyRealizationRate ?? 0) * 100).toFixed(0)}%)`,
        );
      }

      // Solution depth
      if (pack.nonMonotonicBoxMoves !== undefined) {
        lines.push(
          `Depth: nonMono=${pack.nonMonotonicBoxMoves} staging=${pack.stagingOperations}` +
          ` vacancies=${pack.temporaryGoalVacancies} depDepth=${pack.estimatedDependencyDepth}` +
          ` goalOrder=${pack.goalOrderConstraints}`,
        );
      }

      // ASCII board
      lines.push("");
      lines.push(pack.ascii);
    }
  }

  lines.push("");
  lines.push("=".repeat(70));
  lines.push("PLAYTEST QUESTION: Would you voluntarily play another from this tier?");
  lines.push("=".repeat(70));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// validateForAcceptance
// ---------------------------------------------------------------------------

export interface AcceptanceResult {
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly puzzleCount: number;
}

export function validateForAcceptance(
  catalogJson: string,
  manifestJson: string,
): AcceptanceResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Parse catalog
  let entries: PuzzleDefinition[];
  try {
    entries = JSON.parse(catalogJson) as PuzzleDefinition[];
  } catch {
    return { passed: false, errors: ["Failed to parse catalog JSON"], warnings: [], puzzleCount: 0 };
  }

  // Parse manifest
  let manifest: { puzzles?: readonly { id: string }[] };
  try {
    manifest = JSON.parse(manifestJson) as { puzzles?: readonly { id: string }[] };
  } catch {
    return { passed: false, errors: ["Failed to parse manifest JSON"], warnings: [], puzzleCount: entries.length };
  }

  if (!Array.isArray(entries)) {
    errors.push("Catalog is not an array");
    return { passed: false, errors, warnings, puzzleCount: 0 };
  }

  if (entries.length === 0) {
    errors.push("Catalog is empty");
    return { passed: false, errors, warnings, puzzleCount: 0 };
  }

  // Check unique IDs
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      errors.push(`Duplicate ID: ${entry.id}`);
    }
    ids.add(entry.id);

    if (!entry.id.startsWith("gen-v2-")) {
      errors.push(`ID does not use gen-v2- prefix: ${entry.id}`);
    }
  }

  // Check unique board hashes
  const hashes = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.rows || !Array.isArray(entry.rows)) {
      errors.push(`Entry ${entry.id} has no rows`);
      continue;
    }
    const hash = boardHash(entry.rows);
    const existing = hashes.get(hash);
    if (existing) {
      errors.push(`Duplicate board hash: ${entry.id} and ${existing}`);
    }
    hashes.set(hash, entry.id);
  }

  // Check unique symmetry hashes
  const symHashes = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.rows || !Array.isArray(entry.rows)) continue;
    const hash = symmetryHash(entry.rows);
    const existing = symHashes.get(hash);
    if (existing) {
      errors.push(`Duplicate symmetry hash: ${entry.id} and ${existing}`);
    }
    symHashes.set(hash, entry.id);
  }

  // Validate each puzzle
  for (const entry of entries) {
    const validation = validatePuzzle(entry);
    if (!validation.valid) {
      errors.push(
        `Validation failed for ${entry.id}: ${validation.errors.map((e) => e.message).join("; ")}`,
      );
    }
  }

  // Check box count consistency between puzzles and manifest
  if (manifest.puzzles) {
    const manifestById = new Map(
      manifest.puzzles.map((p) => [p.id, p as Record<string, unknown>]),
    );
    for (const entry of entries) {
      if (!entry.rows || !Array.isArray(entry.rows)) continue;
      const counts = countBoxesAndGoals(entry.rows);
      const mp = manifestById.get(entry.id);
      if (!mp) continue;

      if (typeof mp.boxCount === "number" && counts.boxes !== mp.boxCount) {
        errors.push(
          `Box count mismatch for ${entry.id}: puzzle has ${counts.boxes} boxes but manifest declares ${mp.boxCount}`,
        );
      }
      if (typeof mp.genericBoxCount === "number" && counts.generic !== mp.genericBoxCount) {
        errors.push(
          `Generic box count mismatch for ${entry.id}: puzzle has ${counts.generic} but manifest declares ${mp.genericBoxCount}`,
        );
      }
      if (typeof mp.typedBoxCount === "number" && counts.typed !== mp.typedBoxCount) {
        errors.push(
          `Typed box count mismatch for ${entry.id}: puzzle has ${counts.typed} but manifest declares ${mp.typedBoxCount}`,
        );
      }
      if (counts.boxes !== counts.goals) {
        errors.push(
          `Box/goal count mismatch for ${entry.id}: ${counts.boxes} boxes but ${counts.goals} goals`,
        );
      }
    }
  }

  // Check manifest/catalog alignment
  if (manifest.puzzles) {
    const manifestIds = new Set(manifest.puzzles.map((p) => p.id));
    for (const entry of entries) {
      if (!manifestIds.has(entry.id)) {
        warnings.push(`Catalog entry ${entry.id} not in manifest`);
      }
    }
    for (const mp of manifest.puzzles) {
      if (!ids.has(mp.id)) {
        warnings.push(`Manifest entry ${mp.id} not in catalog`);
      }
    }
    if (manifest.puzzles.length !== entries.length) {
      warnings.push(
        `Manifest has ${manifest.puzzles.length} entries but catalog has ${entries.length}`,
      );
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    puzzleCount: entries.length,
  };
}
