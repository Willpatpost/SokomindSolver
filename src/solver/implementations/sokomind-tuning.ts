/**
 * Soft search-ordering parameters for Sokomind Solver.
 *
 * This is deliberately separate from legality, deadlock rejection, replay
 * verification, and resource limits. Automated tuning may change these
 * values, but it cannot make an illegal route valid or turn an ordering hint
 * into a hard prune.
 */

export interface TunableParameterMeta {
  readonly min: number;
  readonly max: number;
  readonly scale: "linear" | "log";
  readonly description: string;
}

export interface SokomindTuningProfile {
  readonly schemaVersion: 2;

  // --- Search ordering weights (original v1 surface) ---
  readonly planMoveWeight: number;
  readonly heuristicWeight: number;
  readonly costWeight: number;
  readonly goalPackingWeight: number;
  readonly mobilityWeight: number;
  readonly topologyWeight: number;
  readonly evacuationWeight: number;
  readonly supportDependencyWeight: number;
  readonly localRoomWeight: number;
  readonly doorwayFlowWeight: number;
  readonly relevanceWeight: number;

  // --- Structural plan parameters ---
  readonly planBeamWidth: number;
  readonly planBoxBranches: number;
  readonly maxPlanSegments: number;
  readonly planSlack: number;
  readonly sequenceMacroLimit: number;

  // --- Time allocation shares ---
  readonly structuralHeadStartMs: number;
  readonly structuralTimeShare: number;
  readonly structuralStateShare: number;

  // --- Improvement pass window sizes ---
  readonly rewriteWindowVisited: number;
  readonly rewriteMoveWindowScale: number;
}

export type SokomindTuningOverrides = Readonly<
  Partial<Omit<SokomindTuningProfile, "schemaVersion">> & {
    readonly schemaVersion?: 1 | 2;
  }
>;

export const TUNABLE_PARAMETER_META: Readonly<
  Record<string, TunableParameterMeta>
> = Object.freeze({
  planMoveWeight: { min: 0, max: 0.1, scale: "linear", description: "Plan-move ordering bias" },
  heuristicWeight: { min: 0, max: 20, scale: "linear", description: "Heuristic multiplier in beam scoring" },
  costWeight: { min: 0, max: 10, scale: "linear", description: "Move-cost weight in beam scoring" },
  goalPackingWeight: { min: 0, max: 5, scale: "linear", description: "Goal-packing density bonus" },
  mobilityWeight: { min: 0, max: 1, scale: "linear", description: "Box mobility bonus" },
  topologyWeight: { min: 0, max: 5, scale: "linear", description: "Topological-distance bonus" },
  evacuationWeight: { min: 0, max: 5, scale: "linear", description: "Evacuation-path weight" },
  supportDependencyWeight: { min: 0, max: 5, scale: "linear", description: "Support-dependency chain weight" },
  localRoomWeight: { min: 0, max: 5, scale: "linear", description: "Local room connectivity weight" },
  doorwayFlowWeight: { min: 0, max: 5, scale: "linear", description: "Doorway flow-through weight" },
  relevanceWeight: { min: 0, max: 5, scale: "linear", description: "Goal-relevance ordering weight" },
  planBeamWidth: { min: 4, max: 128, scale: "log", description: "Structural plan beam width" },
  planBoxBranches: { min: 2, max: 16, scale: "linear", description: "Box candidates per plan step" },
  maxPlanSegments: { min: 20, max: 500, scale: "linear", description: "Maximum plan length in segments" },
  planSlack: { min: 50, max: 800, scale: "linear", description: "Plan cost slack allowance" },
  sequenceMacroLimit: { min: 4, max: 64, scale: "linear", description: "Macro discovery budget per sequence" },
  structuralHeadStartMs: { min: 5000, max: 60000, scale: "log", description: "Structural lane head start in ms" },
  structuralTimeShare: { min: 0.2, max: 0.9, scale: "linear", description: "Fraction of time budget for structural lane" },
  structuralStateShare: { min: 0.2, max: 0.9, scale: "linear", description: "Fraction of state budget for structural lane" },
  rewriteWindowVisited: { min: 2000, max: 50000, scale: "log", description: "Per-window visited state budget for rewrite" },
  rewriteMoveWindowScale: { min: 0.5, max: 4.0, scale: "linear", description: "Move-window size multiplier" },
});

