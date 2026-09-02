import type { CurationObjectives } from "./finalist-evaluator.ts";
import { storyDiversityDistance, type StoryDiversityProfile } from "./story-diversity.ts";

export interface CuratedCandidate<T> {
  readonly item: T;
  readonly objectives: CurationObjectives;
  readonly front: number;
  readonly noveltyScore: number;
  readonly structuralFingerprint?: string;
  readonly storyDiversity?: StoryDiversityProfile;
}

export interface DiversityQuotas {
  readonly maxPerTopology?: number;
  readonly maxPerMode?: number;
  readonly maxPerMechanism?: number;
  readonly maxPerMotif?: number;
}

export interface NormalizationContext {
  readonly ranges: Readonly<Record<keyof CurationObjectives, { min: number; range: number }>>;
}

function dominates(a: CurationObjectives, b: CurationObjectives): boolean {
  const keys: (keyof CurationObjectives)[] = [
    "interaction",
    "dependency",
    "decisionQuality",
    "structuralRichness",
    "solverChallenge",
    "novelty",
  ];
  let strictlyBetter = false;
  for (const key of keys) {
    if (a[key] < b[key]) return false;
    if (a[key] > b[key]) strictlyBetter = true;
  }
  if (a.tedium > b.tedium) return false;
  if (a.tedium < b.tedium) strictlyBetter = true;
  return strictlyBetter;
}

export function nonDominatedSort<T>(
  items: readonly { item: T; objectives: CurationObjectives; structuralFingerprint?: string; storyDiversity?: StoryDiversityProfile }[],
): CuratedCandidate<T>[] {
  const n = items.length;
  const assigned = new Array<number>(n).fill(-1);
  const remaining = new Set(Array.from({ length: n }, (_, i) => i));
  let front = 0;

  while (remaining.size > 0) {
    const currentFront: number[] = [];
    const indices = [...remaining];

    for (const i of indices) {
      let isDominated = false;
      for (const j of indices) {
        if (i === j) continue;
        if (dominates(items[j].objectives, items[i].objectives)) {
          isDominated = true;
          break;
        }
      }
      if (!isDominated) {
        currentFront.push(i);
      }
    }

    if (currentFront.length === 0) {
      for (const i of remaining) {
        assigned[i] = front;
      }
      break;
    }

    for (const i of currentFront) {
      assigned[i] = front;
      remaining.delete(i);
    }
    front++;
  }

  return items.map((entry, i) => ({
    item: entry.item,
    objectives: entry.objectives,
    front: assigned[i],
    noveltyScore: 0,
    structuralFingerprint: entry.structuralFingerprint,
    storyDiversity: entry.storyDiversity,
  }));
}

export function buildNormalizationContext(
  objectives: readonly CurationObjectives[],
): NormalizationContext {
  const keys: (keyof CurationObjectives)[] = [
    "interaction", "dependency", "decisionQuality",
    "structuralRichness", "solverChallenge", "novelty", "tedium",
  ];
  const ranges = {} as Record<keyof CurationObjectives, { min: number; range: number }>;
  for (const key of keys) {
    const values = objectives.map((o) => o[key]);
    const min = values.length > 0 ? Math.min(...values) : 0;
    const max = values.length > 0 ? Math.max(...values) : 0;
    ranges[key] = { min, range: max - min || 1 };
  }
  return { ranges };
}

function normalizedObjectiveDistance(
  a: CurationObjectives,
  b: CurationObjectives,
  ctx?: NormalizationContext,
): number {
  if (!ctx) return objectiveDistanceRaw(a, b);

  const r = ctx.ranges;
  let d = 0;
  d += ((a.interaction - b.interaction) / r.interaction.range) ** 2;
  d += ((a.dependency - b.dependency) / r.dependency.range) ** 2;
  d += ((a.decisionQuality - b.decisionQuality) / r.decisionQuality.range) ** 2;
  d += ((a.structuralRichness - b.structuralRichness) / r.structuralRichness.range) ** 2;
  d += ((a.solverChallenge - b.solverChallenge) / r.solverChallenge.range) ** 2;
  d += ((a.tedium - b.tedium) / r.tedium.range) ** 2;
  return Math.sqrt(d);
}

function objectiveDistanceRaw(a: CurationObjectives, b: CurationObjectives): number {
  let d = 0;
  d += (a.interaction - b.interaction) ** 2;
  d += (a.dependency - b.dependency) ** 2;
  d += (a.decisionQuality - b.decisionQuality) ** 2;
  d += (a.structuralRichness - b.structuralRichness) ** 2;
  d += (a.solverChallenge - b.solverChallenge) ** 2;
  d += (a.tedium - b.tedium) ** 2;
  return Math.sqrt(d);
}

