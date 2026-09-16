import type { CompiledSearchBoard } from "./compiled-board.ts";
import { SEARCH_DIRECTION_COUNT } from "./compiled-board.ts";
import {
  checkExactPreprocessingBudget,
  type ExactPreprocessingBudget,
} from "./preprocessing-budget.ts";

/**
 * Single-box push graph with keeper-region awareness.
 *
 * A node is (boxCell, keeperRegionRepresentative). The keeper region is
 * the connected component of floor cells reachable by the keeper when
 * only the single box blocks at boxCell. Transitions: if the keeper is
 * in a region that contains the support cell for a push of the box from
 * boxCell in direction D, the box moves to destinationCell and the keeper
 * ends up in the region of boxCell (the cell the box just vacated) at
 * destinationCell.
 *
 * This is a relaxation of the real puzzle (other boxes removed), so all
 * distances are admissible lower bounds on real push distances.
 */

export interface SingleBoxPushNode {
  readonly boxCell: number;
  readonly regionRep: number;
  readonly transitions: readonly SingleBoxPushTransition[];
}

export interface SingleBoxPushTransition {
  readonly destinationBoxCell: number;
  readonly destinationNodeIndex: number;
  readonly direction: number;
}

export interface SingleBoxPushGraph {
  readonly nodes: readonly SingleBoxPushNode[];
  readonly nodeIndex: ReadonlyMap<number, number>;
  readonly startIndicesByBoxCell: ReadonlyMap<number, readonly number[]>;
  readonly cellCount: number;
}

function nodeKey(boxCell: number, regionRep: number, cellCount: number): number {
  return boxCell * cellCount + regionRep;
}

function floodFillRegions(
  board: CompiledSearchBoard,
  blockedCell: number,
): { regionRep: Map<number, number>; regions: number[][] } {
  const { cellCount, neighbors } = board;
  const visited = new Uint8Array(cellCount);
  visited[blockedCell] = 1;
  const regionRep = new Map<number, number>();
  const regions: number[][] = [];

  for (let seed = 0; seed < cellCount; seed++) {
    if (visited[seed]) continue;
    const component: number[] = [];
    const queue = [seed];
    visited[seed] = 1;
    let rep = seed;

    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head];
      component.push(cell);
      if (cell < rep) rep = cell;
      const nbrs = neighbors[cell];
      for (let d = 0; d < SEARCH_DIRECTION_COUNT; d++) {
        const next = nbrs[d];
        if (next >= 0 && !visited[next]) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    for (const cell of component) {
      regionRep.set(cell, rep);
    }
    regions.push(component);
  }
  return { regionRep, regions };
}

export function compileSingleBoxPushGraph(
  board: CompiledSearchBoard,
  budget?: ExactPreprocessingBudget,
): SingleBoxPushGraph {
  const { cellCount, neighbors } = board;
  const OPPOSITE = [1, 0, 3, 2] as const;

  const regionsByBoxCell = new Map<number, Map<number, number>>();
  for (let boxCell = 0; boxCell < cellCount; boxCell++) {
    if ((boxCell & 15) === 0) {
      checkExactPreprocessingBudget(budget, cellCount * 200);
    }
    const { regionRep } = floodFillRegions(board, boxCell);
    regionsByBoxCell.set(boxCell, regionRep);
  }

  const nodesByKey = new Map<number, number>();
  const startIndicesByBoxCell = new Map<number, number[]>();
  const transitionsPerNode: SingleBoxPushTransition[][] = [];
  const boxCells: number[] = [];
  const regionReps: number[] = [];

  function getOrCreateNode(bCell: number, rRep: number): number {
    const key = nodeKey(bCell, rRep, cellCount);
    let idx = nodesByKey.get(key);
    if (idx === undefined) {
      idx = boxCells.length;
      nodesByKey.set(key, idx);
      boxCells.push(bCell);
      regionReps.push(rRep);
      transitionsPerNode.push([]);
    }
    return idx;
  }

  for (let boxCell = 0; boxCell < cellCount; boxCell++) {
    if ((boxCell & 15) === 0) {
      checkExactPreprocessingBudget(
        budget,
        cellCount * 200 + boxCells.length * 64,
      );
    }
    const regionRep = regionsByBoxCell.get(boxCell)!;
    const seenReps = new Set<number>();
    const starts: number[] = [];

    for (const rep of regionRep.values()) {
      if (seenReps.has(rep)) continue;
      seenReps.add(rep);

      const srcIdx = getOrCreateNode(boxCell, rep);
      starts.push(srcIdx);

      const boxNbrs = neighbors[boxCell];
      for (let d = 0; d < SEARCH_DIRECTION_COUNT; d++) {
        const supportCell = boxNbrs[OPPOSITE[d]];
        if (supportCell < 0) continue;
        const destCell = boxNbrs[d];
        if (destCell < 0) continue;

        const supportRep = regionRep.get(supportCell);
        if (supportRep !== rep) continue;

        const destRegionRep = regionsByBoxCell.get(destCell);
        if (!destRegionRep) continue;
        const destRep = destRegionRep.get(boxCell);
        if (destRep === undefined) continue;

        const destIdx = getOrCreateNode(destCell, destRep);
        transitionsPerNode[srcIdx].push({
          destinationBoxCell: destCell,
          destinationNodeIndex: destIdx,
          direction: d,
        });
      }
    }

    if (starts.length > 0) {
      startIndicesByBoxCell.set(boxCell, starts);
    }
  }

  const nodes: SingleBoxPushNode[] = boxCells.map((bCell, i) => ({
    boxCell: bCell,
    regionRep: regionReps[i],
    transitions: transitionsPerNode[i],
  }));

  return {
    nodes,
    nodeIndex: nodesByKey,
    startIndicesByBoxCell,
    cellCount,
  };
}

