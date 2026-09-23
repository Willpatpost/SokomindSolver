import type { CompiledSearchBoard } from "./compiled-board.ts";
import { SEARCH_DIRECTION_COUNT } from "./compiled-board.ts";
import type { MatchingComponent } from "./matching-components.ts";
import { isViableEdge } from "./single-box-push-graph.ts";
import type { ExactPreprocessingBudget } from "./preprocessing-budget.ts";
import { checkExactPreprocessingBudget } from "./preprocessing-budget.ts";

const OPPOSITE_DIRECTION = [1, 0, 3, 2] as const;
const ESTIMATED_MAP_ENTRY_BYTES = 80;
const ESTIMATED_BIGINT_BYTES = 24;

export interface ComponentPdbStats {
  states: number;
  buildTimeMs: number;
  retainedBytes: number;
  peakBuildBytes: number;
  maxDepthSeen: number;
  completedRadius: number;
  complete: boolean;
  queries: number;
  hits: number;
  radiusFallbacks: number;
  misses: number;
}

export interface ComponentPdb {
  readonly componentId: number;
  readonly label: string;
  readonly boxCount: number;
  readonly stats: ComponentPdbStats;
  lookup(sortedCells: ArrayLike<number>): number | undefined;
  lowerBound(sortedCells: ArrayLike<number>): number;
}

export interface ComponentPdbCollectionStats {
  componentPdbBuildTimeMs: number;
  componentPdbPeakBuildBytes: number;
  componentPdbRetainedBytes: number;
  partitionQueries: number;
  partitionCacheHits: number;
  partitionMasksRejectedByDomain: number;
  componentPdbImprovements: number;
  componentPdbTotalImprovement: number;
  componentPdbMaxImprovement: number;
}

export interface LabelComponentFamily {
  readonly label: string;
  readonly components: readonly ComponentPdb[];
  readonly totalBoxCount: number;
  lowerBound(currentCells: readonly number[]): number;
}

export interface ComponentPdbCollection {
  readonly families: ReadonlyMap<string, LabelComponentFamily>;
  readonly stats: ComponentPdbCollectionStats;
  readonly retainedBytes: number;
  evaluate(
    boxesByLabel: ReadonlyMap<string, readonly number[]>,
  ): number;
}

function packSortedCells(cells: ArrayLike<number>, cellCount: number): bigint {
  let key = 0n;
  const shift = BigInt(Math.ceil(Math.log2(Math.max(cellCount, 2))));
  for (let i = cells.length - 1; i >= 0; i--) {
    key = (key << shift) | BigInt(cells[i]);
  }
  return key;
}

function buildSingletonPdb(
  board: CompiledSearchBoard,
  component: MatchingComponent,
  now: () => number,
): ComponentPdb {
  const buildStart = now();
  const { cellCount, neighbors } = board;
  const goalCell = component.goalCells[0];
  const corridor = component.corridor;

  const distances = new Int32Array(cellCount).fill(-1);
  const queue: number[] = [];
  distances[goalCell] = 0;
  queue.push(goalCell);

  let maxDepth = 0;
  let stateCount = 1;

  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    const dist = distances[cell];
    const nbrs = neighbors[cell];
    if (!nbrs) continue;

    for (let d = 0; d < SEARCH_DIRECTION_COUNT; d++) {
      const prevCell = nbrs[OPPOSITE_DIRECTION[d]];
      if (prevCell < 0) continue;
      const supportCell = neighbors[prevCell]?.[OPPOSITE_DIRECTION[d]] ?? -1;
      if (supportCell < 0) continue;
      if (distances[prevCell] >= 0) continue;

      if (!isViableEdge(corridor, prevCell, cell)) continue;

      distances[prevCell] = dist + 1;
      if (dist + 1 > maxDepth) maxDepth = dist + 1;
      stateCount++;
      queue.push(prevCell);
    }
  }

  const stats: ComponentPdbStats = {
    states: stateCount,
    buildTimeMs: Math.max(0, now() - buildStart),
    retainedBytes: cellCount * 4 + 200,
    peakBuildBytes: cellCount * 4 + queue.length * 4 + 200,
    maxDepthSeen: maxDepth,
    completedRadius: maxDepth,
    complete: true,
    queries: 0,
    hits: 0,
    radiusFallbacks: 0,
    misses: 0,
  };

  return {
    componentId: component.id,
    label: component.label,
    boxCount: 1,
    stats,
    lookup(sortedCells: ArrayLike<number>): number | undefined {
      const d = distances[sortedCells[0]];
      stats.queries++;
      if (d >= 0) {
        stats.hits++;
        return d;
      }
      return undefined;
    },
    lowerBound(sortedCells: ArrayLike<number>): number {
      stats.queries++;
      const d = distances[sortedCells[0]];
      if (d >= 0) {
        stats.hits++;
        return d;
      }
      stats.radiusFallbacks++;
      return maxDepth + 1;
    },
  };
}

