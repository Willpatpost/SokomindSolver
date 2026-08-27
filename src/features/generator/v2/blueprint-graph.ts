import { createRng } from "../board-template.ts";
import {
  TOPOLOGY_FAMILIES,
  type BlueprintParams,
  type PassageCell,
  type PassageEdge,
  type RoomNode,
  type StructuralBlueprint,
  type TopologyFamily,
} from "./blueprint-types.ts";

interface PlacedRoom {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

function randomInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pickFamily(rng: () => number): TopologyFamily {
  return TOPOLOGY_FAMILIES[Math.floor(rng() * TOPOLOGY_FAMILIES.length)];
}

function roomCountForFamily(
  family: TopologyFamily,
  minRooms: number,
  maxRooms: number,
  rng: () => number,
): number {
  switch (family) {
    case "linear":
      return Math.max(2, randomInt(rng, minRooms, maxRooms));
    case "hub":
      return Math.max(4, randomInt(rng, Math.max(minRooms, 4), maxRooms));
    case "loop":
      return Math.max(4, randomInt(rng, Math.max(minRooms, 4), maxRooms));
    case "branch":
      return Math.max(3, randomInt(rng, Math.max(minRooms, 3), maxRooms));
    case "nested":
      return Math.max(2, randomInt(rng, minRooms, Math.min(maxRooms, 3)));
  }
}

function buildTopologyEdges(
  family: TopologyFamily,
  roomCount: number,
  rng: () => number,
): [number, number][] {
  const edges: [number, number][] = [];

  switch (family) {
    case "linear":
      for (let i = 0; i < roomCount - 1; i++) {
        edges.push([i, i + 1]);
      }
      break;

    case "hub": {
      const hub = Math.floor(rng() * roomCount);
      for (let i = 0; i < roomCount; i++) {
        if (i !== hub) edges.push([hub, i]);
      }
      break;
    }

    case "loop":
      for (let i = 0; i < roomCount; i++) {
        edges.push([i, (i + 1) % roomCount]);
      }
      break;

    case "branch": {
      const spine = Math.min(roomCount - 1, Math.max(2, Math.floor(roomCount * 0.6)));
      for (let i = 0; i < spine; i++) {
        edges.push([i, i + 1]);
      }
      const branchPoint = randomInt(rng, 0, spine);
      for (let i = spine + 1; i < roomCount; i++) {
        edges.push([branchPoint, i]);
      }
      break;
    }

    case "nested":
      for (let i = 0; i < roomCount - 1; i++) {
        edges.push([i, i + 1]);
      }
      break;
  }

  return edges;
}

function placeRooms(
  roomCount: number,
  family: TopologyFamily,
  edges: [number, number][],
  params: BlueprintParams,
  rng: () => number,
): PlacedRoom[] | null {
  const margin = 2;
  const innerW = params.boardWidth - 2;
  const innerH = params.boardHeight - 2;

  const adjacency: number[][] = Array.from({ length: roomCount }, () => []);
  for (const [a, b] of edges) {
    adjacency[a].push(b);
    adjacency[b].push(a);
  }

  const rooms: PlacedRoom[] = [];

  for (let attempt = 0; attempt < 50; attempt++) {
    rooms.length = 0;
    let ok = true;

    for (let i = 0; i < roomCount; i++) {
      const w = randomInt(rng, params.minRoomSize, params.maxRoomSize);
      const h = randomInt(rng, params.minRoomSize, params.maxRoomSize);

      let placed = false;
      for (let tries = 0; tries < 80; tries++) {
        const x = randomInt(rng, margin, innerW - w);
        const y = randomInt(rng, margin, innerH - h);

        if (overlapsAny(rooms, x, y, w, h, margin)) continue;

        rooms.push({ id: i, x, y, width: w, height: h });
        placed = true;
        break;
      }

      if (!placed) {
        ok = false;
        break;
      }
    }

    if (ok && rooms.length === roomCount) {
      if (family === "nested") sortRoomsByDepth(rooms);
      return rooms;
    }
  }

  return null;
}

function sortRoomsByDepth(rooms: PlacedRoom[]): void {
  rooms.sort((a, b) => {
    const aCenter = a.x + a.width / 2 + (a.y + a.height / 2);
    const bCenter = b.x + b.width / 2 + (b.y + b.height / 2);
    return aCenter - bCenter;
  });
  for (let i = 0; i < rooms.length; i++) {
    rooms[i] = { ...rooms[i], id: i };
  }
}

function overlapsAny(
  rooms: PlacedRoom[],
  x: number,
  y: number,
  w: number,
  h: number,
  margin: number,
): boolean {
  for (const r of rooms) {
    if (
      x < r.x + r.width + margin &&
      x + w + margin > r.x &&
      y < r.y + r.height + margin &&
      y + h + margin > r.y
    ) {
      return true;
    }
  }
  return false;
}

function routePassage(
  from: PlacedRoom,
  to: PlacedRoom,
  width: 1 | 2,
  grid: string[][],
): PassageCell[] {
  const fromCX = Math.floor(from.x + from.width / 2);
  const fromCY = Math.floor(from.y + from.height / 2);
  const toCX = Math.floor(to.x + to.width / 2);
  const toCY = Math.floor(to.y + to.height / 2);

  const cells: PassageCell[] = [];
  let cx = fromCX;
  let cy = fromCY;

  while (cx !== toCX) {
    cx += cx < toCX ? 1 : -1;
    addPassageCells(cells, cy, cx, width, grid);
  }
  while (cy !== toCY) {
    cy += cy < toCY ? 1 : -1;
    addPassageCells(cells, cy, cx, width, grid);
  }

  return cells;
}

function addPassageCells(
  cells: PassageCell[],
  row: number,
  column: number,
  width: 1 | 2,
  grid: string[][],
): void {
  if (
    row >= 1 &&
    row < grid.length - 1 &&
    column >= 1 &&
    column < grid[0].length - 1
  ) {
    if (grid[row][column] !== " ") {
      cells.push({ row, column });
    }
    if (width === 2 && column + 1 < grid[0].length - 1) {
      if (grid[row][column + 1] !== " ") {
        cells.push({ row, column: column + 1 });
      }
    }
  }
}

function pickPassageWidth(
  passageWidths: readonly (1 | 2)[] | undefined,
  fallback: 1 | 2,
  rng: () => number,
): 1 | 2 {
  if (passageWidths && passageWidths.length > 0) {
    return passageWidths[Math.floor(rng() * passageWidths.length)];
  }
  return fallback;
}

function rasterizeRoomsAndPassages(
  rooms: PlacedRoom[],
  edges: [number, number][],
  passageWidth: 1 | 2,
  boardWidth: number,
  boardHeight: number,
  passageWidths?: readonly (1 | 2)[],
  rng?: () => number,
): { grid: string[][]; passages: PassageEdge[] } {
  const grid: string[][] = [];
  for (let r = 0; r < boardHeight; r++) {
    grid.push(new Array<string>(boardWidth).fill("O"));
  }

  for (const room of rooms) {
    for (let dy = 0; dy < room.height; dy++) {
      for (let dx = 0; dx < room.width; dx++) {
        const gy = room.y + dy;
        const gx = room.x + dx;
        if (gy > 0 && gy < boardHeight - 1 && gx > 0 && gx < boardWidth - 1) {
          grid[gy][gx] = " ";
        }
      }
    }
  }

  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const passages: PassageEdge[] = [];

  for (const [fromId, toId] of edges) {
    const fromRoom = roomById.get(fromId)!;
    const toRoom = roomById.get(toId)!;
    const width = rng
      ? pickPassageWidth(passageWidths, passageWidth, rng)
      : passageWidth;
    const cells = routePassage(fromRoom, toRoom, width, grid);

    for (const cell of cells) {
      grid[cell.row][cell.column] = " ";
    }

    passages.push({
      from: fromId,
      to: toId,
      width,
      cells,
    });
  }

  return { grid, passages };
}

export function generateBlueprint(params: BlueprintParams): StructuralBlueprint | null {
  const rng = createRng(params.seed);
  const family: TopologyFamily =
    params.family === "random" ? pickFamily(rng) : params.family;
  const roomCount = roomCountForFamily(
    family,
    params.minRooms,
    params.maxRooms,
    rng,
  );

  const edges = buildTopologyEdges(family, roomCount, rng);
  const placed = placeRooms(roomCount, family, edges, params, rng);
  if (!placed) return null;

  const { grid, passages } = rasterizeRoomsAndPassages(
    placed,
    edges,
    params.passageWidth,
    params.boardWidth,
    params.boardHeight,
    params.passageWidths,
    rng,
  );

  if (!isConnected(grid)) return null;

  const rooms: RoomNode[] = placed.map((p) => ({
    id: p.id,
    role: "general" as const,
    width: p.width,
    height: p.height,
    x: p.x,
    y: p.y,
  }));

  return {
    seed: params.seed,
    family,
    rooms,
    passages,
    boardWidth: params.boardWidth,
    boardHeight: params.boardHeight,
  };
}

function isConnected(grid: string[][]): boolean {
  const height = grid.length;
  const width = grid[0].length;
  let startR = -1;
  let startC = -1;

  outer: for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (grid[r][c] === " ") {
        startR = r;
        startC = c;
        break outer;
      }
    }
  }

  if (startR < 0) return false;

  const visited = new Set<number>();
  const queue: number[] = [startR * width + startC];
  visited.add(startR * width + startC);
  let totalFloor = 0;

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (grid[r][c] === " ") totalFloor++;
    }
  }

  const deltas = [-width, width, -1, 1];

  while (queue.length > 0) {
    const pos = queue.shift()!;
    const r = Math.floor(pos / width);
    const c = pos % width;

    for (const d of deltas) {
      const nr = Math.floor((pos + d) / width);
      const nc = (pos + d) % width;
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
      if (Math.abs(r - nr) + Math.abs(c - nc) !== 1) continue;
      const next = pos + d;
      if (visited.has(next)) continue;
      if (grid[nr][nc] !== " ") continue;
      visited.add(next);
      queue.push(next);
    }
  }

  return visited.size === totalFloor;
}

export function rasterizeBlueprint(blueprint: StructuralBlueprint): string[][] {
  const grid: string[][] = [];
  for (let r = 0; r < blueprint.boardHeight; r++) {
    grid.push(new Array<string>(blueprint.boardWidth).fill("O"));
  }

  for (const room of blueprint.rooms) {
    for (let dy = 0; dy < room.height; dy++) {
      for (let dx = 0; dx < room.width; dx++) {
        const gy = room.y + dy;
        const gx = room.x + dx;
        if (
          gy > 0 &&
          gy < blueprint.boardHeight - 1 &&
          gx > 0 &&
          gx < blueprint.boardWidth - 1
        ) {
          grid[gy][gx] = " ";
        }
      }
    }
  }

  for (const passage of blueprint.passages) {
    for (const cell of passage.cells) {
      grid[cell.row][cell.column] = " ";
    }
  }

  return grid;
}

export function generateBlueprintWithRetry(
  params: BlueprintParams,
  maxRetries: number = 20,
): StructuralBlueprint | null {
  for (let i = 0; i < maxRetries; i++) {
    const adjustedParams = { ...params, seed: params.seed + i };
    const blueprint = generateBlueprint(adjustedParams);
    if (blueprint) return blueprint;
  }
  return null;
}
