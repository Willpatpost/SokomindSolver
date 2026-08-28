import type { Difficulty, PuzzleDefinition } from "../../../core/model.ts";
import type { SolutionStep } from "../../../solver/contracts.ts";
import type { TopologyFamily, GeometryProfile, ReverseSearchProfile } from "./blueprint-types.ts";
import type { BeamSearchParams } from "./reverse-beam-search.ts";
import type { PuzzleEvaluationVector } from "./puzzle-evaluator.ts";
import type { MotifType, DependencyHint } from "./motifs.ts";
import type {
  ComposedPuzzleResult,
  CompositionType,
  DependencyDAG,
} from "./dependency-graph.ts";
import type { TighteningParams, TighteningResult, TierTighteningPolicy } from "./geometry-tightening.ts";

import {
  generateBlueprintWithRetry,
  rasterizeBlueprint,
} from "./blueprint-graph.ts";
import { analyzeGrid, parseRowsToGrid } from "./structural-metrics.ts";
import { createRng } from "../board-template.ts";
import { enumerateForgeCombinations, createForgeSchedule, type ForgeGenerationMode } from "./forge-sampling.ts";
import { boardHash } from "./puzzle-identity.ts";
import {
  TOPOLOGY_FAMILIES,
  DEFAULT_BLUEPRINT_PARAMS,
  DEFAULT_GOAL_PARAMS,
} from "./blueprint-types.ts";
import { assignRoomRoles } from "./room-roles.ts";
import {
  placeGoals,
  toSolvedTemplate,
} from "./goal-placement.ts";
import {
  reverseBeamSearch,
  reverseBeamSearchV4,
  DEFAULT_BEAM_PARAMS,
} from "./reverse-beam-search.ts";
import { evaluatePuzzleWithSteps } from "./puzzle-evaluator.ts";
import { evaluateFinalist, computeCurationObjectives } from "./finalist-evaluator.ts";
import {
  generateComposedPuzzle,
  generateVerifiedMotifPuzzle,
  DEFAULT_COMPOSITION_PARAMS,
} from "./dependency-graph.ts";
import {
  tightenPuzzle,
  buildPreservationContext,
  DEFAULT_TIGHTENING_PARAMS,
  DEFAULT_TIER_TIGHTENING_POLICIES,
} from "./geometry-tightening.ts";
import { verifyDependenciesWithEvidence } from "./dependency-verification.ts";
import { createMechanismPlan, placeGoalsFromPlan } from "./mechanism-plan.ts";
import type { MechanismType } from "./blueprint-types.ts";

import type { GridPosition } from "../generator-types.ts";
import { validatePuzzle } from "../../../core/puzzle.ts";
import { buildPuzzleFromScramble } from "../generate-puzzle.ts";
import { assignLabels, assignPartialLabels } from "../label-assignment.ts";
import { createSession, move } from "../../../core/game-session.ts";
import { isGoalChar, isGenericBoxChar, isTypedBoxChar } from "./tile-semantics.ts";
import {
  DiagnosticCollector,
  formatDiagnosticReport,
  type ForgeDiagnosticReport,
} from "./generator-diagnostics.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ForgeGenerationMode } from "./forge-sampling.ts";

export type BoxTypingMode = "generic" | "typed" | "hybrid";

export interface BoxTypingPolicy {
  readonly modes: readonly BoxTypingMode[];
  readonly hybridTypedFractionMin: number;
  readonly hybridTypedFractionMax: number;
}

export interface FunnelBudgets {
  readonly rawAttemptBudget: number;
  readonly preScreenRetain: number;
  readonly finalistRetain: number;
  readonly deepRetain: number;
  readonly catalogQuota: number;
}

export type QualityPreset = "smoke" | "standard" | "high" | "exhaustive";

export const QUALITY_PRESETS: Readonly<Record<QualityPreset, FunnelBudgets>> = {
  smoke:      { rawAttemptBudget: 20,    preScreenRetain: 10,   finalistRetain: 6,   deepRetain: 4,   catalogQuota: 3 },
  standard:   { rawAttemptBudget: 200,   preScreenRetain: 80,   finalistRetain: 30,  deepRetain: 15,  catalogQuota: 10 },
  high:       { rawAttemptBudget: 2000,  preScreenRetain: 500,  finalistRetain: 100, deepRetain: 40,  catalogQuota: 20 },
  exhaustive: { rawAttemptBudget: 20000, preScreenRetain: 2000, finalistRetain: 500, deepRetain: 100, catalogQuota: 40 },
};

export interface ForgeConfig {
  readonly batchSize: number;
  readonly retainTarget: number;
  readonly families: readonly TopologyFamily[];
  readonly boxCounts: readonly number[];
  readonly difficulties: readonly Difficulty[];
  readonly modes: readonly ForgeGenerationMode[];
  readonly motifTypes: readonly (MotifType | "auto")[];
  readonly compositionTypes: readonly (CompositionType | "auto")[];
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly blueprintRetries: number;
  readonly beamParams: Partial<BeamSearchParams>;
  readonly tighteningParams: TighteningParams;
  readonly tierTighteningPolicies?: Readonly<Record<string, TierTighteningPolicy>>;
  readonly gates: ForgeAcceptanceGates;
  readonly diversityMinDistance: number;
  readonly baseSeed: number;
  readonly typingPolicy: BoxTypingPolicy;
  readonly geometryProfile?: GeometryProfile;
  readonly reverseSearchProfile?: ReverseSearchProfile;
  readonly mechanismTier?: string;
  readonly funnelBudgets?: FunnelBudgets;
}

export interface ForgeAcceptanceGates {
  readonly minSolutionPushes: number;
  readonly maxUnusedFloorRatio: number;
  readonly maxEmptyWalkRatio: number;
  readonly maxLongestWalkStreak: number;
  readonly maxRepetitivePushRatio: number;
  readonly maxBoxIndependenceRatio: number;
  readonly minDependencyRealizationRate: number;
  readonly maxMovesPerPush: number;
  readonly minSolverExpandedStates: number;
  readonly minPlayableFloor?: number;
  readonly minFloorCoverage?: number;
  readonly minRegionCount?: number;
  readonly minChokepointCount?: number;
}

export const DEFAULT_FORGE_GATES: ForgeAcceptanceGates = {
  minSolutionPushes: 4,
  maxUnusedFloorRatio: 0.85,
  maxEmptyWalkRatio: 0.80,
  maxLongestWalkStreak: 25,
  maxRepetitivePushRatio: 0.85,
  maxBoxIndependenceRatio: 0.90,
  minDependencyRealizationRate: 0.30,
  maxMovesPerPush: 6.0,
  minSolverExpandedStates: 3,
};

export const DEFAULT_FORGE_CONFIG: ForgeConfig = {
  batchSize: 200,
  retainTarget: 20,
  families: [...TOPOLOGY_FAMILIES],
  boxCounts: [3, 4],
  difficulties: ["intermediate", "advanced"],
  modes: ["plain", "motif", "composed"],
  motifTypes: ["auto"],
  compositionTypes: ["auto"],
  boardWidth: 14,
  boardHeight: 14,
  blueprintRetries: 30,
  beamParams: { maxDepth: 30 },
  tighteningParams: DEFAULT_TIGHTENING_PARAMS,
  gates: DEFAULT_FORGE_GATES,
  diversityMinDistance: 2.0,
  baseSeed: 10000,
  typingPolicy: {
    modes: ["generic", "typed", "hybrid"],
    hybridTypedFractionMin: 0.3,
    hybridTypedFractionMax: 0.7,
  },
};

