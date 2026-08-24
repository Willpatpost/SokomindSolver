import { createRng } from "../board-template.ts";
import type {
  FunctionalBlueprint,
  FunctionalRoom,
  RoomRole,
  StructuralBlueprint,
  TopologyFamily,
} from "./blueprint-types.ts";

// ---------------------------------------------------------------------------
// Graph analysis helpers
// ---------------------------------------------------------------------------

interface RoomGraphInfo {
  readonly degree: number;
  readonly isTerminal: boolean;
  readonly distanceFromCenter: number;
}

function analyzeRoomGraph(blueprint: StructuralBlueprint): Map<number, RoomGraphInfo> {
  const degrees = new Map<number, number>();
  const adjacency = new Map<number, number[]>();
  for (const room of blueprint.rooms) {
    degrees.set(room.id, 0);
    adjacency.set(room.id, []);
  }
  for (const passage of blueprint.passages) {
    degrees.set(passage.from, (degrees.get(passage.from) ?? 0) + 1);
    degrees.set(passage.to, (degrees.get(passage.to) ?? 0) + 1);
    adjacency.get(passage.from)!.push(passage.to);
    adjacency.get(passage.to)!.push(passage.from);
  }

  const centerRoom = findCenterRoom(blueprint, degrees);

  const distances = bfsDistances(adjacency, centerRoom, blueprint.rooms.map((r) => r.id));

  const result = new Map<number, RoomGraphInfo>();
  for (const room of blueprint.rooms) {
    const degree = degrees.get(room.id) ?? 0;
    result.set(room.id, {
      degree,
      isTerminal: degree <= 1,
      distanceFromCenter: distances.get(room.id) ?? 0,
    });
  }
  return result;
}

function findCenterRoom(
  blueprint: StructuralBlueprint,
  degrees: Map<number, number>,
): number {
  let bestId = blueprint.rooms[0]?.id ?? 0;
  let bestDegree = 0;
  for (const room of blueprint.rooms) {
    const deg = degrees.get(room.id) ?? 0;
    if (deg > bestDegree) {
      bestDegree = deg;
      bestId = room.id;
    }
  }
  return bestId;
}

