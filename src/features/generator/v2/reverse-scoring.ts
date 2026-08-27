import type { FunctionalBlueprint, GoalCell } from "./blueprint-types.ts";
import type { GridPosition } from "../generator-types.ts";
import { floodKeeperReachable } from "./reachable-pushes.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReverseStateScore {
  readonly boxesOffGoals: number;
  readonly roomCrossings: number;
  readonly boxDispersion: number;
  readonly chokepointInteractions: number;
  readonly tunnelOccupancy: number;
  readonly distanceFromSolved: number;
  readonly supportConstraints: number;
  readonly composite: number;
}

export interface ScoringContext {
  readonly blueprint: FunctionalBlueprint;
  readonly grid: readonly (readonly string[])[];
  readonly goals: readonly GoalCell[];
  readonly roomLookup: ReadonlyMap<string, number>;
  readonly chokepointSet: ReadonlySet<string>;
  readonly tunnelSet: ReadonlySet<string>;
}

export interface ScoringWeights {
  readonly boxesOffGoals: number;
  readonly roomCrossings: number;
  readonly boxDispersion: number;
  readonly chokepointInteractions: number;
  readonly tunnelOccupancy: number;
  readonly distanceFromSolved: number;
  readonly supportConstraints: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  boxesOffGoals: 3.0,
  roomCrossings: 5.0,
  boxDispersion: 2.0,
  chokepointInteractions: 4.0,
  tunnelOccupancy: 1.5,
  distanceFromSolved: 1.0,
  supportConstraints: 3.0,
};

// ---------------------------------------------------------------------------
// Scoring context construction
// ---------------------------------------------------------------------------

export function buildScoringContext(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  goals: readonly GoalCell[],
): ScoringContext {
  const roomLookup = new Map<string, number>();
  for (const room of blueprint.rooms) {
    for (let dy = 0; dy < room.height; dy++) {
      for (let dx = 0; dx < room.width; dx++) {
        const r = room.y + dy;
        const c = room.x + dx;
        if (r > 0 && r < grid.length - 1 && c > 0 && c < grid[0].length - 1) {
          if (grid[r][c] !== "O") {
            roomLookup.set(`${r},${c}`, room.id);
          }
        }
      }
    }
  }

  const chokepointSet = findChokepoints(grid);
  const tunnelSet = findTunnels(grid);

  return { blueprint, grid, goals, roomLookup, chokepointSet, tunnelSet };
}

function findChokepoints(grid: readonly (readonly string[])[]): Set<string> {
  const result = new Set<string>();
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;
  const DR = [-1, 1, 0, 0];
  const DC = [0, 0, -1, 1];

  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      if (grid[r][c] === "O") continue;
      let floorN = 0;
      for (let d = 0; d < 4; d++) {
        const nr = r + DR[d];
        const nc = c + DC[d];
        if (nr >= 0 && nr < h && nc >= 0 && nc < w && grid[nr][nc] !== "O") {
          floorN++;
        }
      }
      if (floorN === 2) {
        result.add(`${r},${c}`);
      }
    }
  }
  return result;
}