export interface ForgeProvenance {
  readonly seed: number;
  readonly family: TopologyFamily;
  readonly boxCount: number;
  readonly mode: ForgeGenerationMode;
  readonly motifType?: MotifType;
  readonly compositionType?: string;
  readonly difficulty: Difficulty;
  readonly tightened: boolean;
  readonly cellsRemoved: number;
  readonly typingMode: BoxTypingMode;
  readonly genericBoxCount: number;
  readonly typedBoxCount: number;
  readonly dependencyRealizationRate?: number;
  readonly dependencyEdges?: number;
  readonly dependencyRealized?: number;
  readonly playableFloor?: number;
  readonly floorCoverage?: number;
  readonly tighteningProtectedCells?: number;
  readonly preTighteningFloor?: number;
  readonly postTighteningFloor?: number;
  readonly mechanismTypes?: readonly MechanismType[];
  readonly mechanismCount?: number;
}

export interface ForgeCandidate {
  readonly puzzle: PuzzleDefinition;
  readonly provenance: ForgeProvenance;
  readonly evaluation: PuzzleEvaluationVector;
  readonly tighteningResult?: TighteningResult;
  readonly dag?: DependencyDAG;
  readonly hints?: readonly DependencyHint[];
}

export type ForgeRejectionReason =
  | "blueprint-failed"
  | "goal-placement-failed"
  | "beam-search-empty"
  | "validation-failed"
  | "unsolvable"
  | "tightening-failed"
  | "gate-pushes"
  | "gate-unused-floor"
  | "gate-empty-walk"
  | "gate-walk-streak"
  | "gate-repetitive-push"
  | "gate-box-independence"
  | "gate-dependency-realization"
  | "gate-moves-per-push"
  | "gate-solver-effort"
  | "gate-geometry"
  | "geometry-floor-min"
  | "geometry-floor-max"
  | "geometry-coverage"
  | "geometry-regions"
  | "geometry-chokepoints"
  | "geometry-room-count"
  | "motif-failed"
  | "composition-failed"
  | "replay-validation-failed"
  | "duplicate-exact"
  | "difficulty-mismatch"
  | "duplicate-cross-tier"
  | "duplicate-symmetry";

export interface ForgeRejection {
  readonly seed: number;
  readonly reason: ForgeRejectionReason;
}

export interface FunnelStageStats {
  readonly stageA_rawGenerated: number;
  readonly stageB_structuralSurvivors: number;
  readonly stageC_cheapEvalSurvivors: number;
  readonly stageD_deepEvalSurvivors: number;
  readonly stageE_curatedFinal: number;
}

export interface ForgeRunResult {
  readonly config: ForgeConfig;
  readonly candidates: readonly ForgeCandidate[];
  readonly rejections: readonly ForgeRejection[];
  readonly totalAttempted: number;
  readonly totalValid: number;
  readonly totalRetained: number;
  readonly elapsedMs: number;
  readonly rejectionCounts: Readonly<Record<ForgeRejectionReason, number>>;
  readonly exactDuplicatesRejected: number;
  readonly funnelStats?: FunnelStageStats;
  readonly diagnostics?: ForgeDiagnosticReport;
}

export interface ForgeSummary {
  readonly totalAttempted: number;
  readonly totalValid: number;
  readonly totalRetained: number;
  readonly elapsedMs: number;
  readonly msPerCandidate: number;
  readonly rejectionCounts: Readonly<Record<string, number>>;
  readonly topologyDistribution: Readonly<Record<string, number>>;
  readonly modeDistribution: Readonly<Record<string, number>>;
  readonly motifDistribution: Readonly<Record<string, number>>;
  readonly metricRanges: Readonly<
    Record<string, { min: number; max: number; avg: number }>
  >;
}

// ---------------------------------------------------------------------------
// Pipeline: single candidate generation
// ---------------------------------------------------------------------------

interface RawGenResult {
  readonly puzzle: PuzzleDefinition;
  readonly dag?: DependencyDAG;
  readonly hints?: readonly DependencyHint[];
  readonly composedResult?: ComposedPuzzleResult;
  readonly motifType?: MotifType;
  readonly compositionType?: string;
  readonly dependencyRealizationRate?: number;
  readonly mechanismTypes?: readonly MechanismType[];
}

function sampleDimension(
  range: readonly [number, number],
  rng: () => number,
): number {
  const [min, max] = range;
  return min + Math.floor(rng() * (max - min + 1));
}

async function generateRawCandidate(
  config: ForgeConfig,
  seed: number,
  family: TopologyFamily,
  boxCount: number,
  mode: ForgeGenerationMode,
  difficulty: Difficulty,
): Promise<
  | { ok: true; result: RawGenResult }
  | { ok: false; reason: ForgeRejectionReason }
> {
  const gp = config.geometryProfile;

  let boardWidth = config.boardWidth;
  let boardHeight = config.boardHeight;
  let bpMinRooms = DEFAULT_BLUEPRINT_PARAMS.minRooms;
  let bpMaxRooms = DEFAULT_BLUEPRINT_PARAMS.maxRooms;
  let bpMinRoomSize = DEFAULT_BLUEPRINT_PARAMS.minRoomSize;
  let bpMaxRoomSize = DEFAULT_BLUEPRINT_PARAMS.maxRoomSize;
  let passageWidths: readonly (1 | 2)[] | undefined;

  if (gp) {
    const dimRng = createRng(seed);
    boardWidth = sampleDimension(gp.boardWidthRange, dimRng);
    boardHeight = sampleDimension(gp.boardHeightRange, dimRng);
    bpMinRooms = gp.minRooms;
    bpMaxRooms = gp.maxRooms;
    bpMinRoomSize = gp.minRoomSize;
    bpMaxRoomSize = gp.maxRoomSize;
    passageWidths = gp.passageWidths;
  }

  const bp = generateBlueprintWithRetry(
    {
      ...DEFAULT_BLUEPRINT_PARAMS,
      seed,
      family,
      boardWidth,
      boardHeight,
      minRooms: bpMinRooms,
      maxRooms: bpMaxRooms,
      minRoomSize: bpMinRoomSize,
      maxRoomSize: bpMaxRoomSize,
      passageWidths,
    },
    config.blueprintRetries,
  );
  if (!bp) return { ok: false, reason: "blueprint-failed" };

  if (gp) {
    const bpGrid = rasterizeBlueprint(bp);
    const geoRejection = validateBlueprintGeometry(bp, bpGrid, gp);
    if (geoRejection) return { ok: false, reason: geoRejection };
  }

  const fb = assignRoomRoles(bp, seed, boxCount);

  if (mode === "composed") {
    const result = await generateComposedPuzzle(fb, {
      ...DEFAULT_COMPOSITION_PARAMS,
      seed,
      boxCount,
      beamParams: {
        ...DEFAULT_BEAM_PARAMS,
        seed,
        ...config.beamParams,
      },
    });
    if (!result) return { ok: false, reason: "composition-failed" };
    return {
      ok: true,
      result: {
        puzzle: {
          ...result.puzzle,
          id: `forge-${seed}`,
          difficulty,
        },
        dag: result.dag,
        composedResult: result,
        compositionType: result.dag.compositionId,
        dependencyRealizationRate: result.realization.realizationRate,
      },
    };
  }

  if (mode === "motif") {
    const motifChoice =
      config.motifTypes[seed % config.motifTypes.length];
    const result = await generateVerifiedMotifPuzzle(fb, {
      seed,
      boxCount,
      motif: motifChoice,
      beamParams: {
        ...DEFAULT_BEAM_PARAMS,
        seed,
        ...config.beamParams,
      },
    });
    if (!result) return { ok: false, reason: "motif-failed" };
    return {
      ok: true,
      result: {
        puzzle: { ...result.puzzle, id: `forge-${seed}`, difficulty },
        hints: result.hints,
        motifType: result.motif,
      },
    };
  }

  if (mode === "mechanism") {
    const tier = config.mechanismTier ?? difficulty;
    const plan = createMechanismPlan(fb, tier, boxCount, seed);
    if (!plan) return { ok: false, reason: "composition-failed" };

    const placement = placeGoalsFromPlan(fb, plan);
    if (!placement) return { ok: false, reason: "goal-placement-failed" };

    const template = toSolvedTemplate(placement.solved);

    let bestCandidate: { boxPositions: readonly GridPosition[]; robotPosition: GridPosition; depth: number };

    if (config.reverseSearchProfile) {
      const v4Result = reverseBeamSearchV4(placement.solved, seed, config.reverseSearchProfile);
      if (v4Result.best.depth === 0) {
        return { ok: false, reason: "beam-search-empty" };
      }
      bestCandidate = v4Result.best;
    } else {
      const beamParams: BeamSearchParams = {
        ...DEFAULT_BEAM_PARAMS,
        seed,
        ...config.beamParams,
      };
      const beam = reverseBeamSearch(placement.solved, beamParams);
      if (beam.best.depth === 0) {
        return { ok: false, reason: "beam-search-empty" };
      }
      bestCandidate = beam.best;
    }

    const scrambled = {
      template,
      boxPositions: bestCandidate.boxPositions as Array<{ row: number; column: number }>,
      robotPosition: bestCandidate.robotPosition,
      reversePulls: bestCandidate.depth,
    };
    const puzzle = buildPuzzleFromScramble(scrambled, difficulty);
    const validation = validatePuzzle(puzzle);
    if (!validation.valid) {
      return { ok: false, reason: "validation-failed" };
    }

    return {
      ok: true,
      result: {
        puzzle: { ...puzzle, id: `forge-${seed}`, difficulty },
        dag: placement.dag,
        compositionType: placement.dag.compositionId,
        mechanismTypes: plan.mechanisms.map((m) => m.type),
      },
    };
  }

  const solved = placeGoals(fb, {
    ...DEFAULT_GOAL_PARAMS,
    seed,
    boxCount,
  });
  if (!solved) return { ok: false, reason: "goal-placement-failed" };

  const template = toSolvedTemplate(solved);

  let bestCandidate: { boxPositions: readonly GridPosition[]; robotPosition: GridPosition; depth: number };

  if (config.reverseSearchProfile) {
    const v4Result = reverseBeamSearchV4(solved, seed, config.reverseSearchProfile);
    if (v4Result.best.depth === 0) {
      return { ok: false, reason: "beam-search-empty" };
    }
    bestCandidate = v4Result.best;
  } else {
    const beamParams: BeamSearchParams = {
      ...DEFAULT_BEAM_PARAMS,
      seed,
      ...config.beamParams,
    };
    const beam = reverseBeamSearch(solved, beamParams);
    if (beam.best.depth === 0) {
      return { ok: false, reason: "beam-search-empty" };
    }
    bestCandidate = beam.best;
  }

  const scrambled = {
    template,
    boxPositions: bestCandidate.boxPositions as Array<{
      row: number;
      column: number;
    }>,
    robotPosition: bestCandidate.robotPosition,
    reversePulls: bestCandidate.depth,
  };
  const puzzle = buildPuzzleFromScramble(scrambled, difficulty);
  const validation = validatePuzzle(puzzle);
  if (!validation.valid) {
    return { ok: false, reason: "validation-failed" };
  }

  return {
    ok: true,
    result: {
      puzzle: { ...puzzle, id: `forge-${seed}`, difficulty },
    },
  };
}

