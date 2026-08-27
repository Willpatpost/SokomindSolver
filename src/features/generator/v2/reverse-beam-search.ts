import { enumerateReversePulls } from "../reverse-play.ts";
import type { GridPosition, SolvedTemplate } from "../generator-types.ts";
import type { SolvedBlueprint, ReverseSearchProfile } from "./blueprint-types.ts";
import { DEFAULT_SEARCH_PROFILE } from "./blueprint-types.ts";
import {
  buildScoringContext,
  scoreState,
  stateFingerprint,
  reverseStateKey,
  historyComplexityBonus,
  DEFAULT_WEIGHTS,
  type ReverseStateScore,
  type ScoringWeights,
  type PullHistoryEntry,
} from "./reverse-scoring.ts";
import { toSolvedTemplate } from "./goal-placement.ts";
import { createRng } from "../board-template.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BeamSearchParams {
  readonly seed: number;
  readonly beamWidth: number;
  readonly maxDepth: number;
  readonly diversityRadius: number;
  readonly weights: ScoringWeights;
}

export const DEFAULT_BEAM_PARAMS: BeamSearchParams = {
  seed: 0,
  beamWidth: 8,
  maxDepth: 60,
  diversityRadius: 2,
  weights: DEFAULT_WEIGHTS,
};

export interface BeamCandidate {
  readonly boxPositions: readonly GridPosition[];
  readonly robotPosition: GridPosition;
  readonly score: ReverseStateScore;
  readonly depth: number;
  readonly pullHistory: readonly PullRecord[];
}

export interface PullRecord {
  readonly boxIndex: number;
  readonly from: GridPosition;
  readonly to: GridPosition;
  readonly robotFrom: GridPosition;
  readonly robotTo: GridPosition;
}

