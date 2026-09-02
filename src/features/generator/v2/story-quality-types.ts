import type { Difficulty } from "../../../core/model.ts";

export const STORY_QUALITY_POLICY_VERSION = "story-quality-1" as const;
export const STORY_QUALITY_FAMILIES = [
  "assignment-misdirection", "productive-reversal", "multi-room-journey", "ordered-packing",
  "gate-traffic", "shared-transport", "shared-support", "causal-dependency",
] as const;
export type StoryQualityFamily = typeof STORY_QUALITY_FAMILIES[number];

export type StoryFamilyGroup = "behavioral" | "structural" | "interaction";

export const STORY_FAMILY_GROUPS: Readonly<Record<StoryFamilyGroup, readonly StoryQualityFamily[]>> = Object.freeze({
  behavioral: Object.freeze(["productive-reversal", "assignment-misdirection"] as const),
  structural: Object.freeze(["ordered-packing", "gate-traffic", "multi-room-journey"] as const),
  interaction: Object.freeze(["shared-transport", "shared-support", "causal-dependency"] as const),
});

export const DEFAULT_FAMILY_WEIGHTS: Readonly<Record<StoryQualityFamily, number>> = Object.freeze({
  "productive-reversal": 3,
  "assignment-misdirection": 3,
  "ordered-packing": 2,
  "gate-traffic": 2,
  "multi-room-journey": 2,
  "shared-transport": 1,
  "shared-support": 1,
  "causal-dependency": 1,
});

export const DEFAULT_REQUIRED_FAMILY_PRESENCE: Readonly<Record<Difficulty, readonly StoryFamilyGroup[]>> = Object.freeze({
  tutorial: Object.freeze([]),
  beginner: Object.freeze([]),
  intermediate: Object.freeze([]),
  advanced: Object.freeze([]),
  expert: Object.freeze(["structural" as const]),
  master: Object.freeze(["behavioral" as const, "structural" as const]),
});

export interface StoryQualityPolicy {
  /** A basket of different features, not a requirement for every mechanism. */
  readonly minStoryFamilies: Readonly<Record<Difficulty, number>>;
  /** Per-family importance weights for soft quality scoring. */
  readonly familyWeights?: Readonly<Record<StoryQualityFamily, number>>;
  /** Per-tier required family group presence (hard gate). */
  readonly requiredFamilyPresence?: Readonly<Record<Difficulty, readonly StoryFamilyGroup[]>>;
}

export const DEFAULT_STORY_QUALITY_POLICY: StoryQualityPolicy = Object.freeze({
  minStoryFamilies: Object.freeze({ tutorial: 0, beginner: 1, intermediate: 2, advanced: 3, expert: 3, master: 4 }),
  familyWeights: DEFAULT_FAMILY_WEIGHTS,
  requiredFamilyPresence: DEFAULT_REQUIRED_FAMILY_PRESENCE,
});

export type StoryQualityRejectionCode = "story-evidence-invalid" | "story-box-scale"
  | "story-mixed-typing" | "story-box-participation" | "story-isolated-boxes"
  | "story-cross-type-interaction" | "story-feature-variety" | "story-family-progression"
  | "story-construction-unrealized" | "story-typing-unverified";

export interface StoryBoxParticipation {
  readonly boxId: number;
  readonly kind: "generic" | "typed";
  readonly pushes: number;
  readonly distinctCells: number;
  readonly interactionPartners: readonly number[];
}

export interface StoryQualityMeasurements {
  readonly boardHash: string;
  readonly evidenceValid: boolean;
  readonly boxCount: number;
  readonly genericBoxCount: number;
  readonly typedBoxCount: number;
  readonly boxes: readonly StoryBoxParticipation[];
  readonly crossTypePairs: readonly (readonly [number, number])[];
  readonly families: readonly StoryQualityFamily[];
  readonly constructionRequired: boolean;
  readonly constructionVerified: boolean;
  readonly constructionTargets: number;
  readonly constructionRealized: number;
  readonly missingConstructionTargets: readonly string[];
  readonly typingVerified: boolean;
}

export interface StoryQualityViolation {
  readonly code: StoryQualityRejectionCode;
  readonly message: string;
  readonly boxIds?: readonly number[];
}

export interface StoryQualityReport {
  readonly policyVersion: typeof STORY_QUALITY_POLICY_VERSION;
  readonly tier: Difficulty;
  readonly requiredStoryFamilies: number;
  readonly measurements: StoryQualityMeasurements;
  readonly passed: boolean;
  readonly violations: readonly StoryQualityViolation[];
  /** Weighted family score normalized to [0, 1]; soft preference for diversity ranking. */
  readonly familyQualityScore: number;
  /** Confirmed findings and uncertainty are never prerequisites for acceptance. */
  readonly counterfactual: {
    readonly available: boolean;
    readonly necessary: number;
    readonly optional: number;
    readonly recoverable: number;
    readonly delayedFalseStarts: number;
    readonly unknown: number;
    readonly omitted: number;
  };
}