// ---------------------------------------------------------------------------
// Acceptance gates
// ---------------------------------------------------------------------------

function applyGates(
  ev: PuzzleEvaluationVector,
  gates: ForgeAcceptanceGates,
  depRate?: number,
): ForgeRejectionReason | null {
  if (!ev.solved) return "unsolvable";
  if (ev.solutionPushes < gates.minSolutionPushes) return "gate-pushes";
  if (ev.unusedFloorRatio > gates.maxUnusedFloorRatio) return "gate-unused-floor";
  if (ev.emptyWalkRatio > gates.maxEmptyWalkRatio) return "gate-empty-walk";
  if (ev.longestWalkStreak > gates.maxLongestWalkStreak) return "gate-walk-streak";
  if (ev.repetitivePushRatio > gates.maxRepetitivePushRatio)
    return "gate-repetitive-push";
  if (ev.boxIndependenceRatio > gates.maxBoxIndependenceRatio)
    return "gate-box-independence";
  if (ev.movesPerPush > gates.maxMovesPerPush) return "gate-moves-per-push";
  if (ev.solverExpandedStates < gates.minSolverExpandedStates)
    return "gate-solver-effort";
  if (
    depRate !== undefined &&
    depRate < gates.minDependencyRealizationRate
  ) {
    return "gate-dependency-realization";
  }
  return null;
}

function applyStructuralGates(
  rows: readonly string[],
  gates: ForgeAcceptanceGates,
): ForgeRejectionReason | null {
  const hasStructuralGates =
    gates.minPlayableFloor !== undefined ||
    gates.minFloorCoverage !== undefined ||
    gates.minRegionCount !== undefined ||
    gates.minChokepointCount !== undefined;

  if (!hasStructuralGates) return null;

  const grid = parseRowsToGrid(rows);
  const metrics = analyzeGrid(grid);

  if (
    gates.minPlayableFloor !== undefined &&
    metrics.totalFloor < gates.minPlayableFloor
  ) {
    return "geometry-floor-min";
  }
  if (
    gates.minFloorCoverage !== undefined &&
    metrics.floorUtilization < gates.minFloorCoverage
  ) {
    return "geometry-coverage";
  }
  if (
    gates.minRegionCount !== undefined &&
    metrics.regionCount < gates.minRegionCount
  ) {
    return "geometry-regions";
  }
  if (
    gates.minChokepointCount !== undefined &&
    metrics.chokepointCount < gates.minChokepointCount
  ) {
    return "geometry-chokepoints";
  }

  return null;
}

export function validateBlueprintGeometry(
  blueprint: { readonly rooms: readonly { readonly id: number }[]; readonly boardWidth: number; readonly boardHeight: number },
  grid: readonly (readonly string[])[],
  gp: GeometryProfile,
): ForgeRejectionReason | null {
  if (blueprint.boardWidth < gp.boardWidthRange[0] || blueprint.boardWidth > gp.boardWidthRange[1]) {
    return "geometry-room-count";
  }
  if (blueprint.boardHeight < gp.boardHeightRange[0] || blueprint.boardHeight > gp.boardHeightRange[1]) {
    return "geometry-room-count";
  }
  if (blueprint.rooms.length < gp.minRooms || blueprint.rooms.length > gp.maxRooms) {
    return "geometry-room-count";
  }

  const metrics = analyzeGrid(grid);

  if (metrics.totalFloor < gp.minPlayableFloor) {
    return "geometry-floor-min";
  }
  if (gp.maxPlayableFloor !== undefined && metrics.totalFloor > gp.maxPlayableFloor) {
    return "geometry-floor-max";
  }
  if (metrics.floorUtilization < gp.minFloorCoverage) {
    return "geometry-coverage";
  }
  if (metrics.regionCount < gp.minRegions) {
    return "geometry-regions";
  }
  if (metrics.chokepointCount < gp.minChokepoints) {
    return "geometry-chokepoints";
  }

  return null;
}

