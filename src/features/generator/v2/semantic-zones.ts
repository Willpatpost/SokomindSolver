import { analyzeGrid, type StructuralMetrics } from "./structural-metrics.ts";
import { isWallChar } from "./tile-semantics.ts";

export type SemanticZoneKind = "room" | "corridor" | "doorway";

export interface SemanticZonePosition {
  readonly row: number;
  readonly column: number;
}

export interface SemanticZone {
  readonly id: string;
  readonly kind: SemanticZoneKind;
  readonly cells: readonly SemanticZonePosition[];
}

export interface SemanticZoneMap {
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly zones: readonly SemanticZone[];
}

function cellIndex(row: number, column: number, width: number): number {
  return row * width + column;
}

function position(index: number, width: number): SemanticZonePosition {
  return Object.freeze({
    row: Math.floor(index / width),
    column: index % width,
  });
}

function neighbors(index: number, width: number, height: number): readonly number[] {
  const row = Math.floor(index / width);
  const column = index % width;
  const result: number[] = [];
  if (row > 0) result.push(index - width);
  if (row + 1 < height) result.push(index + width);
  if (column > 0) result.push(index - 1);
  if (column + 1 < width) result.push(index + 1);
  return result;
}

function connectedComponents(
  cells: ReadonlySet<number>,
  width: number,
  height: number,
): readonly (readonly number[])[] {
  const unseen = new Set(cells);
  const components: number[][] = [];

  while (unseen.size > 0) {
    const start = Math.min(...unseen);
    unseen.delete(start);
    const queue = [start];
    const component: number[] = [];

    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor];
      component.push(current);
      for (const next of neighbors(current, width, height)) {
        if (!unseen.delete(next)) continue;
        queue.push(next);
      }
    }

    component.sort((left, right) => left - right);
    components.push(component);
  }

  return components.sort((left, right) => left[0] - right[0]);
}

/**
 * Derive semantic rooms, corridors, and doorway bands from the exact final
 * board geometry. No blueprint data is accepted, so later geometry mutations
 * cannot leave this map stale.
 */
export function deriveSemanticZones(
  grid: readonly (readonly string[])[],
  structuralMetrics: StructuralMetrics = analyzeGrid(grid),
): SemanticZoneMap {
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;
  const floor = new Set<number>();

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      if (!isWallChar(grid[row][column])) {
        floor.add(cellIndex(row, column, width));
      }
    }
  }

  const doorway = new Set<number>();
  for (const index of structuralMetrics.articulationPoints) {
    if (floor.has(index)) doorway.add(index);
  }

  const corridor = new Set<number>();
  for (const index of structuralMetrics.tunnelCells) {
    if (floor.has(index) && !doorway.has(index)) corridor.add(index);
  }

  const room = new Set<number>();
  for (const index of floor) {
    if (!doorway.has(index) && !corridor.has(index)) room.add(index);
  }

  const zones: SemanticZone[] = [];
  const append = (kind: SemanticZoneKind, cells: ReadonlySet<number>) => {
    const components = connectedComponents(cells, width, height);
    for (let index = 0; index < components.length; index++) {
      zones.push(Object.freeze({
        id: `${kind}-${index}`,
        kind,
        cells: Object.freeze(components[index].map((cell) => position(cell, width))),
      }));
    }
  };

  append("room", room);
  append("corridor", corridor);
  append("doorway", doorway);

  return Object.freeze({
    boardWidth: width,
    boardHeight: height,
    zones: Object.freeze(zones),
  });
}

export function buildSemanticZoneIndex(
  zoneMap: SemanticZoneMap,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const zone of zoneMap.zones) {
    for (const cell of zone.cells) {
      index.set(`${cell.row},${cell.column}`, zone.id);
    }
  }
  return index;
}
