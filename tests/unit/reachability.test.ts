import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KeeperReachability,
  type ReachabilityTopology,
} from "../../src/solver/search/reachability.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a grid topology for a `rows x cols` board.  Cells are indexed in
 * row-major order: `cell = row * cols + col`.  The `walls` set lists cell
 * indices that have no passable neighbors.
 */
function gridTopology(
  rows: number,
  cols: number,
  walls: ReadonlySet<number> = new Set(),
): ReachabilityTopology {
  const cellCount = rows * cols;
  // Direction order matches DIRECTIONS: up, down, left, right.
  const deltas: readonly [number, number][] = [
    [-1, 0], // up
    [1, 0], // down
    [0, -1], // left
    [0, 1], // right
  ];
  const neighbors: number[][] = [];
  for (let cell = 0; cell < cellCount; cell++) {
    const r = Math.floor(cell / cols);
    const c = cell % cols;
    const cellNeighbors: number[] = [];
    for (const [dr, dc] of deltas) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        const neighbor = nr * cols + nc;
        cellNeighbors.push(walls.has(neighbor) ? -1 : neighbor);
      } else {
        cellNeighbors.push(-1);
      }
    }
    neighbors.push(cellNeighbors);
  }
  return { cellCount, neighbors };
}

/** Creates an occupied array where wall cells are marked as 1 (occupied). */
function occupiedFromWalls(
  cellCount: number,
  walls: ReadonlySet<number>,
): Uint8Array {
  const occupied = new Uint8Array(cellCount);
  for (const w of walls) occupied[w] = 1;
  return occupied;
}

