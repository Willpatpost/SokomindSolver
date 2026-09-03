import { boardHash, canonicalizeRows } from "./puzzle-identity.ts";
import { isBoxChar, isGoalChar, isWallChar } from "./tile-semantics.ts";
import { STORY_QUALITY_FAMILIES, type StoryQualityFamily, type StoryQualityReport } from "./story-quality-types.ts";
import type { PassiveStorySummary } from "./passive-story-analysis.ts";

export const STORY_DIVERSITY_VERSION = "story-diversity-1" as const;

export interface StoryDiversityProfile {
  readonly version: typeof STORY_DIVERSITY_VERSION;
  readonly boardHash: string;
  /** All eight rotations/reflections, ignoring labels, classes and keeper position. */
  readonly layoutKey: string;
  /** Wall/floor silhouette, ignoring all occupants and goals. */
  readonly visualKey: string;
  readonly families: readonly StoryQualityFamily[];
  readonly pacing: "unmeasured" | "linear" | "revisited" | "interleaved";
  readonly interaction: "localized" | "woven";
  readonly storySignature: string;
}

export interface StoryDiversityPolicy {
  readonly maxStoryShare: number;
  readonly maxVisualShare: number;
  /** False preserves diversity limits even when the catalog remains underfilled. */
  readonly allowBackfill?: boolean;
}

export const DEFAULT_STORY_DIVERSITY_POLICY: StoryDiversityPolicy = Object.freeze({
  maxStoryShare: 0.35,
  maxVisualShare: 0.20,
});

export const STRICT_STORY_DIVERSITY_POLICY: StoryDiversityPolicy = Object.freeze({
  ...DEFAULT_STORY_DIVERSITY_POLICY, allowBackfill: false,
});

/** Use canonical strings, not short hashes, for clone decisions. */
export function storyLayoutKeys(rows: readonly string[]): { layoutKey: string; visualKey: string } {
  const normalized = rows.map((row) => [...row].map((tile) =>
    isWallChar(tile) ? "O" : isBoxChar(tile) ? "X" : isGoalChar(tile) ? "S" : " ",
  ).join(""));
  const canonical = (source: readonly string[]): string => {
    let rotated = [...canonicalizeRows(source)];
    const variants: string[] = [];
    for (let i = 0; i < 4; i++) {
      variants.push(rotated.join("\n"), rotated.map((row) => [...row].reverse().join("")).join("\n"));
      rotated = Array.from({ length: rotated[0]?.length ?? 0 }, (_, column) =>
        [...rotated].reverse().map((row) => row[column]).join(""));
    }
    return variants.sort()[0] ?? "";
  };
  return {
    layoutKey: canonical(normalized),
    visualKey: canonical(normalized.map((row) => row.replace(/[XS]/gu, " "))),
  };
}

/** No move counts, labels, solver runtime or counterfactual budgets enter identity. */
export function buildStoryDiversityProfile(
  rows: readonly string[],
  quality: StoryQualityReport | undefined,
  story?: PassiveStorySummary,
): StoryDiversityProfile | undefined {
  const hash = boardHash(rows);
  if (!quality?.passed || !quality.measurements.evidenceValid || quality.measurements.boardHash !== hash) return undefined;
  const families = STORY_QUALITY_FAMILIES.filter((family) => quality.measurements.families.includes(family));
  const revisitRatio = story && story.solutionPhases > 0 ? story.revisitedPhases / story.solutionPhases : 0;
  const pacing = !story ? "unmeasured" : revisitRatio === 0 ? "linear" : revisitRatio < 0.4 ? "revisited" : "interleaved";
  const partnerCount = quality.measurements.boxes.reduce((sum, box) => sum + box.interactionPartners.length, 0);
  const interaction = partnerCount > quality.measurements.boxCount * 2 ? "woven" : "localized";
  return {
    version: STORY_DIVERSITY_VERSION, boardHash: hash, ...storyLayoutKeys(rows), families, pacing, interaction,
    storySignature: `${families.join("+")}|${pacing}|${interaction}`,
  };
}

