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
  readonly constraintResults: readonly HybridTypingConstraintResult[];
}

export interface HybridTypingGenericWitness {
  /** The box whose non-nearest assignment must remain ambiguous. */
  readonly boxIndex: number;
  /** Boxes paired with nearer compatible goals. At least one must remain generic. */
  readonly alternativeBoxIndices: readonly number[];
}

export interface HybridTypingOppositionRequirement {
  readonly id: string;
  /** At least one pair must be split across typed and generic classes. */
  readonly pairs: readonly (readonly [number, number])[];
}

export interface HybridTypingConstraintResult {
  readonly id: string;
  readonly boxIndices: readonly number[];
  readonly typedCount: number;
  readonly genericCount: number;
  readonly classMinimumsSatisfied: boolean;
  readonly interactionCutSatisfied: boolean;
  readonly genericWitnessSatisfied: boolean;
  readonly oppositionSatisfied: boolean;
  readonly satisfied: boolean;
}

export interface HybridTypingGoalGroup {
  readonly id?: string;
  readonly goalIndices: ReadonlySet<number>;
  readonly minTyped?: number;
  readonly minGeneric?: number;
  /** Require an actual route/support/switch edge to cross the class boundary. */
  readonly requireInteractionCut?: boolean;
  /** When present, the cut must include one of these concrete interaction kinds. */
  readonly requiredInteractionKinds?: readonly HybridTypingInteractionKind[];
  /** Preserve at least one complete generic-goal ambiguity witness. */
  readonly genericWitnesses?: readonly HybridTypingGenericWitness[];
  /** Preserve role-specific cross-class relationships such as gate/traffic. */
  readonly oppositionRequirements?: readonly HybridTypingOppositionRequirement[];
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

interface PreparedTypingConstraint {
  readonly group: HybridTypingGoalGroup;
  readonly id: string;
  readonly boxes: readonly number[];
}

function cutScore(
  candidate: ReadonlySet<number>,
  edges: readonly HybridTypingInteractionEdge[],
): number {
  return edges.reduce(
    (score, edge) => score + (candidate.has(edge.boxA) !== candidate.has(edge.boxB)
      ? edge.weight
      : 0),
    0,
  );
}

function interactionCutSatisfied(
  candidate: ReadonlySet<number>,
  constraint: PreparedTypingConstraint,
  baseEdges: readonly HybridTypingInteractionEdge[],
): boolean {
  if (!constraint.group.requireInteractionCut) return true;
  const boxes = new Set(constraint.boxes);
  const requiredKinds = constraint.group.requiredInteractionKinds ?? [];
  return baseEdges.some((edge) =>
    boxes.has(edge.boxA) && boxes.has(edge.boxB) &&
    candidate.has(edge.boxA) !== candidate.has(edge.boxB) &&
    (requiredKinds.length === 0 || edge.kinds.some((kind) => requiredKinds.includes(kind))));
}

function genericWitnessSatisfied(
  candidate: ReadonlySet<number>,
  constraint: PreparedTypingConstraint,
): boolean {
  const witnesses = constraint.group.genericWitnesses ?? [];
  if (witnesses.length === 0) return true;
  return witnesses.some((witness) =>
    !candidate.has(witness.boxIndex) &&
    witness.alternativeBoxIndices.some((boxIndex) => !candidate.has(boxIndex)));
}

function oppositionSatisfied(
  candidate: ReadonlySet<number>,
  constraint: PreparedTypingConstraint,
): boolean {
  return (constraint.group.oppositionRequirements ?? []).every((requirement) =>
    requirement.pairs.some(([left, right]) =>
      candidate.has(left) !== candidate.has(right)));
}

function inspectConstraint(
  candidate: ReadonlySet<number>,
  constraint: PreparedTypingConstraint,
  baseEdges: readonly HybridTypingInteractionEdge[],
): HybridTypingConstraintResult {
  const typedCount = constraint.boxes.filter((box) => candidate.has(box)).length;
  const genericCount = constraint.boxes.length - typedCount;
  const classMinimumsSatisfied =
    typedCount >= (constraint.group.minTyped ?? 1) &&
    genericCount >= (constraint.group.minGeneric ?? 1);
  const hasInteractionCut = interactionCutSatisfied(candidate, constraint, baseEdges);
  const hasGenericWitness = genericWitnessSatisfied(candidate, constraint);
  const hasOpposition = oppositionSatisfied(candidate, constraint);
  return Object.freeze({
    id: constraint.id,
    boxIndices: Object.freeze([...constraint.boxes]),
    typedCount,
    genericCount,
    classMinimumsSatisfied,
    interactionCutSatisfied: hasInteractionCut,
    genericWitnessSatisfied: hasGenericWitness,
    oppositionSatisfied: hasOpposition,
    satisfied:
      classMinimumsSatisfied && hasInteractionCut && hasGenericWitness && hasOpposition,
  });
}

function violationCount(
  candidate: ReadonlySet<number>,
  constraints: readonly PreparedTypingConstraint[],
  baseEdges: readonly HybridTypingInteractionEdge[],
): number {
  return constraints.reduce((total, constraint) => {
    const result = inspectConstraint(candidate, constraint, baseEdges);
    return total +
      (result.classMinimumsSatisfied ? 0 : 1) +
      (result.interactionCutSatisfied ? 0 : 1) +
      (result.genericWitnessSatisfied ? 0 : 1) +
      (result.oppositionSatisfied ? 0 : 1);
  }, 0);
}

function candidateFitness(
  candidate: ReadonlySet<number>,
  edges: readonly HybridTypingInteractionEdge[],
  constraints: readonly PreparedTypingConstraint[],
  baseEdges: readonly HybridTypingInteractionEdge[],
): readonly [number, number] {
  return [violationCount(candidate, constraints, baseEdges), cutScore(candidate, edges)];
}

function isBetterFitness(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] < right[0] || (left[0] === right[0] && left[1] > right[1]);
}

