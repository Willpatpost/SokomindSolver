// Pattern database construction and lookup for the discovery heuristic.
// Reverse-push BFS over combinadic-encoded k-box configurations within
// bounded floor regions around goal cells.

const PDB_MAX_ENTRIES = 2_000_000;
const PDB_REGION_DISTANCE = 8;
const PDB_MAX_PARTITION_SIZE = 5;
const PDB_UNSOLVED = 0xffff;

function pdbBuildBinomials(maxN, maxK) {
  const table = new Array(maxN + 1);
  for (let n = 0; n <= maxN; n++) {
    table[n] = new Float64Array(maxK + 1);
    table[n][0] = 1;
    for (let k = 1; k <= Math.min(n, maxK); k++) {
      const value = table[n - 1][k - 1] + table[n - 1][k];
      table[n][k] = Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
    }
  }
  return table;
}

function pdbCombinadicEncode(positions, binom) {
  let index = 0;
  for (let i = 0; i < positions.length; i++) {
    index += binom[positions[i]][i + 1];
  }
  return index;
}

function pdbBuildRegion(dense, goalCellIds, maxDistance) {
  const region = new Set();
  const dist = new Int32Array(dense.keys.length).fill(-1);
  const queue = [];
  for (const gc of goalCellIds) {
    if (gc >= 0 && dist[gc] < 0) {
      dist[gc] = 0;
      queue.push(gc);
      region.add(gc);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cell = queue[head++];
    if (dist[cell] >= maxDistance) continue;
    for (let d = 0; d < 4; d++) {
      const next = dense.neighbors[cell * 4 + d];
      if (next < 0 || dist[next] >= 0) continue;
      dist[next] = dist[cell] + 1;
      region.add(next);
      queue.push(next);
    }
  }
  return [...region].sort((a, b) => a - b);
}

function pdbBuildTable(dense, goalCellIds, regionCellIds) {
  const k = goalCellIds.length;
  const regionCount = regionCellIds.length;
  const cellToRegion = new Int32Array(dense.keys.length).fill(-1);
  for (let i = 0; i < regionCount; i++) cellToRegion[regionCellIds[i]] = i;

  const regionSet = new Set(regionCellIds);
  const binom = pdbBuildBinomials(regionCount, k);
  const tableSize = binom[regionCount][k];
  if (!Number.isSafeInteger(tableSize) || tableSize <= 0 || tableSize > PDB_MAX_ENTRIES) {
    return null;
  }

  const table = new Uint16Array(tableSize);
  table.fill(PDB_UNSOLVED);

  const solvedRegionPositions = goalCellIds
    .map(gc => cellToRegion[gc])
    .sort((a, b) => a - b);
  if (solvedRegionPositions.some(p => p < 0)) return null;

  const solvedIndex = pdbCombinadicEncode(solvedRegionPositions, binom);
  table[solvedIndex] = 0;

  const queue = [{positions: [...solvedRegionPositions]}];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    const currentIndex = pdbCombinadicEncode(current.positions, binom);
    const currentDist = table[currentIndex];
    if (currentDist >= PDB_UNSOLVED - 1) continue;

    const occupied = new Uint8Array(regionCount);
    for (const rp of current.positions) occupied[rp] = 1;

    for (let bi = 0; bi < k; bi++) {
      const regionPos = current.positions[bi];
      const boardCell = regionCellIds[regionPos];

      for (let d = 0; d < 4; d++) {
        const destCell = dense.neighbors[boardCell * 4 + d];
        if (destCell < 0) continue;
        const destRegion = cellToRegion[destCell];
        if (destRegion < 0 || occupied[destRegion]) continue;

        const supportCell = dense.neighbors[destCell * 4 + d];
        if (supportCell < 0) continue;
        if (!regionSet.has(supportCell) && dense.neighbors[supportCell * 4] === undefined) continue;

        const newPositions = [...current.positions];
        newPositions[bi] = destRegion;
        newPositions.sort((a, b) => a - b);

        const newIndex = pdbCombinadicEncode(newPositions, binom);
        if (table[newIndex] !== PDB_UNSOLVED) continue;

        table[newIndex] = currentDist + 1;
        queue.push({positions: newPositions});
      }
    }
  }

  return {k, table, regionCellIds, cellToRegion, binom, tableSize};
}

function pdbPartitionGoals(board) {
  const partitions = [];
  for (const [label, goals] of board.goalsByLabel) {
    const goalCellIds = goals.map(pos => board.dense.idByKey.get(pos)).filter(id => id >= 0);
    if (goalCellIds.length === 0) continue;
    if (goalCellIds.length <= PDB_MAX_PARTITION_SIZE) {
      partitions.push({label, goalCellIds});
    } else {
      const splits = pdbSplitByProximity(board.dense, goalCellIds, PDB_MAX_PARTITION_SIZE);
      for (const split of splits) {
        partitions.push({label, goalCellIds: split});
      }
    }
  }
  return partitions;
}