/**
 * BFS backward from all nodes whose boxCell is `goalCell`, returning
 * minimum push distance from each boxCell to goalCell.
 *
 * Uses the reverse of the single-box push graph: traverse predecessor edges.
 */
export function singleBoxGoalDistances(
  graph: SingleBoxPushGraph,
  goalCell: number,
): Int32Array {
  const distances = new Int32Array(graph.cellCount).fill(-1);

  const predecessors = new Map<number, number[]>();
  for (let i = 0; i < graph.nodes.length; i++) {
    for (const t of graph.nodes[i].transitions) {
      let preds = predecessors.get(t.destinationNodeIndex);
      if (!preds) {
        preds = [];
        predecessors.set(t.destinationNodeIndex, preds);
      }
      preds.push(i);
    }
  }

  const queue: number[] = [];
  const nodeDistances = new Int32Array(graph.nodes.length).fill(-1);

  const goalStarts = graph.startIndicesByBoxCell.get(goalCell);
  if (!goalStarts) return distances;

  for (const startIdx of goalStarts) {
    nodeDistances[startIdx] = 0;
    queue.push(startIdx);
  }

  for (let head = 0; head < queue.length; head++) {
    const nodeIdx = queue[head];
    const dist = nodeDistances[nodeIdx];
    const preds = predecessors.get(nodeIdx);
    if (!preds) continue;
    for (const predIdx of preds) {
      if (nodeDistances[predIdx] >= 0) continue;
      nodeDistances[predIdx] = dist + 1;
      queue.push(predIdx);
    }
  }

  for (let i = 0; i < graph.nodes.length; i++) {
    if (nodeDistances[i] < 0) continue;
    const bCell = graph.nodes[i].boxCell;
    const d = nodeDistances[i];
    if (distances[bCell] < 0 || d < distances[bCell]) {
      distances[bCell] = d;
    }
  }

  return distances;
}

/**
 * Check whether a box at `boxCell` can reach `goalCell` via some sequence
 * of pushes in the single-box relaxation (keeper-region-aware).
 */
export function singleBoxCanReach(
  graph: SingleBoxPushGraph,
  boxCell: number,
  goalCell: number,
): boolean {
  const starts = graph.startIndicesByBoxCell.get(boxCell);
  if (!starts) return false;

  const visited = new Uint8Array(graph.nodes.length);
  const queue: number[] = [];

  for (const s of starts) {
    visited[s] = 1;
    queue.push(s);
  }

  for (let head = 0; head < queue.length; head++) {
    const nodeIdx = queue[head];
    const node = graph.nodes[nodeIdx];
    if (node.boxCell === goalCell) return true;
    for (const t of node.transitions) {
      if (!visited[t.destinationNodeIndex]) {
        visited[t.destinationNodeIndex] = 1;
        queue.push(t.destinationNodeIndex);
      }
    }
  }
  return false;
}

/**
 * Compute the set of cells reachable by a box starting from `startCell`
 * (forward BFS on the single-box push graph).
 */
export function singleBoxForwardReachableCells(
  graph: SingleBoxPushGraph,
  startCell: number,
): ReadonlySet<number> {
  const cells = new Set<number>();
  const starts = graph.startIndicesByBoxCell.get(startCell);
  if (!starts) return cells;

  const visited = new Uint8Array(graph.nodes.length);
  const queue: number[] = [];

  for (const s of starts) {
    visited[s] = 1;
    queue.push(s);
  }

  for (let head = 0; head < queue.length; head++) {
    const nodeIdx = queue[head];
    cells.add(graph.nodes[nodeIdx].boxCell);
    for (const t of graph.nodes[nodeIdx].transitions) {
      if (!visited[t.destinationNodeIndex]) {
        visited[t.destinationNodeIndex] = 1;
        queue.push(t.destinationNodeIndex);
      }
    }
  }
  return cells;
}