export function computeNoveltyScores<T>(
  candidates: readonly CuratedCandidate<T>[],
  k: number = 3,
  normCtx?: NormalizationContext,
): CuratedCandidate<T>[] {
  const ctx = normCtx ?? buildNormalizationContext(candidates.map((c) => c.objectives));

  return candidates.map((c, i) => {
    const distances: number[] = [];
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      let dist = normalizedObjectiveDistance(c.objectives, candidates[j].objectives, ctx);
      if (c.structuralFingerprint && candidates[j].structuralFingerprint &&
          c.structuralFingerprint !== candidates[j].structuralFingerprint) {
        dist += 0.5;
      }
      if (c.storyDiversity && candidates[j].storyDiversity) {
        dist += storyDiversityDistance(c.storyDiversity, candidates[j].storyDiversity!);
      }
      distances.push(dist);
    }
    distances.sort((a, b) => a - b);
    const kNearest = distances.slice(0, Math.min(k, distances.length));
    const noveltyScore = kNearest.length > 0
      ? kNearest.reduce((s, v) => s + v, 0) / kNearest.length
      : 0;
    return { ...c, noveltyScore };
  });
}

export function selectByParetoNovelty<T>(
  candidates: readonly CuratedCandidate<T>[],
  quota: number,
): CuratedCandidate<T>[] {
  if (candidates.length <= quota) return [...candidates];

  const maxFront = Math.max(...candidates.map((c) => c.front));
  const selected: CuratedCandidate<T>[] = [];

  for (let f = 0; f <= maxFront && selected.length < quota; f++) {
    const frontCandidates = candidates
      .filter((c) => c.front === f)
      .sort((a, b) => b.noveltyScore - a.noveltyScore);

    for (const c of frontCandidates) {
      if (selected.length >= quota) break;
      selected.push(c);
    }
  }

  return selected;
}

export function selectWithDiversityQuotas<T>(
  candidates: readonly CuratedCandidate<T>[],
  quota: number,
  quotas?: DiversityQuotas,
): CuratedCandidate<T>[] {
  if (!quotas) {
    return selectByParetoNovelty(candidates, quota);
  }

  const sorted = [...candidates].sort((a, b) => {
    if (a.front !== b.front) return a.front - b.front;
    return b.noveltyScore - a.noveltyScore;
  });

  const selected: CuratedCandidate<T>[] = [];

  for (const c of sorted) {
    if (selected.length >= quota) break;
    if (diversityQuotaAllows(c, selected, quotas)) selected.push(c);
  }

  return selected;
}

/** Apply metadata caps to the actual selected set, not an earlier preselection. */
export function diversityQuotaAllows(
  candidate: { readonly structuralFingerprint?: string },
  selected: readonly { readonly structuralFingerprint?: string }[],
  quotas?: DiversityQuotas,
): boolean {
  if (!quotas) return true;
  const parts = (candidate.structuralFingerprint ?? "").split("|");
  const fields = ["maxPerTopology", "maxPerMode", "maxPerMotif", "maxPerMechanism"] as const;
  for (let i = 0; i < fields.length; i++) {
    const limit = quotas[fields[i]];
    if (limit === undefined) continue;
    if (!Number.isInteger(limit) || limit < 0) throw new Error("Diversity quotas must be non-negative integers");
    const keys = i === 3 ? (parts[i] ?? "").split("+") : [parts[i]];
    for (const key of keys) {
      if (!key || key === "none") continue;
      const count = selected.filter((entry) => {
        const other = (entry.structuralFingerprint ?? "").split("|")[i] ?? "";
        return i === 3 ? other.split("+").includes(key) : other === key;
      }).length;
      if (count >= limit) return false;
    }
  }
  return true;
}

export interface PopulationDiagnostics {
  readonly totalCandidates: number;
  readonly frontCount: number;
  readonly frontSizes: readonly number[];
  readonly objectiveRanges: Readonly<
    Record<keyof CurationObjectives, { min: number; max: number; avg: number }>
  >;
  readonly noveltyRange: { min: number; max: number; avg: number };
}

export function diagnosePopulation<T>(
  candidates: readonly CuratedCandidate<T>[],
): PopulationDiagnostics {
  const n = candidates.length;
  if (n === 0) {
    const zero = { min: 0, max: 0, avg: 0 };
    return {
      totalCandidates: 0,
      frontCount: 0,
      frontSizes: [],
      objectiveRanges: {
        interaction: zero,
        dependency: zero,
        decisionQuality: zero,
        structuralRichness: zero,
        solverChallenge: zero,
        novelty: zero,
        tedium: zero,
      },
      noveltyRange: zero,
    };
  }

  const maxFront = Math.max(...candidates.map((c) => c.front));
  const frontSizes: number[] = [];
  for (let f = 0; f <= maxFront; f++) {
    frontSizes.push(candidates.filter((c) => c.front === f).length);
  }

  const keys: (keyof CurationObjectives)[] = [
    "interaction",
    "dependency",
    "decisionQuality",
    "structuralRichness",
    "solverChallenge",
    "novelty",
    "tedium",
  ];

  const objectiveRanges = {} as Record<
    keyof CurationObjectives,
    { min: number; max: number; avg: number }
  >;
  for (const key of keys) {
    const values = candidates.map((c) => c.objectives[key]);
    objectiveRanges[key] = {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((s, v) => s + v, 0) / n,
    };
  }

  const noveltyValues = candidates.map((c) => c.noveltyScore);
  const noveltyRange = {
    min: Math.min(...noveltyValues),
    max: Math.max(...noveltyValues),
    avg: noveltyValues.reduce((s, v) => s + v, 0) / n,
  };

  return {
    totalCandidates: n,
    frontCount: maxFront + 1,
    frontSizes,
    objectiveRanges,
    noveltyRange,
  };
}
