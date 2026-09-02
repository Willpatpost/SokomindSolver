import type { Difficulty } from "../../../core/model.ts";

export const STORY_QUALITY_POLICY_VERSION = "story-quality-1" as const;
export const STORY_QUALITY_FAMILIES = [
  "assignment-misdirection", "productive-reversal", "multi-room-journey", "ordered-packing",
  "gate-traffic", "shared-transport", "shared-support", "causal-dependency",
] as const;
export type StoryQualityFamily = typeof STORY_QUALITY_FAMILIES[number];

export interface StoryQualityPolicy {
  /** A basket of different features, not a requirement for every mechanism. */
  readonly minStoryFamilies: Readonly<Record<Difficulty, number>>;
}

export const DEFAULT_STORY_QUALITY_POLICY: StoryQualityPolicy = Object.freeze({
  minStoryFamilies: Object.freeze({ tutorial: 0, beginner: 1, intermediate: 2, advanced: 3, expert: 3, master: 4 }),
});

export type StoryQualityRejectionCode = "story-evidence-invalid" | "story-box-scale"
  | "story-mixed-typing" | "story-box-participation" | "story-isolated-boxes"
  | "story-cross-type-interaction" | "story-feature-variety" | "story-construction-unrealized"
  | "story-typing-unverified";

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
