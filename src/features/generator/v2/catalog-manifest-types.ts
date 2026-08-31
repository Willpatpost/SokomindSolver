import type { Difficulty } from "../../../core/model.ts";
import type { TopologyFamily } from "./blueprint-types.ts";
import type { ForgeGenerationMode } from "./forge-sampling.ts";
import type { MotifType } from "./motifs.ts";
import type { BoxTypingMode } from "./puzzle-forge.ts";

export const CATALOG_GENERATOR_VERSION = "4.2.0" as const;
export const REVIEW_CATALOG_SCHEMA_VERSION = 1 as const;

export interface GeneratedPuzzleManifestEntry {
  readonly id: string;
  readonly title: string;
  readonly difficulty: Difficulty;
  readonly seed: number;
  readonly family: TopologyFamily;
  readonly boxCount: number;
  readonly mode: ForgeGenerationMode;
  readonly motifType?: MotifType;
  readonly compositionType?: string;
  readonly boardHash: string;
  readonly symmetryHash: string;
  readonly tightened: boolean;
  readonly cellsRemoved: number;
  readonly typingMode: BoxTypingMode;
  readonly genericBoxCount?: number;
  readonly typedBoxCount?: number;
  readonly dependencyEdges?: number;
  readonly dependencyRealized?: number;
  readonly dependencyRealizationRate?: number;
  readonly intendedDifficulty: Difficulty;
  readonly classifiedDifficulty: Difficulty;
  readonly difficultyGap: number;
  readonly solutionMoves: number;
  readonly solutionPushes: number;
  readonly minPushesPerBox?: number;
  readonly inactiveBoxCount?: number;
  readonly onePushBoxCount?: number;
  readonly crossTypeInteractionCount?: number;
  readonly totalFloor: number;
  readonly solversAttempted?: number;
  readonly solversSucceeded?: number;
  readonly solverAgreement?: boolean;
  readonly avgExpandedStates?: number;
}

export interface GeneratedPuzzleManifest {
  readonly schemaVersion: 1;
  readonly generatorVersion: string;
  readonly catalogHash: string;
  readonly tierQuotas: Readonly<
    Record<Difficulty, { readonly target: number; readonly actual: number }>
  >;
  readonly puzzles: readonly GeneratedPuzzleManifestEntry[];
}

// ---------------------------------------------------------------------------
// Review catalog types (Phase 10)
// ---------------------------------------------------------------------------

export interface ReviewCandidatePack {
  readonly id: string;
  readonly ascii: string;
  readonly difficulty: Difficulty;
  readonly intendedDifficulty: Difficulty;
  readonly classifiedDifficulty: Difficulty;
  readonly difficultyGap: number;
  readonly boxCount: number;
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly playableFloor: number;
  readonly typingMode: BoxTypingMode;
  readonly genericBoxCount?: number;
  readonly typedBoxCount?: number;
  readonly solutionMoves: number;
  readonly solutionPushes: number;
  readonly minPushesPerBox: number;
  readonly inactiveBoxCount: number;
  readonly onePushBoxCount: number;
  readonly crossTypeInteractionCount: number;
  readonly seed: number;
  readonly family: TopologyFamily;
  readonly mode: ForgeGenerationMode;
  readonly motifType?: MotifType;
  readonly compositionType?: string;
  readonly boardHash: string;
  readonly symmetryHash: string;
  // Quality-gate evidence
  readonly qualityPassed: boolean;
  readonly qualityReasons: readonly string[];
  readonly qualityPurposefulGeometry: number;
  readonly qualityInteraction: number;
  readonly qualityCausalDepth: number;
  readonly qualityDecision: number;
  readonly qualityMechanismIntegrity: number;
  readonly qualityElegance: number;
  readonly qualityTedium: number;
  // Structural metrics
  readonly regionCount: number;
  readonly chokepoints: number;
  readonly articulationPoints: number;
  readonly tunnelCells: number;
  readonly floorUtilization: number;
  // Solver evidence
  readonly solversAttempted: number;
  readonly solversSucceeded: number;
  readonly solverAgreement: boolean;
  readonly avgExpandedStates: number;
  readonly maxExpandedStates: number;
  // Mechanism evidence
  readonly dependencyEdges?: number;
  readonly dependencyRealized?: number;
  readonly dependencyRealizationRate?: number;
  readonly mechanismEvidencePassed?: boolean;
  readonly mechanismEvidenceMissing?: readonly string[];
  readonly counterfactualEdges?: number;
  readonly counterfactualTotal?: number;
  // V4 difficulty
  readonly v4Composite?: number;
  readonly v4Classification?: string;
  readonly v4StructuralScale?: number;
  readonly v4SolutionDepth?: number;
  readonly v4ReasoningComplexity?: number;
  readonly v4TediumPenalty?: number;
  readonly v4ConfidenceNote?: string;
  // Solution depth metrics
  readonly nonMonotonicBoxMoves?: number;
  readonly stagingOperations?: number;
  readonly temporaryGoalVacancies?: number;
  readonly estimatedDependencyDepth?: number;
  readonly goalOrderConstraints?: number;
}

export interface ReviewCatalogTierSummary {
  readonly target: number;
  readonly actual: number;
  readonly candidates: readonly ReviewCandidatePack[];
}

export interface ReviewCatalog {
  readonly schemaVersion: typeof REVIEW_CATALOG_SCHEMA_VERSION;
  readonly generatorVersion: string;
  readonly generatedAt: string;
  readonly qualityPreset?: string;
  readonly tierFilter?: string;
  readonly tierSummaries: Record<string, ReviewCatalogTierSummary>;
}
