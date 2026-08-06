import type { SolutionStep } from "../contracts.ts";
import {
  SEARCH_DIRECTIONS,
  type CompiledSearchBoard,
} from "./compiled-board.ts";
import type { CompactNodeArena } from "./compact-node-arena.ts";
import type { DenseBox } from "./model.ts";
import { KeeperReachability } from "./reachability.ts";

export interface PushRecord {
  readonly boxCell: number;
  readonly directionIndex: number;
}

export type StateKey = string | bigint;

export interface SearchNode {
  readonly robot: number;
  readonly boxes: readonly DenseBox[];
  readonly key: StateKey;
  readonly parentIndex: number;
  readonly push?: PushRecord;
  readonly moves: number;
  readonly pushes: number;
  readonly depth: number;
  readonly p0: number;
  readonly p1: number;
  readonly p2: number;
  readonly estimatedBytes: number;
}

export interface SearchCounters {
  expanded: number;
  generated: number;
  duplicates: number;
  deadlockPrunes: number;
  patternDeadlockPrunes: number;
  corralPrunes: number;
  commitmentSkips: number;
  infeasiblePrunes: number;
  reopens: number;
  reachabilityFloods: number;
  avoidedReachabilityFloods: number;
  retainedBytes: number;
  peakFrontier: number;
  maxDepth: number;
}

export interface Frontier {
  readonly size: number;
  push(nodeIndex: number): void;
  pop(): number | undefined;
}

export function objectiveScore(moves: number): number {
  return moves;
}

export function compareBoxes(a: DenseBox, b: DenseBox): number {
  return (
    a.label.charCodeAt(0) - b.label.charCodeAt(0) ||
    a.cell - b.cell ||
    a.id.charCodeAt(0) - b.id.charCodeAt(0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function comparePriority(left: SearchNode, right: SearchNode): number {
  return (left.p0 - right.p0) || (left.p1 - right.p1) || (left.p2 - right.p2);
}

export function isSolved(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
): boolean {
  return boxes.every(
    (box) => board.goalLabelByCell[box.cell] === box.label,
  );
}

export function estimateNodeBytes(boxCount: number, key: StateKey): number {
  const keyBytes = typeof key === "string" ? key.length * 2 : 64;
  return 448 + boxCount * 80 + keyBytes;
}

export function estimatedMemoryBytes(
  staticBytes: number,
  counters: SearchCounters,
  uniqueStates: number,
  frontierSize: number,
  heuristicCacheEntries: number,
  boxCount: number,
): number {
  return Math.ceil(
    staticBytes +
      counters.retainedBytes +
      uniqueStates * 96 +
      frontierSize * 56 +
      heuristicCacheEntries * (160 + boxCount * 24),
  );
}

export const OPPOSITE_DIRECTION = [1, 0, 3, 2] as const;

export function fillOccupancy(buffer: Uint8Array, boxes: readonly DenseBox[]): void {
  buffer.fill(0);
  for (const box of boxes) buffer[box.cell] = 1;
}

export function fillDeadlockOccupancy(buffer: Int32Array, boxes: readonly DenseBox[]): void {
  buffer.fill(-1);
  for (let i = 0; i < boxes.length; i++) buffer[boxes[i].cell] = i;
}

export function reconstructSolution(
  board: CompiledSearchBoard,
  nodes: readonly SearchNode[],
  goalIndex: number,
  reachability: KeeperReachability,
): readonly SolutionStep[] {
  const chain: number[] = [];
  let cursor = goalIndex;
  while (cursor >= 0) {
    chain.push(cursor);
    const node = nodes[cursor];
    if (!node || node.parentIndex < 0) break;
    cursor = node.parentIndex;
  }
  chain.reverse();

  const occupancyBuffer = new Uint8Array(board.cellCount);
  const steps: SolutionStep[] = [];
  for (let index = 1; index < chain.length; index += 1) {
    const parent = nodes[chain[index - 1] ?? -1];
    const child = nodes[chain[index] ?? -1];
    const push = child?.push;
    if (!parent || !child || !push) {
      throw new Error("Search parent chain is incomplete.");
    }

    const support =
      board.neighbors[push.boxCell]?.[
        OPPOSITE_DIRECTION[push.directionIndex] ?? -1
      ] ?? -1;
    fillOccupancy(occupancyBuffer, parent.boxes);
    const reachable = reachability.flood(parent.robot, occupancyBuffer);
    const walk = reachable.pathTo(support);
    const pushDirection = SEARCH_DIRECTIONS[push.directionIndex]?.direction;
    if (!walk || !pushDirection) {
      throw new Error("Search parent chain contains an unreachable push.");
    }
    for (const direction of walk) {
      steps.push({ direction, kind: "walk" });
    }
    steps.push({ direction: pushDirection, kind: "push" });
  }
  return steps;
}

export function reconstructFromArena(
  board: CompiledSearchBoard,
  arena: CompactNodeArena,
  goalIndex: number,
  reachability: KeeperReachability,
): readonly SolutionStep[] {
  const { cellCount } = board;
  const { boxCount } = arena;
  const chain: number[] = [];
  let cursor = goalIndex;
  while (cursor >= 0) {
    chain.push(cursor);
    const parent = arena.parentNode(cursor);
    if (parent < 0) break;
    cursor = parent;
  }
  chain.reverse();

  const occupancyBuffer = new Uint8Array(cellCount);
  const tokenBuf = new Uint32Array(boxCount);
  const steps: SolutionStep[] = [];
  for (let i = 1; i < chain.length; i++) {
    const parentIdx = chain[i - 1]!;
    const childIdx = chain[i]!;

    occupancyBuffer.fill(0);
    arena.readBoxTokens(parentIdx, tokenBuf);
    for (let b = 0; b < boxCount; b++) {
      occupancyBuffer[tokenBuf[b]! % cellCount] = 1;
    }

    const reachable = reachability.flood(arena.robotCell(parentIdx), occupancyBuffer);
    const pushCell = arena.pushedFromCell(childIdx);
    const dirIdx = arena.pushDirection(childIdx);
    const support =
      board.neighbors[pushCell]?.[OPPOSITE_DIRECTION[dirIdx]! ?? -1] ?? -1;
    const walk = reachable.pathTo(support);
    const pushDirection = SEARCH_DIRECTIONS[dirIdx]?.direction;
    if (!walk || !pushDirection) {
      throw new Error("Arena parent chain contains an unreachable push.");
    }
    for (const direction of walk) {
      steps.push({ direction, kind: "walk" });
    }
    steps.push({ direction: pushDirection, kind: "push" });
  }
  return steps;
}

export function estimateArenaNodeBytes(boxCount: number, bytesPerToken = 2): number {
  return 17 + boxCount * bytesPerToken;
}

export function estimatedArenaMemoryBytes(
  staticBytes: number,
  arenaRetainedBytes: number,
  uniqueStates: number,
  frontierSize: number,
  heuristicCacheEntries: number,
  boxCount: number,
): number {
  return Math.ceil(
    staticBytes +
      arenaRetainedBytes +
      uniqueStates * 96 +
      frontierSize * 8 +
      heuristicCacheEntries * (160 + boxCount * 24),
  );
}
