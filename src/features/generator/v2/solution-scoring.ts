import type { PuzzleDefinition, Direction, Position } from "../../../core/model.ts";
import type { SolverSolution } from "../../../solver/contracts.ts";
import { createSession, stepSnapshot } from "../../../core/game-session.ts";

export interface SolutionScore {
  readonly pushVariety: number;
  readonly directionChanges: number;
  readonly deadEndRecovery: number;
  readonly choicePoints: number;
  readonly roomTransitions: number;
  readonly composite: number;
}

function distToNearest(pos: Position, targets: readonly Position[]): number {
  let best = Infinity;
  for (const t of targets) {
    const d = Math.abs(pos.row - t.row) + Math.abs(pos.column - t.column);
    if (d < best) best = d;
  }
  return best;
}

export function scoreSolution(
  puzzle: PuzzleDefinition,
  solution: SolverSolution,
): SolutionScore {
  const session = createSession(puzzle);
  const { board } = session;
  const goalPositions = board.goals.map((g) => g.position);
  const totalPushes = solution.pushes;

  if (totalPushes === 0 || solution.steps.length === 0) {
    return { pushVariety: 0, directionChanges: 0, deadEndRecovery: 0, choicePoints: 0, roomTransitions: 0, composite: 0 };
  }

  const pushedBoxIds = new Set<string>();
  let dirChanges = 0;
  let lastPushDir: Direction | null = null;
  let recoveryEvents = 0;
  let transitions = 0;

  let snap = session.snapshot;
  const boxDistByIndex = new Map<number, number>();
  for (let i = 0; i < snap.boxes.length; i++) {
    boxDistByIndex.set(i, distToNearest(snap.boxes[i].position, goalPositions));
  }

  for (const step of solution.steps) {
    const prev = snap;
    const result = stepSnapshot(board, snap, step.direction);
    if (!result.moved) break;
    snap = result.snapshot;

    if (result.pushed && result.pushedBoxId) {
      pushedBoxIds.add(result.pushedBoxId);

      const boxIdx = snap.boxes.findIndex((b) => b.id === result.pushedBoxId);
      if (boxIdx >= 0) {
        const newDist = distToNearest(snap.boxes[boxIdx].position, goalPositions);
        const oldDist = boxDistByIndex.get(boxIdx) ?? 0;
        if (newDist > oldDist) recoveryEvents++;
        boxDistByIndex.set(boxIdx, newDist);

        const prevPos = prev.boxes[boxIdx].position;
        const newPos = snap.boxes[boxIdx].position;
        const prevRegion = `${Math.floor(prevPos.row / 4)},${Math.floor(prevPos.column / 4)}`;
        const newRegion = `${Math.floor(newPos.row / 4)},${Math.floor(newPos.column / 4)}`;
        if (prevRegion !== newRegion) transitions++;
      }

      if (lastPushDir !== null && step.direction !== lastPushDir) {
        dirChanges++;
      }
      lastPushDir = step.direction;
    }
  }

  const boxCount = board.initialBoxes.length;
  const pushVariety = boxCount > 1 ? Math.min(1, pushedBoxIds.size / boxCount) : 1;
  const directionChanges = totalPushes > 1 ? Math.min(1, dirChanges / (totalPushes - 1)) : 0;
  const deadEndRecovery = Math.min(1, recoveryEvents / Math.max(1, totalPushes * 0.3));
  const choicePoints = Math.min(1, dirChanges / Math.max(1, totalPushes * 0.5));
  const roomTransitions = Math.min(1, transitions / Math.max(1, boxCount));

  const composite =
    pushVariety * 0.2 +
    directionChanges * 0.25 +
    deadEndRecovery * 0.25 +
    choicePoints * 0.15 +
    roomTransitions * 0.15;

  return {
    pushVariety,
    directionChanges,
    deadEndRecovery,
    choicePoints,
    roomTransitions,
    composite,
  };
}
