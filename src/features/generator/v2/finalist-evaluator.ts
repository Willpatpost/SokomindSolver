import type { PuzzleDefinition } from "../../../core/model.ts";
import type {
  SolverAdapter,
  SolverExecutionContext,
  SolverRequest,
  SolutionStep,
} from "../../../solver/contracts.ts";
import { createSession, stepSnapshot } from "../../../core/game-session.ts";
import {
  classicGreedySolver,
  classicAStarSolver,
  classicIdaStarSolver,
} from "../../../solver/implementations/classic-solvers.ts";
import {
  assignSolverRoles,
  type SolverRole,
  type V4EvaluatorPolicy,
  DEFAULT_V4_POLICY,
} from "./solver-bottleneck.ts";

export interface SolverEvidence {
  readonly solverId: string;
  readonly status: string;
  readonly moves?: number;
  readonly pushes?: number;
  readonly expandedStates?: number;
  readonly generatedStates?: number;
  readonly elapsedMs?: number;
  readonly optimalityProven?: boolean;
}

export interface FinalistEvaluation {
  readonly solverEvidence: readonly SolverEvidence[];
  readonly solverAgreement: boolean;
  readonly minMoves: number;
  readonly maxMoves: number;
  readonly minPushes: number;
  readonly maxPushes: number;
  readonly avgExpandedStates: number;
  readonly maxExpandedStates: number;
  readonly solversSucceeded: number;
  readonly solversAttempted: number;
}

export interface CurationObjectives {
  readonly interaction: number;
  readonly dependency: number;
  readonly decisionQuality: number;
  readonly structuralRichness: number;
  readonly solverChallenge: number;
  readonly novelty: number;
  readonly tedium: number;
}

function createContext(signal?: AbortSignal): SolverExecutionContext {
  return {
    signal: signal ?? new AbortController().signal,
    reportProgress: () => {},
    now: () => performance.now(),
  };
}

async function runSolver(
  solverId: string,
  solver: SolverAdapter,
  puzzle: PuzzleDefinition,
  limits: { maxElapsedMs: number; maxExpandedStates: number },
  signal?: AbortSignal,
): Promise<SolverEvidence> {
  const session = createSession(puzzle);
  const request: SolverRequest = {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" as const },
    limits,
  };
  const context = createContext(signal);

  try {
    const result = await solver.solve(request, context);
    if (result.status === "solved") {
      return {
        solverId,
        status: "solved",
        moves: result.solution.moves,
        pushes: result.solution.pushes,
        expandedStates: result.metrics.expandedStates,
        generatedStates: result.metrics.generatedStates,
        elapsedMs: result.metrics.elapsedMs,
        optimalityProven: result.solution.optimality === "proven",
      };
    }
    return {
      solverId,
      status: result.status === "unsolved" ? `unsolved:${result.reason}` : result.status,
      expandedStates: result.metrics.expandedStates,
      generatedStates: result.metrics.generatedStates,
      elapsedMs: result.metrics.elapsedMs,
    };
  } catch {
    return { solverId, status: "error" };
  }
}

export interface FinalistEvaluatorConfig {
  readonly maxElapsedMs: number;
  readonly maxExpandedStates: number;
}

export const DEFAULT_FINALIST_CONFIG: FinalistEvaluatorConfig = {
  maxElapsedMs: 15_000,
  maxExpandedStates: 2_000_000,
};

export async function evaluateFinalist(
  puzzle: PuzzleDefinition,
  config: FinalistEvaluatorConfig = DEFAULT_FINALIST_CONFIG,
  signal?: AbortSignal,
): Promise<FinalistEvaluation> {
  const limits = {
    maxElapsedMs: config.maxElapsedMs,
    maxExpandedStates: config.maxExpandedStates,
  };

  const evidence = await Promise.all([
    runSolver("greedy", classicGreedySolver, puzzle, limits, signal),
    runSolver("astar", classicAStarSolver, puzzle, limits, signal),
  ]);

  const solved = evidence.filter((e) => e.status === "solved");
  const moveValues = solved.filter((e) => e.moves !== undefined).map((e) => e.moves!);
  const pushValues = solved.filter((e) => e.pushes !== undefined).map((e) => e.pushes!);
  const expandedValues = evidence
    .filter((e) => e.expandedStates !== undefined)
    .map((e) => e.expandedStates!);

  const solverAgreement = moveValues.length >= 2 &&
    moveValues.every((m) => m === moveValues[0]);

  return {
    solverEvidence: evidence,
    solverAgreement,
    minMoves: moveValues.length > 0 ? Math.min(...moveValues) : 0,
    maxMoves: moveValues.length > 0 ? Math.max(...moveValues) : 0,
    minPushes: pushValues.length > 0 ? Math.min(...pushValues) : 0,
    maxPushes: pushValues.length > 0 ? Math.max(...pushValues) : 0,
    avgExpandedStates:
      expandedValues.length > 0
        ? expandedValues.reduce((s, v) => s + v, 0) / expandedValues.length
        : 0,
    maxExpandedStates:
      expandedValues.length > 0 ? Math.max(...expandedValues) : 0,
    solversSucceeded: solved.length,
    solversAttempted: evidence.length,
  };
}

