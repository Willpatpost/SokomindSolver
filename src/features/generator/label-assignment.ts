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

export type HybridTypingInteractionKind =
  | "shared-route"
  | "shared-support"
  | "push-switch"
  | "mechanism-dependency";

export interface HybridTypingInteractionEdge {
  readonly boxA: number;
  readonly boxB: number;
  readonly weight: number;
  readonly kinds: readonly HybridTypingInteractionKind[];
}

export interface HybridTypingConstructionPlan {
  readonly typedBoxIndices: ReadonlySet<number>;
  readonly genericBoxIndices: ReadonlySet<number>;
  readonly typedCount: number;
  readonly genericCount: number;
  readonly minPerKind: number;
  readonly interactionCutWeight: number;
  readonly interactionEdges: readonly HybridTypingInteractionEdge[];
}

export interface HybridTypingGoalGroup {
  readonly goalIndices: ReadonlySet<number>;
  readonly minTyped?: number;
  readonly minGeneric?: number;
}

export type HybridTypingGoalGroupInput = ReadonlySet<number> | HybridTypingGoalGroup;

function normalizeGoalGroup(group: HybridTypingGoalGroupInput): HybridTypingGoalGroup {
  return "goalIndices" in group
    ? group
    : { goalIndices: group, minTyped: 1, minGeneric: 1 };
}

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

interface BoxRouteAnalysis {
  readonly paths: readonly (readonly GridPosition[])[];
  readonly supportCells: readonly ReadonlySet<string>[];
  readonly pushBoxSequence: readonly number[];
}

