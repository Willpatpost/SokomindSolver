import type { PuzzleDefinition } from "../../core/model.ts";
import type { SolverSolution, SolutionStep } from "../../solver/contracts.ts";
import { parsePuzzle } from "../../core/puzzle.ts";
import { stepSnapshot } from "../../core/game-session.ts";
import type { GridPosition } from "./generator-types.ts";
import { shuffleArray } from "./shuffle.ts";

export const VALID_LABELS = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "P", "Q", "T", "U", "V", "W", "Y", "Z",
] as const;

function posKey(pos: GridPosition): string {
  return `${pos.row},${pos.column}`;
}

export function traceBoxGoalPairing(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
): Map<number, number> {
  const board = parsePuzzle(puzzle);
  let snapshot = {
    puzzleId: puzzle.id,
    robot: board.initialRobot,
    boxes: board.initialBoxes,
    moves: 0,
    pushes: 0,
    solved: false,
  };

  for (const step of steps) {
    const transition = stepSnapshot(board, snapshot, step.direction);
    if (transition.moved) {
      snapshot = transition.snapshot;
    }
  }

  const goalMap = new Map<string, number>();
  for (let i = 0; i < board.goals.length; i++) {
    goalMap.set(posKey(board.goals[i].position), i);
  }

  const pairing = new Map<number, number>();
  for (let i = 0; i < snapshot.boxes.length; i++) {
    const goalIdx = goalMap.get(posKey(snapshot.boxes[i].position));
    if (goalIdx !== undefined) {
      pairing.set(i, goalIdx);
    }
  }

  return pairing;
}

export function findPathCrossings(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
): Array<[number, number]> {
  const board = parsePuzzle(puzzle);
  const boxCount = board.initialBoxes.length;

  const paths: GridPosition[][] = Array.from({ length: boxCount }, () => []);
  for (let i = 0; i < boxCount; i++) {
    paths[i].push(board.initialBoxes[i].position);
  }

  let snapshot = {
    puzzleId: puzzle.id,
    robot: board.initialRobot,
    boxes: board.initialBoxes,
    moves: 0,
    pushes: 0,
    solved: false,
  };

  for (const step of steps) {
    const prevBoxes = snapshot.boxes;
    const transition = stepSnapshot(board, snapshot, step.direction);
    if (!transition.moved) continue;
    snapshot = transition.snapshot;

    for (let i = 0; i < boxCount; i++) {
      if (
        snapshot.boxes[i].position.row !== prevBoxes[i].position.row ||
        snapshot.boxes[i].position.column !== prevBoxes[i].position.column
      ) {
        paths[i].push(snapshot.boxes[i].position);
      }
    }
  }

  const crossings: Array<[number, number]> = [];
  for (let i = 0; i < boxCount; i++) {
    for (let j = i + 1; j < boxCount; j++) {
      if (pathsCross(paths[i], paths[j])) {
        crossings.push([i, j]);
      }
    }
  }

  return crossings;
}

function pathsCross(pathA: GridPosition[], pathB: GridPosition[]): boolean {
  const cellsA = new Set(pathA.map(posKey));
  for (const pos of pathB) {
    if (cellsA.has(posKey(pos))) return true;
  }

  if (pathA.length < 2 || pathB.length < 2) return false;
  const startA = pathA[0];
  const endA = pathA[pathA.length - 1];
  const startB = pathB[0];
  const endB = pathB[pathB.length - 1];

  const rowOrderFlipped =
    (startA.row - startB.row) * (endA.row - endB.row) < 0;
  const colOrderFlipped =
    (startA.column - startB.column) * (endA.column - endB.column) < 0;

  return rowOrderFlipped || colOrderFlipped;
}