export async function evaluateFinalists(
  puzzles: readonly PuzzleDefinition[],
  config: FinalistEvaluatorConfig = DEFAULT_FINALIST_CONFIG,
  signal?: AbortSignal,
): Promise<readonly FinalistEvaluation[]> {
  const results: FinalistEvaluation[] = [];
  for (const puzzle of puzzles) {
    if (signal?.aborted) break;
    results.push(await evaluateFinalist(puzzle, config, signal));
  }
  return results;
}

export function computeCurationObjectives(
  ev: import("./puzzle-evaluator.ts").PuzzleEvaluationVector,
  finalist: FinalistEvaluation,
  dependencyRealizationRate?: number,
): CurationObjectives {
  const interaction =
    Math.log2(ev.sharedRouteCells + 1) * 0.25 +
    Math.log2(ev.causalEnableCount + 1) * 0.3 +
    Math.log2(ev.causalDisableCount + 1) * 0.25 +
    Math.log2(ev.sharedChokepointUses + 1) * 0.2;

  const dependency = (dependencyRealizationRate ?? 0) +
    ev.estimatedDependencyDepth * 0.15 +
    ev.goalOrderConstraints * 0.05;

  const decisionQuality =
    Math.log2(ev.avgReachablePushes + 1) * 0.3 +
    (1 - ev.reachableForcedPushRatio) * 0.2 +
    (1 - ev.repetitivePushRatio) * 0.15 +
    ev.nonMonotonicBoxMoves * 0.15 +
    ev.stagingOperations * 0.1 +
    ev.temporaryGoalVacancies * 0.1;

  const structuralRichness =
    (1 - ev.solutionUnusedFloorRatio) * 0.25 +
    Math.log2(ev.deadlockDensity * 100 + 1) * 0.15 +
    Math.log2(ev.boxCount + 1) * 0.2 +
    Math.log2(ev.regionCount + 1) * 0.15 +
    Math.log2(ev.chokepoints + 1) * 0.15 +
    Math.log2(ev.articulationPoints + 1) * 0.1;

  const solverChallenge =
    Math.log2(Math.max(finalist.avgExpandedStates, 1)) * 0.4 +
    Math.log2(ev.solutionPushes + 1) * 0.35 +
    Math.log2(ev.roomCrossingsInSolution + 1) * 0.25;

  const tedium =
    ev.emptyWalkRatio * 0.25 +
    ev.repetitivePushRatio * 0.25 +
    Math.min(ev.movesPerPush / 15, 1) * 0.2 +
    Math.min(ev.longestWalkStreak / 30, 1) * 0.15 +
    ev.solutionUnusedFloorRatio * 0.15;

  return {
    interaction,
    dependency,
    decisionQuality,
    structuralRichness,
    solverChallenge,
    novelty: 0,
    tedium,
  };
}

// ---------------------------------------------------------------------------
// V4 multi-role evaluator
// ---------------------------------------------------------------------------

export interface FinalistEvaluationV4 extends FinalistEvaluation {
  readonly roleResults: ReadonlyMap<SolverRole, SolverEvidence>;
  readonly policyApplied: V4EvaluatorPolicy;
  readonly witnessValid: boolean;
  readonly proofSkipped: boolean;
  readonly proofSkipReason?: string;
}

function countFloorCells(puzzle: PuzzleDefinition): number {
  let count = 0;
  for (const row of puzzle.rows) {
    for (const ch of row) {
      if (ch !== "O") count++;
    }
  }
  return count;
}

function replayWitnessSteps(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
): boolean {
  const session = createSession(puzzle);
  let snapshot = session.snapshot;
  for (const step of steps) {
    const transition = stepSnapshot(session.board, snapshot, step.direction);
    if (!transition.moved) return false;
    snapshot = transition.snapshot;
  }
  return snapshot.solved;
}

