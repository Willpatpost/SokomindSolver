export const EXACT_SEARCH_FEATURE_KEYS = Object.freeze([
  "incrementalAssignment",
  "linearConflict",
  "interactionBoost",
  "patternDatabase",
  "forcedPushMacros",
  "piCorralPruning",
  "corralOrdering",
  "patternDeadlockPruning",
  "deadlockTablePruning",
  "goalCommitmentPruning",
  "tunnelMacros",
  "goalCutHeuristic",
  "backwardPerimeter",
  "componentPdb",
  "moveCostPatternPdb",
] as const);

export type ExactSearchFeatureKey = (typeof EXACT_SEARCH_FEATURE_KEYS)[number];

export interface ExactSearchFeatures {
  readonly incrementalAssignment: boolean;
  readonly linearConflict: boolean;
  readonly interactionBoost: boolean;
  readonly patternDatabase: boolean;
  readonly forcedPushMacros: boolean;
  readonly piCorralPruning: boolean;
  readonly corralOrdering: boolean;
  readonly patternDeadlockPruning: boolean;
  readonly deadlockTablePruning: boolean;
  readonly goalCommitmentPruning: boolean;
  readonly tunnelMacros: boolean;
  readonly goalCutHeuristic: boolean;
  readonly backwardPerimeter: boolean;
  readonly componentPdb: boolean;
  readonly moveCostPatternPdb: boolean;
}

export const DEFAULT_EXACT_SEARCH_FEATURES: ExactSearchFeatures = Object.freeze({
  incrementalAssignment: true,
  linearConflict: true,
  interactionBoost: true,
  patternDatabase: true,
  forcedPushMacros: true,
  piCorralPruning: true,
  corralOrdering: true,
  patternDeadlockPruning: true,
  deadlockTablePruning: true,
  goalCommitmentPruning: true,
  // Off by default: once sound, macro stops only add successors that
  // single-push chains already reach, and the extra work measured slower.
  tunnelMacros: false,
  // Off by default: its bottleneck surplus is not a push lower bound (boxes
  // can cross a shared tunnel one after another without extra pushes), and
  // no move-level bound has been proven.
  goalCutHeuristic: false,
  backwardPerimeter: false,
  componentPdb: false,
  moveCostPatternPdb: false,
});

export const ALL_OFF_EXACT_SEARCH_FEATURES: ExactSearchFeatures = Object.freeze(
  Object.fromEntries(EXACT_SEARCH_FEATURE_KEYS.map((key) => [key, false])) as
    unknown as ExactSearchFeatures,
);