function analyzeBoxRoutes(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
): BoxRouteAnalysis {
  const board = parsePuzzle(puzzle);
  const boxCount = board.initialBoxes.length;
  const paths: GridPosition[][] = Array.from({ length: boxCount }, (_, index) =>
    [board.initialBoxes[index].position]);
  const supportCells = Array.from({ length: boxCount }, () => new Set<string>());
  const pushBoxSequence: number[] = [];
  let snapshot = {
    puzzleId: puzzle.id,
    robot: board.initialRobot,
    boxes: board.initialBoxes,
    moves: 0,
    pushes: 0,
    solved: false,
  };

  for (const step of steps) {
    const before = snapshot;
    const transition = stepSnapshot(board, snapshot, step.direction);
    if (!transition.moved) continue;
    snapshot = transition.snapshot;
    for (let index = 0; index < boxCount; index++) {
      if (
        snapshot.boxes[index].position.row === before.boxes[index].position.row &&
        snapshot.boxes[index].position.column === before.boxes[index].position.column
      ) continue;
      paths[index].push(snapshot.boxes[index].position);
      supportCells[index].add(posKey(before.robot));
      pushBoxSequence.push(index);
      break;
    }
  }

  return { paths, supportCells, pushBoxSequence };
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function buildTypingInteractionEdges(
  analysis: BoxRouteAnalysis,
): readonly HybridTypingInteractionEdge[] {
  const switches = new Map<string, number>();
  for (let index = 1; index < analysis.pushBoxSequence.length; index++) {
    const left = analysis.pushBoxSequence[index - 1];
    const right = analysis.pushBoxSequence[index];
    if (left === right) continue;
    const a = Math.min(left, right);
    const b = Math.max(left, right);
    const key = `${a},${b}`;
    switches.set(key, (switches.get(key) ?? 0) + 1);
  }

  const edges: HybridTypingInteractionEdge[] = [];
  for (let boxA = 0; boxA < analysis.paths.length; boxA++) {
    for (let boxB = boxA + 1; boxB < analysis.paths.length; boxB++) {
      const kinds: HybridTypingInteractionKind[] = [];
      let weight = 0;
      if (pathsCross([...analysis.paths[boxA]], [...analysis.paths[boxB]])) {
        kinds.push("shared-route");
        weight += 3;
      }
      if (intersects(analysis.supportCells[boxA], analysis.supportCells[boxB])) {
        kinds.push("shared-support");
        weight += 4;
      }
      const switchCount = switches.get(`${boxA},${boxB}`) ?? 0;
      if (switchCount > 0) {
        kinds.push("push-switch");
        weight += switchCount * 2;
      }
      if (weight > 0) {
        edges.push(Object.freeze({
          boxA,
          boxB,
          weight,
          kinds: Object.freeze(kinds),
        }));
      }
    }
  }
  return Object.freeze(edges);
}

function minimumHybridClassSize(puzzle: PuzzleDefinition, boxCount: number): number {
  if (boxCount < 2) return 0;
  if (puzzle.difficulty === "beginner" || puzzle.difficulty === "tutorial") return 1;
  return boxCount >= 4 ? 2 : 1;
}

function maximizeInteractionCut(
  shuffledIndices: readonly number[],
  typedCount: number,
  edges: readonly HybridTypingInteractionEdge[],
): Set<number> {
  const typed = new Set(shuffledIndices.slice(0, typedCount));
  const cutScore = (candidate: ReadonlySet<number>): number => edges.reduce(
    (score, edge) => score + (candidate.has(edge.boxA) !== candidate.has(edge.boxB)
      ? edge.weight
      : 0),
    0,
  );
  let bestScore = cutScore(typed);
  while (true) {
    let improvingSwap: readonly [number, number] | undefined;
    search: for (const typedIndex of shuffledIndices) {
      if (!typed.has(typedIndex)) continue;
      for (const genericIndex of shuffledIndices) {
        if (typed.has(genericIndex)) continue;
        const candidate = new Set(typed);
        candidate.delete(typedIndex);
        candidate.add(genericIndex);
        const score = cutScore(candidate);
        if (score <= bestScore) continue;
        bestScore = score;
        improvingSwap = [typedIndex, genericIndex];
        break search;
      }
    }
    if (!improvingSwap) break;
    typed.delete(improvingSwap[0]);
    typed.add(improvingSwap[1]);
  }
  return typed;
}

export function buildHybridTypingConstructionPlan(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
  rng: () => number,
  typedFraction: number,
  requiredGoalGroups: readonly HybridTypingGoalGroupInput[] = [],
): HybridTypingConstructionPlan | null {
  const board = parsePuzzle(puzzle);
  const boxCount = board.initialBoxes.length;
  if (boxCount < 2) return null;
  const pairing = traceBoxGoalPairing(puzzle, steps);
  if (pairing.size !== boxCount) return null;
  const minPerKind = minimumHybridClassSize(puzzle, boxCount);
  let typedCount = Math.round(boxCount * typedFraction);
  typedCount = Math.max(minPerKind, Math.min(typedCount, boxCount - minPerKind));
  if (typedCount > VALID_LABELS.length) return null;

  const shuffledIndices = Array.from({ length: boxCount }, (_, index) => index);
  shuffleArray(shuffledIndices, rng);
  const baseEdges = buildTypingInteractionEdges(analyzeBoxRoutes(puzzle, steps));
  const edgeMap = new Map<string, HybridTypingInteractionEdge>(
    baseEdges.map((edge) => [`${edge.boxA},${edge.boxB}`, edge]),
  );
  const normalizedGroups = requiredGoalGroups.map(normalizeGoalGroup);
  const groupBoxes = normalizedGroups.map((group) => [...pairing]
    .filter(([, goalIndex]) => group.goalIndices.has(goalIndex))
    .map(([boxIndex]) => boxIndex)
    .sort((a, b) => a - b));
  for (let groupIndex = 0; groupIndex < normalizedGroups.length; groupIndex++) {
    const boxes = groupBoxes[groupIndex];
    for (let left = 0; left < boxes.length; left++) {
      for (let right = left + 1; right < boxes.length; right++) {
        const key = `${boxes[left]},${boxes[right]}`;
        const existing = edgeMap.get(key);
        edgeMap.set(key, Object.freeze({
          boxA: boxes[left],
          boxB: boxes[right],
          weight: (existing?.weight ?? 0) + 1000,
          kinds: Object.freeze([...(existing?.kinds ?? []), "mechanism-dependency" as const]),
        }));
      }
    }
  }
  const edges = Object.freeze([...edgeMap.values()]);
  const typedBoxIndices = maximizeInteractionCut(shuffledIndices, typedCount, edges);
  // Repair the weighted cut to satisfy explicit per-mechanism class minima
  // without changing the global typed count.
  for (let pass = 0; pass < normalizedGroups.length * 2; pass++) {
    let changed = false;
    for (let groupIndex = 0; groupIndex < normalizedGroups.length; groupIndex++) {
      const group = normalizedGroups[groupIndex];
      const boxes = groupBoxes[groupIndex];
      const minTyped = group.minTyped ?? 1;
      const minGeneric = group.minGeneric ?? 1;
      const typedHere = boxes.filter((box) => typedBoxIndices.has(box));
      if (typedHere.length < minTyped) {
        const add = boxes.find((box) => !typedBoxIndices.has(box));
        const remove = shuffledIndices.find((box) => typedBoxIndices.has(box) && !boxes.includes(box));
        if (add !== undefined && remove !== undefined) {
          typedBoxIndices.add(add); typedBoxIndices.delete(remove); changed = true;
        }
      } else if (boxes.length - typedHere.length < minGeneric) {
        const remove = typedHere[0];
        const add = shuffledIndices.find((box) => !typedBoxIndices.has(box) && !boxes.includes(box));
        if (remove !== undefined && add !== undefined) {
          typedBoxIndices.delete(remove); typedBoxIndices.add(add); changed = true;
        }
      }
    }
    if (!changed) break;
  }
  if (normalizedGroups.some((group, index) => {
    const boxes = groupBoxes[index];
    const typedHere = boxes.filter((box) => typedBoxIndices.has(box)).length;
    return typedHere < (group.minTyped ?? 1) ||
      boxes.length - typedHere < (group.minGeneric ?? 1);
  })) return null;
  const genericBoxIndices = new Set(shuffledIndices.filter((index) =>
    !typedBoxIndices.has(index)));
  const interactionCutWeight = edges.reduce(
    (score, edge) => score + (
      typedBoxIndices.has(edge.boxA) !== typedBoxIndices.has(edge.boxB)
        ? edge.weight
        : 0
    ),
    0,
  );
  return Object.freeze({
    typedBoxIndices,
    genericBoxIndices,
    typedCount,
    genericCount: boxCount - typedCount,
    minPerKind,
    interactionCutWeight,
    interactionEdges: edges,
  });
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
  requiredGoalGroups: readonly HybridTypingGoalGroupInput[] = [],
): PuzzleDefinition {
  const board = parsePuzzle(puzzle);
  const boxCount = board.initialBoxes.length;

  if (boxCount < 2) return puzzle;

  const pairing = traceBoxGoalPairing(puzzle, solution.steps);
  if (pairing.size !== boxCount) return puzzle;

  const construction = buildHybridTypingConstructionPlan(
    puzzle,
    solution.steps,
    rng,
    typedFraction,
    requiredGoalGroups,
  );
  if (!construction) return puzzle;
  const { typedCount, typedBoxIndices: typedSet } = construction;

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
