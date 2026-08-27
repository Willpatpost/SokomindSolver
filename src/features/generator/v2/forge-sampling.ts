import type { Difficulty } from "../../../core/model.ts";
import type { TopologyFamily } from "./blueprint-types.ts";
import { createRng } from "../board-template.ts";

export type ForgeGenerationMode = "plain" | "motif" | "composed" | "mechanism";

export interface ForgeCombination {
  readonly family: TopologyFamily;
  readonly boxCount: number;
  readonly mode: ForgeGenerationMode;
  readonly difficulty: Difficulty;
}

export interface ForgeScheduleEntry {
  readonly seed: number;
  readonly combination: ForgeCombination;
}

export function enumerateForgeCombinations(config: {
  readonly families: readonly TopologyFamily[];
  readonly boxCounts: readonly number[];
  readonly modes: readonly ForgeGenerationMode[];
  readonly difficulties: readonly Difficulty[];
}): readonly ForgeCombination[] {
  const result: ForgeCombination[] = [];
  for (const family of config.families) {
    for (const boxCount of config.boxCounts) {
      for (const mode of config.modes) {
        for (const difficulty of config.difficulties) {
          result.push({ family, boxCount, mode, difficulty });
        }
      }
    }
  }
  return result;
}

export function createForgeSchedule(
  combinations: readonly ForgeCombination[],
  batchSize: number,
  baseSeed: number,
): readonly ForgeScheduleEntry[] {
  if (combinations.length === 0) return [];

  const shuffled = [...combinations];
  const rng = createRng(baseSeed);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const schedule: ForgeScheduleEntry[] = [];
  for (let i = 0; i < batchSize; i++) {
    schedule.push({
      seed: baseSeed + i,
      combination: shuffled[i % shuffled.length],
    });
  }
  return schedule;
}
