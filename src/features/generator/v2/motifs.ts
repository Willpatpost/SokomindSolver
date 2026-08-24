import { createRng } from "../board-template.ts";
import { rasterizeBlueprint } from "./blueprint-graph.ts";
import type {
  FunctionalBlueprint,
  FunctionalRoom,
  GoalCell,
  GoalStyle,
  PassageEdge,
  SolvedBlueprint,
} from "./blueprint-types.ts";
import {
  collectRoomFloorCells,
  chooseRobotPosition,
  findDoorways,
  selectGoals,
  type RoomFloorCell,
} from "./goal-placement.ts";
import type { GridPosition } from "../generator-types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MotifType =
  | "packing-order"
  | "doorway-traffic"
  | "staging-dep"
  | "gatekeeper";

export const MOTIF_TYPES: readonly MotifType[] = [
  "packing-order",
  "doorway-traffic",
  "staging-dep",
  "gatekeeper",
];

export interface MotifParams {
  readonly seed: number;
  readonly boxCount: number;
  readonly motif: MotifType | "auto";
}

export const DEFAULT_MOTIF_PARAMS: MotifParams = {
  seed: 0,
  boxCount: 3,
  motif: "auto",
};

export interface DependencyHint {
  readonly type: string;
  readonly description: string;
  readonly involvedGoalIndices: readonly number[];
}

