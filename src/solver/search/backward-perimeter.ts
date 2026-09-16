import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { ExactStateCodec } from "./exact-state.ts";
import type { ZobristTable } from "./zobrist-state.ts";
import type { ExactPreprocessingBudget } from "./preprocessing-budget.ts";
import { checkExactPreprocessingBudget } from "./preprocessing-budget.ts";
import { SEARCH_DIRECTION_COUNT } from "./compiled-board.ts";
import {
  analyzeMatchingComponents,
  type MatchingComponentResult,
} from "./matching-components.ts";
import {
  compileSingleBoxPushGraph,
  type ComponentViableCorridor,
  isViableEdge,
} from "./single-box-push-graph.ts";
import { createExactStateCodec } from "./exact-state.ts";
import { createZobristTable } from "./zobrist-state.ts";

export interface BackwardPerimeterStats {
  seeds: number;
  coloredStatesExplored: number;
  projectedStates: number;
  duplicateProjections: number;
  constrainedTransitionsSkipped: number;
  buildTimeMs: number;
  retainedBytes: number;
  peakWorkingBytes: number;
  lookups: number;
  hits: number;
  improvements: number;
  totalImprovement: number;
  maxImprovement: number;
  maxDepth: number;
  matchingComponents: number;
  matchingEliminatedEdges: number;
  corridorViableCells: number;
  corridorViableEdges: number;
}

interface PerimeterEntry {
  bigintKey: bigint;
  distance: number;
}

interface DedupEntry {
  bigintKey: bigint;
}

export interface BackwardPerimeterTable {
  readonly stats: BackwardPerimeterStats;
  lookup(boxZobristKey: number, boxExactKey: bigint): number | undefined;
}

export interface BackwardPerimeterBudget {
  readonly maxStates: number;
  readonly maxDepth?: number;
  /** Disable corridor constraints for testing uncolored baseline. */
  readonly disableCorridors?: boolean;
}

const OPPOSITE_DIRECTION = [1, 0, 3, 2] as const;