interface MultiBoxBfsState {
  readonly key: bigint;
  readonly cells: Uint16Array;
}

function buildMultiBoxPdb(
  board: CompiledSearchBoard,
  component: MatchingComponent,
  maxStates: number,
  budget: ExactPreprocessingBudget | undefined,
  now: () => number,
): ComponentPdb {
  const buildStart = now();
  const { cellCount, neighbors } = board;
  const boxCount = component.goalCells.length;
  const corridor = component.corridor;

  const table = new Map<bigint, number>();

  const seedCells = new Uint16Array(boxCount);
  const goalsSorted = [...component.goalCells].sort((a, b) => a - b);
  for (let i = 0; i < boxCount; i++) seedCells[i] = goalsSorted[i];
  const seedKey = packSortedCells(seedCells, cellCount);
  table.set(seedKey, 0);

  const queue: MultiBoxBfsState[] = [{ key: seedKey, cells: seedCells }];
  let queueHead = 0;

  let maxDepthSeen = 0;
  let completedRadius = -1;
  let currentLayerEnd = 1;
  let currentLayerDist = 0;
  let peakBytes = 0;

  const childCells = new Uint16Array(boxCount);
  const occupancy = new Uint8Array(cellCount);

  while (queueHead < queue.length) {
    if (table.size >= maxStates) break;

    if ((queueHead & 63) === 0) {
      const estimatedBytes = table.size * (ESTIMATED_MAP_ENTRY_BYTES + ESTIMATED_BIGINT_BYTES + 4) +
        queue.length * (boxCount * 2 + ESTIMATED_BIGINT_BYTES + 32);
      if (estimatedBytes > peakBytes) peakBytes = estimatedBytes;
      checkExactPreprocessingBudget(budget, estimatedBytes);
    }

    if (queueHead >= currentLayerEnd) {
      completedRadius = currentLayerDist;
      currentLayerDist++;
      currentLayerEnd = queue.length;
    }

    const state = queue[queueHead++];
    const dist = table.get(state.key)!;

    occupancy.fill(0);
    for (let b = 0; b < boxCount; b++) occupancy[state.cells[b]] = 1;

    for (let b = 0; b < boxCount; b++) {
      const boxCell = state.cells[b];
      const nbrs = neighbors[boxCell];
      if (!nbrs) continue;

      for (let d = 0; d < SEARCH_DIRECTION_COUNT; d++) {
        const prevCell = nbrs[OPPOSITE_DIRECTION[d]];
        if (prevCell < 0) continue;
        const supportCell = neighbors[prevCell]?.[OPPOSITE_DIRECTION[d]] ?? -1;
        if (supportCell < 0) continue;
        if (occupancy[prevCell] !== 0 || occupancy[supportCell] !== 0) continue;

        if (!isViableEdge(corridor, prevCell, boxCell)) continue;

        for (let i = 0; i < boxCount; i++) {
          childCells[i] = i === b ? prevCell : state.cells[i];
        }
        childCells.sort();

        const childKey = packSortedCells(childCells, cellCount);
        if (table.has(childKey)) continue;

        if (table.size >= maxStates) break;

        const newDist = dist + 1;
        table.set(childKey, newDist);
        if (newDist > maxDepthSeen) maxDepthSeen = newDist;
        queue.push({
          key: childKey,
          cells: Uint16Array.from(childCells),
        });
      }
      if (table.size >= maxStates) break;
    }
  }

  if (queueHead >= queue.length && completedRadius < currentLayerDist) {
    completedRadius = currentLayerDist;
  }

  const complete = queueHead >= queue.length;
  if (complete) completedRadius = maxDepthSeen;

  const retainedBytes = table.size * (ESTIMATED_MAP_ENTRY_BYTES + ESTIMATED_BIGINT_BYTES + 4) + 200;
  const stats: ComponentPdbStats = {
    states: table.size,
    buildTimeMs: Math.max(0, now() - buildStart),
    retainedBytes,
    peakBuildBytes: Math.max(peakBytes, retainedBytes),
    maxDepthSeen,
    completedRadius: Math.max(completedRadius, 0),
    complete,
    queries: 0,
    hits: 0,
    radiusFallbacks: 0,
    misses: 0,
  };

  const finalCompletedRadius = stats.completedRadius;

  return {
    componentId: component.id,
    label: component.label,
    boxCount,
    stats,
    lookup(sortedCells: ArrayLike<number>): number | undefined {
      stats.queries++;
      const key = packSortedCells(sortedCells, cellCount);
      const d = table.get(key);
      if (d !== undefined) {
        stats.hits++;
        return d;
      }
      return undefined;
    },
    lowerBound(sortedCells: ArrayLike<number>): number {
      stats.queries++;
      const key = packSortedCells(sortedCells, cellCount);
      const d = table.get(key);
      if (d !== undefined) {
        stats.hits++;
        return d;
      }
      if (complete) {
        stats.misses++;
        return 0;
      }
      if (finalCompletedRadius >= 0) {
        stats.radiusFallbacks++;
        return finalCompletedRadius + 1;
      }
      stats.misses++;
      return 0;
    },
  };
}