/**
 * Compute the set of cells from which a box can reach `goalCell`
 * (backward BFS on the single-box push graph).
 */
export function singleBoxBackwardReachableCells(
  graph: SingleBoxPushGraph,
  goalCell: number,
): ReadonlySet<number> {
  const cells = new Set<number>();

  const predecessors = new Map<number, number[]>();
  for (let i = 0; i < graph.nodes.length; i++) {
    for (const t of graph.nodes[i].transitions) {
      let preds = predecessors.get(t.destinationNodeIndex);
      if (!preds) {
        preds = [];
        predecessors.set(t.destinationNodeIndex, preds);
      }
      preds.push(i);
    }
  }

  const goalStarts = graph.startIndicesByBoxCell.get(goalCell);
  if (!goalStarts) return cells;

  const visited = new Uint8Array(graph.nodes.length);
  const queue: number[] = [];
  for (const s of goalStarts) {
    visited[s] = 1;
    queue.push(s);
  }

  for (let head = 0; head < queue.length; head++) {
    const nodeIdx = queue[head];
    cells.add(graph.nodes[nodeIdx].boxCell);
    const preds = predecessors.get(nodeIdx);
    if (!preds) continue;
    for (const predIdx of preds) {
      if (!visited[predIdx]) {
        visited[predIdx] = 1;
        queue.push(predIdx);
      }
    }
  }
  return cells;
}

export interface ComponentViableCorridor {
  readonly viableCells: ReadonlySet<number>;
  readonly viableDirectedEdges: ReadonlySet<number>;
  readonly cellCount: number;
}

function directedEdgeKey(
  fromCell: number,
  toCell: number,
  cellCount: number,
): number {
  return fromCell * cellCount + toCell;
}

/**
 * Compute the viable corridor for a matching component.
 *
 * The corridor is a superset of all cells and directed push edges that
 * can appear in any real trajectory of a component-C box from its
 * initial position to any of C's goals:
 *
 * viableCells: intersection of (forward-reachable from ANY initial box
 * in C) and (backward-reachable to ANY goal in C), both computed on the
 * full single-box push graph (all keeper regions, not just shortest
 * paths). This is a superset because every real trajectory cell is
 * forward-reachable from the box's start and backward-reachable to
 * its goal.
 *
 * viableDirectedEdges: for each single-box graph node whose boxCell is
 * viable, for each transition to another viable boxCell, record the
 * directed edge (fromCell, toCell). This is a cell-level over-
 * approximation collapsed from (boxCell, keeperRegion) nodes — it
 * includes an edge if it exists under ANY keeper region, never
 * restricting to a single region or path.
 *
 * The superset property is what makes the backward perimeter admissible:
 * see the proof in backward-perimeter.ts.
 */
export function computeComponentCorridor(
  graph: SingleBoxPushGraph,
  boxCells: readonly number[],
  goalCells: readonly number[],
): ComponentViableCorridor {
  const { cellCount } = graph;

  const forwardReachable = new Set<number>();
  for (const boxCell of boxCells) {
    for (const cell of singleBoxForwardReachableCells(graph, boxCell)) {
      forwardReachable.add(cell);
    }
  }

  const backwardReachable = new Set<number>();
  for (const goalCell of goalCells) {
    for (const cell of singleBoxBackwardReachableCells(graph, goalCell)) {
      backwardReachable.add(cell);
    }
  }

  const viableCells = new Set<number>();
  for (const cell of forwardReachable) {
    if (backwardReachable.has(cell)) viableCells.add(cell);
  }

  const viableDirectedEdges = new Set<number>();
  for (const node of graph.nodes) {
    if (!viableCells.has(node.boxCell)) continue;
    for (const t of node.transitions) {
      if (!viableCells.has(t.destinationBoxCell)) continue;
      viableDirectedEdges.add(
        directedEdgeKey(node.boxCell, t.destinationBoxCell, cellCount),
      );
    }
  }

  return { viableCells, viableDirectedEdges, cellCount };
}

export function isViableEdge(
  corridor: ComponentViableCorridor,
  fromCell: number,
  toCell: number,
): boolean {
  return corridor.viableDirectedEdges.has(
    directedEdgeKey(fromCell, toCell, corridor.cellCount),
  );
}
