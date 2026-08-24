import { enumerateReversePulls } from "../reverse-play.ts";
import type { GridPosition, SolvedTemplate } from "../generator-types.ts";
import type { SolvedBlueprint } from "./blueprint-types.ts";
import {
  buildScoringContext,
  scoreState,
  stateFingerprint,
  DEFAULT_WEIGHTS,
  type ReverseStateScore,
  type ScoringWeights,
} from "./reverse-scoring.ts";
import { toSolvedTemplate } from "./goal-placement.ts";

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