export function storyDiversityDistance(a: StoryDiversityProfile, b: StoryDiversityProfile): number {
  if (a.layoutKey === b.layoutKey) return 0;
  const union = new Set([...a.families, ...b.families]);
  const shared = a.families.filter((family) => b.families.includes(family)).length;
  const familyDistance = union.size === 0 ? 0 : 1 - shared / union.size;
  return 0.6 * familyDistance + (a.pacing === b.pacing ? 0 : 0.15) +
    (a.interaction === b.interaction ? 0 : 0.1) + (a.visualKey === b.visualKey ? 0 : 0.15);
}

export interface StorySelectionEntry<T> {
  readonly item: T;
  readonly id: string;
  readonly profile?: StoryDiversityProfile;
  /** Earlier qualified Pareto fronts/ranks win novelty ties. */
  readonly rank: number;
}

export type StorySelectionReason = "selected" | "missing-story-evidence" | "layout-clone" |
  "story-cap" | "visual-cap" | "metadata-cap" | "quota";

export interface StorySelectionDecision {
  readonly id: string;
  readonly reason: StorySelectionReason;
  readonly relatedId?: string;
}

export interface StorySelectionReport {
  readonly version: typeof STORY_DIVERSITY_VERSION;
  readonly target: number;
  readonly considered: number;
  readonly selected: number;
  readonly shortfall: number;
  readonly storyLimit: number;
  readonly visualLimit: number;
  readonly decisions: readonly StorySelectionDecision[];
}

export function storyDiversityLimits(target: number, policy = DEFAULT_STORY_DIVERSITY_POLICY): {
  storyLimit: number; visualLimit: number;
} {
  if (!Number.isInteger(target) || target < 0) throw new Error("Catalog target must be a non-negative integer");
  for (const value of [policy.maxStoryShare, policy.maxVisualShare]) {
    if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error("Diversity shares must be in (0, 1]");
  }
  return {
    storyLimit: Math.max(1, Math.ceil(target * policy.maxStoryShare)),
    visualLimit: Math.max(1, Math.ceil(target * policy.maxVisualShare)),
  };
}

/** Greedy coverage + farthest-first selection among already qualified puzzles.
 * When the strict pass leaves a shortfall, a backfill pass relaxes story and
 * visual caps (but not layout-clone exclusions) to prefer filling the target
 * over discarding qualified candidates.
 */