export function resolveExactSearchFeatures(
  overrides?: Partial<ExactSearchFeatures>,
): ExactSearchFeatures {
  if (overrides === undefined) return DEFAULT_EXACT_SEARCH_FEATURES;
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    throw new TypeError("Exact-search feature overrides must be a plain object.");
  }
  const record = overrides as Readonly<Record<string, unknown>>;
  const known = new Set<string>(EXACT_SEARCH_FEATURE_KEYS);
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown exact-search feature(s): ${unknown.join(", ")}`);
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "boolean") {
      throw new TypeError(`Exact-search feature '${key}' must be boolean.`);
    }
  }
  return Object.freeze({ ...DEFAULT_EXACT_SEARCH_FEATURES, ...overrides });
}

export function exactSearchFeatureFingerprint(
  features: ExactSearchFeatures,
): string {
  return `exact-v1:${EXACT_SEARCH_FEATURE_KEYS.map(
    (key) => `${key}=${features[key] ? 1 : 0}`,
  ).join(",")}`;
}

export function exactSearchFeatureMask(features: ExactSearchFeatures): number {
  return EXACT_SEARCH_FEATURE_KEYS.reduce(
    (mask, key, index) => mask | (features[key] ? 1 << index : 0),
    0,
  );
}

export function isDefaultExactSearchFeatures(
  features: ExactSearchFeatures,
): boolean {
  return EXACT_SEARCH_FEATURE_KEYS.every(
    (key) => features[key] === DEFAULT_EXACT_SEARCH_FEATURES[key],
  );
}

interface ExactSearchFeatureTelemetry {
  linearConflictEvaluations: number;
  linearConflictTotal: number;
  pdbBuildTimeMs: number;
  pdbTableEntries: number;
  pdbEvaluations: number;
  deadlockTableChecks: number;
  tunnelMacroApplications: number;
  goalCutEvaluations: number;
  goalCutTotal: number;
  backwardPerimeterBuildExpanded: number;
  backwardPerimeterColoredStates: number;
  backwardPerimeterProjectedStates: number;
  backwardPerimeterDuplicateProjections: number;
  backwardPerimeterConstrainedSkipped: number;
  backwardPerimeterBuildTimeMs: number;
  backwardPerimeterRetainedBytes: number;
  backwardPerimeterPeakWorkingBytes: number;
  backwardPerimeterLookups: number;
  backwardPerimeterHits: number;
  backwardPerimeterImprovements: number;
  backwardPerimeterTotalImprovement: number;
  backwardPerimeterMaxImprovement: number;
  backwardPerimeterMaxDepth: number;
  matchingComponents: number;
  matchingEliminatedEdges: number;
  corridorViableCells: number;
  corridorViableEdges: number;
  componentPdbBuildTimeMs: number;
  componentPdbRetainedBytes: number;
  componentPdbPeakBuildBytes: number;
  componentPdbComponents: number;
  componentPdbImprovements: number;
  componentPdbTotalImprovement: number;
  componentPdbMaxImprovement: number;
  componentPdbPartitionQueries: number;
  componentPdbPartitionCacheHits: number;
  moveCostPdbBuildTimeMs: number;
  moveCostPdbRetainedBytes: number;
  moveCostPdbPatterns: number;
  moveCostPdbSettledStates: number;
  moveCostPdbImprovements: number;
  moveCostPdbTotalImprovement: number;
  moveCostPdbMaxImprovement: number;
}

export function createExactSearchFeatureTelemetry(): ExactSearchFeatureTelemetry {
  return {
    linearConflictEvaluations: 0,
    linearConflictTotal: 0,
    pdbBuildTimeMs: 0,
    pdbTableEntries: 0,
    pdbEvaluations: 0,
    deadlockTableChecks: 0,
    tunnelMacroApplications: 0,
    goalCutEvaluations: 0,
    goalCutTotal: 0,
    backwardPerimeterBuildExpanded: 0,
    backwardPerimeterColoredStates: 0,
    backwardPerimeterProjectedStates: 0,
    backwardPerimeterDuplicateProjections: 0,
    backwardPerimeterConstrainedSkipped: 0,
    backwardPerimeterBuildTimeMs: 0,
    backwardPerimeterRetainedBytes: 0,
    backwardPerimeterPeakWorkingBytes: 0,
    backwardPerimeterLookups: 0,
    backwardPerimeterHits: 0,
    backwardPerimeterImprovements: 0,
    backwardPerimeterTotalImprovement: 0,
    backwardPerimeterMaxImprovement: 0,
    backwardPerimeterMaxDepth: 0,
    matchingComponents: 0,
    matchingEliminatedEdges: 0,
    corridorViableCells: 0,
    corridorViableEdges: 0,
    componentPdbBuildTimeMs: 0,
    componentPdbRetainedBytes: 0,
    componentPdbPeakBuildBytes: 0,
    componentPdbComponents: 0,
    componentPdbImprovements: 0,
    componentPdbTotalImprovement: 0,
    componentPdbMaxImprovement: 0,
    componentPdbPartitionQueries: 0,
    componentPdbPartitionCacheHits: 0,
    moveCostPdbBuildTimeMs: 0,
    moveCostPdbRetainedBytes: 0,
    moveCostPdbPatterns: 0,
    moveCostPdbSettledStates: 0,
    moveCostPdbImprovements: 0,
    moveCostPdbTotalImprovement: 0,
    moveCostPdbMaxImprovement: 0,
  };
}