export interface BeamSearchResult {
  readonly best: BeamCandidate;
  readonly candidates: readonly BeamCandidate[];
  readonly totalExpanded: number;
  readonly maxDepthReached: number;
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Beam search
// ---------------------------------------------------------------------------

export function reverseBeamSearch(
  solved: SolvedBlueprint,
  params: BeamSearchParams = DEFAULT_BEAM_PARAMS,
): BeamSearchResult {
  const start = performance.now();
  const template = toSolvedTemplate(solved);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  const initialBoxes: GridPosition[] = template.goalPositions.map((g) => ({
    row: g.row,
    column: g.column,
  }));

  const initialScore = scoreState(ctx, initialBoxes, template.robotPosition, params.weights);

  let beam: BeamCandidate[] = [
    {
      boxPositions: initialBoxes,
      robotPosition: template.robotPosition,
      score: initialScore,
      depth: 0,
      pullHistory: [],
    },
  ];

  let totalExpanded = 0;
  let maxDepthReached = 0;
  let bestEver: BeamCandidate = beam[0];

  for (let depth = 0; depth < params.maxDepth; depth++) {
    const nextCandidates: BeamCandidate[] = [];

    for (const candidate of beam) {
      const pulls = enumerateReversePulls(
        template.grid,
        candidate.boxPositions,
        candidate.robotPosition,
      );
      totalExpanded++;

      if (pulls.length === 0) continue;

      for (const pull of pulls) {
        const newBoxes = candidate.boxPositions.map((b, i) =>
          i === pull.boxIndex ? pull.newBoxPosition : b,
        );

        const record: PullRecord = {
          boxIndex: pull.boxIndex,
          from: candidate.boxPositions[pull.boxIndex],
          to: pull.newBoxPosition,
          robotFrom: candidate.robotPosition,
          robotTo: pull.newRobotPosition,
        };

        const newScore = scoreState(ctx, newBoxes, pull.newRobotPosition, params.weights);

        nextCandidates.push({
          boxPositions: newBoxes,
          robotPosition: pull.newRobotPosition,
          score: newScore,
          depth: depth + 1,
          pullHistory: [...candidate.pullHistory, record],
        });
      }
    }

    if (nextCandidates.length === 0) break;

    beam = selectDiverseBeam(
      nextCandidates,
      params.beamWidth,
      params.diversityRadius,
    );

    for (const c of beam) {
      if (c.score.composite > bestEver.score.composite) {
        bestEver = c;
      }
      if (c.depth > maxDepthReached) {
        maxDepthReached = c.depth;
      }
    }
  }

  const elapsed = performance.now() - start;

  const allCandidates = [...beam];
  if (!allCandidates.some((c) => c === bestEver)) {
    allCandidates.push(bestEver);
  }
  allCandidates.sort((a, b) => b.score.composite - a.score.composite);

  return {
    best: bestEver,
    candidates: allCandidates.slice(0, params.beamWidth),
    totalExpanded,
    maxDepthReached,
    elapsedMs: elapsed,
  };
}

// ---------------------------------------------------------------------------
// Diversity-aware beam selection
// ---------------------------------------------------------------------------

function selectDiverseBeam(
  candidates: BeamCandidate[],
  beamWidth: number,
  diversityRadius: number,
): BeamCandidate[] {
  candidates.sort((a, b) => b.score.composite - a.score.composite);

  const selected: BeamCandidate[] = [];
  const fingerprints = new Set<string>();

  for (const c of candidates) {
    if (selected.length >= beamWidth) break;

    const fp = stateFingerprint(c.boxPositions);
    if (fingerprints.has(fp)) continue;

    if (diversityRadius > 0 && isTooSimilar(c, selected, diversityRadius)) {
      continue;
    }

    selected.push(c);
    fingerprints.add(fp);
  }

  if (selected.length < beamWidth) {
    for (const c of candidates) {
      if (selected.length >= beamWidth) break;
      const fp = stateFingerprint(c.boxPositions);
      if (fingerprints.has(fp)) continue;
      selected.push(c);
      fingerprints.add(fp);
    }
  }

  return selected;
}

function isTooSimilar(
  candidate: BeamCandidate,
  existing: readonly BeamCandidate[],
  radius: number,
): boolean {
  for (const e of existing) {
    let totalDist = 0;
    for (let i = 0; i < candidate.boxPositions.length; i++) {
      totalDist +=
        Math.abs(candidate.boxPositions[i].row - e.boxPositions[i].row) +
        Math.abs(candidate.boxPositions[i].column - e.boxPositions[i].column);
    }
    if (totalDist <= radius) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Forward solution replay — verify a candidate is solvable by replaying
// the pull history in reverse (as forward pushes)
// ---------------------------------------------------------------------------

export function replayForwardSolution(
  template: SolvedTemplate,
  candidate: BeamCandidate,
): boolean {
  const boxes: GridPosition[] = candidate.boxPositions.map((b) => ({
    row: b.row,
    column: b.column,
  }));

  for (let i = candidate.pullHistory.length - 1; i >= 0; i--) {
    const pull = candidate.pullHistory[i];

    const boxIdx = boxes.findIndex(
      (b) => b.row === pull.to.row && b.column === pull.to.column,
    );
    if (boxIdx < 0) return false;

    boxes[boxIdx] = { row: pull.from.row, column: pull.from.column };
  }

  const goalSet = new Set(
    template.goalPositions.map((g) => `${g.row},${g.column}`),
  );
  for (const box of boxes) {
    if (!goalSet.has(`${box.row},${box.column}`)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Convenience: build puzzle rows from a beam candidate
// ---------------------------------------------------------------------------

export function candidateToRows(
  template: SolvedTemplate,
  candidate: BeamCandidate,
): string[] {
  const grid: string[][] = template.grid.map((row) => [...row]);

  for (const goal of template.goalPositions) {
    grid[goal.row][goal.column] = "S";
  }

  for (const box of candidate.boxPositions) {
    grid[box.row][box.column] =
      grid[box.row][box.column] === "S" ? "X" : "X";
  }

  grid[candidate.robotPosition.row][candidate.robotPosition.column] = "R";

  return grid.map((row) => row.join(""));
}

export function candidateToAscii(
  template: SolvedTemplate,
  candidate: BeamCandidate,
): string {
  return candidateToRows(template, candidate).join("\n");
}

// ===========================================================================
// V4 Reverse Beam Search
// ===========================================================================

// ---------------------------------------------------------------------------
// V4 Types
// ---------------------------------------------------------------------------

export interface BeamSearchResultV4 {
  readonly best: BeamCandidate;
  readonly archive: readonly BeamCandidate[];
  readonly totalExpanded: number;
  readonly maxDepthReached: number;
  readonly elapsedMs: number;
  readonly restartCount: number;
  readonly transpositionHits: number;
  readonly perRestartStats: readonly RestartStats[];
}

export interface RestartStats {
  readonly restartIndex: number;
  readonly seed: number;
  readonly expanded: number;
  readonly maxDepth: number;
  readonly bestComposite: number;
}

// ---------------------------------------------------------------------------
// Transposition Table
// ---------------------------------------------------------------------------

export class TranspositionTable {
  private readonly table = new Map<string, { bestScore: number; bestDepth: number }>();
  private _hits = 0;

  get hits(): number {
    return this._hits;
  }

  get size(): number {
    return this.table.size;
  }

  shouldExpand(key: string, score: number, depth: number): boolean {
    const existing = this.table.get(key);
    if (!existing) return true;
    if (score > existing.bestScore) return true;
    if (score === existing.bestScore && depth < existing.bestDepth) return true;
    this._hits++;
    return false;
  }

  record(key: string, score: number, depth: number): void {
    const existing = this.table.get(key);
    if (
      !existing ||
      score > existing.bestScore ||
      (score === existing.bestScore && depth < existing.bestDepth)
    ) {
      this.table.set(key, { bestScore: score, bestDepth: depth });
    }
  }
}

// ---------------------------------------------------------------------------
// Diverse Archive
// ---------------------------------------------------------------------------

export class DiverseArchive {
  private entries: BeamCandidate[] = [];
  private readonly keys = new Set<string>();
  private readonly capacity: number;
  private readonly diversityRadius: number;

  constructor(capacity: number, diversityRadius: number) {
    this.capacity = capacity;
    this.diversityRadius = diversityRadius;
  }

  get size(): number {
    return this.entries.length;
  }

  getAll(): readonly BeamCandidate[] {
    return [...this.entries].sort((a, b) => b.score.composite - a.score.composite);
  }

  getBest(): BeamCandidate | undefined {
    let best: BeamCandidate | undefined;
    for (const e of this.entries) {
      if (!best || e.score.composite > best.score.composite) best = e;
    }
    return best;
  }

  offer(candidate: BeamCandidate, stateKey: string): boolean {
    if (this.keys.has(stateKey)) return false;

    if (this.entries.length < this.capacity) {
      this.entries.push(candidate);
      this.keys.add(stateKey);
      return true;
    }

    let worstIdx = 0;
    let worstScore = this.entries[0].score.composite;
    for (let i = 1; i < this.entries.length; i++) {
      if (this.entries[i].score.composite < worstScore) {
        worstScore = this.entries[i].score.composite;
        worstIdx = i;
      }
    }

    if (candidate.score.composite <= worstScore) return false;

    if (this.diversityRadius > 0 && isTooSimilar(candidate, this.entries, this.diversityRadius)) {
      return false;
    }

    this.entries[worstIdx] = candidate;
    this.keys.add(stateKey);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Anti-immediate-undo filter
// ---------------------------------------------------------------------------

function isImmediateUndo(pull: { boxIndex: number; newBoxPosition: GridPosition }, lastPull: PullRecord): boolean {
  return (
    pull.boxIndex === lastPull.boxIndex &&
    pull.newBoxPosition.row === lastPull.from.row &&
    pull.newBoxPosition.column === lastPull.from.column
  );
}

// ---------------------------------------------------------------------------
// V4 Single-restart beam search (internal)
// ---------------------------------------------------------------------------

function singleRestartBeamSearch(
  template: SolvedTemplate,
  ctx: ReturnType<typeof buildScoringContext>,
  profile: ReverseSearchProfile,
  seed: number,
  transposition: TranspositionTable,
  archive: DiverseArchive,
  globalStartTime: number,
): RestartStats {
  const rng = createRng(seed);
  const initialBoxes: GridPosition[] = template.goalPositions.map((g) => ({
    row: g.row,
    column: g.column,
  }));
  const initialScore = scoreState(ctx, initialBoxes, template.robotPosition, DEFAULT_WEIGHTS);

  let beam: BeamCandidate[] = [
    {
      boxPositions: initialBoxes,
      robotPosition: template.robotPosition,
      score: initialScore,
      depth: 0,
      pullHistory: [],
    },
  ];

  let expanded = 0;
  let maxDepth = 0;
  let bestComposite = initialScore.composite;

  const initialKey = reverseStateKey(template.grid, initialBoxes, template.robotPosition);
  transposition.record(initialKey, initialScore.composite, 0);
  archive.offer(beam[0], initialKey);

  for (let depth = 0; depth < profile.maxDepth; depth++) {
    if (profile.maxExpandedStates !== undefined && expanded >= profile.maxExpandedStates) break;
    if (profile.maxElapsedMs !== undefined && performance.now() - globalStartTime >= profile.maxElapsedMs) break;

    const nextCandidates: BeamCandidate[] = [];

    for (const candidate of beam) {
      const pulls = enumerateReversePulls(
        template.grid,
        candidate.boxPositions,
        candidate.robotPosition,
      );
      expanded++;

      if (pulls.length === 0) continue;

      const lastPull = candidate.pullHistory.length > 0
        ? candidate.pullHistory[candidate.pullHistory.length - 1]
        : null;

      for (const pull of pulls) {
        if (profile.antiImmediateUndo && lastPull && isImmediateUndo(pull, lastPull)) {
          continue;
        }

        const newBoxes = candidate.boxPositions.map((b, i) =>
          i === pull.boxIndex ? pull.newBoxPosition : b,
        );

        const stateKey = reverseStateKey(template.grid, newBoxes, pull.newRobotPosition);

        const baseScore = scoreState(ctx, newBoxes, pull.newRobotPosition, DEFAULT_WEIGHTS);

        const record: PullRecord = {
          boxIndex: pull.boxIndex,
          from: candidate.boxPositions[pull.boxIndex],
          to: pull.newBoxPosition,
          robotFrom: candidate.robotPosition,
          robotTo: pull.newRobotPosition,
        };
        const newHistory = [...candidate.pullHistory, record];

        const historyEntries: PullHistoryEntry[] = newHistory.map((h) => ({
          boxIndex: h.boxIndex,
          fromRoom: ctx.roomLookup.get(`${h.from.row},${h.from.column}`),
          toRoom: ctx.roomLookup.get(`${h.to.row},${h.to.column}`),
        }));
        const histBonus = historyComplexityBonus(historyEntries);

        const compositeWithBonus = baseScore.composite + histBonus;

        if (!transposition.shouldExpand(stateKey, compositeWithBonus, depth + 1)) {
          continue;
        }
        transposition.record(stateKey, compositeWithBonus, depth + 1);

        const augmentedScore: ReverseStateScore = {
          ...baseScore,
          composite: compositeWithBonus,
        };

        const newCandidate: BeamCandidate = {
          boxPositions: newBoxes,
          robotPosition: pull.newRobotPosition,
          score: augmentedScore,
          depth: depth + 1,
          pullHistory: newHistory,
        };

        nextCandidates.push(newCandidate);
        archive.offer(newCandidate, stateKey);

        if (compositeWithBonus > bestComposite) {
          bestComposite = compositeWithBonus;
        }
      }
    }

    if (nextCandidates.length === 0) break;

    beam = selectDiverseBeamV4(
      nextCandidates,
      profile.beamWidth,
      profile.diversityRadius,
      profile.stochasticTieBreaking ? rng : undefined,
    );

    for (const c of beam) {
      if (c.depth > maxDepth) maxDepth = c.depth;
    }
  }

  return { restartIndex: 0, seed, expanded, maxDepth, bestComposite };
}

// ---------------------------------------------------------------------------
// V4 Diversity-aware beam selection with stochastic tie-breaking
// ---------------------------------------------------------------------------

function selectDiverseBeamV4(
  candidates: BeamCandidate[],
  beamWidth: number,
  diversityRadius: number,
  rng?: () => number,
): BeamCandidate[] {
  if (rng) {
    candidates.sort((a, b) => {
      const diff = b.score.composite - a.score.composite;
      if (Math.abs(diff) < 1e-9) {
        return rng() - 0.5;
      }
      return diff;
    });
  } else {
    candidates.sort((a, b) => b.score.composite - a.score.composite);
  }

  const selected: BeamCandidate[] = [];
  const fingerprints = new Set<string>();

  for (const c of candidates) {
    if (selected.length >= beamWidth) break;

    const fp = stateFingerprint(c.boxPositions);
    if (fingerprints.has(fp)) continue;

    if (diversityRadius > 0 && isTooSimilar(c, selected, diversityRadius)) {
      continue;
    }

    selected.push(c);
    fingerprints.add(fp);
  }

  if (selected.length < beamWidth) {
    for (const c of candidates) {
      if (selected.length >= beamWidth) break;
      const fp = stateFingerprint(c.boxPositions);
      if (fingerprints.has(fp)) continue;
      selected.push(c);
      fingerprints.add(fp);
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// V4 Multi-restart beam search (public entry point)
// ---------------------------------------------------------------------------

export function reverseBeamSearchV4(
  solved: SolvedBlueprint,
  seed: number,
  profile: ReverseSearchProfile = DEFAULT_SEARCH_PROFILE,
): BeamSearchResultV4 {
  const globalStart = performance.now();
  const template = toSolvedTemplate(solved);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  const transposition = new TranspositionTable();
  const archive = new DiverseArchive(profile.diverseArchiveSize, profile.diversityRadius);

  const perRestartStats: RestartStats[] = [];
  let totalExpanded = 0;
  let maxDepthReached = 0;

  for (let r = 0; r < profile.restartCount; r++) {
    if (profile.maxElapsedMs !== undefined && performance.now() - globalStart >= profile.maxElapsedMs) break;

    const restartSeed = seed + r;
    const stats = singleRestartBeamSearch(
      template,
      ctx,
      profile,
      restartSeed,
      transposition,
      archive,
      globalStart,
    );

    perRestartStats.push({ ...stats, restartIndex: r });
    totalExpanded += stats.expanded;
    if (stats.maxDepth > maxDepthReached) maxDepthReached = stats.maxDepth;
  }

  const archiveCandidates = archive.getAll();
  const best = archive.getBest() ?? {
    boxPositions: template.goalPositions.map((g) => ({ row: g.row, column: g.column })),
    robotPosition: template.robotPosition,
    score: scoreState(
      ctx,
      template.goalPositions.map((g) => ({ row: g.row, column: g.column })),
      template.robotPosition,
      DEFAULT_WEIGHTS,
    ),
    depth: 0,
    pullHistory: [],
  };

  return {
    best,
    archive: archiveCandidates,
    totalExpanded,
    maxDepthReached,
    elapsedMs: performance.now() - globalStart,
    restartCount: perRestartStats.length,
    transpositionHits: transposition.hits,
    perRestartStats,
  };
}