export interface MotifPlacementResult {
  readonly solved: SolvedBlueprint;
  readonly motif: MotifType;
  readonly hints: readonly DependencyHint[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function placeGoalsWithMotif(
  blueprint: FunctionalBlueprint,
  params: MotifParams,
): MotifPlacementResult | null {
  const rng = createRng(params.seed);
  const grid = rasterizeBlueprint(blueprint);

  const motif =
    params.motif === "auto"
      ? selectMotif(blueprint, params.boxCount, rng)
      : params.motif;

  const placement = applyMotif(blueprint, grid, params.boxCount, motif, rng);
  if (!placement) return null;

  const robotPos = chooseRobotPosition(blueprint, grid, placement.goals, rng);
  if (!robotPos) return null;

  return {
    solved: {
      blueprint,
      grid,
      goals: placement.goals,
      robotPosition: robotPos,
      goalStyle: placement.goalStyle,
    },
    motif,
    hints: placement.hints,
  };
}

// ---------------------------------------------------------------------------
// Motif selection
// ---------------------------------------------------------------------------

function selectMotif(
  blueprint: FunctionalBlueprint,
  boxCount: number,
  rng: () => number,
): MotifType {
  const scores: { motif: MotifType; score: number }[] = [];

  const terminalRooms = blueprint.rooms.filter((r) => r.isTerminal);
  const narrowPassages = blueprint.passages.filter((p) => p.width === 1);

  if (terminalRooms.length >= 1 && narrowPassages.length >= 1) {
    scores.push({ motif: "packing-order", score: 3 + (terminalRooms.length > 1 ? 1 : 0) });
  }

  if (narrowPassages.length >= 1 && blueprint.rooms.length >= 2 && boxCount >= 2) {
    scores.push({ motif: "doorway-traffic", score: 2 + narrowPassages.length });
  }

  if (blueprint.rooms.some((r) => r.width >= 2 && r.height >= 3 || r.width >= 3 && r.height >= 2)) {
    scores.push({ motif: "staging-dep", score: 2 });
  }

  if (narrowPassages.length >= 1 && terminalRooms.length >= 1 && boxCount >= 2) {
    scores.push({ motif: "gatekeeper", score: 2 + (terminalRooms.length > 2 ? 1 : 0) });
  }

  if (scores.length === 0) return "packing-order";

  scores.sort((a, b) => b.score - a.score);
  const topScore = scores[0].score;
  const ties = scores.filter((s) => s.score === topScore);
  return ties[Math.floor(rng() * ties.length)].motif;
}

// ---------------------------------------------------------------------------
// Motif dispatch
// ---------------------------------------------------------------------------

interface MotifGoalResult {
  goals: GoalCell[];
  hints: DependencyHint[];
  goalStyle: GoalStyle;
}

function applyMotif(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  motif: MotifType,
  rng: () => number,
): MotifGoalResult | null {
  switch (motif) {
    case "packing-order":
      return packingOrderMotif(blueprint, grid, boxCount);
    case "doorway-traffic":
      return doorwayTrafficMotif(blueprint, grid, boxCount, rng);
    case "staging-dep":
      return stagingDepMotif(blueprint, grid, boxCount);
    case "gatekeeper":
      return gatekeeperMotif(blueprint, grid, boxCount, rng);
  }
}

// ---------------------------------------------------------------------------
// 1. Packing Order
//
// Place all goals deep in a terminal room with narrow access.
// Shallow goals block access to deeper goals, forcing back-to-front
// fill order. The depth gradient creates natural ordering dependency.
// ---------------------------------------------------------------------------

function packingOrderMotif(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
): MotifGoalResult | null {
  const terminalRooms = blueprint.rooms
    .filter((r) => r.isTerminal)
    .sort((a, b) => {
      const areaA = a.width * a.height;
      const areaB = b.width * b.height;
      if (b.distanceFromCenter !== a.distanceFromCenter)
        return b.distanceFromCenter - a.distanceFromCenter;
      return areaB - areaA;
    });

  for (const room of terminalRooms) {
    const cells = collectRoomFloorCells(room, grid, blueprint);
    const viable = cells.filter((c) => c.reversePullDirs >= 1);

    if (viable.length < boxCount) continue;

    viable.sort((a, b) => {
      if (b.depthFromDoorway !== a.depthFromDoorway)
        return b.depthFromDoorway - a.depthFromDoorway;
      if (a.wallAdjacent !== b.wallAdjacent) return a.wallAdjacent ? -1 : 1;
      return a.reversePullDirs - b.reversePullDirs;
    });

    const goals = selectGoals(viable, boxCount, room.id, grid);
    if (goals.length < boxCount) continue;

    const depths = goals.map((g) => g.depthFromDoorway);
    const maxDepth = Math.max(...depths);
    const minDepth = Math.min(...depths);

    if (maxDepth - minDepth < 1 && boxCount > 1) continue;

    const hints: DependencyHint[] = [];
    const deepGoals = goals
      .map((g, i) => ({ g, i }))
      .filter((x) => x.g.depthFromDoorway >= maxDepth - 1);
    const shallowGoals = goals
      .map((g, i) => ({ g, i }))
      .filter((x) => x.g.depthFromDoorway <= minDepth + 1);

    if (deepGoals.length > 0 && shallowGoals.length > 0) {
      hints.push({
        type: "ordering",
        description:
          `Goals at depth ${maxDepth} must be filled before depth ${minDepth} ` +
          `(shallow boxes block access to deeper positions)`,
        involvedGoalIndices: [...deepGoals.map((x) => x.i), ...shallowGoals.map((x) => x.i)],
      });
    }

    return { goals, hints, goalStyle: "concentrated" };
  }

  return fallbackPacking(blueprint, grid, boxCount);
}

function fallbackPacking(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
): MotifGoalResult | null {
  const sorted = [...blueprint.rooms].sort((a, b) => {
    const aArea = a.width * a.height;
    const bArea = b.width * b.height;
    if (b.distanceFromCenter !== a.distanceFromCenter)
      return b.distanceFromCenter - a.distanceFromCenter;
    return bArea - aArea;
  });

  for (const room of sorted) {
    const cells = collectRoomFloorCells(room, grid, blueprint);
    const viable = cells.filter((c) => c.reversePullDirs >= 1);
    viable.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);

    if (viable.length >= boxCount) {
      const goals = selectGoals(viable, boxCount, room.id, grid);
      if (goals.length === boxCount) {
        return {
          goals,
          hints: [{
            type: "ordering",
            description: "Goals placed deepest-first in room (fallback — no terminal room found)",
            involvedGoalIndices: goals.map((_, i) => i),
          }],
          goalStyle: "concentrated",
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 2. Doorway Traffic
//
// Place goals on opposite sides of a narrow passage. Boxes heading
// to goals in the far room must transit through the bottleneck, and
// boxes heading to near-side goals interact with transit traffic.
// The passage width-1 constraint forces sequencing.
// ---------------------------------------------------------------------------

function doorwayTrafficMotif(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  rng: () => number,
): MotifGoalResult | null {
  const narrowPassages = blueprint.passages.filter((p) => p.width === 1);
  if (narrowPassages.length === 0 || blueprint.rooms.length < 2) return null;

  const roomMap = new Map<number, FunctionalRoom>();
  for (const room of blueprint.rooms) roomMap.set(room.id, room);

  const shuffled = [...narrowPassages];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const passage of shuffled) {
    const roomA = roomMap.get(passage.from);
    const roomB = roomMap.get(passage.to);
    if (!roomA || !roomB) continue;

    const cellsA = collectRoomFloorCells(roomA, grid, blueprint);
    const cellsB = collectRoomFloorCells(roomB, grid, blueprint);
    const viableA = cellsA.filter((c) => c.reversePullDirs >= 1);
    const viableB = cellsB.filter((c) => c.reversePullDirs >= 1);

    const countA = Math.max(1, Math.floor(boxCount / 2));
    const countB = boxCount - countA;

    if (viableA.length < countA || viableB.length < countB) continue;

    viableA.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);
    viableB.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);

    const goalsA = selectGoals(viableA, countA, roomA.id, grid);
    if (goalsA.length < countA) continue;

    const usedKeys = new Set(goalsA.map((g) => `${g.row},${g.column}`));
    const filteredB = viableB.filter((c) => !usedKeys.has(`${c.row},${c.column}`));
    const goalsB = selectGoals(filteredB, countB, roomB.id, grid);
    if (goalsB.length < countB) continue;

    const goals = [...goalsA, ...goalsB];

    const passageCells = passage.cells.map((c) => `(${c.row},${c.column})`).join(" ");
    const hints: DependencyHint[] = [{
      type: "traffic",
      description:
        `Goals split across rooms ${roomA.id} (${countA}) and ${roomB.id} (${countB}), ` +
        `connected by width-1 passage at ${passageCells}. ` +
        `Boxes must be sequenced through the bottleneck.`,
      involvedGoalIndices: goals.map((_, i) => i),
    }];

    return { goals, hints, goalStyle: "multi-room" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 3. Staging Dependency
//
// Place goals such that the approach path to a deep goal passes
// through another goal's position. Solving requires temporarily
// staging one box so the other can pass. Works best in elongated
// rooms or corridors.
// ---------------------------------------------------------------------------

function stagingDepMotif(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
): MotifGoalResult | null {
  if (boxCount < 2) return null;

  const candidates = [...blueprint.rooms].sort((a, b) => {
    const elongA = Math.max(a.width, a.height) / Math.max(1, Math.min(a.width, a.height));
    const elongB = Math.max(b.width, b.height) / Math.max(1, Math.min(b.width, b.height));
    if (elongB !== elongA) return elongB - elongA;
    return (b.width * b.height) - (a.width * a.height);
  });

  for (const room of candidates) {
    const cells = collectRoomFloorCells(room, grid, blueprint);
    const viable = cells.filter((c) => c.reversePullDirs >= 1);

    if (viable.length < boxCount) continue;

    const doorways = findDoorways(room, blueprint);
    if (doorways.length === 0) continue;

    viable.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);

    const deepGoal = viable[0];
    if (deepGoal.depthFromDoorway < 2) continue;

    const blockingCandidates = viable.filter((c) => {
      if (c.row === deepGoal.row && c.column === deepGoal.column) return false;
      return isOnApproachPath(c, deepGoal, doorways);
    });

    if (blockingCandidates.length === 0) continue;

    const blockerGoal = blockingCandidates[0];

    const goals: GoalCell[] = [
      {
        row: deepGoal.row,
        column: deepGoal.column,
        roomId: room.id,
        depthFromDoorway: deepGoal.depthFromDoorway,
        reversePullDirs: deepGoal.reversePullDirs,
      },
      {
        row: blockerGoal.row,
        column: blockerGoal.column,
        roomId: room.id,
        depthFromDoorway: blockerGoal.depthFromDoorway,
        reversePullDirs: blockerGoal.reversePullDirs,
      },
    ];

    if (boxCount > 2) {
      const usedKeys = new Set(goals.map((g) => `${g.row},${g.column}`));
      const remaining = viable.filter((c) => !usedKeys.has(`${c.row},${c.column}`));
      remaining.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);
      const extra = selectGoals(remaining, boxCount - 2, room.id, grid);

      for (const g of extra) {
        if (goals.length >= boxCount) break;
        if (!usedKeys.has(`${g.row},${g.column}`)) {
          usedKeys.add(`${g.row},${g.column}`);
          goals.push(g);
        }
      }
    }

    if (goals.length < boxCount) continue;

    const hints: DependencyHint[] = [{
      type: "staging",
      description:
        `Goal at (${deepGoal.row},${deepGoal.column}) depth=${deepGoal.depthFromDoorway} ` +
        `requires passing through (${blockerGoal.row},${blockerGoal.column}) ` +
        `depth=${blockerGoal.depthFromDoorway}. ` +
        `Box at blocker position must be staged temporarily.`,
      involvedGoalIndices: [0, 1],
    }];

    return { goals, hints, goalStyle: "concentrated" };
  }

  return null;
}

function isOnApproachPath(
  candidate: RoomFloorCell,
  target: RoomFloorCell,
  doorways: readonly GridPosition[],
): boolean {
  for (const door of doorways) {
    const doorToTarget = Math.abs(door.row - target.row) + Math.abs(door.column - target.column);
    const doorToCandidate = Math.abs(door.row - candidate.row) + Math.abs(door.column - candidate.column);
    const candidateToTarget = Math.abs(candidate.row - target.row) + Math.abs(candidate.column - target.column);

    if (doorToCandidate < doorToTarget && candidateToTarget < doorToTarget) {
      if (candidate.row === target.row || candidate.column === target.column) {
        return true;
      }
      if (doorToCandidate + candidateToTarget <= doorToTarget + 1) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 4. Gatekeeper
//
// Place one goal adjacent to a narrow passage. When a box occupies
// this goal, it partially blocks passage transit. Other goals are
// placed in the room beyond the passage. The gatekeeper box must
// be coordinated with boxes passing through.
// ---------------------------------------------------------------------------

function gatekeeperMotif(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  rng: () => number,
): MotifGoalResult | null {
  if (boxCount < 2) return null;

  const narrowPassages = blueprint.passages.filter((p) => p.width === 1);
  if (narrowPassages.length === 0) return null;

  const roomMap = new Map<number, FunctionalRoom>();
  for (const room of blueprint.rooms) roomMap.set(room.id, room);

  const shuffled = [...narrowPassages];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const passage of shuffled) {
    const roomFrom = roomMap.get(passage.from);
    const roomTo = roomMap.get(passage.to);
    if (!roomFrom || !roomTo) continue;

    const nearRoom = roomFrom.distanceFromCenter <= roomTo.distanceFromCenter ? roomFrom : roomTo;
    const farRoom = nearRoom === roomFrom ? roomTo : roomFrom;

    const nearCells = collectRoomFloorCells(nearRoom, grid, blueprint);
    const farCells = collectRoomFloorCells(farRoom, grid, blueprint);

    const gateCandidates = findGatekeeperCells(nearCells, passage);
    if (gateCandidates.length === 0) continue;

    const innerViable = farCells.filter((c) => c.reversePullDirs >= 1);
    if (innerViable.length < boxCount - 1) continue;

    const gateCell = gateCandidates[0];
    const gateGoal: GoalCell = {
      row: gateCell.row,
      column: gateCell.column,
      roomId: nearRoom.id,
      depthFromDoorway: gateCell.depthFromDoorway,
      reversePullDirs: gateCell.reversePullDirs,
    };

    innerViable.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);
    const innerGoals = selectGoals(innerViable, boxCount - 1, farRoom.id, grid);
    if (innerGoals.length < boxCount - 1) continue;

    const goals: GoalCell[] = [gateGoal, ...innerGoals];

    const passageCells = passage.cells.map((c) => `(${c.row},${c.column})`).join(" ");
    const hints: DependencyHint[] = [{
      type: "gatekeeper",
      description:
        `Goal at (${gateCell.row},${gateCell.column}) guards passage at ${passageCells}. ` +
        `${boxCount - 1} goals in far room ${farRoom.id} require transit through this passage. ` +
        `Gatekeeper box must be coordinated with inner-box movement.`,
      involvedGoalIndices: goals.map((_, i) => i),
    }];

    return { goals, hints, goalStyle: "mixed" };
  }

  return null;
}

function findGatekeeperCells(
  roomCells: RoomFloorCell[],
  passage: PassageEdge,
): RoomFloorCell[] {
  const adjacent = roomCells.filter((cell) => {
    if (cell.reversePullDirs < 1) return false;

    for (const pc of passage.cells) {
      const dist = Math.abs(cell.row - pc.row) + Math.abs(cell.column - pc.column);
      if (dist === 1) return true;
    }
    return false;
  });

  adjacent.sort((a, b) => a.floorNeighbors - b.floorNeighbors);
  return adjacent;
}
