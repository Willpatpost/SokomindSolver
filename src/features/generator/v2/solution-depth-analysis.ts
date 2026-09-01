import type { SolutionStep } from "../../../solver/contracts.ts";
import {
  buildCanonicalSolutionTrace,
  type CanonicalSolutionTrace,
  type TracePosition,
} from "./solution-trace.ts";

export interface SolutionDepthMetrics {
  readonly nonMonotonicBoxMoves: number;
  readonly nonMonotonicBoxCount: number;
  readonly stagingOperations: number;
  readonly temporaryGoalVacancies: number;
  readonly boxSwitchRate: number;
  readonly distinctBoxesMoved: number;
  readonly multiMoveBoxCount: number;
  readonly maxBoxEpisodes: number;
  readonly estimatedDependencyDepth: number;
  readonly goalOrderConstraints: number;
}

const ZERO: SolutionDepthMetrics = Object.freeze({
  nonMonotonicBoxMoves: 0,
  nonMonotonicBoxCount: 0,
  stagingOperations: 0,
  temporaryGoalVacancies: 0,
  boxSwitchRate: 0,
  distinctBoxesMoved: 0,
  multiMoveBoxCount: 0,
  maxBoxEpisodes: 0,
  estimatedDependencyDepth: 0,
  goalOrderConstraints: 0,
});

export function analyzeSolutionDepthFromTrace(
  trace: CanonicalSolutionTrace,
): SolutionDepthMetrics {
  if (trace.pushes.length === 0 || trace.boxes.length === 0) return ZERO;

  const goals = trace.goals.map((goal) => goal.position);
  const currentDistance = trace.boxes.map((box) =>
    minGoalDistance(box.initialPosition, goals));
  const boxEpisodeCounts = new Array<number>(trace.boxes.length).fill(0);
  const boxMoved = new Set<number>();
  const nonMonotonicBoxes = new Set<number>();
  const goalCompletionOrder: number[] = [];
  let previousBoxId = -1;
  let boxSwitches = 0;
  let nonMonotonicMoves = 0;
  let stagingOperations = 0;
  let temporaryGoalVacancies = 0;

  for (const push of trace.pushes) {
    boxMoved.add(push.boxId);
    if (previousBoxId >= 0 && push.boxId !== previousBoxId) boxSwitches++;
    if (push.boxId !== previousBoxId) boxEpisodeCounts[push.boxId]++;

    const lastDistance = currentDistance[push.boxId];
    const nextDistance = minGoalDistance(push.to, goals);
    currentDistance[push.boxId] = nextDistance;

    if (nextDistance > lastDistance) {
      nonMonotonicMoves++;
      nonMonotonicBoxes.add(push.boxId);
    }
    if (
      push.fromGoalId === undefined &&
      push.toGoalId === undefined &&
      nextDistance > lastDistance
    ) {
      stagingOperations++;
    }
    if (push.fromGoalId !== undefined && push.toGoalId === undefined) {
      temporaryGoalVacancies++;
    }
    if (push.fromGoalId === undefined && push.toGoalId !== undefined) {
      goalCompletionOrder.push(push.boxId);
    }

    previousBoxId = push.boxId;
  }

  const maxBoxEpisodes = Math.max(0, ...boxEpisodeCounts);
  const estimatedDependencyDepth = estimateDependencyDepth(
    goalCompletionOrder,
    trace.boxes.length,
    temporaryGoalVacancies,
    nonMonotonicMoves,
  );

  return {
    nonMonotonicBoxMoves: nonMonotonicMoves,
    nonMonotonicBoxCount: nonMonotonicBoxes.size,
    stagingOperations,
    temporaryGoalVacancies,
    boxSwitchRate: trace.pushes.length > 1
      ? boxSwitches / (trace.pushes.length - 1)
      : 0,
    distinctBoxesMoved: boxMoved.size,
    multiMoveBoxCount: boxEpisodeCounts.filter((count) => count >= 2).length,
    maxBoxEpisodes,
    estimatedDependencyDepth,
    goalOrderConstraints: countGoalOrderConstraints(goalCompletionOrder),
  };
}

export function analyzeSolutionDepth(
  grid: readonly (readonly string[])[],
  steps: readonly SolutionStep[],
): SolutionDepthMetrics {
  if (steps.length === 0) return ZERO;
  const result = buildCanonicalSolutionTrace(grid, steps);
  return result.ok ? analyzeSolutionDepthFromTrace(result.trace) : ZERO;
}

function minGoalDistance(
  position: TracePosition,
  goals: readonly TracePosition[],
): number {
  let best = Infinity;
  for (const goal of goals) {
    const distance = Math.abs(position.row - goal.row) +
      Math.abs(position.column - goal.column);
    if (distance < best) best = distance;
  }
  return best === Infinity ? 0 : best;
}

function estimateDependencyDepth(
  completionOrder: readonly number[],
  boxCount: number,
  temporaryGoalVacancies: number,
  nonMonotonicMoves: number,
): number {
  if (completionOrder.length <= 1) return completionOrder.length;

  let chainLength = 1;
  let maxChain = 1;
  for (let index = 1; index < completionOrder.length; index++) {
    if (completionOrder[index] !== completionOrder[index - 1]) chainLength++;
    else chainLength = 1;
    if (chainLength > maxChain) maxChain = chainLength;
  }

  const vacancyBonus = Math.min(temporaryGoalVacancies, boxCount);
  const nonMonotonicBonus = Math.min(nonMonotonicMoves * 0.5, boxCount);
  return Math.min(
    maxChain + vacancyBonus + nonMonotonicBonus,
    completionOrder.length * 2,
  );
}

function countGoalOrderConstraints(completionOrder: readonly number[]): number {
  if (completionOrder.length <= 1) return 0;
  const precedences = new Set<string>();
  for (let left = 0; left < completionOrder.length; left++) {
    for (let right = left + 1; right < completionOrder.length; right++) {
      if (completionOrder[left] !== completionOrder[right]) {
        precedences.add(`${completionOrder[left]}->${completionOrder[right]}`);
      }
    }
  }
  return precedences.size;
}