export function selectStoryDiverse<T>(
  entries: readonly StorySelectionEntry<T>[], target: number,
  policy = DEFAULT_STORY_DIVERSITY_POLICY,
  additionalAllowance?: (entry: StorySelectionEntry<T>, selected: readonly StorySelectionEntry<T>[]) => boolean,
): { selected: readonly StorySelectionEntry<T>[]; report: StorySelectionReport } {
  const limits = storyDiversityLimits(target, policy);
  const pending = [...entries].sort((a, b) => a.rank - b.rank || compareText(a.id, b.id));
  const selected: StorySelectionEntry<T>[] = [];
  const decisions: StorySelectionDecision[] = [];
  const stories = new Map<string, number>();
  const visuals = new Map<string, number>();
  const layouts = new Map<string, string>();
  const covered = new Set<StoryQualityFamily>();
  const softCapped: StorySelectionEntry<T>[] = [];
  const blocked = (entry: StorySelectionEntry<T>): StorySelectionDecision | undefined => {
    const p = entry.profile;
    if (!p) return { id: entry.id, reason: "missing-story-evidence" };
    const relatedId = layouts.get(p.layoutKey);
    if (relatedId !== undefined) return { id: entry.id, reason: "layout-clone", relatedId };
    if ((stories.get(p.storySignature) ?? 0) >= limits.storyLimit) return { id: entry.id, reason: "story-cap" };
    if ((visuals.get(p.visualKey) ?? 0) >= limits.visualLimit) return { id: entry.id, reason: "visual-cap" };
    if (additionalAllowance && !additionalAllowance(entry, selected)) return { id: entry.id, reason: "metadata-cap" };
    return undefined;
  };
  const selectEntry = (entry: StorySelectionEntry<T>) => {
    const p = entry.profile!;
    selected.push(entry);
    decisions.push({ id: entry.id, reason: "selected" });
    layouts.set(p.layoutKey, entry.id);
    stories.set(p.storySignature, (stories.get(p.storySignature) ?? 0) + 1);
    visuals.set(p.visualKey, (visuals.get(p.visualKey) ?? 0) + 1);
    p.families.forEach((family) => covered.add(family));
  };
  while (pending.length > 0) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const reason = blocked(pending[i]);
      if (reason) {
        if (reason.reason === "story-cap" || reason.reason === "visual-cap") {
          softCapped.push(pending[i]);
        }
        decisions.push(reason);
        pending.splice(i, 1);
      }
    }
    if (pending.length === 0 || selected.length >= target) break;
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i].profile!;
      const coverage = p.families.filter((family) => !covered.has(family)).length / STORY_QUALITY_FAMILIES.length;
      const distance = selected.length === 0 ? 0 : Math.min(...selected.map((s) => storyDiversityDistance(p, s.profile!)));
      const score = selected.length === 0 ? 0 : coverage + distance;
      if (score > bestScore) { bestIndex = i; bestScore = score; }
    }
    const [entry] = pending.splice(bestIndex, 1);
    selectEntry(entry);
  }
  // Backfill: when the strict pass left a shortfall, relax story/visual caps
  // but keep layout-clone exclusions. Prefer candidates with the most novel
  // families among the soft-capped pool.
  if (policy.allowBackfill !== false && selected.length < target && softCapped.length > 0) {
    const selectedIds = new Set(selected.map((entry) => entry.id));
    const backfill = softCapped
      .filter((entry) => !selectedIds.has(entry.id) && !layouts.has(entry.profile!.layoutKey))
      .sort((a, b) => a.rank - b.rank || compareText(a.id, b.id));
    for (const entry of backfill) {
      if (selected.length >= target) break;
      if (layouts.has(entry.profile!.layoutKey)) continue;
      const decisionIndex = decisions.findIndex((d) => d.id === entry.id &&
        (d.reason === "story-cap" || d.reason === "visual-cap"));
      if (decisionIndex >= 0) decisions.splice(decisionIndex, 1);
      selectEntry(entry);
    }
  }
  pending.forEach((entry) => decisions.push({ id: entry.id, reason: "quota" }));
  decisions.sort((a, b) => compareText(a.id, b.id));
  return { selected, report: { version: STORY_DIVERSITY_VERSION, target, considered: entries.length,
    selected: selected.length, shortfall: Math.max(0, target - selected.length), ...limits, decisions } };
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export interface StoryDiversityNeighbor {
  readonly id: string;
  readonly distance: number;
  readonly reasons: readonly string[];
}

export interface StoryCatalogDiversity {
  readonly version: typeof STORY_DIVERSITY_VERSION;
  readonly measured: number;
  readonly missingEvidenceIds: readonly string[];
  readonly familyCounts: Readonly<Record<string, number>>;
  readonly storyCounts: Readonly<Record<string, number>>;
  readonly visualCounts: Readonly<Record<string, number>>;
  readonly pacingCounts: Readonly<Record<string, number>>;
  readonly storyConcentration: number;
  readonly visualConcentration: number;
  readonly missingFamilies: readonly StoryQualityFamily[];
  readonly cloneGroups: readonly (readonly string[])[];
  readonly nearestNeighbors: Readonly<Record<string, readonly StoryDiversityNeighbor[]>>;
}

