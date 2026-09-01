import type { FunctionalBlueprint, GoalCell, MechanismPlan } from "./blueprint-types.ts";
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
  readonly deadlockPressure: number;
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
  readonly deadlockPressure: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  boxesOffGoals: 3.0,
  roomCrossings: 5.0,
  boxDispersion: 2.0,
  chokepointInteractions: 4.0,
  tunnelOccupancy: 1.5,
  distanceFromSolved: 1.0,
  supportConstraints: 3.0,
  deadlockPressure: 2.0,
};

// ---------------------------------------------------------------------------
// Reverse Objective Vector (Phase 8)
// ---------------------------------------------------------------------------

export interface ReverseObjectiveVector {
  readonly scrambleDepth: number;
  readonly boxDiversity: number;
  readonly roomTraffic: number;
  readonly supportCompetition: number;
  readonly mechanismProgress: number;
  readonly dependencyPotential: number;
  readonly structuralRisk: number;
  readonly repetitionPenalty: number;
}

export interface MechanismReverseContext {
  readonly plan: MechanismPlan;
  readonly gateRoomIds: ReadonlySet<number>;
  readonly packingRoomIds: ReadonlySet<number>;
  readonly exchangeRoomIds: ReadonlySet<number>;
  readonly passageCells: ReadonlySet<string>;
}

export function buildMechanismReverseContext(
  plan: MechanismPlan,
  ctx: ScoringContext,
): MechanismReverseContext {
  const gateRoomIds = new Set<number>();
  const packingRoomIds = new Set<number>();
  const exchangeRoomIds = new Set<number>();

  for (const mech of plan.mechanisms) {
    for (const roomId of mech.primaryRoomIds) {
      if (mech.type === "gatekeeper" || mech.type === "gate-reopening") {
        gateRoomIds.add(roomId);
      }
      if (mech.type === "packing-chain" || mech.type === "dependency-chain") {
        packingRoomIds.add(roomId);
      }
      if (mech.type === "cross-room-exchange") {
        exchangeRoomIds.add(roomId);
      }
    }
  }

  const passageCells = new Set<string>();
  for (const passage of ctx.blueprint.passages) {
    for (const cell of passage.cells) {
      passageCells.add(`${cell.row},${cell.column}`);
    }
  }

  return { plan, gateRoomIds, packingRoomIds, exchangeRoomIds, passageCells };
}