const ESTIMATED_MAP_ENTRY_BYTES = 80;
const ESTIMATED_CHAIN_ELEMENT_BYTES = 48;
const ESTIMATED_BIGINT_BYTES = 24;
export function buildBackwardPerimeter(
  board: CompiledSearchBoard,
  forwardCodec: ExactStateCodec,
  forwardZobrist: ZobristTable,
  budget: BackwardPerimeterBudget,
  preprocessingBudget: ExactPreprocessingBudget,
  now: () => number,
): BackwardPerimeterTable | null {
  const buildStart = now();
  const { cellCount } = board;
  const boxCount = board.source.initialBoxes.length;

  if (boxCount === 0) return null;

  checkExactPreprocessingBudget(preprocessingBudget);

  const singleBoxGraph = compileSingleBoxPushGraph(board, preprocessingBudget);
  const matchingResult = analyzeMatchingComponents(board, singleBoxGraph);

  const stats: BackwardPerimeterStats = {
    seeds: 0,
    coloredStatesExplored: 0,
    projectedStates: 0,
    duplicateProjections: 0,
    constrainedTransitionsSkipped: 0,
    buildTimeMs: 0,
    retainedBytes: 0,
    peakWorkingBytes: 0,
    lookups: 0,
    hits: 0,
    improvements: 0,
    totalImprovement: 0,
    maxImprovement: 0,
    maxDepth: 0,
    matchingComponents: matchingResult.totalComponents,
    matchingEliminatedEdges: matchingResult.eliminatedEdges,
    corridorViableCells: 0,
    corridorViableEdges: 0,
  };

  for (const corridors of matchingResult.corridorsByLabel.values()) {
    for (const corridor of corridors) {
      stats.corridorViableCells += corridor.viableCells.size;
      stats.corridorViableEdges += corridor.viableDirectedEdges.size;
    }
  }

  const coloredLabels = buildColoredLabels(board, matchingResult);
  if (!coloredLabels) {
    stats.buildTimeMs = Math.max(0, now() - buildStart);
    return makeEmptyTable(stats);
  }

  const {
    coloredLabelNames,
    coloredLabelToOriginalId,
    goalColoredLabelId,
    coloredLabelToCorridor,
  } = coloredLabels;

  const coloredCodec = createExactStateCodec(cellCount, coloredLabelNames);
  const coloredZobrist = createZobristTable(
    cellCount,
    coloredLabelNames.length,
    0x52455653,
  );

  const seedTokens = buildSeedTokens(
    board, goalColoredLabelId, cellCount,
  );
  if (!seedTokens) {
    stats.buildTimeMs = Math.max(0, now() - buildStart);
    return makeEmptyTable(stats);
  }

  const projectedTable = new Map<number, PerimeterEntry[]>();

  const { maxStates, maxDepth, disableCorridors } = budget;

  const arenaBytes =
    maxStates * boxCount * Uint32Array.BYTES_PER_ELEMENT +
    maxStates * Uint32Array.BYTES_PER_ELEMENT;
  let currentWorkingBytes = arenaBytes;

  checkExactPreprocessingBudget(preprocessingBudget, currentWorkingBytes);

  const arenaTokens = new Uint32Array(maxStates * boxCount);
  const arenaDistances = new Uint32Array(maxStates);
  let queueHead = 0;
  let queueTail = 0;

  const coloredDedup = new Map<number, DedupEntry[]>();
  let coloredDedupEntries = 0;

  const normalTokenBuf = new Uint32Array(boxCount);

  function updateWorkingBytes(): void {
    currentWorkingBytes = arenaBytes +
      coloredDedupEntries * (ESTIMATED_CHAIN_ELEMENT_BYTES + ESTIMATED_BIGINT_BYTES) +
      coloredDedup.size * ESTIMATED_MAP_ENTRY_BYTES +
      stats.projectedStates * (ESTIMATED_CHAIN_ELEMENT_BYTES + ESTIMATED_BIGINT_BYTES) +
      projectedTable.size * ESTIMATED_MAP_ENTRY_BYTES;
    if (currentWorkingBytes > stats.peakWorkingBytes) {
      stats.peakWorkingBytes = currentWorkingBytes;
    }
  }

  function coloredDedupHas(zobKey: number, bigKey: bigint): boolean {
    const chain = coloredDedup.get(zobKey);
    if (!chain) return false;
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].bigintKey === bigKey) return true;
    }
    return false;
  }

  function coloredDedupStore(zobKey: number, bigKey: bigint): void {
    const chain = coloredDedup.get(zobKey);
    if (!chain) {
      coloredDedup.set(zobKey, [{ bigintKey: bigKey }]);
    } else {
      chain.push({ bigintKey: bigKey });
    }
    coloredDedupEntries++;
  }

  function projectedStore(zobKey: number, bigKey: bigint, dist: number): void {
    const chain = projectedTable.get(zobKey);
    if (!chain) {
      projectedTable.set(zobKey, [{ bigintKey: bigKey, distance: dist }]);
      stats.projectedStates++;
      return;
    }
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].bigintKey === bigKey) {
        stats.duplicateProjections++;
        if (dist < chain[i].distance) chain[i].distance = dist;
        return;
      }
    }
    chain.push({ bigintKey: bigKey, distance: dist });
    stats.projectedStates++;
  }

  function projectAndStore(
    coloredTokens: ArrayLike<number>,
    dist: number,
  ): void {
    for (let i = 0; i < boxCount; i++) {
      const ct = coloredTokens[i];
      const cell = ct % cellCount;
      const cLabelId = (ct / cellCount) | 0;
      const origLabelId = coloredLabelToOriginalId[cLabelId];
      normalTokenBuf[i] = origLabelId * cellCount + cell;
    }
    normalTokenBuf.sort();

    const normalZob = forwardZobrist.hashFromTokensNoRobot(normalTokenBuf);
    const normalKey = forwardCodec.packBoxTokens(normalTokenBuf);
    projectedStore(normalZob, normalKey, dist);
  }

  function enqueueState(tokens: Uint32Array, distance: number): boolean {
    if (queueTail >= maxStates) return false;
    if (maxDepth !== undefined && distance > maxDepth) return false;

    const zobKey = coloredZobrist.hashFromTokensNoRobot(tokens);
    const bigKey = coloredCodec.packBoxTokens(tokens);

    if (coloredDedupHas(zobKey, bigKey)) return true;
    coloredDedupStore(zobKey, bigKey);

    const offset = queueTail * boxCount;
    arenaTokens.set(tokens, offset);
    arenaDistances[queueTail] = distance;
    queueTail++;

    projectAndStore(tokens, distance);
    return true;
  }

  if (!enqueueState(seedTokens, 0)) {
    stats.buildTimeMs = Math.max(0, now() - buildStart);
    return makeEmptyTable(stats);
  }
  stats.seeds = 1;

  const childTokenBuf = new Uint32Array(boxCount);
  const occupancy = new Uint8Array(cellCount);

  while (queueHead < queueTail) {
    if ((queueHead & 63) === 0) {
      updateWorkingBytes();
      checkExactPreprocessingBudget(preprocessingBudget, currentWorkingBytes);
    }

    const stateOffset = queueHead * boxCount;
    const distance = arenaDistances[queueHead];
    queueHead++;

    if (maxDepth !== undefined && distance >= maxDepth) continue;

    stats.coloredStatesExplored++;
    if (distance > stats.maxDepth) stats.maxDepth = distance;

    occupancy.fill(0);
    for (let b = 0; b < boxCount; b++) {
      const cell = arenaTokens[stateOffset + b] % cellCount;
      occupancy[cell] = 1;
    }

    for (let b = 0; b < boxCount; b++) {
      const token = arenaTokens[stateOffset + b];
      const boxCell = token % cellCount;
      const coloredLabelId = (token / cellCount) | 0;
      const corridor = coloredLabelToCorridor[coloredLabelId];
      const neighbors = board.neighbors[boxCell];
      if (!neighbors) continue;

      for (let d = 0; d < SEARCH_DIRECTION_COUNT; d++) {
        const oppositeD = OPPOSITE_DIRECTION[d];
        const prevCell = neighbors[oppositeD];
        if (prevCell < 0) continue;
        const supportCell = board.neighbors[prevCell]?.[oppositeD] ?? -1;
        if (supportCell < 0) continue;
        if (occupancy[prevCell] !== 0 || occupancy[supportCell] !== 0) continue;

        if (!disableCorridors && corridor && !isViableEdge(corridor, prevCell, boxCell)) {
          stats.constrainedTransitionsSkipped++;
          continue;
        }

        const newToken = coloredLabelId * cellCount + prevCell;

        for (let i = 0; i < boxCount; i++) {
          childTokenBuf[i] = i === b ? newToken : arenaTokens[stateOffset + i];
        }
        childTokenBuf.sort();

        if (queueTail >= maxStates) break;
        enqueueState(childTokenBuf, distance + 1);
      }
      if (queueTail >= maxStates) break;
    }
  }

  coloredDedup.clear();

  updateWorkingBytes();
  stats.retainedBytes = estimateProjectedRetainedBytes(projectedTable);
  stats.buildTimeMs = Math.max(0, now() - buildStart);

  return makeLookupTable(projectedTable, stats);
}

