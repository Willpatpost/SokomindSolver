import type { Difficulty, PuzzleDefinition } from "../../../core/model.ts";
import type { TopologyFamily } from "./blueprint-types.ts";
import type { BeamSearchParams } from "./reverse-beam-search.ts";
import type { PuzzleEvaluationVector } from "./puzzle-evaluator.ts";
import type { MotifType, DependencyHint } from "./motifs.ts";
import type {
  ComposedPuzzleResult,
  CompositionType,
  DependencyDAG,
} from "./dependency-graph.ts";
import type { TighteningParams, TighteningResult } from "./geometry-tightening.ts";

import {
  generateBlueprintWithRetry,
} from "./blueprint-graph.ts";
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
  DEFAULT_BEAM_PARAMS,
} from "./reverse-beam-search.ts";
import { evaluatePuzzleWithSteps } from "./puzzle-evaluator.ts";
import {
  generateComposedPuzzle,
  generateVerifiedMotifPuzzle,
  DEFAULT_COMPOSITION_PARAMS,
} from "./dependency-graph.ts";
import {
  tightenPuzzle,
  DEFAULT_TIGHTENING_PARAMS,
} from "./geometry-tightening.ts";

import { validatePuzzle } from "../../../core/puzzle.ts";
import { buildPuzzleFromScramble } from "../generate-puzzle.ts";
import { assignLabels } from "../label-assignment.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ForgeGenerationMode } from "./forge-sampling.ts";

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
  readonly gates: ForgeAcceptanceGates;
  readonly diversityMinDistance: number;
  readonly baseSeed: number;
  readonly useLabels: boolean;
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
  useLabels: true,
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
  readonly labeled: boolean;
  readonly dependencyRealizationRate?: number;
  readonly dependencyEdges?: number;
  readonly dependencyRealized?: number;
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
  | "motif-failed"
  | "composition-failed"
  | "duplicate-exact"
  | "difficulty-mismatch"
  | "duplicate-cross-tier"
  | "duplicate-symmetry";

export interface ForgeRejection {
  readonly seed: number;
  readonly reason: ForgeRejectionReason;
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
  const bp = generateBlueprintWithRetry(
    {
      ...DEFAULT_BLUEPRINT_PARAMS,
      seed,
      family,
      boardWidth: config.boardWidth,
      boardHeight: config.boardHeight,
    },
    config.blueprintRetries,
  );
  if (!bp) return { ok: false, reason: "blueprint-failed" };

  const fb = assignRoomRoles(bp, seed, boxCount);

  if (mode === "composed") {
    const result = await generateComposedPuzzle(fb, {
      ...DEFAULT_COMPOSITION_PARAMS,
      seed,
      boxCount,
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

  const solved = placeGoals(fb, {
    ...DEFAULT_GOAL_PARAMS,
    seed,
    boxCount,
  });
  if (!solved) return { ok: false, reason: "goal-placement-failed" };

  const template = toSolvedTemplate(solved);
  const beamParams: BeamSearchParams = {
    ...DEFAULT_BEAM_PARAMS,
    seed,
    ...config.beamParams,
  };
  const beam = reverseBeamSearch(solved, beamParams);
  if (beam.best.depth === 0) {
    return { ok: false, reason: "beam-search-empty" };
  }

  const scrambled = {
    template,
    boxPositions: beam.best.boxPositions as Array<{
      row: number;
      column: number;
    }>,
    robotPosition: beam.best.robotPosition,
    reversePulls: beam.best.depth,
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
  const start = performance.now();
  const rejections: ForgeRejection[] = [];
  const validCandidates: ForgeCandidate[] = [];

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
      continue;
    }

    let puzzle = raw.result.puzzle;
    let tighteningResult: TighteningResult | undefined;
    let cellsRemoved = 0;

    const tResult = await tightenPuzzle(puzzle, config.tighteningParams);
    if (tResult && tResult.cellsRemoved > 0) {
      puzzle = tResult.tightened;
      tighteningResult = tResult;
      cellsRemoved = tResult.cellsRemoved;
    }

    const evalResult = await evaluatePuzzleWithSteps(puzzle);
    const ev = evalResult.vector;
    if (!ev.solved) {
      rejections.push({ seed, reason: "unsolvable" });
      continue;
    }

    const gateResult = applyGates(
      ev,
      config.gates,
      raw.result.dependencyRealizationRate,
    );
    if (gateResult) {
      rejections.push({ seed, reason: gateResult });
      continue;
    }

    let labeled = false;
    if (config.useLabels && boxCount >= 2 && evalResult.steps) {
      const solution = {
        steps: evalResult.steps,
        moves: ev.solutionMoves,
        pushes: ev.solutionPushes,
        objective: { kind: "moves" as const },
        objectiveScore: ev.solutionMoves,
        optimality: "unknown" as const,
      };
      const labelRng = (() => {
        let s = (seed * 2654435761 + 999983) | 0;
        return () => { s = (s * 1103515245 + 12345) | 0; return (s >>> 0) / 0x100000000; };
      })();
      const labeledPuzzle = assignLabels(puzzle, solution, labelRng);
      if (labeledPuzzle !== puzzle) {
        const labelValidation = validatePuzzle(labeledPuzzle);
        if (labelValidation.valid) {
          puzzle = labeledPuzzle;
          labeled = true;
        }
      }
    }

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
      labeled,
      dependencyRealizationRate: raw.result.dependencyRealizationRate,
      dependencyEdges: raw.result.composedResult?.realization.totalEdges,
      dependencyRealized: raw.result.composedResult?.realization.realizedEdges,
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
