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

export interface CombinationRejectionRecord {
  readonly attempts: number;
  readonly rejections: number;
  readonly reasons: Readonly<Record<string, number>>;
}

export type RejectionHistory = ReadonlyMap<string, CombinationRejectionRecord>;

export function combinationKey(c: ForgeCombination): string {
  return `${c.family}:${c.boxCount}:${c.mode}`;
}

export function computeSamplingWeights(
  combinations: readonly ForgeCombination[],
  history: RejectionHistory,
  damping: number = 0.8,
  minWeight: number = 0.1,
): readonly number[] {
  return combinations.map((c) => {
    const record = history.get(combinationKey(c));
    if (!record || record.attempts === 0) return 1.0;
    const rejectionRate = record.rejections / record.attempts;
    return Math.max(minWeight, 1 - rejectionRate * damping);
  });
}

export function buildRejectionHistory(
  schedule: readonly ForgeScheduleEntry[],
  rejections: readonly { readonly seed: number; readonly reason: string }[],
): RejectionHistory {
  const attemptsByKey = new Map<string, { attempts: number; rejections: number; reasons: Record<string, number> }>();
  const seedToKey = new Map<number, string>();

  for (const entry of schedule) {
    const key = combinationKey(entry.combination);
    seedToKey.set(entry.seed, key);
    const rec = attemptsByKey.get(key);
    if (rec) rec.attempts++;
    else attemptsByKey.set(key, { attempts: 1, rejections: 0, reasons: {} });
  }

  for (const r of rejections) {
    const key = seedToKey.get(r.seed);
    if (!key) continue;
    const rec = attemptsByKey.get(key);
    if (!rec) continue;
    rec.rejections++;
    rec.reasons[r.reason] = (rec.reasons[r.reason] ?? 0) + 1;
  }

  return attemptsByKey as RejectionHistory;
}

export function mergeRejectionHistories(
  ...histories: readonly RejectionHistory[]
): RejectionHistory {
  const merged = new Map<string, { attempts: number; rejections: number; reasons: Record<string, number> }>();

  for (const history of histories) {
    for (const [key, record] of history) {
      const existing = merged.get(key);
      if (existing) {
        existing.attempts += record.attempts;
        existing.rejections += record.rejections;
        for (const [reason, count] of Object.entries(record.reasons)) {
          existing.reasons[reason] = (existing.reasons[reason] ?? 0) + count;
        }
      } else {
        merged.set(key, { attempts: record.attempts, rejections: record.rejections, reasons: { ...record.reasons } });
      }
    }
  }

  return merged as RejectionHistory;
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

export function createAdaptiveForgeSchedule(
  combinations: readonly ForgeCombination[],
  batchSize: number,
  baseSeed: number,
  history: RejectionHistory,
  damping?: number,
  minWeight?: number,
): readonly ForgeScheduleEntry[] {
  if (combinations.length === 0) return [];

  const weights = computeSamplingWeights(combinations, history, damping, minWeight);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) return createForgeSchedule(combinations, batchSize, baseSeed);

  const cumulative: number[] = [];
  let sum = 0;
  for (const w of weights) {
    sum += w / totalWeight;
    cumulative.push(sum);
  }

  const rng = createRng(baseSeed);
  const schedule: ForgeScheduleEntry[] = [];
  for (let i = 0; i < batchSize; i++) {
    const r = rng();
    let idx = 0;
    while (idx < cumulative.length - 1 && cumulative[idx] < r) idx++;
    schedule.push({ seed: baseSeed + i, combination: combinations[idx] });
  }
  return schedule;
}