export function computeObjectiveVector(
  ctx: ScoringContext,
  boxPositions: readonly GridPosition[],
  history: readonly PullHistoryEntry[],
  mechCtx?: MechanismReverseContext,
): ReverseObjectiveVector {
  const scrambleDepth = history.length;

  // Box diversity: how many distinct boxes have been moved
  const distinctBoxes = new Set<number>();
  for (const entry of history) {
    distinctBoxes.add(entry.boxIndex);
  }
  const boxDiversity = history.length > 0
    ? distinctBoxes.size / Math.max(boxPositions.length, 1)
    : 0;

  // Room traffic: how many room crossings occurred
  let roomCrossings = 0;
  for (const entry of history) {
    if (entry.fromRoom !== undefined && entry.toRoom !== undefined && entry.fromRoom !== entry.toRoom) {
      roomCrossings++;
    }
  }
  const roomTraffic = history.length > 0
    ? roomCrossings / history.length
    : 0;

  // Support competition: how many boxes are adjacent to other boxes
  const boxSet = new Set(boxPositions.map((b) => `${b.row},${b.column}`));
  const DR = [-1, 1, 0, 0];
  const DC = [0, 0, -1, 1];
  let supportPairs = 0;
  for (const box of boxPositions) {
    for (let d = 0; d < 4; d++) {
      if (boxSet.has(`${box.row + DR[d]},${box.column + DC[d]}`)) {
        supportPairs++;
      }
    }
  }
  const supportCompetition = supportPairs / Math.max(boxPositions.length, 1);

  // Mechanism progress: reward states aligned with the mechanism plan
  let mechanismProgress = 0;
  if (mechCtx) {
    mechanismProgress = computeMechanismProgress(ctx, boxPositions, history, mechCtx);
  }

  // Dependency potential: boxes in different rooms from their goals
  const goalSet = new Map<number, number>();
  for (let i = 0; i < ctx.goals.length; i++) {
    const goalRoom = ctx.roomLookup.get(`${ctx.goals[i].row},${ctx.goals[i].column}`);
    if (goalRoom !== undefined) goalSet.set(i, goalRoom);
  }
  let crossRoomBoxes = 0;
  for (let i = 0; i < boxPositions.length && i < ctx.goals.length; i++) {
    const boxRoom = ctx.roomLookup.get(`${boxPositions[i].row},${boxPositions[i].column}`);
    const goalRoom = goalSet.get(i);
    if (boxRoom !== undefined && goalRoom !== undefined && boxRoom !== goalRoom) {
      crossRoomBoxes++;
    }
  }
  const dependencyPotential = crossRoomBoxes / Math.max(boxPositions.length, 1);

  // Structural risk: boxes on chokepoints or tunnels (creates interesting constraints)
  let riskCells = 0;
  for (const box of boxPositions) {
    const key = `${box.row},${box.column}`;
    if (ctx.chokepointSet.has(key) || ctx.tunnelSet.has(key)) {
      riskCells++;
    }
  }
  const structuralRisk = riskCells / Math.max(boxPositions.length, 1);

  // Repetition penalty: how many consecutive pulls were on the same box
  let repetitions = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i].boxIndex === history[i - 1].boxIndex) {
      repetitions++;
    }
  }
  const repetitionPenalty = history.length > 1
    ? repetitions / (history.length - 1)
    : 0;

  return {
    scrambleDepth,
    boxDiversity,
    roomTraffic,
    supportCompetition,
    mechanismProgress,
    dependencyPotential,
    structuralRisk,
    repetitionPenalty,
  };
}

