import { createRng } from "../board-template.ts";
import type {
  FunctionalBlueprint,
  FunctionalRoom,
  GoalCell,
  GoalPlacementParams,
  GoalStyle,
  SolvedBlueprint,
} from "./blueprint-types.ts";
import type { GridPosition, SolvedTemplate } from "../generator-types.ts";
import { rasterizeBlueprint } from "./blueprint-graph.ts";
import { shuffleArray } from "../shuffle.ts";

// ---------------------------------------------------------------------------
// Directions
// ---------------------------------------------------------------------------

const DR = [-1, 1, 0, 0];
const DC = [0, 0, -1, 1];

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------

function isFloor(
  grid: readonly (readonly string[])[],
  r: number,
  c: number,
): boolean {
  if (r < 0 || r >= grid.length || c < 0 || c >= grid[0].length) return false;
  return grid[r][c] !== "O";
}

function floorNeighborCount(
  grid: readonly (readonly string[])[],
  r: number,
  c: number,
): number {
  let count = 0;
  for (let d = 0; d < 4; d++) {
    if (isFloor(grid, r + DR[d], c + DC[d])) count++;
  }
  return count;
}

function reversePullDirections(
  grid: readonly (readonly string[])[],
  r: number,
  c: number,
): number {
  let count = 0;
  for (let d = 0; d < 4; d++) {
    const pullR = r + DR[d];
    const pullC = c + DC[d];
    const retreatR = pullR + DR[d];
    const retreatC = pullC + DC[d];
    if (isFloor(grid, pullR, pullC) && isFloor(grid, retreatR, retreatC)) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Room floor cells
// ---------------------------------------------------------------------------

export interface RoomFloorCell {
  readonly row: number;
  readonly column: number;
  readonly depthFromDoorway: number;
  readonly reversePullDirs: number;
  readonly wallAdjacent: boolean;
  readonly floorNeighbors: number;
}

export function collectRoomFloorCells(
  room: FunctionalRoom,
  grid: readonly (readonly string[])[],
  blueprint: FunctionalBlueprint,
): RoomFloorCell[] {
  const cells: RoomFloorCell[] = [];
  const doorways = findDoorways(room, blueprint);

  for (let dy = 0; dy < room.height; dy++) {
    for (let dx = 0; dx < room.width; dx++) {
      const r = room.y + dy;
      const c = room.x + dx;
      if (!isFloor(grid, r, c)) continue;
      if (r <= 0 || r >= grid.length - 1) continue;
      if (c <= 0 || c >= grid[0].length - 1) continue;

      const rpDirs = reversePullDirections(grid, r, c);
      const fn = floorNeighborCount(grid, r, c);
      const depth = minDistanceToDoorways(r, c, doorways);
      const wa = isWallAdjacent(grid, r, c);

      cells.push({
        row: r,
        column: c,
        depthFromDoorway: depth,
        reversePullDirs: rpDirs,
        wallAdjacent: wa,
        floorNeighbors: fn,
      });
    }
  }

  return cells;
}

export function findDoorways(
  room: FunctionalRoom,
  blueprint: FunctionalBlueprint,
): GridPosition[] {
  const doorways: GridPosition[] = [];
  for (const passage of blueprint.passages) {
    if (passage.from !== room.id && passage.to !== room.id) continue;
    for (const cell of passage.cells) {
      const inRoom =
        cell.row >= room.y &&
        cell.row < room.y + room.height &&
        cell.column >= room.x &&
        cell.column < room.x + room.width;
      const adjacent =
        cell.row >= room.y - 1 &&
        cell.row <= room.y + room.height &&
        cell.column >= room.x - 1 &&
        cell.column <= room.x + room.width;
      if (inRoom || adjacent) {
        doorways.push({ row: cell.row, column: cell.column });
      }
    }
  }

  if (doorways.length === 0) {
    const cx = Math.floor(room.x + room.width / 2);
    const cy = Math.floor(room.y + room.height / 2);
    doorways.push({ row: cy, column: cx });
  }

  return doorways;
}

function minDistanceToDoorways(
  r: number,
  c: number,
  doorways: readonly GridPosition[],
): number {
  if (doorways.length === 0) return 0;
  let min = Infinity;
  for (const d of doorways) {
    const dist = Math.abs(r - d.row) + Math.abs(c - d.column);
    if (dist < min) min = dist;
  }
  return min;
}

function isWallAdjacent(
  grid: readonly (readonly string[])[],
  r: number,
  c: number,
): boolean {
  for (let d = 0; d < 4; d++) {
    if (!isFloor(grid, r + DR[d], c + DC[d])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Goal style selection
// ---------------------------------------------------------------------------

function chooseGoalStyle(
  blueprint: FunctionalBlueprint,
  boxCount: number,
  rng: () => number,
): GoalStyle {
  const goalRooms = blueprint.rooms.filter((r) => r.role === "goal-room");
  const exchangeRooms = blueprint.rooms.filter((r) => r.role === "exchange");

  if (exchangeRooms.length >= 2 && boxCount >= 4) {
    if (rng() < 0.3) return "exchange";
  }

  if (goalRooms.length >= 2 && boxCount >= 2) {
    const roll = rng();
    if (roll < 0.4) return "multi-room";
    if (roll < 0.7) return "mixed";
    return "concentrated";
  }

  if (goalRooms.length === 1) {
    const otherRooms = blueprint.rooms.filter(
      (r) => r.role !== "goal-room" && r.role !== "transit",
    );
    if (otherRooms.length >= 1 && boxCount >= 2) {
      const roll = rng();
      if (roll < 0.35) return "mixed";
    }
    return "concentrated";
  }

  return "concentrated";
}

// ---------------------------------------------------------------------------
// Goal placement
// ---------------------------------------------------------------------------

export function placeGoals(
  blueprint: FunctionalBlueprint,
  params: GoalPlacementParams,
): SolvedBlueprint | null {
  const rng = createRng(params.seed);
  const grid = rasterizeBlueprint(blueprint);

  const style: GoalStyle =
    params.goalStyle === "auto"
      ? chooseGoalStyle(blueprint, params.boxCount, rng)
      : params.goalStyle;

  const goals = placeGoalsForStyle(blueprint, grid, params.boxCount, style, rng);
  if (!goals || goals.length !== params.boxCount) return null;

  const robotPos = chooseRobotPosition(blueprint, grid, goals, rng);
  if (!robotPos) return null;

  return {
    blueprint,
    grid,
    goals,
    robotPosition: robotPos,
    goalStyle: style,
  };
}

function placeGoalsForStyle(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  style: GoalStyle,
  rng: () => number,
): GoalCell[] | null {
  switch (style) {
    case "concentrated":
      return placeConcentrated(blueprint, grid, boxCount, rng);
    case "multi-room":
      return placeMultiRoom(blueprint, grid, boxCount, rng);
    case "mixed":
      return placeMixed(blueprint, grid, boxCount, rng);
    case "exchange":
      return placeExchange(blueprint, grid, boxCount, rng);
  }
}

// ---------------------------------------------------------------------------
// Concentrated: all goals in a single goal room, deepest-first
// ---------------------------------------------------------------------------

function placeConcentrated(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  rng: () => number,
): GoalCell[] | null {
  const goalRooms = blueprint.rooms.filter((r) => r.role === "goal-room");
  if (goalRooms.length === 0) {
    const sorted = [...blueprint.rooms].sort(
      (a, b) => (b.width * b.height) - (a.width * a.height),
    );
    if (sorted.length > 0) goalRooms.push(sorted[0] as FunctionalRoom);
  }

  for (const room of goalRooms) {
    const cells = collectRoomFloorCells(room, grid, blueprint);
    const viable = cells.filter((c) => c.reversePullDirs >= 1);

    viable.sort((a, b) => {
      if (b.depthFromDoorway !== a.depthFromDoorway)
        return b.depthFromDoorway - a.depthFromDoorway;
      if (a.wallAdjacent !== b.wallAdjacent)
        return a.wallAdjacent ? -1 : 1;
      return a.reversePullDirs - b.reversePullDirs;
    });

    if (viable.length >= boxCount) {
      return selectGoals(viable, boxCount, room.id, grid);
    }
  }

  return placeAnyAvailable(blueprint, grid, boxCount, rng);
}

// ---------------------------------------------------------------------------
// Multi-room: distribute goals across multiple goal rooms
// ---------------------------------------------------------------------------

function placeMultiRoom(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  rng: () => number,
): GoalCell[] | null {
  const goalRooms = blueprint.rooms.filter((r) => r.role === "goal-room");
  if (goalRooms.length < 2) return placeConcentrated(blueprint, grid, boxCount, rng);

  const goals: GoalCell[] = [];
  const goalsPerRoom = distributeEvenly(boxCount, goalRooms.length);

  for (let i = 0; i < goalRooms.length; i++) {
    const room = goalRooms[i];
    const count = goalsPerRoom[i];
    if (count === 0) continue;

    const cells = collectRoomFloorCells(room, grid, blueprint);
    const viable = cells.filter((c) => c.reversePullDirs >= 1);
    viable.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);

    const placed = selectGoals(viable, count, room.id, grid);
    if (placed.length < count) return placeConcentrated(blueprint, grid, boxCount, rng);
    goals.push(...placed);
  }

  return goals.length === boxCount ? goals : placeConcentrated(blueprint, grid, boxCount, rng);
}

// ---------------------------------------------------------------------------
// Mixed: some goals in a goal room, rest in general area
// ---------------------------------------------------------------------------

function placeMixed(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  rng: () => number,
): GoalCell[] | null {
  const goalRooms = blueprint.rooms.filter((r) => r.role === "goal-room");
  if (goalRooms.length === 0) return placeConcentrated(blueprint, grid, boxCount, rng);

  const primaryCount = Math.max(1, Math.ceil(boxCount * 0.6));

  const goals: GoalCell[] = [];

  const primaryRoom = goalRooms[0];
  const primaryCells = collectRoomFloorCells(primaryRoom, grid, blueprint);
  const primaryViable = primaryCells.filter((c) => c.reversePullDirs >= 1);
  primaryViable.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);

  const primaryPlaced = selectGoals(primaryViable, primaryCount, primaryRoom.id, grid);
  if (primaryPlaced.length < primaryCount) {
    return placeConcentrated(blueprint, grid, boxCount, rng);
  }
  goals.push(...primaryPlaced);

  const usedKeys = new Set(goals.map((g) => `${g.row},${g.column}`));
  const otherRooms = blueprint.rooms.filter(
    (r) => r.id !== primaryRoom.id && r.role !== "transit",
  );

  const secondaryCells: RoomFloorCell[] = [];
  for (const room of otherRooms) {
    const cells = collectRoomFloorCells(room, grid, blueprint);
    for (const c of cells) {
      if (!usedKeys.has(`${c.row},${c.column}`) && c.reversePullDirs >= 1) {
        secondaryCells.push(c);
      }
    }
  }

  shuffleArray(secondaryCells, rng);

  for (const cell of secondaryCells) {
    if (goals.length >= boxCount) break;
    const key = `${cell.row},${cell.column}`;
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    goals.push({
      row: cell.row,
      column: cell.column,
      roomId: findRoomForCell(blueprint, cell.row, cell.column),
      depthFromDoorway: cell.depthFromDoorway,
      reversePullDirs: cell.reversePullDirs,
    });
  }

  return goals.length === boxCount ? goals : placeConcentrated(blueprint, grid, boxCount, rng);
}

// ---------------------------------------------------------------------------
// Exchange: goals in different regions requiring cross-traffic
// ---------------------------------------------------------------------------

function placeExchange(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  rng: () => number,
): GoalCell[] | null {
  const exchangeRooms = blueprint.rooms.filter(
    (r) => r.role === "exchange" || r.role === "goal-room",
  );
  if (exchangeRooms.length < 2) return placeMultiRoom(blueprint, grid, boxCount, rng);

  const goals: GoalCell[] = [];
  const perRoom = distributeEvenly(boxCount, exchangeRooms.length);

  for (let i = 0; i < exchangeRooms.length; i++) {
    const room = exchangeRooms[i];
    const count = perRoom[i];
    if (count === 0) continue;

    const cells = collectRoomFloorCells(room, grid, blueprint);
    const viable = cells.filter((c) => c.reversePullDirs >= 1);
    viable.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);

    const placed = selectGoals(viable, count, room.id, grid);
    goals.push(...placed);
  }

  return goals.length === boxCount ? goals : placeMultiRoom(blueprint, grid, boxCount, rng);
}

// ---------------------------------------------------------------------------
// Fallback: any available floor cell
// ---------------------------------------------------------------------------

function placeAnyAvailable(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  boxCount: number,
  rng: () => number,
): GoalCell[] | null {
  const allCells: RoomFloorCell[] = [];
  for (const room of blueprint.rooms) {
    allCells.push(...collectRoomFloorCells(room, grid, blueprint));
  }

  const viable = allCells.filter((c) => c.reversePullDirs >= 1);
  if (viable.length < boxCount) return null;

  shuffleArray(viable, rng);
  return selectGoals(viable, boxCount, -1, grid);
}

// ---------------------------------------------------------------------------
// Goal selection with uniqueness and mutual mobility check
// ---------------------------------------------------------------------------

export function selectGoals(
  candidates: RoomFloorCell[],
  count: number,
  defaultRoomId: number,
  grid: readonly (readonly string[])[],
): GoalCell[] {
  const goals: GoalCell[] = [];
  const used = new Set<string>();

  for (const cell of candidates) {
    if (goals.length >= count) break;
    const key = `${cell.row},${cell.column}`;
    if (used.has(key)) continue;

    if (!wouldBlockExistingGoals(goals, cell, grid)) {
      used.add(key);
      const rid = defaultRoomId >= 0 ? defaultRoomId : 0;
      goals.push({
        goalId: `r${rid}-g${goals.length}`,
        row: cell.row,
        column: cell.column,
        roomId: rid,
        depthFromDoorway: cell.depthFromDoorway,
        reversePullDirs: cell.reversePullDirs,
      });
    }
  }

  return goals;
}

/** Extend a real motif without overwriting its goals or blocking its pull supports. */
export function extendGoalSet(blueprint: FunctionalBlueprint, grid: readonly (readonly string[])[],
  anchors: readonly GoalCell[], count: number, seed: number): GoalCell[] | null {
  const goals = [...anchors];
  const used = new Set(goals.map(g => `${g.row},${g.column}`));
  const rng = createRng(seed);
  const cells = blueprint.rooms.flatMap(room => collectRoomFloorCells(room, grid, blueprint)
    .filter(c => c.reversePullDirs > 0).map(cell => ({ ...cell, roomId: room.id, tie: rng() })));
  // Round-robin room occupancy prevents overfilling the motif's original room.
  while (goals.length < count) {
    const occupancy = new Map<number, number>();
    for (const goal of goals) occupancy.set(goal.roomId, (occupancy.get(goal.roomId) ?? 0) + 1);
    cells.sort((a, b) => (occupancy.get(a.roomId) ?? 0) - (occupancy.get(b.roomId) ?? 0) ||
      b.depthFromDoorway - a.depthFromDoorway || a.tie - b.tie);
    const next = cells.find(c => !used.has(`${c.row},${c.column}`) && !wouldBlockExistingGoals(goals, c, grid));
    if (!next) return null;
    used.add(`${next.row},${next.column}`);
    goals.push({ goalId: `extension-${goals.length}`, roomId: next.roomId, row: next.row, column: next.column,
      depthFromDoorway: next.depthFromDoorway, reversePullDirs: next.reversePullDirs });
  }
  return goals;
}

function wouldBlockExistingGoals(
  existing: readonly GoalCell[],
  candidate: RoomFloorCell,
  grid: readonly (readonly string[])[],
): boolean {
  if (existing.length === 0) return false;

  for (const goal of existing) {
    const rp = reversePullDirectionsExcluding(
      grid,
      goal.row,
      goal.column,
      [...existing.filter((g) => g !== goal), { row: candidate.row, column: candidate.column }],
    );
    if (rp === 0) return true;
  }

  const candidateRp = reversePullDirectionsExcluding(
    grid,
    candidate.row,
    candidate.column,
    existing.map((g) => ({ row: g.row, column: g.column })),
  );
  if (candidateRp === 0) return true;

  return false;
}

function reversePullDirectionsExcluding(
  grid: readonly (readonly string[])[],
  r: number,
  c: number,
  occupied: readonly { row: number; column: number }[],
): number {
  const occupiedSet = new Set(occupied.map((o) => `${o.row},${o.column}`));
  let count = 0;
  for (let d = 0; d < 4; d++) {
    const pullR = r + DR[d];
    const pullC = c + DC[d];
    const retreatR = pullR + DR[d];
    const retreatC = pullC + DC[d];
    if (
      isFloor(grid, pullR, pullC) &&
      isFloor(grid, retreatR, retreatC) &&
      !occupiedSet.has(`${pullR},${pullC}`) &&
      !occupiedSet.has(`${retreatR},${retreatC}`)
    ) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Robot placement
// ---------------------------------------------------------------------------

export function chooseRobotPosition(
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  goals: readonly GoalCell[],
  rng: () => number,
): { row: number; column: number } | null {
  const goalSet = new Set(goals.map((g) => `${g.row},${g.column}`));

  const stagingRooms = blueprint.rooms.filter(
    (r) => r.role === "staging" || r.role === "transit" || r.role === "general",
  );
  const searchRooms = stagingRooms.length > 0 ? stagingRooms : blueprint.rooms;

  const candidates: { row: number; column: number; score: number }[] = [];

  for (const room of searchRooms) {
    for (let dy = 0; dy < room.height; dy++) {
      for (let dx = 0; dx < room.width; dx++) {
        const r = room.y + dy;
        const c = room.x + dx;
        if (!isFloor(grid, r, c)) continue;
        if (r <= 0 || r >= grid.length - 1) continue;
        if (c <= 0 || c >= grid[0].length - 1) continue;
        if (goalSet.has(`${r},${c}`)) continue;

        const fn = floorNeighborCount(grid, r, c);
        if (fn < 2) continue;

        const score = fn + (room.role === "staging" ? 2 : 0) + (room.role === "transit" ? 1 : 0);
        candidates.push({ row: r, column: c, score });
      }
    }
  }

  if (candidates.length === 0) {
    for (let r = 1; r < grid.length - 1; r++) {
      for (let c = 1; c < grid[0].length - 1; c++) {
        if (isFloor(grid, r, c) && !goalSet.has(`${r},${c}`)) {
          return { row: r, column: c };
        }
      }
    }
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);
  const topN = Math.min(3, candidates.length);
  const chosen = candidates[Math.floor(rng() * topN)];
  return { row: chosen.row, column: chosen.column };
}

// ---------------------------------------------------------------------------
// SolvedTemplate conversion
// ---------------------------------------------------------------------------

export function toSolvedTemplate(solved: SolvedBlueprint): SolvedTemplate {
  return {
    width: solved.blueprint.boardWidth,
    height: solved.blueprint.boardHeight,
    grid: solved.grid,
    goalPositions: solved.goals.map((g) => ({ row: g.row, column: g.column })),
    robotPosition: solved.robotPosition,
  };
}

// ---------------------------------------------------------------------------
// Solved blueprint ASCII visualization
// ---------------------------------------------------------------------------

export function solvedBlueprintToAscii(solved: SolvedBlueprint): string {
  const grid = solved.grid.map((row) => [...row]);

  for (const room of solved.blueprint.rooms) {
    const roleChar = roleToChar(room.role);
    for (let dy = 0; dy < room.height; dy++) {
      for (let dx = 0; dx < room.width; dx++) {
        const r = room.y + dy;
        const c = room.x + dx;
        if (r > 0 && r < grid.length - 1 && c > 0 && c < grid[0].length - 1) {
          if (grid[r][c] === " ") {
            grid[r][c] = roleChar;
          }
        }
      }
    }
  }

  for (const goal of solved.goals) {
    grid[goal.row][goal.column] = "*";
  }

  grid[solved.robotPosition.row][solved.robotPosition.column] = "R";

  return grid.map((row) => row.join("")).join("\n");
}

function roleToChar(role: string): string {
  switch (role) {
    case "goal-room": return "g";
    case "staging": return "s";
    case "transit": return "t";
    case "exchange": return "x";
    case "packing": return "p";
    default: return ".";
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function distributeEvenly(total: number, buckets: number): number[] {
  const base = Math.floor(total / buckets);
  const remainder = total % buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < remainder ? 1 : 0));
}

function findRoomForCell(blueprint: FunctionalBlueprint, row: number, col: number): number {
  for (const room of blueprint.rooms) {
    if (
      row >= room.y &&
      row < room.y + room.height &&
      col >= room.x &&
      col < room.x + room.width
    ) {
      return room.id;
    }
  }
  return -1;
}
