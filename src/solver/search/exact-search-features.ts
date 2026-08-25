export const EXACT_SEARCH_FEATURE_KEYS = Object.freeze([
  "incrementalAssignment",
  "linearConflict",
  "interactionBoost",
  "patternDatabase",
  "forcedPushMacros",
  "piCorralPruning",
  "patternDeadlockPruning",
  "deadlockTablePruning",
  "goalCommitmentPruning",
  "tunnelMacros",
] as const);

export type ExactSearchFeatureKey = (typeof EXACT_SEARCH_FEATURE_KEYS)[number];

export interface ExactSearchFeatures {
  readonly incrementalAssignment: boolean;
  readonly linearConflict: boolean;
  readonly interactionBoost: boolean;
  readonly patternDatabase: boolean;
  readonly forcedPushMacros: boolean;
  readonly piCorralPruning: boolean;
  readonly patternDeadlockPruning: boolean;
  readonly deadlockTablePruning: boolean;
  readonly goalCommitmentPruning: boolean;
  readonly tunnelMacros: boolean;
}

export const DEFAULT_EXACT_SEARCH_FEATURES: ExactSearchFeatures = Object.freeze({
  incrementalAssignment: true,
  linearConflict: true,
  interactionBoost: true,
  patternDatabase: true,
  forcedPushMacros: true,
  piCorralPruning: true,
  patternDeadlockPruning: true,
  deadlockTablePruning: true,
  goalCommitmentPruning: true,
  tunnelMacros: true,
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
  };
}