function optimizeAssignment(
  initial: ReadonlySet<number>,
  order: readonly number[],
  edges: readonly HybridTypingInteractionEdge[],
  constraints: readonly PreparedTypingConstraint[],
  baseEdges: readonly HybridTypingInteractionEdge[],
): Set<number> {
  const typed = new Set(initial);
  let fitness = candidateFitness(typed, edges, constraints, baseEdges);
  while (true) {
    let bestSwap: readonly [number, number] | undefined;
    let bestFitness = fitness;
    for (const typedIndex of order) {
      if (!typed.has(typedIndex)) continue;
      for (const genericIndex of order) {
        if (typed.has(genericIndex)) continue;
        const candidate = new Set(typed);
        candidate.delete(typedIndex);
        candidate.add(genericIndex);
        const nextFitness = candidateFitness(candidate, edges, constraints, baseEdges);
        if (!isBetterFitness(nextFitness, bestFitness)) continue;
        bestFitness = nextFitness;
        bestSwap = [typedIndex, genericIndex];
      }
    }
    if (!bestSwap) break;
    typed.delete(bestSwap[0]);
    typed.add(bestSwap[1]);
    fitness = bestFitness;
  }
  return typed;
}

function exactAssignment(
  boxCount: number,
  typedCount: number,
  edges: readonly HybridTypingInteractionEdge[],
  constraints: readonly PreparedTypingConstraint[],
  baseEdges: readonly HybridTypingInteractionEdge[],
  tieOrder: readonly number[],
): Set<number> | null {
  let best: Set<number> | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestTie = Number.POSITIVE_INFINITY;
  const rank = new Map(tieOrder.map((boxIndex, index) => [boxIndex, index] as const));
  const visit = (next: number, remaining: number, selected: number[]): void => {
    if (remaining === 0) {
      const candidate = new Set(selected);
      if (violationCount(candidate, constraints, baseEdges) !== 0) return;
      const score = cutScore(candidate, edges);
      const tie = selected.reduce((sum, boxIndex) => sum + (rank.get(boxIndex) ?? 0), 0);
      if (score > bestScore || (score === bestScore && tie < bestTie)) {
        best = candidate;
        bestScore = score;
        bestTie = tie;
      }
      return;
    }
    for (let boxIndex = next; boxIndex <= boxCount - remaining; boxIndex++) {
      selected.push(boxIndex);
      visit(boxIndex + 1, remaining - 1, selected);
      selected.pop();
    }
  };
  visit(0, typedCount, []);
  return best;
}

function maximizeInteractionCut(
  shuffledIndices: readonly number[],
  typedCount: number,
  edges: readonly HybridTypingInteractionEdge[],
  constraints: readonly PreparedTypingConstraint[],
  baseEdges: readonly HybridTypingInteractionEdge[],
  rng: () => number,
): Set<number> | null {
  if (shuffledIndices.length <= 14) {
    return exactAssignment(
      shuffledIndices.length,
      typedCount,
      edges,
      constraints,
      baseEdges,
      shuffledIndices,
    );
  }

  let best: Set<number> | null = null;
  let bestFitness: readonly [number, number] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const starts = Math.max(128, shuffledIndices.length * 8);
  for (let start = 0; start < starts; start++) {
    const order = [...shuffledIndices];
    if (start > 0) shuffleArray(order, rng);
    const optimized = optimizeAssignment(
      new Set(order.slice(0, typedCount)),
      order,
      edges,
      constraints,
      baseEdges,
    );
    const fitness = candidateFitness(optimized, edges, constraints, baseEdges);
    if (isBetterFitness(fitness, bestFitness)) {
      best = optimized;
      bestFitness = fitness;
    }
  }
  return bestFitness[0] === 0 ? best : null;
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
  const constraints: readonly PreparedTypingConstraint[] = Object.freeze(
    normalizedGroups.map((group, index) => Object.freeze({
      group,
      id: group.id ?? `goal-group-${index}`,
      boxes: Object.freeze(groupBoxes[index]),
    })),
  );
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
  const typedBoxIndices = maximizeInteractionCut(
    shuffledIndices,
    typedCount,
    edges,
    constraints,
    baseEdges,
    rng,
  );
  if (!typedBoxIndices) return null;
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
  const constraintResults = Object.freeze(constraints.map((constraint) =>
    inspectConstraint(typedBoxIndices, constraint, baseEdges)));
  return Object.freeze({
    typedBoxIndices,
    genericBoxIndices,
    typedCount,
    genericCount: boxCount - typedCount,
    minPerKind,
    interactionCutWeight,
    interactionEdges: edges,
    constraintResults,
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
  return applyHybridTypingConstructionPlan(puzzle, solution.steps, construction, rng);
}

/** Apply an already-verified class assignment without re-running its optimizer. */
export function applyHybridTypingConstructionPlan(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
  construction: HybridTypingConstructionPlan,
  rng: () => number,
): PuzzleDefinition {
  const board = parsePuzzle(puzzle);
  const boxCount = board.initialBoxes.length;
  const pairing = traceBoxGoalPairing(puzzle, steps);
  if (
    pairing.size !== boxCount ||
    construction.typedCount + construction.genericCount !== boxCount ||
    construction.typedBoxIndices.size !== construction.typedCount
  ) return puzzle;
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