function pdbSplitByProximity(dense, goalCellIds, maxSize) {
  if (goalCellIds.length <= maxSize) return [goalCellIds];
  const n = goalCellIds.length;
  const used = new Uint8Array(n);
  const result = [];
  while (true) {
    let seed = -1;
    for (let i = 0; i < n; i++) {
      if (!used[i]) { seed = i; break; }
    }
    if (seed < 0) break;
    const group = [seed];
    used[seed] = 1;
    while (group.length < maxSize) {
      let bestIdx = -1, bestDist = Infinity;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        let minDist = Infinity;
        for (const gi of group) {
          const dist = Math.abs(dense.y[goalCellIds[gi]] - dense.y[goalCellIds[i]]) +
            Math.abs(dense.x[goalCellIds[gi]] - dense.x[goalCellIds[i]]);
          if (dist < minDist) minDist = dist;
        }
        if (minDist < bestDist) { bestDist = minDist; bestIdx = i; }
      }
      if (bestIdx < 0) break;
      group.push(bestIdx);
      used[bestIdx] = 1;
    }
    result.push(group.map(i => goalCellIds[i]).sort((a, b) => a - b));
  }
  return result;
}

function buildPdbPartitions(board) {
  const started = now();
  const goalPartitions = pdbPartitionGoals(board);
  const partitions = [];
  for (const {label, goalCellIds} of goalPartitions) {
    const regionCellIds = pdbBuildRegion(board.dense, goalCellIds, PDB_REGION_DISTANCE);
    const pdb = pdbBuildTable(board.dense, goalCellIds, regionCellIds);
    if (!pdb) continue;
    partitions.push({...pdb, label});
    if (now() - started > 500) break;
  }
  board.metrics.pdbBuildMs = now() - started;
  board.metrics.pdbPartitionCount = partitions.length;
  board.metrics.pdbTotalEntries = partitions.reduce((sum, p) => sum + p.tableSize, 0);
  return partitions;
}

function pdbLookup(partition, boxCellIds) {
  const positions = [];
  for (const cellId of boxCellIds) {
    const ri = partition.cellToRegion[cellId];
    if (ri < 0) return 0;
    positions.push(ri);
  }
  positions.sort((a, b) => a - b);
  const index = pdbCombinadicEncode(positions, partition.binom);
  if (index >= partition.tableSize) return 0;
  const value = partition.table[index];
  return value === PDB_UNSOLVED ? 0 : value;
}

function pdbHeuristic(boxes, board) {
  const partitions = board.pdbPartitions;
  if (!partitions || !partitions.length) return 0;
  const cellIdsByLabel = new Map();
  for (const [y, x, label] of boxes) {
    const cellId = board.dense.idByKey.get(pkey(y, x));
    if (cellId === undefined) continue;
    if (!cellIdsByLabel.has(label)) cellIdsByLabel.set(label, []);
    cellIdsByLabel.get(label).push(cellId);
  }
  let total = 0;
  for (const partition of partitions) {
    const cellIds = cellIdsByLabel.get(partition.label);
    if (!cellIds || cellIds.length < partition.k) continue;
    if (cellIds.length === partition.k) {
      total += pdbLookup(partition, cellIds);
    } else {
      let minValue = Infinity;
      const indices = new Array(partition.k);
      const subset = new Array(partition.k);
      for (let j = 0; j < partition.k; j++) indices[j] = j;
      while (true) {
        for (let j = 0; j < partition.k; j++) subset[j] = cellIds[indices[j]];
        const value = pdbLookup(partition, subset);
        if (value < minValue) {
          minValue = value;
          if (value === 0) break;
        }
        let j = partition.k - 1;
        while (j >= 0 && indices[j] === cellIds.length - partition.k + j) j--;
        if (j < 0) break;
        indices[j]++;
        for (let m = j + 1; m < partition.k; m++) indices[m] = indices[m - 1] + 1;
      }
      if (Number.isFinite(minValue)) total += minValue;
    }
  }
  return total;
}

// --- Module registration ---
const SokomindPdb = {
  pdbBuildBinomials,
  pdbCombinadicEncode,
  pdbBuildRegion,
  pdbBuildTable,
  pdbPartitionGoals,
  buildPdbPartitions,
  pdbLookup,
  pdbHeuristic,
  PDB_UNSOLVED,
};
if (typeof globalThis !== "undefined") globalThis.SokomindPdb = SokomindPdb;
if (typeof module === "object" && module.exports) module.exports = SokomindPdb;