function bfsDistances(
  adjacency: Map<number, number[]>,
  start: number,
  allIds: number[],
): Map<number, number> {
  const dist = new Map<number, number>();
  dist.set(start, 0);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    const d = dist.get(current)!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!dist.has(neighbor)) {
        dist.set(neighbor, d + 1);
        queue.push(neighbor);
      }
    }
  }
  for (const id of allIds) {
    if (!dist.has(id)) dist.set(id, 0);
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

export function assignRoomRoles(
  blueprint: StructuralBlueprint,
  seed: number,
  boxCount: number = 3,
): FunctionalBlueprint {
  const rng = createRng(seed);
  const graphInfo = analyzeRoomGraph(blueprint);

  const rooms = blueprint.rooms.map((room): FunctionalRoom => {
    const info = graphInfo.get(room.id)!;
    return {
      ...room,
      role: "general",
      isTerminal: info.isTerminal,
      graphDegree: info.degree,
      distanceFromCenter: info.distanceFromCenter,
    };
  });

  const assigned = assignRolesForFamily(
    rooms,
    blueprint.family,
    blueprint.passages.length,
    boxCount,
    rng,
  );

  return {
    ...blueprint,
    rooms: assigned,
  };
}

function assignRolesForFamily(
  rooms: FunctionalRoom[],
  family: TopologyFamily,
  passageCount: number,
  boxCount: number,
  rng: () => number,
): FunctionalRoom[] {
  if (rooms.length <= 1) return rooms;

  const result = [...rooms];

  switch (family) {
    case "linear":
    case "nested":
      return assignLinearRoles(result, boxCount, rng);
    case "hub":
      return assignHubRoles(result, boxCount, rng);
    case "loop":
      return assignLoopRoles(result, boxCount, rng);
    case "branch":
      return assignBranchRoles(result, boxCount, rng);
  }
}

function setRole(rooms: FunctionalRoom[], index: number, role: RoomRole): void {
  rooms[index] = { ...rooms[index], role };
}

function roomArea(room: FunctionalRoom): number {
  return room.width * room.height;
}

// ---------------------------------------------------------------------------
// Linear / Nested
// ---------------------------------------------------------------------------

function assignLinearRoles(
  rooms: FunctionalRoom[],
  boxCount: number,
  rng: () => number,
): FunctionalRoom[] {
  const sorted = rooms
    .map((r, i) => ({ room: r, idx: i }))
    .sort((a, b) => b.room.distanceFromCenter - a.room.distanceFromCenter);

  const deepest = sorted[0];
  if (deepest && roomArea(deepest.room) >= boxCount) {
    setRole(rooms, deepest.idx, "goal-room");
  }

  const needsSecondGoalRoom =
    boxCount > roomArea(deepest?.room ?? rooms[0]) ||
    (sorted.length > 2 && boxCount >= 2 && rng() < 0.4);
  if (needsSecondGoalRoom && sorted.length > 1) {
    const second = sorted[1];
    if (roomArea(second.room) >= 2) {
      setRole(rooms, second.idx, "goal-room");
    }
  }

  const centerIdx = rooms.findIndex(
    (r) => r.distanceFromCenter === 0 && r.role === "general",
  );
  if (centerIdx >= 0) {
    setRole(rooms, centerIdx, rooms.length > 3 ? "transit" : "staging");
  }

  for (let i = 0; i < rooms.length; i++) {
    if (rooms[i].role !== "general") continue;
    if (rooms[i].isTerminal && roomArea(rooms[i]) >= 2) {
      setRole(rooms, i, rng() < 0.5 ? "staging" : "general");
    }
  }

  return rooms;
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

function assignHubRoles(
  rooms: FunctionalRoom[],
  boxCount: number,
  rng: () => number,
): FunctionalRoom[] {
  const hubIdx = rooms.findIndex((r) => r.graphDegree === Math.max(...rooms.map((x) => x.graphDegree)));
  if (hubIdx >= 0) {
    setRole(rooms, hubIdx, "transit");
  }

  const peripherals = rooms
    .map((r, i) => ({ room: r, idx: i }))
    .filter((x) => x.room.role === "general" && x.room.isTerminal);

  peripherals.sort((a, b) => roomArea(b.room) - roomArea(a.room));

  const maxGoalsPerRoom = Math.max(1, Math.ceil(boxCount / Math.max(1, peripherals.length)));
  let goalsAssigned = 0;
  for (const p of peripherals) {
    if (goalsAssigned >= boxCount) break;
    if (roomArea(p.room) >= 2) {
      setRole(rooms, p.idx, "goal-room");
      goalsAssigned += Math.min(maxGoalsPerRoom, roomArea(p.room));
    }
  }

  if (goalsAssigned < boxCount) {
    for (let i = 0; i < rooms.length; i++) {
      if (rooms[i].role === "general" && roomArea(rooms[i]) >= 2) {
        setRole(rooms, i, "goal-room");
        goalsAssigned += roomArea(rooms[i]);
        if (goalsAssigned >= boxCount) break;
      }
    }
  }

  for (let i = 0; i < rooms.length; i++) {
    if (rooms[i].role !== "general") continue;
    if (roomArea(rooms[i]) >= 4) {
      setRole(rooms, i, rng() < 0.6 ? "staging" : "exchange");
    }
  }

  return rooms;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

function assignLoopRoles(
  rooms: FunctionalRoom[],
  boxCount: number,
  rng: () => number,
): FunctionalRoom[] {
  const sorted = [...rooms]
    .map((r, i) => ({ room: r, idx: i }))
    .sort((a, b) => roomArea(b.room) - roomArea(a.room));

  if (sorted.length >= 2) {
    const first = sorted[0];
    const half = Math.floor(rooms.length / 2);
    const opposite = sorted.find(
      (x) => Math.abs(x.idx - first.idx) >= half && x.idx !== first.idx,
    ) ?? sorted[1];

    setRole(rooms, first.idx, "goal-room");
    setRole(rooms, opposite.idx, boxCount > roomArea(first.room) ? "goal-room" : "staging");
  }

  for (let i = 0; i < rooms.length; i++) {
    if (rooms[i].role !== "general") continue;
    const roll = rng();
    if (roll < 0.3) setRole(rooms, i, "transit");
    else if (roll < 0.5) setRole(rooms, i, "exchange");
  }

  return rooms;
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

function assignBranchRoles(
  rooms: FunctionalRoom[],
  boxCount: number,
  rng: () => number,
): FunctionalRoom[] {
  const terminals = rooms
    .map((r, i) => ({ room: r, idx: i }))
    .filter((x) => x.room.isTerminal);

  terminals.sort((a, b) => roomArea(b.room) - roomArea(a.room));

  let goalsAssigned = 0;
  for (const t of terminals) {
    if (goalsAssigned >= boxCount) break;
    if (roomArea(t.room) >= 2) {
      setRole(rooms, t.idx, "goal-room");
      goalsAssigned += Math.min(boxCount - goalsAssigned, roomArea(t.room));
    }
  }

  if (goalsAssigned < boxCount) {
    for (let i = 0; i < rooms.length; i++) {
      if (rooms[i].role === "general" && roomArea(rooms[i]) >= 2) {
        setRole(rooms, i, "goal-room");
        goalsAssigned += roomArea(rooms[i]);
        if (goalsAssigned >= boxCount) break;
      }
    }
  }

  const spineCenter = rooms.findIndex(
    (r) => r.graphDegree >= 3 && r.role === "general",
  );
  if (spineCenter >= 0) {
    setRole(rooms, spineCenter, "transit");
  }

  for (let i = 0; i < rooms.length; i++) {
    if (rooms[i].role !== "general") continue;
    if (rooms[i].graphDegree >= 2) {
      setRole(rooms, i, rng() < 0.5 ? "staging" : "general");
    }
  }

  return rooms;
}