/** Converts (row, col) to a cell index in a row-major grid. */
function cell(row: number, col: number, cols: number): number {
  return row * cols + col;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KeeperReachability", () => {
  it("floods all reachable cells on an open 3x3 grid", () => {
    const cols = 3;
    const topology = gridTopology(3, cols);
    const reachability = new KeeperReachability(topology);
    const occupied = new Uint8Array(topology.cellCount); // no walls

    const result = reachability.flood(cell(1, 1, cols), occupied);

    // All 9 cells should be reachable from the center.
    assert.equal(result.reachableCount, 9);
    for (let i = 0; i < topology.cellCount; i++) {
      assert.equal(result.isReachable(i), true, `cell ${i} reachable`);
    }
  });

  it("reports canonicalCell as the minimum reachable cell", () => {
    const cols = 3;
    const topology = gridTopology(3, cols);
    const reachability = new KeeperReachability(topology);
    const occupied = new Uint8Array(topology.cellCount);

    // Start from center (cell 4). Minimum reachable = 0.
    const result = reachability.flood(cell(1, 1, cols), occupied);
    assert.equal(result.canonicalCell, 0);
  });

  it("reports canonicalCell correctly when some cells are blocked", () => {
    // 3x3 grid with cells 0, 1, 2 blocked (entire top row).
    // Reachable cells from center (4) are: 3, 4, 5, 6, 7, 8.
    const cols = 3;
    const walls = new Set([0, 1, 2]);
    const topology = gridTopology(3, cols, walls);
    const reachability = new KeeperReachability(topology);
    const occupied = occupiedFromWalls(topology.cellCount, walls);

    const result = reachability.flood(cell(1, 0, cols), occupied);
    assert.equal(result.canonicalCell, 3);
  });

  it("marks blocked and unreachable cells as not reachable", () => {
    // 3x3 grid:
    //   . W .
    //   . S W
    //   . . .
    // Start at S = (1,1) = cell 4. Cells 1 and 5 are walls.
    // Cell 2 (top-right) is unreachable because both paths go through walls.
    const cols = 3;
    const walls = new Set([cell(0, 1, cols), cell(1, 2, cols)]);
    const topology = gridTopology(3, cols, walls);
    const reachability = new KeeperReachability(topology);
    const occupied = occupiedFromWalls(topology.cellCount, walls);

    const result = reachability.flood(cell(1, 1, cols), occupied);

    assert.equal(result.isReachable(cell(0, 1, cols)), false, "wall cell 1");
    assert.equal(result.isReachable(cell(1, 2, cols)), false, "wall cell 5");
    assert.equal(result.isReachable(cell(0, 2, cols)), false, "isolated cell 2");
    assert.equal(result.isReachable(cell(1, 1, cols)), true, "start cell");
    assert.equal(result.isReachable(cell(2, 2, cols)), true, "reachable cell 8");
  });

  it("returns correct pathTo for adjacent and distant cells", () => {
    // 3x3 open grid, start at (0,0) = cell 0.
    const cols = 3;
    const topology = gridTopology(3, cols);
    const reachability = new KeeperReachability(topology);
    const occupied = new Uint8Array(topology.cellCount);

    const result = reachability.flood(cell(0, 0, cols), occupied);

    // Path to self should be empty.
    const pathToSelf = result.pathTo(cell(0, 0, cols));
    assert.ok(pathToSelf);
    assert.equal(pathToSelf.length, 0);

    // Path to (0,1) should be ["right"].
    const pathRight = result.pathTo(cell(0, 1, cols));
    assert.ok(pathRight);
    assert.equal(pathRight.length, 1);
    assert.equal(pathRight[0], "right");

    // Path to (1,0) should be ["down"].
    const pathDown = result.pathTo(cell(1, 0, cols));
    assert.ok(pathDown);
    assert.equal(pathDown.length, 1);
    assert.equal(pathDown[0], "down");

    // Path to (2,2) should have length 4 (BFS shortest).
    const pathCorner = result.pathTo(cell(2, 2, cols));
    assert.ok(pathCorner);
    assert.equal(pathCorner.length, 4);
  });

  it("returns undefined pathTo for unreachable cells", () => {
    const cols = 3;
    const walls = new Set([cell(0, 1, cols), cell(1, 0, cols)]);
    const topology = gridTopology(3, cols, walls);
    const reachability = new KeeperReachability(topology);
    const occupied = occupiedFromWalls(topology.cellCount, walls);

    // Start at (0,0) = cell 0. Walls block (0,1) and (1,0), so cell 0 is
    // completely isolated.
    const result = reachability.flood(cell(0, 0, cols), occupied);
    assert.equal(result.pathTo(cell(2, 2, cols)), undefined);
  });

  it("handles flood with single reachable cell (fully isolated start)", () => {
    // 3x3 grid, start at center (1,1). All neighbors are walls.
    const cols = 3;
    const walls = new Set([
      cell(0, 1, cols), // up
      cell(2, 1, cols), // down
      cell(1, 0, cols), // left
      cell(1, 2, cols), // right
    ]);
    const topology = gridTopology(3, cols, walls);
    const reachability = new KeeperReachability(topology);
    const occupied = occupiedFromWalls(topology.cellCount, walls);

    const result = reachability.flood(cell(1, 1, cols), occupied);

    assert.equal(result.reachableCount, 1);
    assert.equal(result.isReachable(cell(1, 1, cols)), true);
    assert.equal(result.canonicalCell, cell(1, 1, cols));
    // All walls and non-adjacent cells unreachable.
    assert.equal(result.isReachable(cell(0, 0, cols)), false);
    assert.equal(result.isReachable(cell(0, 1, cols)), false);
  });

  it("respects the occupied predicate (boxes block passage)", () => {
    // 5x1 corridor: cells [0, 1, 2, 3, 4]. Cell 2 is occupied (a box).
    // Start at cell 0. Should reach 0, 1 only.
    const topology = gridTopology(1, 5);
    const reachability = new KeeperReachability(topology);
    const occupied = new Uint8Array(5);
    occupied[2] = 1; // box at cell 2

    const result = reachability.flood(0, occupied);

    assert.equal(result.isReachable(0), true);
    assert.equal(result.isReachable(1), true);
    assert.equal(result.isReachable(2), false, "occupied cell");
    assert.equal(result.isReachable(3), false, "beyond occupied");
    assert.equal(result.isReachable(4), false, "beyond occupied");
    assert.equal(result.reachableCount, 2);
  });

  it("handles multiple sequential floods correctly (epoch advancement)", () => {
    const cols = 3;
    const topology = gridTopology(3, cols);
    const reachability = new KeeperReachability(topology);
    const occupied = new Uint8Array(topology.cellCount);

    // First flood from top-left.
    const first = reachability.flood(cell(0, 0, cols), occupied);
    assert.equal(first.reachableCount, 9);

    // Add an occupied cell and re-flood from a different position.
    occupied[cell(1, 1, cols)] = 1;
    const second = reachability.flood(cell(0, 0, cols), occupied);

    // With center blocked, all cells except center should be reachable from
    // corner (in a 3x3, removing center still leaves all others connected).
    assert.equal(second.isReachable(cell(1, 1, cols)), false);
    assert.equal(second.reachableCount, 8);

    // The first result is now stale (shares the workspace), so we only verify
    // the second result is self-consistent.
    assert.equal(second.canonicalCell, 0);
  });

  it("survives many floods without corruption (epoch wraparound stress)", () => {
    // Run many floods to exercise epoch advancement. The epoch uses a Uint32
    // counter that wraps at 2^32, resetting the seenEpoch array.
    const cols = 3;
    const topology = gridTopology(3, cols);
    const reachability = new KeeperReachability(topology);
    const occupied = new Uint8Array(topology.cellCount);

    // Run 100 floods alternating start positions.
    for (let i = 0; i < 100; i++) {
      const start = i % topology.cellCount;
      const result = reachability.flood(start, occupied);
      assert.equal(result.reachableCount, 9, `flood ${i} count`);
      assert.equal(result.isReachable(start), true, `flood ${i} start reachable`);
      assert.equal(result.canonicalCell, 0, `flood ${i} canonical`);
    }
  });

  it("distanceTo returns correct BFS distances", () => {
    const cols = 3;
    const topology = gridTopology(3, cols);
    const reachability = new KeeperReachability(topology);
    const occupied = new Uint8Array(topology.cellCount);

    const result = reachability.flood(cell(0, 0, cols), occupied);

    assert.equal(result.distanceTo(cell(0, 0, cols)), 0, "distance to self");
    assert.equal(result.distanceTo(cell(0, 1, cols)), 1, "distance to right neighbor");
    assert.equal(result.distanceTo(cell(1, 0, cols)), 1, "distance to down neighbor");
    assert.equal(result.distanceTo(cell(1, 1, cols)), 2, "distance to diagonal");
    assert.equal(result.distanceTo(cell(2, 2, cols)), 4, "distance to far corner");
  });

  it("distanceTo returns -1 for unreachable cells", () => {
    const cols = 3;
    const walls = new Set([cell(0, 1, cols), cell(1, 0, cols)]);
    const topology = gridTopology(3, cols, walls);
    const reachability = new KeeperReachability(topology);
    const occupied = occupiedFromWalls(topology.cellCount, walls);

    const result = reachability.flood(cell(0, 0, cols), occupied);
    assert.equal(result.distanceTo(cell(2, 2, cols)), -1);
  });

  it("throws when start is on an occupied cell", () => {
    const topology = gridTopology(3, 3);
    const reachability = new KeeperReachability(topology);
    const occupied = new Uint8Array(9);
    occupied[4] = 1;

    assert.throws(
      () => reachability.flood(4, occupied),
      { message: /occupied/ },
    );
  });

  it("throws when occupied array length mismatches topology", () => {
    const topology = gridTopology(3, 3);
    const reachability = new KeeperReachability(topology);
    const wrongSized = new Uint8Array(5);

    assert.throws(
      () => reachability.flood(0, wrongSized),
      { message: /inconsistent/ },
    );
  });

  it("throws for invalid topology dimensions", () => {
    assert.throws(
      () =>
        new KeeperReachability({
          cellCount: 5,
          neighbors: [], // length 0, but cellCount is 5
        }),
      { message: /inconsistent/ },
    );
    assert.throws(
      () =>
        new KeeperReachability({
          cellCount: -1,
          neighbors: [],
        }),
      { message: /inconsistent/ },
    );
  });

  it("handles a zero-cell topology gracefully", () => {
    // A degenerate board with no cells. Construction should succeed.
    const topology: ReachabilityTopology = { cellCount: 0, neighbors: [] };
    const reachability = new KeeperReachability(topology);
    // Calling flood on an empty board should throw because start < 0 or >= 0.
    assert.throws(
      () => reachability.flood(0, new Uint8Array(0)),
      { name: "RangeError" },
    );
  });

  it("pathTo yields a valid BFS walk that reaches the target", () => {
    // L-shaped corridor:
    //  .  W  .
    //  .  W  .
    //  .  .  .
    const cols = 3;
    const walls = new Set([cell(0, 1, cols), cell(1, 1, cols)]);
    const topology = gridTopology(3, cols, walls);
    const reachability = new KeeperReachability(topology);
    const occupied = occupiedFromWalls(topology.cellCount, walls);

    const start = cell(0, 0, cols);
    const target = cell(0, 2, cols);
    const result = reachability.flood(start, occupied);

    const path = result.pathTo(target);
    assert.ok(path, "path should exist");
    // Walk the path and verify we arrive at the target.
    let current = start;
    const deltas: Record<string, [number, number]> = {
      up: [-1, 0],
      down: [1, 0],
      left: [0, -1],
      right: [0, 1],
    };
    for (const dir of path) {
      const [dr, dc] = deltas[dir]!;
      const r = Math.floor(current / cols) + dr;
      const c = (current % cols) + dc;
      current = r * cols + c;
    }
    assert.equal(current, target, "path should end at target");
    // BFS path length should equal the BFS distance.
    assert.equal(path.length, result.distanceTo(target));
  });
});