function computeMechanismProgress(
  ctx: ScoringContext,
  boxPositions: readonly GridPosition[],
  history: readonly PullHistoryEntry[],
  mechCtx: MechanismReverseContext,
): number {
  let progress = 0;
  const mechanisms = mechCtx.plan.mechanisms;
  const MP_DR = [-1, 1, 0, 0];
  const MP_DC = [0, 0, -1, 1];

  let goalOffset = 0;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const mech of mechanisms) {
    const range = { start: goalOffset, end: goalOffset + mech.allocatedGoals };
    ranges.push(range);
    const groupIndices = Array.from({ length: mech.allocatedGoals }, (_, index) => goalOffset + index)
      .filter((index) => index < boxPositions.length && index < ctx.goals.length);
    switch (mech.type) {
      case "gate-reopening":
      case "gatekeeper": {
        // Reward: gate-related boxes displaced from their goal positions near passages
        let gateDisplacement = 0;
        for (let i = 0; i < boxPositions.length && i < ctx.goals.length; i++) {
          const goalRoom = ctx.roomLookup.get(`${ctx.goals[i].row},${ctx.goals[i].column}`);
          if (goalRoom !== undefined && mechCtx.gateRoomIds.has(goalRoom)) {
            const dist =
              Math.abs(boxPositions[i].row - ctx.goals[i].row) +
              Math.abs(boxPositions[i].column - ctx.goals[i].column);
            if (dist > 0) gateDisplacement += dist;
          }
        }
        progress += Math.min(gateDisplacement * 0.5, 3.0);
        break;
      }
      case "packing-chain":
      case "dependency-chain": {
        // Reward: boxes in packing rooms are in reverse order from their goals
        let orderReversals = 0;
        const packingBoxes: Array<{ boxIdx: number; goalDepth: number; boxPos: GridPosition }> = [];
        for (let i = 0; i < boxPositions.length && i < ctx.goals.length; i++) {
          const goalRoom = ctx.roomLookup.get(`${ctx.goals[i].row},${ctx.goals[i].column}`);
          if (goalRoom !== undefined && mechCtx.packingRoomIds.has(goalRoom)) {
            packingBoxes.push({
              boxIdx: i,
              goalDepth: ctx.goals[i].depthFromDoorway,
              boxPos: boxPositions[i],
            });
          }
        }
        for (let a = 0; a < packingBoxes.length; a++) {
          for (let b = a + 1; b < packingBoxes.length; b++) {
            if (packingBoxes[a].goalDepth > packingBoxes[b].goalDepth) {
              // Deeper goal should have its box farther from door in starting state
              const distA = Math.abs(packingBoxes[a].boxPos.row - ctx.goals[packingBoxes[a].boxIdx].row) +
                Math.abs(packingBoxes[a].boxPos.column - ctx.goals[packingBoxes[a].boxIdx].column);
              const distB = Math.abs(packingBoxes[b].boxPos.row - ctx.goals[packingBoxes[b].boxIdx].row) +
                Math.abs(packingBoxes[b].boxPos.column - ctx.goals[packingBoxes[b].boxIdx].column);
              if (distA > distB) orderReversals++;
            }
          }
        }
        progress += Math.min(orderReversals * 0.5, 2.0);
        break;
      }
      case "cross-room-exchange": {
        // Reward: boxes beginning in opposite logical regions from their goal regions
        let crossRoom = 0;
        for (let i = 0; i < boxPositions.length && i < ctx.goals.length; i++) {
          const boxRoom = ctx.roomLookup.get(`${boxPositions[i].row},${boxPositions[i].column}`);
          const goalRoom = ctx.roomLookup.get(`${ctx.goals[i].row},${ctx.goals[i].column}`);
          if (boxRoom !== undefined && goalRoom !== undefined &&
              mechCtx.exchangeRoomIds.has(goalRoom) && boxRoom !== goalRoom) {
            crossRoom++;
          }
        }
        progress += Math.min(crossRoom * 1.0, 3.0);
        break;
      }
      case "corridor-traffic": {
        // Reward: boxes near or on passage cells (creating traffic contention)
        let passageAdjacent = 0;
        for (const box of boxPositions) {
          const key = `${box.row},${box.column}`;
          if (mechCtx.passageCells.has(key)) {
            passageAdjacent += 2;
          } else {
            for (let d = 0; d < 4; d++) {
              if (mechCtx.passageCells.has(`${box.row + MP_DR[d]},${box.column + MP_DC[d]}`)) {
                passageAdjacent++;
                break;
              }
            }
          }
        }
        progress += Math.min(passageAdjacent * 0.5, 3.0);
        break;
      }
      case "staging-dependency":
      case "temporary-parking": {
        const displaced = groupIndices.filter((index) =>
          boxPositions[index].row !== ctx.goals[index].row ||
          boxPositions[index].column !== ctx.goals[index].column).length;
        const revisited = groupIndices.filter((boxIndex) => {
          const occurrences = history.map((entry) => entry.boxIndex).filter((index) => index === boxIndex).length;
          return occurrences >= 2;
        }).length;
        progress += Math.min(displaced * 0.5 + revisited, 3.0);
        break;
      }
      case "assignment-misdirection": {
        let surprises = 0;
        for (const index of groupIndices) {
          const own = Math.abs(boxPositions[index].row - ctx.goals[index].row) +
            Math.abs(boxPositions[index].column - ctx.goals[index].column);
          const alternative = Math.min(...groupIndices
            .filter((other) => other !== index)
            .map((other) => Math.abs(boxPositions[index].row - ctx.goals[other].row) +
              Math.abs(boxPositions[index].column - ctx.goals[other].column)));
          if (alternative < own) surprises++;
        }
        progress += Math.min(surprises * 1.25, 4.0);
        break;
      }
      case "support-square-contention": {
        let contention = 0;
        for (let left = 0; left < groupIndices.length; left++) {
          for (let right = left + 1; right < groupIndices.length; right++) {
            const a = boxPositions[groupIndices[left]];
            const b = boxPositions[groupIndices[right]];
            const dr = Math.abs(a.row - b.row);
            const dc = Math.abs(a.column - b.column);
            if ((dr === 2 && dc === 0) || (dr === 0 && dc === 2)) contention++;
          }
        }
        progress += Math.min(contention * 1.5, 3.0);
        break;
      }
      case "multi-chain-merge": {
        const moved = new Set(history
          .filter((entry) => entry.boxIndex >= range.start && entry.boxIndex < range.end)
          .map((entry) => entry.boxIndex));
        const rooms = new Set(groupIndices.map((index) =>
          ctx.roomLookup.get(`${boxPositions[index].row},${boxPositions[index].column}`))
          .filter((room): room is number => room !== undefined));
        progress += Math.min(moved.size * 0.5 + Math.max(0, rooms.size - 1), 4.0);
        break;
      }
      default:
        break;
    }
    goalOffset = range.end;
  }

  // Reverse search should dismantle later mechanisms before earlier ones so
  // replay produces the plan's explicit forward sequence.
  for (let index = 0; index + 1 < ranges.length; index++) {
    const firstCurrent = history.findIndex((entry) => entry.boxIndex >= ranges[index].start && entry.boxIndex < ranges[index].end);
    const firstNext = history.findIndex((entry) => entry.boxIndex >= ranges[index + 1].start && entry.boxIndex < ranges[index + 1].end);
    if (firstNext >= 0 && (firstCurrent < 0 || firstNext < firstCurrent)) progress += 0.75;
  }

  return progress;
}