export async function evaluateFinalistV4(
  puzzle: PuzzleDefinition,
  policy: V4EvaluatorPolicy = DEFAULT_V4_POLICY,
  witnessSteps?: readonly SolutionStep[],
  signal?: AbortSignal,
): Promise<FinalistEvaluationV4> {
  const totalFloor = countFloorCells(puzzle);
  const roles = assignSolverRoles(puzzle.boxes, totalFloor, policy);

  const roleResults = new Map<SolverRole, SolverEvidence>();
  const allEvidence: SolverEvidence[] = [];

  // 1. Witness validation
  let witnessValid = false;
  if (witnessSteps && witnessSteps.length > 0) {
    witnessValid = replayWitnessSteps(puzzle, witnessSteps);
  }
  // If no steps provided, attempt greedy with tight witness budget
  if (!witnessSteps) {
    const witnessRole = roles.find((r) => r.role === "witness");
    if (witnessRole) {
      const ev = await runSolver(
        "greedy-witness",
        classicGreedySolver,
        puzzle,
        witnessRole.limits,
        signal,
      );
      roleResults.set("witness", ev);
      allEvidence.push(ev);
      witnessValid = ev.status === "solved";
    }
  } else {
    roleResults.set("witness", {
      solverId: "witness-replay",
      status: witnessValid ? "solved" : "invalid",
      moves: witnessSteps.filter((s) => s.kind === "walk" || s.kind === "push").length,
      pushes: witnessSteps.filter((s) => s.kind === "push").length,
    });
  }

  // 2. Fast probe (greedy with probe limits)
  const fastProbeRole = roles.find((r) => r.role === "fast-probe");
  if (fastProbeRole) {
    const ev = await runSolver(
      "greedy",
      classicGreedySolver,
      puzzle,
      fastProbeRole.limits,
      signal,
    );
    roleResults.set("fast-probe", ev);
    allEvidence.push(ev);
  }

  // 3. Exact evidence (A* with evidence limits)
  const exactRole = roles.find((r) => r.role === "exact-evidence");
  if (exactRole) {
    const ev = await runSolver(
      "astar",
      classicAStarSolver,
      puzzle,
      exactRole.limits,
      signal,
    );
    roleResults.set("exact-evidence", ev);
    allEvidence.push(ev);
  }

  // 4. Optional proof (IDA* with proof limits, only if puzzle qualifies)
  const proofRole = roles.find((r) => r.role === "optional-proof");
  let proofSkipped = false;
  let proofSkipReason: string | undefined;

  if (proofRole) {
    const ev = await runSolver(
      "ida-star",
      classicIdaStarSolver,
      puzzle,
      proofRole.limits,
      signal,
    );
    roleResults.set("optional-proof", ev);
    allEvidence.push(ev);
  } else {
    proofSkipped = true;
    if (puzzle.boxes > policy.proofMaxBoxes) {
      proofSkipReason = `boxCount ${puzzle.boxes} exceeds proofMaxBoxes ${policy.proofMaxBoxes}`;
    } else if (totalFloor > policy.proofMaxFloor) {
      proofSkipReason = `totalFloor ${totalFloor} exceeds proofMaxFloor ${policy.proofMaxFloor}`;
    } else {
      proofSkipReason = "puzzle exceeds proof limits";
    }
  }

  // Build base FinalistEvaluation fields from allEvidence
  const solved = allEvidence.filter((e) => e.status === "solved");
  const moveValues = solved
    .filter((e) => e.moves !== undefined)
    .map((e) => e.moves!);
  const pushValues = solved
    .filter((e) => e.pushes !== undefined)
    .map((e) => e.pushes!);
  const expandedValues = allEvidence
    .filter((e) => e.expandedStates !== undefined)
    .map((e) => e.expandedStates!);

  const solverAgreement =
    moveValues.length >= 2 && moveValues.every((m) => m === moveValues[0]);

  return {
    solverEvidence: allEvidence,
    solverAgreement,
    minMoves: moveValues.length > 0 ? Math.min(...moveValues) : 0,
    maxMoves: moveValues.length > 0 ? Math.max(...moveValues) : 0,
    minPushes: pushValues.length > 0 ? Math.min(...pushValues) : 0,
    maxPushes: pushValues.length > 0 ? Math.max(...pushValues) : 0,
    avgExpandedStates:
      expandedValues.length > 0
        ? expandedValues.reduce((s, v) => s + v, 0) / expandedValues.length
        : 0,
    maxExpandedStates:
      expandedValues.length > 0 ? Math.max(...expandedValues) : 0,
    solversSucceeded: solved.length,
    solversAttempted: allEvidence.length,
    roleResults,
    policyApplied: policy,
    witnessValid,
    proofSkipped,
    proofSkipReason,
  };
}
