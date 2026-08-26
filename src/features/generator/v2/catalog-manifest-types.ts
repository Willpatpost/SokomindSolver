import type { Difficulty } from "../../../core/model.ts";
import type { TopologyFamily } from "./blueprint-types.ts";
import type { ForgeGenerationMode } from "./forge-sampling.ts";
import type { MotifType } from "./motifs.ts";

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
  readonly labeled: boolean;
  readonly dependencyEdges?: number;
  readonly dependencyRealized?: number;
  readonly dependencyRealizationRate?: number;
  readonly intendedDifficulty: Difficulty;
  readonly classifiedDifficulty: Difficulty;
  readonly difficultyGap: number;
  readonly solutionMoves: number;
  readonly solutionPushes: number;
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
