import type { Difficulty, PuzzleDefinition } from "../../core/model.ts";

export interface GeneratorParams {
  readonly width: number;
  readonly height: number;
  readonly boxCount: number;
  readonly targetDifficulty: Difficulty;
  readonly useLabels: boolean;
  readonly maxAttempts: number;
}

export const DEFAULT_GENERATOR_PARAMS: GeneratorParams = {
  width: 7,
  height: 7,
  boxCount: 2,
  targetDifficulty: "beginner",
  useLabels: false,
  maxAttempts: 50,
};

export const DIFFICULTY_PRESETS: Record<
  Difficulty,
  Pick<GeneratorParams, "width" | "height" | "boxCount">
> = {
  tutorial: { width: 5, height: 5, boxCount: 1 },
  beginner: { width: 6, height: 6, boxCount: 2 },
  intermediate: { width: 8, height: 8, boxCount: 3 },
  advanced: { width: 9, height: 9, boxCount: 5 },
  expert: { width: 11, height: 11, boxCount: 6 },
  master: { width: 12, height: 12, boxCount: 8 },
};

export const PULL_COUNTS: Record<Difficulty, { min: number; max: number }> = {
  tutorial: { min: 3, max: 8 },
  beginner: { min: 8, max: 20 },
  intermediate: { min: 20, max: 50 },
  advanced: { min: 40, max: 100 },
  expert: { min: 80, max: 200 },
  master: { min: 150, max: 350 },
};

export interface GridPosition {
  readonly row: number;
  readonly column: number;
}

export interface SolvedTemplate {
  readonly width: number;
  readonly height: number;
  readonly grid: readonly (readonly string[])[];
  readonly goalPositions: readonly GridPosition[];
  readonly robotPosition: GridPosition;
}

export interface ScrambledState {
  readonly template: SolvedTemplate;
  readonly boxPositions: readonly GridPosition[];
  readonly robotPosition: GridPosition;
  readonly reversePulls: number;
}

export type GenerationResult =
  | {
      readonly status: "success";
      readonly puzzle: PuzzleDefinition;
      readonly attempts: number;
      readonly solverMoves: number;
      readonly solverPushes: number;
    }
  | {
      readonly status: "failed";
      readonly attempts: number;
      readonly lastReason: string;
    };

export interface GeneratorProgress {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly phase: "generating" | "solving" | "classifying";
  readonly message: string;
}

export type GeneratorProgressCallback = (
  progress: GeneratorProgress,
) => void;

export interface ClassificationResult {
  readonly difficulty: Difficulty;
  readonly moves: number;
  readonly pushes: number;
  readonly expandedStates: number;
  readonly elapsedMs: number;
}