export function summarizeStoryDiversity(
  entries: readonly { readonly id: string; readonly profile?: StoryDiversityProfile }[],
): StoryCatalogDiversity {
  const measured = entries.filter((entry): entry is { id: string; profile: StoryDiversityProfile } => !!entry.profile)
    .sort((a, b) => compareText(a.id, b.id));
  const families = new Map<string, number>(STORY_QUALITY_FAMILIES.map((family) => [family, 0]));
  const stories = new Map<string, number>();
  const visuals = new Map<string, number>();
  const pacing = new Map<string, number>();
  const layouts = new Map<string, string[]>();
  const nearest = new Map<string, readonly StoryDiversityNeighbor[]>();
  const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const entry of measured) {
    const p = entry.profile;
    p.families.forEach((family) => increment(families, family));
    increment(stories, p.storySignature);
    increment(visuals, p.visualKey);
    increment(pacing, p.pacing);
    layouts.set(p.layoutKey, [...(layouts.get(p.layoutKey) ?? []), entry.id]);
    nearest.set(entry.id, measured.filter((other) => other.id !== entry.id).map((other) => ({
      id: other.id, distance: storyDiversityDistance(p, other.profile),
      reasons: [
        ...(p.layoutKey === other.profile.layoutKey ? ["same layout after rotations/reflections and label removal"] : []),
        ...(p.visualKey === other.profile.visualKey ? ["same wall/floor silhouette"] : []),
        ...(p.storySignature === other.profile.storySignature ? ["same story basket and pacing"] : []),
        ...p.families.filter((family) => other.profile.families.includes(family)).map((family) => `shared ${family}`),
      ],
    })).sort((a, b) => a.distance - b.distance || compareText(a.id, b.id)).slice(0, 3));
  }
  return {
    version: STORY_DIVERSITY_VERSION, measured: measured.length,
    missingEvidenceIds: entries.filter((entry) => !entry.profile).map((entry) => entry.id).sort(),
    familyCounts: Object.fromEntries(families), storyCounts: Object.fromEntries(stories),
    visualCounts: Object.fromEntries(visuals), pacingCounts: Object.fromEntries(pacing),
    storyConcentration: measured.length ? Math.max(...stories.values()) / measured.length : 0,
    visualConcentration: measured.length ? Math.max(...visuals.values()) / measured.length : 0,
    missingFamilies: STORY_QUALITY_FAMILIES.filter((family) => !families.get(family)),
    cloneGroups: [...layouts.values()].filter((ids) => ids.length > 1),
    nearestNeighbors: Object.fromEntries(nearest),
  };
}

export function formatStorySelection(report: StorySelectionReport): string {
  const counts = new Map<string, number>();
  for (const decision of report.decisions) counts.set(decision.reason, (counts.get(decision.reason) ?? 0) + 1);
  return `Story curation: ${report.selected}/${report.target} selected from ${report.considered}; ` +
    `shortfall ${report.shortfall}; caps story=${report.storyLimit}, visual=${report.visualLimit}. ` +
    [...counts].map(([reason, count]) => `${reason}=${count}`).join(", ");
}

/** Rebuild serialized identity; never trust a supplied fingerprint or pass flag. */
export function checkStoryDiversityForRelease(
  profile: unknown, rows: unknown, quality: StoryQualityReport, story: unknown,
): readonly string[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every((row) => typeof row === "string")) {
    return ["missing exact review rows for diversity verification"];
  }
  if (story !== undefined) {
    const metrics = ["assignmentMisdirections", "reversalEpisodes", "multiRoomJourneys", "orderedPackingPairs",
      "gateTransitions", "gateReopenings", "crossTypeDependencies", "crossTypeSwitches", "solutionPhases",
      "revisitedPhases", "usedZones", "crossZonePushes"];
    if (!isRecord(story) || typeof story.traversalSignature !== "string" || metrics.some((key) =>
      !Number.isInteger(story[key]) || (story[key] as number) < 0) ||
      (story.revisitedPhases as number) > (story.solutionPhases as number)) {
      return ["malformed passive story summary for diversity verification"];
    }
  }
  const expected = buildStoryDiversityProfile(rows, quality, story as PassiveStorySummary | undefined);
  if (!expected) return ["review rows and quality evidence do not match"];
  if (!isRecord(profile)) return ["missing story diversity profile; regenerate review evidence"];
  const fields = ["version", "boardHash", "layoutKey", "visualKey", "pacing", "interaction", "storySignature"] as const;
  if (fields.some((key) => profile[key] !== expected[key]) ||
    !Array.isArray(profile.families) || profile.families.length !== expected.families.length ||
    profile.families.some((family, i) => family !== expected.families[i])) {
    return ["stale or inconsistent story diversity profile"];
  }
  return [];
}
