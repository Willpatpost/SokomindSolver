import type { SolutionStep } from "../../../solver/contracts.ts";
import { directionDelta } from "../../../core/position.ts";

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

const WALL = "O";

export function analyzeSolutionDepth(
  grid: readonly (readonly string[])[],
  steps: readonly SolutionStep[],
): SolutionDepthMetrics {
  const zero: SolutionDepthMetrics = {
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
  };

  if (steps.length === 0) return zero;

  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;
  if (h === 0 || w === 0) return zero;

  let robot = { row: 0, column: 0 };
  const boxes: Array<{ row: number; column: number }> = [];
  const goalSet = new Set<string>();

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = grid[r][c];
      if (ch === "R") robot = { row: r, column: c };
      if (ch === "X" || (ch >= "A" && ch <= "Z" && ch !== WALL && ch !== "R" && ch !== "S")) {
        boxes.push({ row: r, column: c });
      }
      if (ch === "S" || (ch >= "a" && ch <= "z")) {
        goalSet.add(`${r},${c}`);
      }
    }
  }

  if (boxes.length === 0) return zero;

  const boxGoalDistances: number[][] = [];
  const boxOnGoal: boolean[] = [];
  const boxEpisodeCounts: number[] = new Array(boxes.length).fill(0);
  const boxMoved = new Set<number>();
  const goalOccupied = new Map<string, number>();
  let prevPushBoxIdx = -1;
  let boxSwitches = 0;
  let totalPushes = 0;
  let nonMonotonicMoves = 0;
  const nonMonotonicBoxes = new Set<number>();
  let stagingOps = 0;
  let tempVacancies = 0;
  const goalCompletionOrder: number[] = [];

  for (let i = 0; i < boxes.length; i++) {
    boxGoalDistances.push([minGoalDistance(boxes[i], goalSet)]);
    const key = `${boxes[i].row},${boxes[i].column}`;
    boxOnGoal.push(goalSet.has(key));
    if (goalSet.has(key)) goalOccupied.set(key, i);
  }

  for (const step of steps) {
    const delta = directionDelta(step.direction);
    const nr = robot.row + delta.row;
    const nc = robot.column + delta.column;

    if (step.kind === "push") {
      const bi = boxes.findIndex((b) => b.row === nr && b.column === nc);
      if (bi >= 0) {
        totalPushes++;
        boxMoved.add(bi);

        if (prevPushBoxIdx >= 0 && bi !== prevPushBoxIdx) boxSwitches++;

        const fromKey = `${nr},${nc}`;
        const wasOnGoal = goalSet.has(fromKey);

        const destR = nr + delta.row;
        const destC = nc + delta.column;
        const destKey = `${destR},${destC}`;
        const nowOnGoal = goalSet.has(destKey);

        if (wasOnGoal && !nowOnGoal) {
          tempVacancies++;
          goalOccupied.delete(fromKey);
        }

        if (!wasOnGoal && nowOnGoal) {
          goalOccupied.set(destKey, bi);
          goalCompletionOrder.push(bi);
        }

        if (wasOnGoal && nowOnGoal) {
          goalOccupied.delete(fromKey);
          goalOccupied.set(destKey, bi);
        }

        boxes[bi] = { row: destR, column: destC };

        const newDist = minGoalDistance(boxes[bi], goalSet);
        const prevDists = boxGoalDistances[bi];
        const lastDist = prevDists[prevDists.length - 1];
        prevDists.push(newDist);

        if (newDist > lastDist) {
          nonMonotonicMoves++;
          nonMonotonicBoxes.add(bi);
        }

        if (!wasOnGoal && !nowOnGoal && lastDist < newDist) {
          stagingOps++;
        }

        if (bi !== prevPushBoxIdx) {
          boxEpisodeCounts[bi]++;
        }
        prevPushBoxIdx = bi;
      }
    }

    robot = { row: nr, column: nc };
  }

  const multiMoveBoxCount = boxEpisodeCounts.filter((c) => c >= 2).length;
  const maxEpisodes = Math.max(0, ...boxEpisodeCounts);

  const depthEstimate = estimateDependencyDepth(
    goalCompletionOrder,
    boxes.length,
    tempVacancies,
    nonMonotonicMoves,
  );

  const goalOrderConstraints = countGoalOrderConstraints(
    goalCompletionOrder,
    boxes.length,
  );

  return {
    nonMonotonicBoxMoves: nonMonotonicMoves,
    nonMonotonicBoxCount: nonMonotonicBoxes.size,
    stagingOperations: stagingOps,
    temporaryGoalVacancies: tempVacancies,
    boxSwitchRate: totalPushes > 1 ? boxSwitches / (totalPushes - 1) : 0,
    distinctBoxesMoved: boxMoved.size,
    multiMoveBoxCount,
    maxBoxEpisodes: maxEpisodes,
    estimatedDependencyDepth: depthEstimate,
    goalOrderConstraints,
  };
}

function minGoalDistance(
  pos: { row: number; column: number },
  goals: ReadonlySet<string>,
): number {
  let best = Infinity;
  for (const g of goals) {
    const [gr, gc] = g.split(",").map(Number);
    const d = Math.abs(pos.row - gr) + Math.abs(pos.column - gc);
    if (d < best) best = d;
  }
  return best === Infinity ? 0 : best;
}

function estimateDependencyDepth(
  completionOrder: readonly number[],
  boxCount: number,
  tempVacancies: number,
  nonMonotonicMoves: number,
): number {
  if (completionOrder.length <= 1) return completionOrder.length;

  let chainLen = 1;
  let maxChain = 1;
  for (let i = 1; i < completionOrder.length; i++) {
    if (completionOrder[i] !== completionOrder[i - 1]) {
      chainLen++;
    } else {
      chainLen = 1;
    }
    if (chainLen > maxChain) maxChain = chainLen;
  }

  const vacancyBonus = Math.min(tempVacancies, boxCount);
  const nonMonoBonus = Math.min(nonMonotonicMoves * 0.5, boxCount);

  return Math.min(
    maxChain + vacancyBonus + nonMonoBonus,
    completionOrder.length * 2,
  );
}

function countGoalOrderConstraints(
  completionOrder: readonly number[],
  boxCount: number,
): number {
  if (completionOrder.length <= 1) return 0;

  const precedences = new Set<string>();
  for (let i = 0; i < completionOrder.length; i++) {
    for (let j = i + 1; j < completionOrder.length; j++) {
      if (completionOrder[i] !== completionOrder[j]) {
        precedences.add(`${completionOrder[i]}->${completionOrder[j]}`);
      }
    }
  }
  return precedences.size;
}