export function assignPartialLabels(
  puzzle: PuzzleDefinition,
  solution: SolverSolution,
  rng: () => number,
  typedFraction: number,
): PuzzleDefinition {
  const board = parsePuzzle(puzzle);
  const boxCount = board.initialBoxes.length;

  if (boxCount < 2) return puzzle;

  const pairing = traceBoxGoalPairing(puzzle, solution.steps);
  if (pairing.size !== boxCount) return puzzle;

  // Determine how many pairs to type, ensuring at least 1 typed and 1 generic
  let typedCount = Math.round(boxCount * typedFraction);
  typedCount = Math.max(1, Math.min(typedCount, boxCount - 1));
  if (typedCount > VALID_LABELS.length) return puzzle;

  // Build an index array [0..boxCount-1] and shuffle to pick which pairs get typed
  const indices = Array.from({ length: boxCount }, (_, i) => i);
  shuffleArray(indices, rng);
  const crossings = findPathCrossings(puzzle, solution.steps);
  const typedSet = maximizeCrossTypeRouteInteractions(
    indices,
    typedCount,
    crossings,
  );

  // Assign labels only to typed pairs; leave the rest as X/S
  const labels = VALID_LABELS.slice(0, typedCount) as unknown as string[];
  const labelsCopy = [...labels];
  shuffleArray(labelsCopy, rng);

  const boxLabelMap = new Map<string, string>();
  const goalLabelMap = new Map<string, string>();

  let labelIdx = 0;
  for (let i = 0; i < boxCount; i++) {
    if (!typedSet.has(i)) continue;
    const goalIdx = pairing.get(i);
    if (goalIdx === undefined) return puzzle;
    const label = labelsCopy[labelIdx++];
    boxLabelMap.set(posKey(board.initialBoxes[i].position), label);
    goalLabelMap.set(posKey(board.goals[goalIdx].position), label.toLowerCase());
  }

  const newRows = puzzle.rows.map((row, r) =>
    row
      .split("")
      .map((ch, c) => {
        const key = `${r},${c}`;
        if (ch === "X") {
          const label = boxLabelMap.get(key);
          return label ?? ch;
        }
        if (ch === "S") {
          const label = goalLabelMap.get(key);
          return label ?? ch;
        }
        return ch;
      })
      .join(""),
  );

  return {
    id: puzzle.id,
    title: puzzle.title,
    difficulty: puzzle.difficulty,
    boxes: puzzle.boxes,
    ...(puzzle.hint ? { hint: puzzle.hint } : {}),
    ...(puzzle.collection ? { collection: puzzle.collection } : {}),
    rows: newRows,
  };
}

function maximizeCrossTypeRouteInteractions(
  shuffledIndices: readonly number[],
  typedCount: number,
  crossings: readonly (readonly [number, number])[],
): Set<number> {
  const typed = new Set(shuffledIndices.slice(0, typedCount));
  if (crossings.length === 0) return typed;

  const cutScore = (candidate: ReadonlySet<number>): number => {
    let score = 0;
    for (const [a, b] of crossings) {
      if (candidate.has(a) !== candidate.has(b)) score++;
    }
    return score;
  };

  // Deterministic hill-climb over typed/generic swaps. The shuffled order is
  // the seeded tie-breaker, while the objective makes the final labels expose
  // actual route interactions instead of an arbitrary partition.
  let bestScore = cutScore(typed);
  let improved = true;
  while (improved) {
    improved = false;
    for (const typedIndex of shuffledIndices) {
      if (!typed.has(typedIndex)) continue;
      for (const genericIndex of shuffledIndices) {
        if (typed.has(genericIndex)) continue;
        const candidate = new Set(typed);
        candidate.delete(typedIndex);
        candidate.add(genericIndex);
        const score = cutScore(candidate);
        if (score > bestScore) {
          typed.delete(typedIndex);
          typed.add(genericIndex);
          bestScore = score;
          improved = true;
        }
      }
    }
  }

  return typed;
}

export function assignLabels(
  puzzle: PuzzleDefinition,
  solution: SolverSolution,
  rng: () => number,
): PuzzleDefinition {
  const board = parsePuzzle(puzzle);
  const boxCount = board.initialBoxes.length;

  if (boxCount < 2 || boxCount > VALID_LABELS.length) return puzzle;

  const pairing = traceBoxGoalPairing(puzzle, solution.steps);
  if (pairing.size !== boxCount) return puzzle;

  const labels = VALID_LABELS.slice(0, boxCount) as unknown as string[];
  const labelsCopy = [...labels];
  shuffleArray(labelsCopy, rng);

  const boxLabelMap = new Map<string, string>();
  const goalLabelMap = new Map<string, string>();

  for (let i = 0; i < boxCount; i++) {
    const goalIdx = pairing.get(i);
    if (goalIdx === undefined) return puzzle;
    const label = labelsCopy[i];
    boxLabelMap.set(posKey(board.initialBoxes[i].position), label);
    goalLabelMap.set(posKey(board.goals[goalIdx].position), label.toLowerCase());
  }

  const newRows = puzzle.rows.map((row, r) =>
    row
      .split("")
      .map((ch, c) => {
        const key = `${r},${c}`;
        if (ch === "X") {
          const label = boxLabelMap.get(key);
          return label ?? ch;
        }
        if (ch === "S") {
          const label = goalLabelMap.get(key);
          return label ?? ch;
        }
        return ch;
      })
      .join(""),
  );

  return {
    id: puzzle.id,
    title: puzzle.title,
    difficulty: puzzle.difficulty,
    boxes: puzzle.boxes,
    ...(puzzle.hint ? { hint: puzzle.hint } : {}),
    ...(puzzle.collection ? { collection: puzzle.collection } : {}),
    rows: newRows,
  };
}