export function objectiveVectorComposite(vec: ReverseObjectiveVector): number {
  return (
    vec.scrambleDepth * 0.3 +
    vec.boxDiversity * 5.0 +
    vec.roomTraffic * 4.0 +
    vec.supportCompetition * 3.0 +
    vec.mechanismProgress * 4.0 +
    vec.dependencyPotential * 5.0 +
    vec.structuralRisk * 2.0 -
    vec.repetitionPenalty * 3.0
  );
}

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
  const deadlockPressure = computeDeadlockPressure(boxPositions, ctx.grid, goalSet);

  const composite =
    boxesOffGoals * weights.boxesOffGoals +
    roomCrossings * weights.roomCrossings +
    boxDispersion * weights.boxDispersion +
    chokepointInteractions * weights.chokepointInteractions +
    tunnelOccupancy * weights.tunnelOccupancy +
    distanceFromSolved * weights.distanceFromSolved +
    supportConstraints * weights.supportConstraints +
    deadlockPressure * weights.deadlockPressure;

  return {
    boxesOffGoals,
    roomCrossings,
    boxDispersion,
    chokepointInteractions,
    tunnelOccupancy,
    distanceFromSolved,
    supportConstraints,
    deadlockPressure,
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

function computeDeadlockPressure(
  boxPositions: readonly GridPosition[],
  grid: readonly (readonly string[])[],
  goalSet: ReadonlySet<string>,
): number {
  if (boxPositions.length === 0) return 0;
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;
  const boxSet = new Set(boxPositions.map((b) => `${b.row},${b.column}`));
  const DR = [-1, 1, 0, 0];
  const DC = [0, 0, -1, 1];

  let deadlockAdjacentCount = 0;
  for (const box of boxPositions) {
    let hasAdjacentDead = false;
    for (let d = 0; d < 4; d++) {
      const nr = box.row + DR[d];
      const nc = box.column + DC[d];
      if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
      if (grid[nr][nc] === "O" || boxSet.has(`${nr},${nc}`)) continue;
      if (isCornerDeadCell(nr, nc, grid, h, w, goalSet)) {
        hasAdjacentDead = true;
        break;
      }
    }
    if (hasAdjacentDead) deadlockAdjacentCount++;
  }
  return deadlockAdjacentCount / boxPositions.length;
}

function isCornerDeadCell(
  r: number, c: number,
  grid: readonly (readonly string[])[],
  h: number, w: number,
  goalSet: ReadonlySet<string>,
): boolean {
  if (goalSet.has(`${r},${c}`)) return false;
  if (grid[r][c] === "O") return false;

  const wallUp = r <= 0 || grid[r - 1][c] === "O";
  const wallDown = r >= h - 1 || grid[r + 1][c] === "O";
  const wallLeft = c <= 0 || grid[r][c - 1] === "O";
  const wallRight = c >= w - 1 || grid[r][c + 1] === "O";

  return (wallUp && wallLeft) || (wallUp && wallRight) ||
         (wallDown && wallLeft) || (wallDown && wallRight);
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
