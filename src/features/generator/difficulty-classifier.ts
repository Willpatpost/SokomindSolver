import type { Difficulty, PuzzleDefinition } from "../../core/model.ts";
import type {
  SolverExecutionContext,
  SolverResult,
  SolverSolution,
} from "../../solver/contracts.ts";
import { createSession } from "../../core/game-session.ts";
import { classicGreedySolver } from "../../solver/implementations/classic-solvers.ts";
import type { ClassificationResult } from "./generator-types.ts";

interface DifficultyThresholds {
  readonly maxMoves: number;
  readonly maxPushes: number;
  readonly maxBoxes: number;
}

const DIFFICULTY_THRESHOLDS: Record<Difficulty, DifficultyThresholds> = {
  tutorial: { maxMoves: 10, maxPushes: 5, maxBoxes: 2 },
  beginner: { maxMoves: 25, maxPushes: 15, maxBoxes: 3 },
  intermediate: { maxMoves: 80, maxPushes: 40, maxBoxes: 5 },
  advanced: { maxMoves: 200, maxPushes: 80, maxBoxes: 7 },
  expert: { maxMoves: 500, maxPushes: 200, maxBoxes: 10 },
  master: {
    maxMoves: Number.POSITIVE_INFINITY,
    maxPushes: Number.POSITIVE_INFINITY,
    maxBoxes: Number.POSITIVE_INFINITY,
  },
};

const TIER_ORDER: readonly Difficulty[] = [
  "tutorial",
  "beginner",
  "intermediate",
  "advanced",
  "expert",
  "master",
];

export function classifyFromMetrics(
  moves: number,
  pushes: number,
  boxCount: number,
): Difficulty {
  for (const tier of TIER_ORDER) {
    if (tier === "master") return "master";
    const t = DIFFICULTY_THRESHOLDS[tier];
    if (moves <= t.maxMoves && pushes <= t.maxPushes && boxCount <= t.maxBoxes) {
      return tier;
    }
  }
  return "master";
}

function createMainThreadContext(
  signal?: AbortSignal,
): SolverExecutionContext {
  return {
    signal: signal ?? new AbortController().signal,
    reportProgress: () => {},
    now: () => performance.now(),
  };
}

export async function classifyPuzzleDifficulty(
  puzzle: PuzzleDefinition,
  signal?: AbortSignal,
): Promise<ClassificationResult | null> {
  const session = createSession(puzzle);
  const request = {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" as const },
    limits: { maxElapsedMs: 5_000, maxExpandedStates: 500_000 },
  };
  const context = createMainThreadContext(signal);
  const result: SolverResult = await classicGreedySolver.solve(request, context);

  if (result.status !== "solved") return null;

  const { moves, pushes } = result.solution;
  const difficulty = classifyFromMetrics(moves, pushes, puzzle.boxes);

  return {
    difficulty,
    moves,
    pushes,
    expandedStates: result.metrics.expandedStates ?? 0,
    elapsedMs: result.metrics.elapsedMs,
  };
}

export async function solvePuzzleForSteps(
  puzzle: PuzzleDefinition,
  signal?: AbortSignal,
): Promise<SolverSolution | null> {
  const session = createSession(puzzle);
  const request = {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" as const },
    limits: { maxElapsedMs: 10_000, maxExpandedStates: 1_000_000 },
  };
  const context = createMainThreadContext(signal);
  const result: SolverResult = await classicGreedySolver.solve(request, context);

  if (result.status !== "solved") return null;
  return result.solution;
}
