import type { Difficulty, PuzzleDefinition } from "../../core/model.ts";
import { validatePuzzle } from "../../core/puzzle.ts";
import { generateBoardTemplate, createRng } from "./board-template.ts";
import { scrambleByReversePull } from "./reverse-play.ts";
import { assignLabels } from "./label-assignment.ts";
import {
  classifyPuzzleDifficulty,
  solvePuzzleForSteps,
} from "./difficulty-classifier.ts";
import {
  PULL_COUNTS,
  type GeneratorParams,
  type GenerationResult,
  type GeneratorProgressCallback,
  type ScrambledState,
  type GridPosition,
} from "./generator-types.ts";

const DIFFICULTIES_ORDERED: readonly Difficulty[] = [
  "tutorial",
  "beginner",
  "intermediate",
  "advanced",
  "expert",
  "master",
];

function tierIndex(d: Difficulty): number {
  return DIFFICULTIES_ORDERED.indexOf(d);
}

function difficultyAcceptable(
  target: Difficulty,
  actual: Difficulty,
): boolean {
  return Math.abs(tierIndex(target) - tierIndex(actual)) <= 1;
}

function closerToTarget(
  a: Difficulty,
  b: Difficulty,
  target: Difficulty,
): boolean {
  return (
    Math.abs(tierIndex(target) - tierIndex(a)) <
    Math.abs(tierIndex(target) - tierIndex(b))
  );
}

function posKey(p: GridPosition): string {
  return `${p.row},${p.column}`;
}

function allBoxesOffGoals(scrambled: ScrambledState): boolean {
  const goalKeys = new Set(scrambled.template.goalPositions.map(posKey));
  return scrambled.boxPositions.every((bp) => !goalKeys.has(posKey(bp)));
}

export function buildPuzzleFromScramble(
  scrambled: ScrambledState,
  difficulty: Difficulty,
): PuzzleDefinition {
  const { template, boxPositions, robotPosition } = scrambled;
  const grid: string[][] = template.grid.map((row) => [...row]);

  for (const gp of template.goalPositions) {
    grid[gp.row][gp.column] = "S";
  }

  for (const bp of boxPositions) {
    grid[bp.row][bp.column] = "X";
  }

  grid[robotPosition.row][robotPosition.column] = "R";

  const rows = grid.map((row) => row.join(""));

  return {
    id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "Generated Puzzle",
    difficulty,
    boxes: boxPositions.length,
    rows,
  };
}

export async function generatePuzzle(
  params: GeneratorParams,
  onProgress?: GeneratorProgressCallback,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  const rng = createRng(seed);
  const pullRange = PULL_COUNTS[params.targetDifficulty];

  let bestPuzzle: PuzzleDefinition | null = null;
  let bestDifficulty: Difficulty | null = null;
  let bestMoves = 0;
  let bestPushes = 0;
  let lastReason = "No attempts completed";

  for (let attempt = 1; attempt <= params.maxAttempts; attempt++) {
    if (signal?.aborted) {
      return { status: "failed", attempts: attempt - 1, lastReason: "Cancelled" };
    }

    onProgress?.({
      attempt,
      maxAttempts: params.maxAttempts,
      phase: "generating",
      message: `Generating board (attempt ${attempt})...`,
    });

    // Yield to event loop between attempts
    await new Promise((r) => setTimeout(r, 0));

    let template;
    try {
      template = generateBoardTemplate(
        params.width,
        params.height,
        params.boxCount,
        rng,
      );
    } catch {
      lastReason = "Failed to generate board template";
      continue;
    }

    const pullCount =
      pullRange.min + Math.floor(rng() * (pullRange.max - pullRange.min + 1));
    const scrambled = scrambleByReversePull(template, pullCount, rng);

    if (scrambled.reversePulls < Math.max(1, Math.floor(pullRange.min / 2))) {
      lastReason = "Too few reverse pulls succeeded";
      continue;
    }

    if (!allBoxesOffGoals(scrambled)) {
      lastReason = "Some boxes remain on their goals";
      continue;
    }

    const puzzle = buildPuzzleFromScramble(scrambled, params.targetDifficulty);

    const validation = validatePuzzle(puzzle);
    if (!validation.valid) {
      lastReason = `Validation failed: ${validation.errors.map((e) => e.message).join("; ")}`;
      continue;
    }

    onProgress?.({
      attempt,
      maxAttempts: params.maxAttempts,
      phase: "solving",
      message: `Solving puzzle (attempt ${attempt})...`,
    });

    const classification = await classifyPuzzleDifficulty(puzzle, signal);
    if (classification === null) {
      lastReason = "Puzzle is unsolvable or solver timed out";
      continue;
    }

    onProgress?.({
      attempt,
      maxAttempts: params.maxAttempts,
      phase: "classifying",
      message: `Classified as ${classification.difficulty} (${classification.moves} moves, ${classification.pushes} pushes)`,
    });

    const isAcceptable = difficultyAcceptable(
      params.targetDifficulty,
      classification.difficulty,
    );

    if (
      bestPuzzle === null ||
      (isAcceptable && bestDifficulty !== params.targetDifficulty) ||
      (isAcceptable &&
        bestDifficulty !== null &&
        closerToTarget(
          classification.difficulty,
          bestDifficulty,
          params.targetDifficulty,
        ))
    ) {
      bestPuzzle = { ...puzzle, difficulty: classification.difficulty };
      bestDifficulty = classification.difficulty;
      bestMoves = classification.moves;
      bestPushes = classification.pushes;
    }

    if (!isAcceptable) {
      lastReason = `Classified as ${classification.difficulty}, wanted ${params.targetDifficulty}`;
      continue;
    }

    let finalPuzzle: PuzzleDefinition = {
      ...puzzle,
      difficulty: classification.difficulty,
    };

    if (params.useLabels && puzzle.boxes >= 2) {
      const solution = await solvePuzzleForSteps(finalPuzzle, signal);
      if (solution) {
        finalPuzzle = assignLabels(finalPuzzle, solution, rng);
      }
    }

    return {
      status: "success",
      puzzle: finalPuzzle,
      attempts: attempt,
      solverMoves: classification.moves,
      solverPushes: classification.pushes,
    };
  }

  if (bestPuzzle && bestDifficulty) {
    let finalPuzzle = bestPuzzle;
    if (params.useLabels && finalPuzzle.boxes >= 2) {
      const solution = await solvePuzzleForSteps(finalPuzzle, signal);
      if (solution) {
        finalPuzzle = assignLabels(finalPuzzle, solution, rng);
      }
    }
    return {
      status: "success",
      puzzle: finalPuzzle,
      attempts: params.maxAttempts,
      solverMoves: bestMoves,
      solverPushes: bestPushes,
    };
  }

  return {
    status: "failed",
    attempts: params.maxAttempts,
    lastReason,
  };
}