export function validateFinalGeometry(
  rows: readonly string[],
  gp: GeometryProfile,
): ForgeRejectionReason | null {
  const grid = parseRowsToGrid(rows);
  const metrics = analyzeGrid(grid);

  if (metrics.totalFloor < gp.minPlayableFloor) {
    return "geometry-floor-min";
  }
  if (gp.maxPlayableFloor !== undefined && metrics.totalFloor > gp.maxPlayableFloor) {
    return "geometry-floor-max";
  }
  if (metrics.floorUtilization < gp.minFloorCoverage) {
    return "geometry-coverage";
  }
  if (metrics.regionCount < gp.minRegions) {
    return "geometry-regions";
  }
  if (metrics.chokepointCount < gp.minChokepoints) {
    return "geometry-chokepoints";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Diversity: structural fingerprint + distance
// ---------------------------------------------------------------------------

function candidateFingerprint(c: ForgeCandidate): string {
  const ev = c.evaluation;
  const p = c.provenance;
  const bucketFloor = Math.round(ev.totalFloor / 5) * 5;
  const bucketPushes = Math.round(ev.solutionPushes / 3) * 3;
  const bucketMoves = Math.round(ev.solutionMoves / 5) * 5;
  return `${p.family}|${p.mode}|${p.motifType ?? "none"}|${p.boxCount}|${bucketFloor}|${bucketPushes}|${bucketMoves}`;
}

function metricDistance(a: ForgeCandidate, b: ForgeCandidate): number {
  const ea = a.evaluation;
  const eb = b.evaluation;
  let d = 0;
  d += Math.abs(ea.totalFloor - eb.totalFloor) / 20;
  d += Math.abs(ea.solutionMoves - eb.solutionMoves) / 10;
  d += Math.abs(ea.solutionPushes - eb.solutionPushes) / 5;
  d += Math.abs(ea.boxIndependenceRatio - eb.boxIndependenceRatio) * 5;
  d += Math.abs(ea.emptyWalkRatio - eb.emptyWalkRatio) * 3;
  d += Math.abs(ea.unusedFloorRatio - eb.unusedFloorRatio) * 3;
  d += Math.abs(ea.deadlockDensity - eb.deadlockDensity) * 2;
  return d;
}

function selectDiverse(
  candidates: ForgeCandidate[],
  target: number,
  minDistance: number,
): ForgeCandidate[] {
  if (candidates.length <= target) return candidates;

  candidates.sort((a, b) => {
    const scoreA = paretoScore(a);
    const scoreB = paretoScore(b);
    return scoreB - scoreA;
  });

  const selected: ForgeCandidate[] = [];
  const seenFingerprints = new Set<string>();

  for (const c of candidates) {
    if (selected.length >= target) break;

    const fp = candidateFingerprint(c);
    if (seenFingerprints.has(fp)) {
      const tooClose = selected.some(
        (s) => metricDistance(c, s) < minDistance,
      );
      if (tooClose) continue;
    }

    selected.push(c);
    seenFingerprints.add(fp);
  }

  if (selected.length < target) {
    for (const c of candidates) {
      if (selected.length >= target) break;
      if (selected.includes(c)) continue;
      selected.push(c);
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Pareto-like scoring (multi-objective ranking)
// ---------------------------------------------------------------------------

function paretoScore(c: ForgeCandidate): number {
  const ev = c.evaluation;
  let score = 0;
  score += (1 - ev.boxIndependenceRatio) * 30;
  score += ev.boxInteractionEvents * 3;
  score += Math.min(ev.solutionPushes, 30) * 0.5;
  score += Math.min(ev.deadlockDensity, 3) * 5;
  score += (1 - ev.unusedFloorRatio) * 10;
  score += (1 - ev.emptyWalkRatio) * 8;
  score += (1 - ev.repetitivePushRatio) * 5;
  score -= Math.max(0, ev.longestWalkStreak - 10) * 0.5;
  score -= Math.max(0, ev.movesPerPush - 3) * 2;
  if (c.provenance.dependencyRealizationRate !== undefined) {
    score += c.provenance.dependencyRealizationRate * 15;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Main forge runner
// ---------------------------------------------------------------------------

export async function runForge(
  config: ForgeConfig = DEFAULT_FORGE_CONFIG,
): Promise<ForgeRunResult> {
  if (config.funnelBudgets) {
    return runForgeFunnel(config, config.funnelBudgets);
  }
  return runForgeFlat(config);
}

export function countBoxesAndGoals(rows: readonly string[]): { boxes: number; goals: number; generic: number; typed: number } {
  let boxes = 0, goals = 0, generic = 0, typed = 0;
  for (const row of rows) {
    for (const ch of row) {
      if (isGenericBoxChar(ch)) { boxes++; generic++; }
      else if (isTypedBoxChar(ch)) { boxes++; typed++; }
      if (isGoalChar(ch)) goals++;
    }
  }
  return { boxes, goals, generic, typed };
}

function inferStagesFromRejection(reason: ForgeRejectionReason): {
  blueprint: boolean; mechanism: boolean; goalPlacement: boolean; reverse: boolean; validation: boolean;
} {
  switch (reason) {
    case "blueprint-failed":
    case "geometry-floor-min":
    case "geometry-floor-max":
    case "geometry-coverage":
    case "geometry-regions":
    case "geometry-chokepoints":
    case "geometry-room-count":
      return { blueprint: false, mechanism: false, goalPlacement: false, reverse: false, validation: false };
    case "composition-failed":
    case "motif-failed":
      return { blueprint: true, mechanism: false, goalPlacement: false, reverse: false, validation: false };
    case "goal-placement-failed":
      return { blueprint: true, mechanism: true, goalPlacement: false, reverse: false, validation: false };
    case "beam-search-empty":
      return { blueprint: true, mechanism: true, goalPlacement: true, reverse: false, validation: false };
    case "validation-failed":
      return { blueprint: true, mechanism: true, goalPlacement: true, reverse: true, validation: false };
    default:
      return { blueprint: true, mechanism: true, goalPlacement: true, reverse: true, validation: true };
  }
}

async function runForgeFlat(
  config: ForgeConfig,
): Promise<ForgeRunResult> {
  const start = performance.now();
  const rejections: ForgeRejection[] = [];
  const validCandidates: ForgeCandidate[] = [];
  const collector = new DiagnosticCollector();

  const combinations = enumerateForgeCombinations({
    families: config.families,
    boxCounts: config.boxCounts,
    modes: config.modes,
    difficulties: config.difficulties,
  });
  const schedule = createForgeSchedule(combinations, config.batchSize, config.baseSeed);

  for (let i = 0; i < schedule.length; i++) {
    const { seed, combination } = schedule[i];
    const { family, boxCount, mode, difficulty } = combination;

    collector.recordAttempt();

    const raw = await generateRawCandidate(
      config,
      seed,
      family,
      boxCount,
      mode,
      difficulty,
    );

    if (!raw.ok) {
      rejections.push({ seed, reason: raw.reason });
      const stages = inferStagesFromRejection(raw.reason);
      if (stages.blueprint) collector.recordBlueprintSuccess();
      if (stages.mechanism) collector.recordMechanismPlanSuccess();
      if (stages.goalPlacement) collector.recordGoalPlacementSuccess();
      if (stages.reverse) collector.recordReverseSearchSuccess();
      if (stages.validation) collector.recordPuzzleValidationSuccess();
      collector.recordRejection({
        reason: raw.reason, tier: difficulty, family, mode,
        requestedBoxCount: boxCount,
      });
      continue;
    }

    collector.recordBlueprintSuccess();
    collector.recordMechanismPlanSuccess();
    collector.recordGoalPlacementSuccess();
    collector.recordReverseSearchSuccess();
    collector.recordPuzzleValidationSuccess();

    let puzzle = raw.result.puzzle;
    let tighteningResult: TighteningResult | undefined;
    let cellsRemoved = 0;
    let tighteningProtectedCells: number | undefined;
    let preTighteningFloor: number | undefined;
    let postTighteningFloor: number | undefined;

    // Step 1: Tighten puzzle geometry with tier-aware policy
    {
      const puzzleGrid = parseRowsToGrid(puzzle.rows);
      const preservation = buildPreservationContext(puzzleGrid);
      const tierPolicies = config.tierTighteningPolicies ?? DEFAULT_TIER_TIGHTENING_POLICIES;
      const tierPolicy = tierPolicies[difficulty];
      preTighteningFloor = analyzeGrid(puzzleGrid).totalFloor;

      const tResult = await tightenPuzzle(puzzle, config.tighteningParams, preservation, tierPolicy);
      if (tResult && tResult.cellsRemoved > 0) {
        puzzle = tResult.tightened;
        tighteningResult = tResult;
        cellsRemoved = tResult.cellsRemoved;
      }
      if (tResult) {
        tighteningProtectedCells = tResult.protectedCellCount;
        postTighteningFloor = tResult.metrics.after.totalFloor;
      } else {
        postTighteningFloor = preTighteningFloor;
      }
    }

    if (config.geometryProfile) {
      const geoResult = validateFinalGeometry(puzzle.rows, config.geometryProfile);
      if (geoResult) {
        rejections.push({ seed, reason: geoResult });
        collector.recordRejection({
          reason: geoResult, tier: difficulty, family, mode,
          requestedBoxCount: boxCount,
        });
        continue;
      }
    }

    // Step 2: Determine typing mode
    const modeIndex = seed % config.typingPolicy.modes.length;
    const typingMode = config.typingPolicy.modes[modeIndex];

    // Step 3: If not generic, do preliminary solve for box-goal pairing steps
    let pairingSteps: readonly SolutionStep[] | null = null;
    let prelimMoves = 0;
    let prelimPushes = 0;

    if (typingMode !== "generic" && boxCount >= 2) {
      const prelimResult = await evaluatePuzzleWithSteps(puzzle);
      if (!prelimResult.vector.solved || !prelimResult.steps) {
        rejections.push({ seed, reason: "unsolvable" });
        collector.recordRejection({
          reason: "unsolvable", tier: difficulty, family, mode,
          requestedBoxCount: boxCount,
        });
        continue;
      }
      collector.recordInitialSolveSuccess();
      pairingSteps = prelimResult.steps;
      prelimMoves = prelimResult.vector.solutionMoves;
      prelimPushes = prelimResult.vector.solutionPushes;
    }

    // Step 4: Apply typing transformation
    let puzzleChanged = false;
    if (typingMode !== "generic" && boxCount >= 2 && pairingSteps) {
      const solution = {
        steps: pairingSteps,
        moves: prelimMoves,
        pushes: prelimPushes,
        objective: { kind: "moves" as const },
        objectiveScore: prelimMoves,
        optimality: "unknown" as const,
      };
      const labelRng = (() => {
        let s = (seed * 2654435761 + 999983) | 0;
        return () => { s = (s * 1103515245 + 12345) | 0; return (s >>> 0) / 0x100000000; };
      })();

      let candidatePuzzle: PuzzleDefinition;
      if (typingMode === "typed") {
        candidatePuzzle = assignLabels(puzzle, solution, labelRng);
      } else {
        // hybrid: pick a typed fraction within the configured range
        const range =
          config.typingPolicy.hybridTypedFractionMax -
          config.typingPolicy.hybridTypedFractionMin;
        const typedFraction =
          config.typingPolicy.hybridTypedFractionMin + labelRng() * range;
        candidatePuzzle = assignPartialLabels(
          puzzle,
          solution,
          labelRng,
          typedFraction,
        );
      }

      if (candidatePuzzle !== puzzle) {
        const labelValidation = validatePuzzle(candidatePuzzle);
        if (labelValidation.valid) {
          puzzle = candidatePuzzle;
          puzzleChanged = true;
        }
      }
    }

    // Step 5: If typed puzzle changed, replay-validate the solution
    if (puzzleChanged && pairingSteps) {
      let session = createSession(puzzle);
      let replayOk = true;
      for (const step of pairingSteps) {
        const next = move(session, step.direction);
        if (next === session) {
          replayOk = false;
          break;
        }
        session = next;
      }
      if (!replayOk || !session.solved) {
        rejections.push({ seed, reason: "replay-validation-failed" });
        collector.recordRejection({
          reason: "replay-validation-failed", tier: difficulty, family, mode,
          requestedBoxCount: boxCount,
        });
        continue;
      }
    }

    // Step 6: Final evaluation on the post-typing puzzle
    const evalResult = await evaluatePuzzleWithSteps(puzzle);
    const ev = evalResult.vector;
    if (!ev.solved) {
      rejections.push({ seed, reason: "unsolvable" });
      collector.recordRejection({
        reason: "unsolvable", tier: difficulty, family, mode,
        requestedBoxCount: boxCount,
      });
      continue;
    }
    collector.recordInitialSolveSuccess();

    // Step 7: Re-verify dependencies if DAG exists
    let depRate = raw.result.dependencyRealizationRate;
    let depEdges = raw.result.composedResult?.realization.totalEdges;
    let depRealized = raw.result.composedResult?.realization.realizedEdges;

    if (raw.result.dag && evalResult.steps) {
      const reVerification = verifyDependenciesWithEvidence(
        raw.result.dag,
        puzzle,
        evalResult.steps,
      );
      depRate = reVerification.realizationRate;
      depEdges = reVerification.totalEdges;
      depRealized = reVerification.realizedEdges;
    }

    // Step 8: Apply gates using final evaluation
    const gateResult = applyGates(ev, config.gates, depRate);
    if (gateResult) {
      rejections.push({ seed, reason: gateResult });
      collector.recordRejection({
        reason: gateResult, tier: difficulty, family, mode,
        requestedBoxCount: boxCount,
      });
      continue;
    }

    // Step 8b: Apply structural gates (geometry profile)
    const structuralGateResult = applyStructuralGates(puzzle.rows, config.gates);
    if (structuralGateResult) {
      rejections.push({ seed, reason: structuralGateResult });
      collector.recordRejection({
        reason: structuralGateResult, tier: difficulty, family, mode,
        requestedBoxCount: boxCount,
      });
      continue;
    }

    collector.recordGatePassed();

    // Step 9: Count generic/typed boxes in final puzzle + box scale diagnostics
    const boxGoalCounts = countBoxesAndGoals(puzzle.rows);
    const genericBoxCount = boxGoalCounts.generic;
    const typedBoxCount = boxGoalCounts.typed;
    const actualBoxes = boxGoalCounts.boxes;

    if (actualBoxes !== boxCount || genericBoxCount + typedBoxCount !== actualBoxes) {
      rejections.push({ seed, reason: "validation-failed" });
      collector.recordRejection({
        reason: "validation-failed", tier: difficulty, family, mode,
        requestedBoxCount: boxCount, actualBoxCount: actualBoxes,
      });
      collector.recordBoxScale({
        requestedBoxes: boxCount,
        actualBoxes,
        goalCount: boxGoalCounts.goals,
        genericBoxes: genericBoxCount,
        typedBoxes: typedBoxCount,
        difference: actualBoxes - boxCount,
      });
      continue;
    }

    collector.recordBoxScale({
      requestedBoxes: boxCount,
      actualBoxes,
      goalCount: boxGoalCounts.goals,
      genericBoxes: genericBoxCount,
      typedBoxes: typedBoxCount,
      difference: actualBoxes - boxCount,
    });

    // Step 10: Construct provenance with all final data
    const provGrid = parseRowsToGrid(puzzle.rows);
    const provMetrics = analyzeGrid(provGrid);

    const provenance: ForgeProvenance = {
      seed,
      family,
      boxCount,
      mode,
      motifType: raw.result.motifType,
      compositionType: raw.result.compositionType,
      difficulty,
      tightened: cellsRemoved > 0,
      cellsRemoved,
      typingMode,
      genericBoxCount,
      typedBoxCount,
      dependencyRealizationRate: depRate,
      dependencyEdges: depEdges,
      dependencyRealized: depRealized,
      playableFloor: provMetrics.totalFloor,
      floorCoverage: provMetrics.floorUtilization,
      tighteningProtectedCells,
      preTighteningFloor,
      postTighteningFloor,
      mechanismTypes: raw.result.mechanismTypes,
      mechanismCount: raw.result.mechanismTypes?.length,
    };

    validCandidates.push({
      puzzle: { ...puzzle, id: `forge-${seed}` },
      provenance,
      evaluation: ev,
      tighteningResult,
      dag: raw.result.dag,
      hints: raw.result.hints,
    });
  }

  const seen = new Map<string, { candidate: ForgeCandidate; index: number }>();
  const dedupedCandidates: ForgeCandidate[] = [];
  let exactDuplicatesRejected = 0;

  for (let i = 0; i < validCandidates.length; i++) {
    const c = validCandidates[i];
    const hash = boardHash(c.puzzle.rows);
    const existing = seen.get(hash);
    if (existing) {
      const existingScore = paretoScore(existing.candidate);
      const currentScore = paretoScore(c);
      if (currentScore > existingScore) {
        dedupedCandidates[existing.index] = c;
        seen.set(hash, { candidate: c, index: existing.index });
      }
      rejections.push({ seed: c.provenance.seed, reason: "duplicate-exact" });
      exactDuplicatesRejected++;
    } else {
      seen.set(hash, { candidate: c, index: dedupedCandidates.length });
      dedupedCandidates.push(c);
    }
  }

  const retained = selectDiverse(
    dedupedCandidates,
    config.retainTarget,
    config.diversityMinDistance,
  );

  for (let ci = 0; ci < retained.length; ci++) {
    collector.recordCurated();
  }

  const rejectionCounts = {} as Record<ForgeRejectionReason, number>;
  for (const r of rejections) {
    rejectionCounts[r.reason] = (rejectionCounts[r.reason] ?? 0) + 1;
  }

  return {
    config,
    candidates: retained,
    rejections,
    totalAttempted: config.batchSize,
    totalValid: validCandidates.length,
    totalRetained: retained.length,
    elapsedMs: performance.now() - start,
    rejectionCounts,
    exactDuplicatesRejected,
    diagnostics: collector.build(),
  };
}

// ---------------------------------------------------------------------------
// Staged funnel pipeline (Phase 7)
// ---------------------------------------------------------------------------

function structuralPreScore(c: ForgeCandidate): number {
  const ev = c.evaluation;
  let score = 0;
  score += Math.log2(ev.totalFloor + 1) * 2;
  score += Math.log2(ev.boxCount + 1) * 3;
  score += ev.regionCount * 1.5;
  score += ev.chokepoints * 2;
  score += ev.articulationPoints * 1;
  score += ev.tunnelCells * 0.5;
  score += (1 - ev.unusedFloorRatio) * 5;
  return score;
}

function cheapEvalScore(c: ForgeCandidate): number {
  const ev = c.evaluation;
  let score = paretoScore(c);
  score += ev.nonMonotonicBoxMoves * 2;
  score += ev.stagingOperations * 3;
  score += ev.temporaryGoalVacancies * 4;
  score += ev.estimatedDependencyDepth * 2;
  score += ev.boxSwitchRate * 5;
  score += Math.log2(ev.avgReachablePushes + 1) * 3;
  score -= ev.emptyWalkRatio * 10;
  score -= ev.repetitivePushRatio * 8;
  return score;
}

async function runForgeFunnel(
  config: ForgeConfig,
  budgets: FunnelBudgets,
): Promise<ForgeRunResult> {
  const start = performance.now();
  const rejections: ForgeRejection[] = [];
  const collector = new DiagnosticCollector();

  // ---- Stage A: Raw generation ----
  const combinations = enumerateForgeCombinations({
    families: config.families,
    boxCounts: config.boxCounts,
    modes: config.modes,
    difficulties: config.difficulties,
  });
  const schedule = createForgeSchedule(combinations, budgets.rawAttemptBudget, config.baseSeed);

  const rawCandidates: ForgeCandidate[] = [];

  for (let i = 0; i < schedule.length; i++) {
    const { seed, combination } = schedule[i];
    const { family, boxCount, mode, difficulty } = combination;

    collector.recordAttempt();

    const raw = await generateRawCandidate(config, seed, family, boxCount, mode, difficulty);
    if (!raw.ok) {
      rejections.push({ seed, reason: raw.reason });
      const stages = inferStagesFromRejection(raw.reason);
      if (stages.blueprint) collector.recordBlueprintSuccess();
      if (stages.mechanism) collector.recordMechanismPlanSuccess();
      if (stages.goalPlacement) collector.recordGoalPlacementSuccess();
      if (stages.reverse) collector.recordReverseSearchSuccess();
      if (stages.validation) collector.recordPuzzleValidationSuccess();
      collector.recordRejection({
        reason: raw.reason, tier: difficulty, family, mode,
        requestedBoxCount: boxCount,
      });
      continue;
    }

    collector.recordBlueprintSuccess();
    collector.recordMechanismPlanSuccess();
    collector.recordGoalPlacementSuccess();
    collector.recordReverseSearchSuccess();
    collector.recordPuzzleValidationSuccess();

    let puzzle = raw.result.puzzle;
    let tighteningResult: TighteningResult | undefined;
    let cellsRemoved = 0;
    let tighteningProtectedCells: number | undefined;
    let preTighteningFloor: number | undefined;
    let postTighteningFloor: number | undefined;

    {
      const puzzleGrid = parseRowsToGrid(puzzle.rows);
      const preservation = buildPreservationContext(puzzleGrid);
      const tierPolicies = config.tierTighteningPolicies ?? DEFAULT_TIER_TIGHTENING_POLICIES;
      const tierPolicy = tierPolicies[difficulty];
      preTighteningFloor = analyzeGrid(puzzleGrid).totalFloor;

      const tResult = await tightenPuzzle(puzzle, config.tighteningParams, preservation, tierPolicy);
      if (tResult && tResult.cellsRemoved > 0) {
        puzzle = tResult.tightened;
        tighteningResult = tResult;
        cellsRemoved = tResult.cellsRemoved;
      }
      if (tResult) {
        tighteningProtectedCells = tResult.protectedCellCount;
        postTighteningFloor = tResult.metrics.after.totalFloor;
      } else {
        postTighteningFloor = preTighteningFloor;
      }
    }

    if (config.geometryProfile) {
      const geoResult = validateFinalGeometry(puzzle.rows, config.geometryProfile);
      if (geoResult) {
        rejections.push({ seed, reason: geoResult });
        collector.recordRejection({
          reason: geoResult, tier: difficulty, family, mode,
          requestedBoxCount: boxCount,
        });
        continue;
      }
    }

    const modeIndex = seed % config.typingPolicy.modes.length;
    const typingMode = config.typingPolicy.modes[modeIndex];

    let pairingSteps: readonly SolutionStep[] | null = null;
    let prelimMoves = 0;
    let prelimPushes = 0;

    if (typingMode !== "generic" && boxCount >= 2) {
      const prelimResult = await evaluatePuzzleWithSteps(puzzle);
      if (!prelimResult.vector.solved || !prelimResult.steps) {
        rejections.push({ seed, reason: "unsolvable" });
        collector.recordRejection({
          reason: "unsolvable", tier: difficulty, family, mode,
          requestedBoxCount: boxCount,
        });
        continue;
      }
      collector.recordInitialSolveSuccess();
      pairingSteps = prelimResult.steps;
      prelimMoves = prelimResult.vector.solutionMoves;
      prelimPushes = prelimResult.vector.solutionPushes;
    }

    let puzzleChanged = false;
    if (typingMode !== "generic" && boxCount >= 2 && pairingSteps) {
      const solution = {
        steps: pairingSteps,
        moves: prelimMoves,
        pushes: prelimPushes,
        objective: { kind: "moves" as const },
        objectiveScore: prelimMoves,
        optimality: "unknown" as const,
      };
      const labelRng = (() => {
        let s = (seed * 2654435761 + 999983) | 0;
        return () => { s = (s * 1103515245 + 12345) | 0; return (s >>> 0) / 0x100000000; };
      })();

      let candidatePuzzle: PuzzleDefinition;
      if (typingMode === "typed") {
        candidatePuzzle = assignLabels(puzzle, solution, labelRng);
      } else {
        const range = config.typingPolicy.hybridTypedFractionMax - config.typingPolicy.hybridTypedFractionMin;
        const typedFraction = config.typingPolicy.hybridTypedFractionMin + labelRng() * range;
        candidatePuzzle = assignPartialLabels(puzzle, solution, labelRng, typedFraction);
      }

      if (candidatePuzzle !== puzzle) {
        const labelValidation = validatePuzzle(candidatePuzzle);
        if (labelValidation.valid) {
          puzzle = candidatePuzzle;
          puzzleChanged = true;
        }
      }
    }

    if (puzzleChanged && pairingSteps) {
      let session = createSession(puzzle);
      let replayOk = true;
      for (const step of pairingSteps) {
        const next = move(session, step.direction);
        if (next === session) { replayOk = false; break; }
        session = next;
      }
      if (!replayOk || !session.solved) {
        rejections.push({ seed, reason: "replay-validation-failed" });
        collector.recordRejection({
          reason: "replay-validation-failed", tier: difficulty, family, mode,
          requestedBoxCount: boxCount,
        });
        continue;
      }
    }

    const evalResult = await evaluatePuzzleWithSteps(puzzle);
    const ev = evalResult.vector;
    if (!ev.solved) {
      rejections.push({ seed, reason: "unsolvable" });
      collector.recordRejection({
        reason: "unsolvable", tier: difficulty, family, mode,
        requestedBoxCount: boxCount,
      });
      continue;
    }
    collector.recordInitialSolveSuccess();

    let depRate = raw.result.dependencyRealizationRate;
    let depEdges = raw.result.composedResult?.realization.totalEdges;
    let depRealized = raw.result.composedResult?.realization.realizedEdges;

    if (raw.result.dag && evalResult.steps) {
      const reVerification = verifyDependenciesWithEvidence(raw.result.dag, puzzle, evalResult.steps);
      depRate = reVerification.realizationRate;
      depEdges = reVerification.totalEdges;
      depRealized = reVerification.realizedEdges;
    }

    const gateResult = applyGates(ev, config.gates, depRate);
    if (gateResult) {
      rejections.push({ seed, reason: gateResult });
      collector.recordRejection({
        reason: gateResult, tier: difficulty, family, mode,
        requestedBoxCount: boxCount,
      });
      continue;
    }

    const structuralGateResult = applyStructuralGates(puzzle.rows, config.gates);
    if (structuralGateResult) {
      rejections.push({ seed, reason: structuralGateResult });
      collector.recordRejection({
        reason: structuralGateResult, tier: difficulty, family, mode,
        requestedBoxCount: boxCount,
      });
      continue;
    }

    collector.recordGatePassed();

    const boxGoalCounts = countBoxesAndGoals(puzzle.rows);
    const genericBoxCount = boxGoalCounts.generic;
    const typedBoxCount = boxGoalCounts.typed;
    const actualBoxes = boxGoalCounts.boxes;

    if (actualBoxes !== boxCount || genericBoxCount + typedBoxCount !== actualBoxes) {
      rejections.push({ seed, reason: "validation-failed" });
      collector.recordRejection({
        reason: "validation-failed", tier: difficulty, family, mode,
        requestedBoxCount: boxCount, actualBoxCount: actualBoxes,
      });
      collector.recordBoxScale({
        requestedBoxes: boxCount,
        actualBoxes,
        goalCount: boxGoalCounts.goals,
        genericBoxes: genericBoxCount,
        typedBoxes: typedBoxCount,
        difference: actualBoxes - boxCount,
      });
      continue;
    }

    collector.recordBoxScale({
      requestedBoxes: boxCount,
      actualBoxes,
      goalCount: boxGoalCounts.goals,
      genericBoxes: genericBoxCount,
      typedBoxes: typedBoxCount,
      difference: actualBoxes - boxCount,
    });

    const provGrid = parseRowsToGrid(puzzle.rows);
    const provMetrics = analyzeGrid(provGrid);

    rawCandidates.push({
      puzzle: { ...puzzle, id: `forge-${seed}` },
      provenance: {
        seed, family, boxCount, mode,
        motifType: raw.result.motifType,
        compositionType: raw.result.compositionType,
        difficulty, tightened: cellsRemoved > 0, cellsRemoved,
        typingMode, genericBoxCount, typedBoxCount,
        dependencyRealizationRate: depRate,
        dependencyEdges: depEdges,
        dependencyRealized: depRealized,
        playableFloor: provMetrics.totalFloor,
        floorCoverage: provMetrics.floorUtilization,
        tighteningProtectedCells, preTighteningFloor, postTighteningFloor,
        mechanismTypes: raw.result.mechanismTypes,
        mechanismCount: raw.result.mechanismTypes?.length,
      },
      evaluation: ev,
      tighteningResult,
      dag: raw.result.dag,
      hints: raw.result.hints,
    });
  }

  // Dedup
  const seen = new Map<string, { candidate: ForgeCandidate; index: number }>();
  const dedupedRaw: ForgeCandidate[] = [];
  let exactDuplicatesRejected = 0;

  for (let i = 0; i < rawCandidates.length; i++) {
    const c = rawCandidates[i];
    const hash = boardHash(c.puzzle.rows);
    const existing = seen.get(hash);
    if (existing) {
      const existingScore = paretoScore(existing.candidate);
      const currentScore = paretoScore(c);
      if (currentScore > existingScore) {
        dedupedRaw[existing.index] = c;
        seen.set(hash, { candidate: c, index: existing.index });
      }
      rejections.push({ seed: c.provenance.seed, reason: "duplicate-exact" });
      exactDuplicatesRejected++;
    } else {
      seen.set(hash, { candidate: c, index: dedupedRaw.length });
      dedupedRaw.push(c);
    }
  }

  const stageA = dedupedRaw.length;

  // ---- Stage B: Structural pre-screening ----
  const structuralScored = dedupedRaw.map((c) => ({ c, score: structuralPreScore(c) }));
  structuralScored.sort((a, b) => b.score - a.score);
  const stageB_survivors = structuralScored.slice(0, budgets.preScreenRetain).map((s) => s.c);

  // ---- Stage C: Cheap forward eval screening ----
  const cheapScored = stageB_survivors.map((c) => ({ c, score: cheapEvalScore(c) }));
  cheapScored.sort((a, b) => b.score - a.score);
  const stageC_survivors = cheapScored.slice(0, budgets.finalistRetain).map((s) => s.c);

  for (let ci = 0; ci < stageC_survivors.length; ci++) {
    collector.recordFinalistPassed();
  }

  // ---- Stage D: Deep finalist eval ----
  const deepScored: Array<{ c: ForgeCandidate; deepScore: number }> = [];
  for (const c of stageC_survivors) {
    const finalist = await evaluateFinalist(c.puzzle);
    const objectives = computeCurationObjectives(
      c.evaluation,
      finalist,
      c.provenance.dependencyRealizationRate,
    );
    const deepScore = objectives.interaction + objectives.dependency +
      objectives.decisionQuality + objectives.structuralRichness +
      objectives.solverChallenge - objectives.tedium * 3;
    deepScored.push({ c, deepScore });
  }
  deepScored.sort((a, b) => b.deepScore - a.deepScore);
  const stageD_survivors = deepScored.slice(0, budgets.deepRetain).map((s) => s.c);

  for (let ci = 0; ci < stageD_survivors.length; ci++) {
    collector.recordQualityPassed();
  }

  // ---- Stage E: Pareto + novelty curation ----
  const finalCandidates = selectDiverse(
    [...stageD_survivors],
    budgets.catalogQuota,
    config.diversityMinDistance,
  );

  for (let ci = 0; ci < finalCandidates.length; ci++) {
    collector.recordCurated();
  }

  const rejectionCounts = {} as Record<ForgeRejectionReason, number>;
  for (const r of rejections) {
    rejectionCounts[r.reason] = (rejectionCounts[r.reason] ?? 0) + 1;
  }

  return {
    config,
    candidates: finalCandidates,
    rejections,
    totalAttempted: budgets.rawAttemptBudget,
    totalValid: rawCandidates.length,
    totalRetained: finalCandidates.length,
    elapsedMs: performance.now() - start,
    rejectionCounts,
    exactDuplicatesRejected,
    diagnostics: collector.build(),
    funnelStats: {
      stageA_rawGenerated: stageA,
      stageB_structuralSurvivors: stageB_survivors.length,
      stageC_cheapEvalSurvivors: stageC_survivors.length,
      stageD_deepEvalSurvivors: stageD_survivors.length,
      stageE_curatedFinal: finalCandidates.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Summary statistics
// ---------------------------------------------------------------------------

export function summarizeForgeRun(result: ForgeRunResult): ForgeSummary {
  const candidates = result.candidates;
  const n = candidates.length;

  const topologyDist: Record<string, number> = {};
  const modeDist: Record<string, number> = {};
  const motifDist: Record<string, number> = {};

  for (const c of candidates) {
    topologyDist[c.provenance.family] =
      (topologyDist[c.provenance.family] ?? 0) + 1;
    modeDist[c.provenance.mode] =
      (modeDist[c.provenance.mode] ?? 0) + 1;
    const motif =
      c.provenance.motifType ?? c.provenance.compositionType ?? "none";
    motifDist[motif] = (motifDist[motif] ?? 0) + 1;
  }

  const metricKeys = [
    "solutionMoves",
    "solutionPushes",
    "boxIndependenceRatio",
    "pushSwitchRatio",
    "boxInteractionEvents",
    "avgReachablePushes",
    "maxReachablePushes",
    "reachableForcedPushRatio",
    "sharedRouteCells",
    "sharedSupportCells",
    "sharedChokepointUses",
    "causalEnableCount",
    "causalDisableCount",
    "emptyWalkRatio",
    "longestWalkStreak",
    "repetitivePushRatio",
    "unusedFloorRatio",
    "solutionFloorCoverage",
    "solutionUnusedFloorRatio",
    "movesPerPush",
    "deadlockDensity",
    "solverExpandedStates",
    "totalFloor",
    "pushesPerBox",
  ] as const;

  const metricRanges: Record<
    string,
    { min: number; max: number; avg: number }
  > = {};

  for (const key of metricKeys) {
    if (n === 0) {
      metricRanges[key] = { min: 0, max: 0, avg: 0 };
      continue;
    }
    const values = candidates.map((c) => c.evaluation[key]);
    metricRanges[key] = {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((s, v) => s + v, 0) / n,
    };
  }

  return {
    totalAttempted: result.totalAttempted,
    totalValid: result.totalValid,
    totalRetained: result.totalRetained,
    elapsedMs: result.elapsedMs,
    msPerCandidate: result.totalAttempted > 0
      ? result.elapsedMs / result.totalAttempted
      : 0,
    rejectionCounts: result.rejectionCounts,
    topologyDistribution: topologyDist,
    modeDistribution: modeDist,
    motifDistribution: motifDist,
    metricRanges,
  };
}

// ---------------------------------------------------------------------------
// ASCII sample output with provenance
// ---------------------------------------------------------------------------

export function forgeCandidateToAscii(c: ForgeCandidate): string {
  const lines: string[] = [];
  const p = c.provenance;
  const ev = c.evaluation;

  lines.push(`=== ${c.puzzle.id} ===`);
  lines.push(
    `Seed: ${p.seed} | Family: ${p.family} | Mode: ${p.mode} | Boxes: ${p.boxCount}`,
  );
  if (p.motifType) lines.push(`Motif: ${p.motifType}`);
  if (p.compositionType) lines.push(`Composition: ${p.compositionType}`);
  lines.push(
    `Difficulty: ${p.difficulty} | Tightened: ${p.tightened} (${p.cellsRemoved} cells)`,
  );
  if (p.dependencyRealizationRate !== undefined) {
    lines.push(
      `Dependency: ${p.dependencyRealized}/${p.dependencyEdges} edges (${(p.dependencyRealizationRate * 100).toFixed(0)}%)`,
    );
  }
  lines.push("");

  for (const row of c.puzzle.rows) {
    lines.push(`  ${row}`);
  }

  lines.push("");
  lines.push(
    `Moves: ${ev.solutionMoves} | Pushes: ${ev.solutionPushes} | ` +
      `Floor: ${ev.totalFloor} | Unused: ${(ev.unusedFloorRatio * 100).toFixed(1)}%`,
  );
  lines.push(
    `BoxInd: ${ev.boxIndependenceRatio.toFixed(3)} | ` +
      `WalkRatio: ${ev.emptyWalkRatio.toFixed(3)} | ` +
      `WalkStreak: ${ev.longestWalkStreak} | ` +
      `RepPush: ${ev.repetitivePushRatio.toFixed(3)}`,
  );
  lines.push(
    `Deadlock: ${ev.deadlockDensity.toFixed(3)} | ` +
      `Solver: ${ev.solverExpandedStates} states | ` +
      `Moves/Push: ${ev.movesPerPush.toFixed(2)}`,
  );
  lines.push("");

  return lines.join("\n");
}

export function forgeRunReport(result: ForgeRunResult): string {
  const summary = summarizeForgeRun(result);
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════╗");
  lines.push("║           Puzzle Forge Run Report                ║");
  lines.push("╚══════════════════════════════════════════════════╝");
  lines.push("");

  lines.push("Pipeline:");
  lines.push(
    `  Attempted: ${summary.totalAttempted} | Valid: ${summary.totalValid} | Retained: ${summary.totalRetained}`,
  );
  lines.push(
    `  Runtime: ${(summary.elapsedMs / 1000).toFixed(1)}s | Per candidate: ${summary.msPerCandidate.toFixed(0)}ms`,
  );
  lines.push("");

  lines.push("Rejection reasons:");
  const reasons = Object.entries(summary.rejectionCounts).sort(
    (a, b) => b[1] - a[1],
  );
  for (const [reason, count] of reasons) {
    lines.push(`  ${reason.padEnd(30)} ${count}`);
  }
  lines.push("");

  lines.push("Topology distribution:");
  for (const [family, count] of Object.entries(
    summary.topologyDistribution,
  )) {
    lines.push(`  ${family.padEnd(12)} ${count}`);
  }
  lines.push("");

  lines.push("Mode distribution:");
  for (const [mode, count] of Object.entries(summary.modeDistribution)) {
    lines.push(`  ${mode.padEnd(12)} ${count}`);
  }
  lines.push("");

  lines.push("Motif/composition distribution:");
  for (const [motif, count] of Object.entries(
    summary.motifDistribution,
  )) {
    lines.push(`  ${motif.padEnd(20)} ${count}`);
  }
  lines.push("");

  lines.push("Metric ranges (retained puzzles):");
  lines.push(
    `  ${"Metric".padEnd(26)} ${"Min".padStart(10)} ${"Max".padStart(10)} ${"Avg".padStart(10)}`,
  );
  lines.push(
    `  ${"─".repeat(26)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(10)}`,
  );
  for (const [key, range] of Object.entries(summary.metricRanges)) {
    lines.push(
      `  ${key.padEnd(26)} ${range.min.toFixed(3).padStart(10)} ${range.max.toFixed(3).padStart(10)} ${range.avg.toFixed(3).padStart(10)}`,
    );
  }
  lines.push("");

  if (result.diagnostics) {
    lines.push(formatDiagnosticReport(result.diagnostics));
  }

  if (result.candidates.length > 0) {
    const sampleCount = Math.min(3, result.candidates.length);
    lines.push(`Sample puzzles (${sampleCount} of ${result.candidates.length}):`);
    lines.push("");
    for (let i = 0; i < sampleCount; i++) {
      lines.push(forgeCandidateToAscii(result.candidates[i]));
    }
  }

  return lines.join("\n");
}