function findTunnels(grid: readonly (readonly string[])[]): Set<string> {
  const result = new Set<string>();
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;
  const DR = [-1, 1, 0, 0];
  const DC = [0, 0, -1, 1];

  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      if (grid[r][c] === "O") continue;
      const dirs: number[] = [];
      for (let d = 0; d < 4; d++) {
        const nr = r + DR[d];
        const nc = c + DC[d];
        if (nr >= 0 && nr < h && nc >= 0 && nc < w && grid[nr][nc] !== "O") {
          dirs.push(d);
        }
      }
      if (dirs.length !== 2) continue;
      const [d0, d1] = dirs;
      if ((d0 === 0 && d1 === 1) || (d0 === 2 && d1 === 3)) {
        result.add(`${r},${c}`);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Score a reverse-search state
// ---------------------------------------------------------------------------

export function scoreState(
  ctx: ScoringContext,
  boxPositions: readonly GridPosition[],
  robotPosition: GridPosition,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): ReverseStateScore {
  const goalSet = new Set(ctx.goals.map((g) => `${g.row},${g.column}`));

  const boxesOffGoals = countBoxesOffGoals(boxPositions, goalSet);
  const roomCrossings = countRoomCrossings(boxPositions, ctx);
  const boxDispersion = computeBoxDispersion(boxPositions);
  const chokepointInteractions = countChokepointInteractions(boxPositions, ctx);
  const tunnelOccupancy = countTunnelOccupancy(boxPositions, ctx);
  const distanceFromSolved = computeDistanceFromSolved(boxPositions, ctx.goals);
  const supportConstraints = countSupportConstraints(boxPositions);

  const composite =
    boxesOffGoals * weights.boxesOffGoals +
    roomCrossings * weights.roomCrossings +
    boxDispersion * weights.boxDispersion +
    chokepointInteractions * weights.chokepointInteractions +
    tunnelOccupancy * weights.tunnelOccupancy +
    distanceFromSolved * weights.distanceFromSolved +
    supportConstraints * weights.supportConstraints;

  return {
    boxesOffGoals,
    roomCrossings,
    boxDispersion,
    chokepointInteractions,
    tunnelOccupancy,
    distanceFromSolved,
    supportConstraints,
    composite,
  };
}

// ---------------------------------------------------------------------------
// Individual scoring features
// ---------------------------------------------------------------------------

function countBoxesOffGoals(
  boxPositions: readonly GridPosition[],
  goalSet: ReadonlySet<string>,
): number {
  let count = 0;
  for (const box of boxPositions) {
    if (!goalSet.has(`${box.row},${box.column}`)) count++;
  }
  return count;
}

function countRoomCrossings(
  boxPositions: readonly GridPosition[],
  ctx: ScoringContext,
): number {
  let crossings = 0;
  for (let i = 0; i < boxPositions.length; i++) {
    const boxKey = `${boxPositions[i].row},${boxPositions[i].column}`;
    const goalKey = `${ctx.goals[i]?.row},${ctx.goals[i]?.column}`;
    const boxRoom = ctx.roomLookup.get(boxKey);
    const goalRoom = ctx.roomLookup.get(goalKey);
    if (boxRoom !== undefined && goalRoom !== undefined && boxRoom !== goalRoom) {
      crossings++;
    }
  }
  return crossings;
}

function computeBoxDispersion(boxPositions: readonly GridPosition[]): number {
  if (boxPositions.length <= 1) return 0;
  let totalDist = 0;
  let pairs = 0;
  for (let i = 0; i < boxPositions.length; i++) {
    for (let j = i + 1; j < boxPositions.length; j++) {
      totalDist +=
        Math.abs(boxPositions[i].row - boxPositions[j].row) +
        Math.abs(boxPositions[i].column - boxPositions[j].column);
      pairs++;
    }
  }
  return pairs > 0 ? totalDist / pairs : 0;
}

function countChokepointInteractions(
  boxPositions: readonly GridPosition[],
  ctx: ScoringContext,
): number {
  let count = 0;
  for (const box of boxPositions) {
    if (ctx.chokepointSet.has(`${box.row},${box.column}`)) count++;
    for (let d = 0; d < 4; d++) {
      const DR = [-1, 1, 0, 0];
      const DC = [0, 0, -1, 1];
      const nr = box.row + DR[d];
      const nc = box.column + DC[d];
      if (ctx.chokepointSet.has(`${nr},${nc}`)) {
        count++;
        break;
      }
    }
  }
  return count;
}

function countTunnelOccupancy(
  boxPositions: readonly GridPosition[],
  ctx: ScoringContext,
): number {
  let count = 0;
  for (const box of boxPositions) {
    if (ctx.tunnelSet.has(`${box.row},${box.column}`)) count++;
  }
  return count;
}

function computeDistanceFromSolved(
  boxPositions: readonly GridPosition[],
  goals: readonly GoalCell[],
): number {
  let totalDist = 0;
  for (let i = 0; i < boxPositions.length && i < goals.length; i++) {
    totalDist +=
      Math.abs(boxPositions[i].row - goals[i].row) +
      Math.abs(boxPositions[i].column - goals[i].column);
  }
  return totalDist;
}

function countSupportConstraints(
  boxPositions: readonly GridPosition[],
): number {
  const boxSet = new Set(boxPositions.map((b) => `${b.row},${b.column}`));
  let count = 0;
  const DR = [-1, 1, 0, 0];
  const DC = [0, 0, -1, 1];

  for (const box of boxPositions) {
    for (let d = 0; d < 4; d++) {
      const nr = box.row + DR[d];
      const nc = box.column + DC[d];
      if (boxSet.has(`${nr},${nc}`)) {
        count++;
        break;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// State fingerprint for diversity tracking
// ---------------------------------------------------------------------------

export function stateFingerprint(
  boxPositions: readonly GridPosition[],
): string {
  const sorted = [...boxPositions]
    .map((b) => `${b.row},${b.column}`)
    .sort();
  return sorted.join("|");
}

// ---------------------------------------------------------------------------
// Keeper-region-aware state key (V4)
// ---------------------------------------------------------------------------

function hashKeeperRegion(reachableCells: ReadonlySet<string>): string {
  const sorted = [...reachableCells].sort();
  let hash = 0;
  for (const key of sorted) {
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
  }
  return (hash >>> 0).toString(36);
}

export function reverseStateKey(
  grid: readonly (readonly string[])[],
  boxPositions: readonly GridPosition[],
  robotPosition: GridPosition,
): string {
  const boxSet = new Set<string>();
  for (const b of boxPositions) boxSet.add(`${b.row},${b.column}`);

  const reachable = floodKeeperReachable(grid, robotPosition, boxSet);
  const regionHash = hashKeeperRegion(reachable);
  const boxFp = stateFingerprint(boxPositions);

  return `${boxFp}#${regionHash}`;
}

// ---------------------------------------------------------------------------
// History-based complexity bonus (V4)
// ---------------------------------------------------------------------------

export interface PullHistoryEntry {
  readonly boxIndex: number;
  readonly fromRoom?: number;
  readonly toRoom?: number;
}

export function historyComplexityBonus(
  history: readonly PullHistoryEntry[],
): number {
  if (history.length === 0) return 0;

  const distinctBoxes = new Set<number>();
  let roomCrossings = 0;

  for (const entry of history) {
    distinctBoxes.add(entry.boxIndex);
    if (
      entry.fromRoom !== undefined &&
      entry.toRoom !== undefined &&
      entry.fromRoom !== entry.toRoom
    ) {
      roomCrossings++;
    }
  }

  const boxDiversity = distinctBoxes.size / Math.max(history.length, 1);
  const crossingRate = roomCrossings / Math.max(history.length, 1);

  return boxDiversity * 2.0 + crossingRate * 3.0;
}