export const DEFAULT_SOKOMIND_TUNING: SokomindTuningProfile = Object.freeze({
  schemaVersion: 2 as const,

  planMoveWeight: 0.005,
  heuristicWeight: 3,
  costWeight: 0,
  goalPackingWeight: 0.8,
  mobilityWeight: 0.03,
  topologyWeight: 0.7,
  evacuationWeight: 0,
  supportDependencyWeight: 0.8,
  localRoomWeight: 0.6,
  doorwayFlowWeight: 0.35,
  relevanceWeight: 0.6,

  planBeamWidth: 32,
  planBoxBranches: 6,
  maxPlanSegments: 160,
  planSlack: 240,
  sequenceMacroLimit: 24,

  structuralHeadStartMs: 25_000,
  structuralTimeShare: 0.7,
  structuralStateShare: 0.6,

  rewriteWindowVisited: 12_000,
  rewriteMoveWindowScale: 1.0,
});

const TUNABLE_KEYS = Object.freeze([
  "planMoveWeight",
  "heuristicWeight",
  "costWeight",
  "goalPackingWeight",
  "mobilityWeight",
  "topologyWeight",
  "evacuationWeight",
  "supportDependencyWeight",
  "localRoomWeight",
  "doorwayFlowWeight",
  "relevanceWeight",
  "planBeamWidth",
  "planBoxBranches",
  "maxPlanSegments",
  "planSlack",
  "sequenceMacroLimit",
  "structuralHeadStartMs",
  "structuralTimeShare",
  "structuralStateShare",
  "rewriteWindowVisited",
  "rewriteMoveWindowScale",
] as const);

type TunableKey = (typeof TUNABLE_KEYS)[number];
const ALLOWED_OVERRIDE_KEYS = new Set<string>([
  "schemaVersion",
  ...TUNABLE_KEYS,
]);

function checkedWeight(key: TunableKey, value: number): number {
  const meta = TUNABLE_PARAMETER_META[key];
  if (!meta) {
    throw new TypeError(`Unknown tuning key "${key}".`);
  }
  if (!Number.isFinite(value) || value < meta.min || value > meta.max) {
    throw new RangeError(
      `Sokomind tuning value "${key}" must be finite and between ${meta.min} and ${meta.max}; got ${value}.`,
    );
  }
  return value;
}

export function resolveSokomindTuning(
  overrides: SokomindTuningOverrides = {},
): SokomindTuningProfile {
  if (
    typeof overrides !== "object" ||
    overrides === null ||
    Array.isArray(overrides)
  ) {
    throw new TypeError("Sokomind tuning overrides must be an object.");
  }
  for (const key of Object.keys(overrides)) {
    if (!ALLOWED_OVERRIDE_KEYS.has(key)) {
      throw new TypeError(`Unknown Sokomind tuning key "${key}".`);
    }
  }
  if (
    overrides.schemaVersion !== undefined &&
    overrides.schemaVersion !== 1 &&
    overrides.schemaVersion !== DEFAULT_SOKOMIND_TUNING.schemaVersion
  ) {
    throw new RangeError(
      `Unsupported Sokomind tuning schema version ${String(overrides.schemaVersion)}.`,
    );
  }
  const resolved = Object.fromEntries(
    TUNABLE_KEYS.map((key) => [
      key,
      checkedWeight(key, overrides[key] ?? DEFAULT_SOKOMIND_TUNING[key]),
    ]),
  ) as unknown as Omit<SokomindTuningProfile, "schemaVersion">;

  return Object.freeze({
    schemaVersion: 2 as const,
    ...resolved,
  });
}

/**
 * Stable identity used by benchmark output and future optimizer datasets.
 */
export function sokomindTuningFingerprint(
  profile: SokomindTuningProfile,
): string {
  return [
    `v${profile.schemaVersion}`,
    ...TUNABLE_KEYS.map((key) => `${key}=${profile[key]}`),
  ].join(";");
}

/**
 * Translate the public profile to the legacy engine's payload vocabulary.
 */
export function sokomindTuningPayload(
  profile: SokomindTuningProfile,
): Readonly<Record<string, number>> {
  return Object.freeze({
    planMoveWeight: profile.planMoveWeight,
    weight: profile.heuristicWeight,
    costWeight: profile.costWeight,
    goalPackingWeight: profile.goalPackingWeight,
    mobilityWeight: profile.mobilityWeight,
    topologyWeight: profile.topologyWeight,
    evacuationWeight: profile.evacuationWeight,
    supportDependencyWeight: profile.supportDependencyWeight,
    localRoomWeight: profile.localRoomWeight,
    doorwayFlowWeight: profile.doorwayFlowWeight,
    relevanceWeight: profile.relevanceWeight,
    planBeamWidth: profile.planBeamWidth,
    planBoxBranches: profile.planBoxBranches,
    maxPlanSegments: profile.maxPlanSegments,
    planSlack: profile.planSlack,
    sequenceMacroLimit: profile.sequenceMacroLimit,
  });
}