export interface ComponentPdbBudget {
  readonly totalMaxStates: number;
  readonly maxStatesPerComponent?: number;
}

export function buildComponentPdbs(
  board: CompiledSearchBoard,
  components: readonly MatchingComponent[],
  pdbBudget: ComponentPdbBudget,
  preprocessingBudget: ExactPreprocessingBudget | undefined,
  now: () => number,
): ComponentPdb[] {
  const pdbs: ComponentPdb[] = [];
  let totalBudgetRemaining = pdbBudget.totalMaxStates;
  const perComponentMax = pdbBudget.maxStatesPerComponent ?? pdbBudget.totalMaxStates;

  const sorted = [...components].sort((a, b) => a.goalCells.length - b.goalCells.length);

  for (const comp of sorted) {
    checkExactPreprocessingBudget(preprocessingBudget);

    if (totalBudgetRemaining <= 0) break;

    const componentBudget = Math.min(totalBudgetRemaining, perComponentMax);

    let pdb: ComponentPdb;
    if (comp.goalCells.length === 1) {
      pdb = buildSingletonPdb(board, comp, now);
    } else {
      pdb = buildMultiBoxPdb(board, comp, componentBudget, preprocessingBudget, now);
    }

    totalBudgetRemaining -= pdb.stats.states;
    pdbs.push(pdb);
  }

  return pdbs;
}

function subsetsOfSize(
  mask: number,
  size: number,
  callback: (subset: number) => boolean,
): void {
  if (size === 0) {
    callback(0);
    return;
  }
  let subset = (1 << size) - 1;
  while (subset <= mask) {
    if ((subset & mask) === subset) {
      if (!callback(subset)) return;
    }
    if (subset === 0) break;
    const c = subset & -subset;
    const r = subset + c;
    subset = (((r ^ subset) >> 2) / c) | r;
    if (subset < 0 || !Number.isFinite(subset)) break;
  }
}

