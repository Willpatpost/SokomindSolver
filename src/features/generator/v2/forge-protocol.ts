import type { ForgeConfig, BlueprintCandidate, RawGenerationResult, ReverseStart } from "./puzzle-forge.ts";
import type { ForgeScheduleEntry } from "./forge-sampling.ts";
import type { FinalistTaskPayload } from "./finalist-worker.ts";
import type { V4EvaluatorPolicy } from "./solver-bottleneck.ts";
import type { PuzzleDefinition } from "../../../core/model.ts";

export type ForgeTask =
  | { kind: "blueprint"; config: ForgeConfig; entry: ForgeScheduleEntry }
  | { kind: "reverse"; config: ForgeConfig; blueprint: BlueprintCandidate }
  | { kind: "complete"; config: ForgeConfig; blueprint: BlueprintCandidate; forcedReverseState?: ReverseStart; prepared?: RawGenerationResult }
  | { kind: "finalist"; policy: V4EvaluatorPolicy; payload: FinalistTaskPayload }
  | { kind: "evaluate"; puzzle: PuzzleDefinition };