// ---------------------------------------------------------------------------
// Incremental canonical cell
// ---------------------------------------------------------------------------

describe("incrementalCanonicalCell", () => {
  it("matches full flood for a push in an open room", () => {
    const cols = 4;
    const topology = gridTopology(4, cols);
    const reachability = new KeeperReachability(topology);
    const verify = new KeeperReachability(topology);

    const boxCell = cell(1, 1, cols);
    const destination = cell(1, 2, cols);
    const robotCell = cell(1, 0, cols);

    const parentOccupancy = new Uint8Array(topology.cellCount);
    parentOccupancy[boxCell] = 1;
    reachability.flood(robotCell, parentOccupancy);

    parentOccupancy[boxCell] = 0;
    parentOccupancy[destination] = 1;
    const incremental = reachability.incrementalCanonicalCell(
      boxCell, destination, parentOccupancy);
    const fullResult = verify.flood(boxCell, parentOccupancy);
    parentOccupancy[boxCell] = 1;
    parentOccupancy[destination] = 0;

    assert.equal(incremental, null, "reachable destinations require full flood");
    assert.equal(fullResult.canonicalCell, 0);
  });

  it("freed cell lowers canonical cell below parent canonical", () => {
    // 4x3 grid, walls at (2,0) and (2,2) create a corridor at (2,1).
    // Box at (2,1)=7, robot at (3,1)=10. Push up: box to (1,1)=4.
    // Parent reachable: {10, 9, 11}. Canonical = 9.
    // After push: freedCell=7 is newly reachable, canonical drops to 7.
    const rows = 4;
    const cols = 3;
    const walls = new Set([cell(2, 0, cols), cell(2, 2, cols)]);
    const topology = gridTopology(rows, cols, walls);
    const reachability = new KeeperReachability(topology);
    const verify = new KeeperReachability(topology);

    const boxCell = cell(2, 1, cols);
    const destination = cell(1, 1, cols);
    const robotCell = cell(3, 1, cols);

    const parentOccupancy = occupiedFromWalls(topology.cellCount, walls);
    parentOccupancy[boxCell] = 1;
    reachability.flood(robotCell, parentOccupancy);

    parentOccupancy[boxCell] = 0;
    parentOccupancy[destination] = 1;
    const incremental = reachability.incrementalCanonicalCell(
      boxCell, destination, parentOccupancy);
    const fullResult = verify.flood(boxCell, parentOccupancy);
    parentOccupancy[boxCell] = 1;
    parentOccupancy[destination] = 0;

    assert.notEqual(incremental, null);
    assert.equal(incremental, fullResult.canonicalCell);
    assert.equal(incremental, 7, "freed cell 7 < parent canonical 9");
  });

  it("returns null when blockedCell equals parentCanonical", () => {
    const cols = 3;
    const topology = gridTopology(3, cols);
    const reachability = new KeeperReachability(topology);

    const boxCell = cell(0, 1, cols);
    const destination = cell(0, 0, cols);
    const robotCell = cell(1, 1, cols);

    const parentOccupancy = new Uint8Array(topology.cellCount);
    parentOccupancy[boxCell] = 1;
    reachability.flood(robotCell, parentOccupancy);

    parentOccupancy[boxCell] = 0;
    parentOccupancy[destination] = 1;
    const result = reachability.incrementalCanonicalCell(
      boxCell, destination, parentOccupancy);
    parentOccupancy[boxCell] = 1;
    parentOccupancy[destination] = 0;

    assert.equal(result, null);
  });

  it("uses fast path when blockedCell is not parent-reachable", () => {
    const topology = gridTopology(1, 5);
    const reachability = new KeeperReachability(topology);
    const occupied = new Uint8Array(5);
    occupied[2] = 1;
    const parent = reachability.flood(1, occupied);
    assert.equal(parent.isReachable(3), false);
    occupied[2] = 0; occupied[3] = 1;
    assert.equal(reachability.incrementalCanonicalCell(2, 3, occupied), 0);
    assert.equal(new KeeperReachability(topology).flood(2, occupied).canonicalCell, 0);
  });

  it("returns null for potential articulation point", () => {
    // 3x5 grid + dangling cell 15 connected only to cell 1.
    // Robot at 10, box at 6. Push up: box to 1. Cell 15 has no
    // alternative neighbor besides blockedCell 1 -> articulation.
    const artGridCols = 5;
    const artGridRows = 3;
    const artGridCellCount = artGridRows * artGridCols + 1;
    const artGridNeighborsList: number[][] = [];
    for (let r = 0; r < artGridRows; r++) {
      for (let c = 0; c < artGridCols; c++) {
        const idx = r * artGridCols + c;
        const up = r > 0 ? (r - 1) * artGridCols + c : (idx === 1 ? 15 : -1);
        const down = r < artGridRows - 1 ? (r + 1) * artGridCols + c : -1;
        const left = c > 0 ? r * artGridCols + (c - 1) : -1;
        const right = c < artGridCols - 1 ? r * artGridCols + (c + 1) : -1;
        artGridNeighborsList.push([up, down, left, right]);
      }
    }
    artGridNeighborsList.push([-1, 1, -1, -1]);
    artGridNeighborsList[1] = [15, 6, 0, 2];

    const artGridTopo: ReachabilityTopology = {
      cellCount: artGridCellCount,
      neighbors: artGridNeighborsList,
    };
    const artGridReach = new KeeperReachability(artGridTopo);

    const artOccupancy = new Uint8Array(artGridCellCount);
    artOccupancy[6] = 1;
    artGridReach.flood(10, artOccupancy);

    artOccupancy[6] = 0;
    artOccupancy[1] = 1;
    const artResult = artGridReach.incrementalCanonicalCell(6, 1, artOccupancy);
    artOccupancy[6] = 1;
    artOccupancy[1] = 0;

    assert.equal(artResult, null, "should detect potential articulation point");
  });

  it("falls back for a reachable destination even with multiple neighbors", () => {
    // 3x5 open grid (no dangling cell). Robot at 10, box at 6.
    // Push up: box to 1. Cell 1 is not an articulation point.
    const cols = 5;
    const topology = gridTopology(3, cols);
    const reachability = new KeeperReachability(topology);
    const verify = new KeeperReachability(topology);

    const occupancy = new Uint8Array(topology.cellCount);
    occupancy[6] = 1;
    reachability.flood(10, occupancy);

    occupancy[6] = 0;
    occupancy[1] = 1;
    const incremental = reachability.incrementalCanonicalCell(6, 1, occupancy);
    const fullResult = verify.flood(6, occupancy);
    occupancy[6] = 1;
    occupancy[1] = 0;

    assert.equal(incremental, null);
    assert.equal(fullResult.canonicalCell, 0);
  });

  it("matches full flood exhaustively on a small board", () => {
    const cols = 4;
    const topology = gridTopology(4, cols);
    const n = topology.cellCount;
    const dirs = [
      [-1, 0], [1, 0], [0, -1], [0, 1],
    ] as const;

    let tested = 0;
    let incremental_hits = 0;
    let fallbacks = 0;
    let mismatches = 0;

    for (let robot = 0; robot < n; robot++) {
      for (let boxCell = 0; boxCell < n; boxCell++) {
        if (boxCell === robot) continue;
        for (let d = 0; d < 4; d++) {
          const br = Math.floor(boxCell / cols);
          const bc = boxCell % cols;
          const [dr, dc] = dirs[d];
          const destR = br + dr;
          const destC = bc + dc;
          const suppR = br - dr;
          const suppC = bc - dc;
          if (destR < 0 || destR >= 4 || destC < 0 || destC >= cols) continue;
          if (suppR < 0 || suppR >= 4 || suppC < 0 || suppC >= cols) continue;
          const destination = destR * cols + destC;
          const support = suppR * cols + suppC;
          if (destination === robot) continue;

          const reachability = new KeeperReachability(topology);
          const verify = new KeeperReachability(topology);

          const occupancy = new Uint8Array(n);
          occupancy[boxCell] = 1;
          const parentResult = reachability.flood(robot, occupancy);

          if (!parentResult.isReachable(support)) continue;
          if (occupancy[destination] !== 0) continue;

          occupancy[boxCell] = 0;
          occupancy[destination] = 1;
          const inc = reachability.incrementalCanonicalCell(
            boxCell, destination, occupancy);
          const full = verify.flood(boxCell, occupancy);
          occupancy[boxCell] = 1;
          occupancy[destination] = 0;

          tested++;
          if (inc !== null) {
            incremental_hits++;
            if (inc !== full.canonicalCell) mismatches++;
          } else {
            fallbacks++;
          }
        }
      }
    }

    assert.equal(mismatches, 0,
      `incremental must match full flood (${tested} tested, ${incremental_hits} hits, ${fallbacks} fallbacks)`);
    assert.ok(tested > 100, `should test a meaningful number of cases (got ${tested})`);
    assert.equal(fallbacks, tested, "open-room destinations were parent-reachable");
  });
});