function popcount(n: number): number {
  n = n - ((n >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  return (((n + (n >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

function cellsFromMask(
  allCells: readonly number[],
  mask: number,
  out: Uint16Array,
): void {
  let j = 0;
  for (let i = 0; i < allCells.length; i++) {
    if (mask & (1 << i)) out[j++] = allCells[i];
  }
}

export function buildComponentPdbCollection(
  board: CompiledSearchBoard,
  components: readonly MatchingComponent[],
  pdbBudget: ComponentPdbBudget,
  preprocessingBudget: ExactPreprocessingBudget | undefined,
  now: () => number,
): ComponentPdbCollection {
  const buildStart = now();
  const pdbs = buildComponentPdbs(
    board, components, pdbBudget, preprocessingBudget, now,
  );

  const familyMap = new Map<string, { components: ComponentPdb[]; totalBoxCount: number }>();
  for (const pdb of pdbs) {
    let family = familyMap.get(pdb.label);
    if (!family) {
      family = { components: [], totalBoxCount: 0 };
      familyMap.set(pdb.label, family);
    }
    family.components.push(pdb);
    family.totalBoxCount += pdb.boxCount;
  }

  const collectionStats: ComponentPdbCollectionStats = {
    componentPdbBuildTimeMs: 0,
    componentPdbPeakBuildBytes: 0,
    componentPdbRetainedBytes: 0,
    partitionQueries: 0,
    partitionCacheHits: 0,
    partitionMasksRejectedByDomain: 0,
    componentPdbImprovements: 0,
    componentPdbTotalImprovement: 0,
    componentPdbMaxImprovement: 0,
  };

  let totalRetained = 0;
  let peakBuild = 0;
  for (const pdb of pdbs) {
    totalRetained += pdb.stats.retainedBytes;
    if (pdb.stats.peakBuildBytes > peakBuild) peakBuild = pdb.stats.peakBuildBytes;
  }
  collectionStats.componentPdbRetainedBytes = totalRetained;
  collectionStats.componentPdbPeakBuildBytes = peakBuild;

  const partitionCache = new Map<string, number>();
  const MAX_PARTITION_CACHE = 50_000;

  const viableCellSets: Map<number, Set<number>> = new Map();
  for (const pdb of pdbs) {
    const comp = components.find((c) => c.id === pdb.componentId);
    if (comp) {
      viableCellSets.set(pdb.componentId, new Set(comp.corridor.viableCells));
    }
  }

  function labelPartitionLowerBound(
    currentCells: readonly number[],
    familyComponents: readonly ComponentPdb[],
  ): number {
    const n = currentCells.length;
    if (n === 0) return 0;

    if (n > 20) return 0;

    const sortedComps = [...familyComponents].sort((a, b) => {
      const aViable = viableCellSets.get(a.componentId);
      const bViable = viableCellSets.get(b.componentId);
      const aCount = aViable
        ? currentCells.filter((c) => aViable.has(c)).length
        : n;
      const bCount = bViable
        ? currentCells.filter((c) => bViable.has(c)).length
        : n;
      return aCount - bCount || a.boxCount - b.boxCount;
    });

    const fullMask = (1 << n) - 1;
    const dpSize = sortedComps.length + 1;
    const dp = new Float64Array(dpSize * (fullMask + 1)).fill(Infinity);
    dp[sortedComps.length * (fullMask + 1)] = 0;

    const cellBuf = new Uint16Array(n);

    for (let ci = sortedComps.length - 1; ci >= 0; ci--) {
      const comp = sortedComps[ci];
      const need = comp.boxCount;
      const viable = viableCellSets.get(comp.componentId);

      for (let remaining = 0; remaining <= fullMask; remaining++) {
        if (popcount(remaining) < need) {
          dp[ci * (fullMask + 1) + remaining] = Infinity;
          continue;
        }

        let best = Infinity;

        subsetsOfSize(remaining, need, (subset) => {
          let domainOk = true;
          if (viable) {
            for (let i = 0; i < n; i++) {
              if ((subset & (1 << i)) && !viable.has(currentCells[i])) {
                collectionStats.partitionMasksRejectedByDomain++;
                domainOk = false;
                break;
              }
            }
          }
          if (!domainOk) return true;

          cellsFromMask(currentCells, subset, cellBuf);
          const h = comp.lowerBound(cellBuf.subarray(0, need));

          const rest = dp[(ci + 1) * (fullMask + 1) + (remaining ^ subset)];
          if (Number.isFinite(rest)) {
            const total = h + rest;
            if (total < best) best = total;
          }
          return true;
        });

        dp[ci * (fullMask + 1) + remaining] = best;
      }
    }

    const result = dp[0 * (fullMask + 1) + fullMask];
    return Number.isFinite(result) ? result : 0;
  }

  const families = new Map<string, LabelComponentFamily>();
  for (const [label, family] of familyMap) {
    const comps = family.components;
    const totalBoxCount = family.totalBoxCount;

    const labelFamily: LabelComponentFamily = {
      label,
      components: comps,
      totalBoxCount,
      lowerBound(currentCells: readonly number[]): number {
        if (currentCells.length !== totalBoxCount) return 0;

        collectionStats.partitionQueries++;

        const sorted = [...currentCells].sort((a, b) => a - b);
        const cacheKey = `${label}:${sorted.join(",")}`;
        const cached = partitionCache.get(cacheKey);
        if (cached !== undefined) {
          collectionStats.partitionCacheHits++;
          return cached;
        }

        const result = labelPartitionLowerBound(sorted, comps);

        if (partitionCache.size < MAX_PARTITION_CACHE) {
          partitionCache.set(cacheKey, result);
        }

        return result;
      },
    };
    families.set(label, labelFamily);
  }

  collectionStats.componentPdbBuildTimeMs = Math.max(0, now() - buildStart);

  return {
    families,
    stats: collectionStats,
    retainedBytes: totalRetained,
    evaluate(
      boxesByLabel: ReadonlyMap<string, readonly number[]>,
    ): number {
      let total = 0;
      for (const [label, cells] of boxesByLabel) {
        const family = families.get(label);
        if (!family) continue;
        total += family.lowerBound(cells);
      }
      return total;
    },
  };
}
