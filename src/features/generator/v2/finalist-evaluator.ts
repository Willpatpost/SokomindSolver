import type { PuzzleDefinition } from "../../../core/model.ts";
import type {
  SolverAdapter,
  SolverExecutionContext,
  SolverRequest,
} from "../../../solver/contracts.ts";
import { createSession } from "../../../core/game-session.ts";
import { classicGreedySolver, classicAStarSolver } from "../../../solver/implementations/classic-solvers.ts";

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
    ev.sharedRouteCells * 0.3 +
    ev.causalEnableCount * 0.4 +
    ev.causalDisableCount * 0.3;

  const dependency = dependencyRealizationRate ?? 0;

  const decisionQuality =
    ev.avgReachablePushes * 0.4 +
    (1 - ev.reachableForcedPushRatio) * 0.3 +
    (1 - ev.repetitivePushRatio) * 0.3;

  const structuralRichness =
    (1 - ev.unusedFloorRatio) * 0.4 +
    ev.deadlockDensity * 0.3 +
    Math.min(ev.boxCount / 6, 1) * 0.3;

  const solverChallenge =
    Math.log2(Math.max(finalist.avgExpandedStates, 1)) * 0.5 +
    Math.min(ev.solutionPushes / 30, 1) * 0.5;

  const tedium =
    ev.emptyWalkRatio * 0.3 +
    ev.repetitivePushRatio * 0.3 +
    Math.min(ev.movesPerPush / 10, 1) * 0.2 +
    Math.min(ev.longestWalkStreak / 20, 1) * 0.2;

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
