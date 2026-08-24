import type {
  BlueprintDiagnostics,
  StructuralBlueprint,
} from "./blueprint-types.ts";
import { rasterizeBlueprint } from "./blueprint-graph.ts";

export function computeDiagnostics(
  blueprint: StructuralBlueprint,
): BlueprintDiagnostics {
  const grid = rasterizeBlueprint(blueprint);

  let totalFloor = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (cell === " ") totalFloor++;
    }
  }

  const roomAreas = blueprint.rooms.map((r) => {
    let area = 0;
    for (let dy = 0; dy < r.height; dy++) {
      for (let dx = 0; dx < r.width; dx++) {
        const gy = r.y + dy;
        const gx = r.x + dx;
        if (
          gy > 0 &&
          gy < blueprint.boardHeight - 1 &&
          gx > 0 &&
          gx < blueprint.boardWidth - 1
        ) {
          area++;
        }
      }
    }
    return area;
  });

  const maxArea = Math.max(...roomAreas, 0);
  const largestRoomRatio = totalFloor > 0 ? maxArea / totalFloor : 0;

  const degrees = new Map<number, number>();
  for (const room of blueprint.rooms) {
    degrees.set(room.id, 0);
  }
  for (const passage of blueprint.passages) {
    degrees.set(passage.from, (degrees.get(passage.from) ?? 0) + 1);
    degrees.set(passage.to, (degrees.get(passage.to) ?? 0) + 1);
  }
  const connectivityDegrees = blueprint.rooms.map(
    (r) => degrees.get(r.id) ?? 0,
  );

  let doorwayCount = 0;
  for (const passage of blueprint.passages) {
    if (passage.cells.length > 0) doorwayCount++;
  }

  return {
    seed: blueprint.seed,
    family: blueprint.family,
    roomCount: blueprint.rooms.length,
    passageCount: blueprint.passages.length,
    doorwayCount,
    totalFloor,
    roomAreas,
    largestRoomRatio,
    boardWidth: blueprint.boardWidth,
    boardHeight: blueprint.boardHeight,
    connectivityDegrees,
  };
}

export function blueprintToAscii(blueprint: StructuralBlueprint): string {
  const grid = rasterizeBlueprint(blueprint);
  return grid.map((row) => row.join("")).join("\n");
}
