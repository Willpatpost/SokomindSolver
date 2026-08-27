import type { CurationObjectives } from "./finalist-evaluator.ts";

export interface CuratedCandidate<T> {
  readonly item: T;
  readonly objectives: CurationObjectives;
  readonly front: number;
  readonly noveltyScore: number;
  readonly structuralFingerprint?: string;
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
  items: readonly { item: T; objectives: CurationObjectives }[],
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

export function selectWithDiversityQuotas<T extends { structuralFingerprint?: string }>(
  candidates: readonly CuratedCandidate<T>[],
  quota: number,
  quotas?: DiversityQuotas,
): CuratedCandidate<T>[] {
  if (!quotas || candidates.length <= quota) {
    return selectByParetoNovelty(candidates, quota);
  }

  const sorted = [...candidates].sort((a, b) => {
    if (a.front !== b.front) return a.front - b.front;
    return b.noveltyScore - a.noveltyScore;
  });

  const selected: CuratedCandidate<T>[] = [];
  const bucketCounts = new Map<string, number>();

  for (const c of sorted) {
    if (selected.length >= quota) break;

    const fp = c.structuralFingerprint ?? "";
    const parts = fp.split("|");
    const topology = parts[0] ?? "";
    const mode = parts[1] ?? "";
    const motif = parts[2] ?? "";
    const mechanism = parts[3] ?? "";

    let blocked = false;
    if (quotas.maxPerTopology !== undefined && topology) {
      const key = `topo:${topology}`;
      if ((bucketCounts.get(key) ?? 0) >= quotas.maxPerTopology) blocked = true;
    }
    if (quotas.maxPerMode !== undefined && mode) {
      const key = `mode:${mode}`;
      if ((bucketCounts.get(key) ?? 0) >= quotas.maxPerMode) blocked = true;
    }
    if (quotas.maxPerMotif !== undefined && motif && motif !== "none") {
      const key = `motif:${motif}`;
      if ((bucketCounts.get(key) ?? 0) >= quotas.maxPerMotif) blocked = true;
    }
    if (quotas.maxPerMechanism !== undefined && mechanism && mechanism !== "none") {
      const key = `mech:${mechanism}`;
      if ((bucketCounts.get(key) ?? 0) >= quotas.maxPerMechanism) blocked = true;
    }

    if (!blocked) {
      selected.push(c);
      if (topology) bucketCounts.set(`topo:${topology}`, (bucketCounts.get(`topo:${topology}`) ?? 0) + 1);
      if (mode) bucketCounts.set(`mode:${mode}`, (bucketCounts.get(`mode:${mode}`) ?? 0) + 1);
      if (motif && motif !== "none") bucketCounts.set(`motif:${motif}`, (bucketCounts.get(`motif:${motif}`) ?? 0) + 1);
      if (mechanism && mechanism !== "none") bucketCounts.set(`mech:${mechanism}`, (bucketCounts.get(`mech:${mechanism}`) ?? 0) + 1);
    }
  }

  if (selected.length < quota) {
    for (const c of sorted) {
      if (selected.length >= quota) break;
      if (selected.includes(c)) continue;
      selected.push(c);
    }
  }

  return selected;
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