function buildColoredLabels(
  board: CompiledSearchBoard,
  matching: MatchingComponentResult,
): {
  coloredLabelNames: string[];
  coloredLabelToOriginalId: number[];
  goalColoredLabelId: Map<number, number>;
  coloredLabelToCorridor: (ComponentViableCorridor | null)[];
} | null {
  const sortedLabels = [...board.goalCellsByLabel.keys()].sort();
  const originalLabelToId = new Map<string, number>();
  for (let i = 0; i < sortedLabels.length; i++) {
    originalLabelToId.set(sortedLabels[i], i);
  }

  const coloredLabelNames: string[] = [];
  const coloredLabelToOriginalId: number[] = [];
  const coloredLabelToCorridor: (ComponentViableCorridor | null)[] = [];
  const goalColoredLabelId = new Map<number, number>();

  for (const label of sortedLabels) {
    const origId = originalLabelToId.get(label)!;
    const compCount = matching.componentCountByLabel.get(label) ?? 1;
    const goalComps = matching.goalComponentsByLabel.get(label);
    const goalCells = board.goalCellsByLabel.get(label);
    const corridors = matching.corridorsByLabel.get(label);

    const baseId = coloredLabelNames.length;

    for (let c = 0; c < compCount; c++) {
      coloredLabelNames.push(`${label}__c${c}`);
      coloredLabelToOriginalId.push(origId);
      coloredLabelToCorridor.push(corridors?.[c] ?? null);
    }

    if (goalCells && goalComps) {
      for (let g = 0; g < goalCells.length; g++) {
        goalColoredLabelId.set(goalCells[g], baseId + (goalComps[g] ?? 0));
      }
    }
  }

  if (coloredLabelNames.length === 0) return null;
  return {
    coloredLabelNames,
    coloredLabelToOriginalId,
    goalColoredLabelId,
    coloredLabelToCorridor,
  };
}

function buildSeedTokens(
  board: CompiledSearchBoard,
  goalColoredLabelId: Map<number, number>,
  cellCount: number,
): Uint32Array | null {
  const goalCells: number[] = [];
  for (const cells of board.goalCellsByLabel.values()) {
    for (const cell of cells) goalCells.push(cell);
  }

  if (goalCells.length === 0) return null;

  const seedTokens = new Uint32Array(goalCells.length);
  for (let i = 0; i < goalCells.length; i++) {
    const cell = goalCells[i];
    const coloredLabelId = goalColoredLabelId.get(cell);
    if (coloredLabelId === undefined) return null;
    seedTokens[i] = coloredLabelId * cellCount + cell;
  }
  seedTokens.sort();

  return seedTokens;
}

function estimateProjectedRetainedBytes(
  table: Map<number, PerimeterEntry[]>,
): number {
  let bytes = 0;
  for (const chain of table.values()) {
    bytes += ESTIMATED_MAP_ENTRY_BYTES;
    for (let i = 0; i < chain.length; i++) {
      bytes += ESTIMATED_CHAIN_ELEMENT_BYTES + ESTIMATED_BIGINT_BYTES;
    }
  }
  return bytes;
}

function makeEmptyTable(stats: BackwardPerimeterStats): BackwardPerimeterTable {
  return {
    stats,
    lookup(): number | undefined {
      return undefined;
    },
  };
}

function makeLookupTable(
  projected: Map<number, PerimeterEntry[]>,
  stats: BackwardPerimeterStats,
): BackwardPerimeterTable {
  return {
    stats,
    lookup(boxZobristKey: number, boxExactKey: bigint): number | undefined {
      stats.lookups++;
      const chain = projected.get(boxZobristKey);
      if (!chain) return undefined;
      for (let i = 0; i < chain.length; i++) {
        if (chain[i].bigintKey === boxExactKey) {
          stats.hits++;
          return chain[i].distance;
        }
      }
      return undefined;
    },
  };
}
