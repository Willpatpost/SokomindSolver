import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createCompactNodeArena,
} from "../../src/solver/search/compact-node-arena.ts";
import { NumericPriorityQueue } from "../../src/solver/search/numeric-priority-queue.ts";
import {
  estimateArenaNodeBytes,
  estimatedArenaMemoryBytes,
} from "../../src/solver/search/exact-search-types.ts";

// ---------------------------------------------------------------------------
// 1. CompactNodeArena
// ---------------------------------------------------------------------------

describe("CompactNodeArena", () => {
  it("round-trips all scalar fields", () => {
    const arena = createCompactNodeArena(3);
    const idx = arena.allocate();

    arena.setRobotCell(idx, 42);
    arena.setGMoves(idx, 1234);
    arena.setPushes(idx, 7);
    arena.setParentNode(idx, -1);
    arena.setPushedFromCell(idx, 99);
    arena.setPushDirection(idx, 2);
    arena.setHeuristic(idx, 55);

    assert.equal(arena.robotCell(idx), 42);
    assert.equal(arena.gMoves(idx), 1234);
    assert.equal(arena.pushes(idx), 7);
    assert.equal(arena.parentNode(idx), -1);
    assert.equal(arena.pushedFromCell(idx), 99);
    assert.equal(arena.pushDirection(idx), 2);
    assert.equal(arena.heuristic(idx), 55);
  });

  it("round-trips box tokens", () => {
    const arena = createCompactNodeArena(4);
    const idx = arena.allocate();
    const tokens = new Uint32Array([10, 20, 30, 40]);
    arena.writeBoxTokens(idx, tokens);

    const out = new Uint32Array(4);
    arena.readBoxTokens(idx, out);
    assert.deepStrictEqual([...out], [10, 20, 30, 40]);
  });

  it("boxTokenAt reads individual tokens", () => {
    const arena = createCompactNodeArena(3);
    const idx = arena.allocate();
    const tokens = new Uint32Array([5, 15, 25]);
    arena.writeBoxTokens(idx, tokens);

    assert.equal(arena.boxTokenAt(idx, 0), 5);
    assert.equal(arena.boxTokenAt(idx, 1), 15);
    assert.equal(arena.boxTokenAt(idx, 2), 25);
  });

  it("handles multiple nodes independently", () => {
    const arena = createCompactNodeArena(2);
    const a = arena.allocate();
    const b = arena.allocate();

    arena.setRobotCell(a, 10);
    arena.setGMoves(a, 100);
    arena.writeBoxTokens(a, new Uint32Array([1, 2]));

    arena.setRobotCell(b, 20);
    arena.setGMoves(b, 200);
    arena.writeBoxTokens(b, new Uint32Array([3, 4]));

    assert.equal(arena.robotCell(a), 10);
    assert.equal(arena.gMoves(a), 100);
    assert.equal(arena.robotCell(b), 20);
    assert.equal(arena.gMoves(b), 200);

    const outA = new Uint32Array(2);
    const outB = new Uint32Array(2);
    arena.readBoxTokens(a, outA);
    arena.readBoxTokens(b, outB);
    assert.deepStrictEqual([...outA], [1, 2]);
    assert.deepStrictEqual([...outB], [3, 4]);
  });

  it("crosses chunk boundary correctly", () => {
    const arena = createCompactNodeArena(1);
    const count = 8193;
    for (let i = 0; i < count; i++) {
      const idx = arena.allocate();
      arena.setRobotCell(idx, i % 65536);
      arena.setGMoves(idx, i);
      arena.writeBoxTokens(idx, new Uint32Array([i % 60000]));
    }

    assert.equal(arena.size, count);

    assert.equal(arena.robotCell(0), 0);
    assert.equal(arena.gMoves(0), 0);
    assert.equal(arena.robotCell(8191), 8191);
    assert.equal(arena.gMoves(8191), 8191);
    assert.equal(arena.robotCell(8192), 8192);
    assert.equal(arena.gMoves(8192), 8192);
    assert.equal(arena.boxTokenAt(8192, 0), 8192 % 60000);
  });

  it("works with different box counts", () => {
    for (const boxCount of [1, 4, 8]) {
      const arena = createCompactNodeArena(boxCount);
      const idx = arena.allocate();
      const tokens = new Uint32Array(boxCount);
      for (let b = 0; b < boxCount; b++) tokens[b] = b * 10;
      arena.writeBoxTokens(idx, tokens);

      const out = new Uint32Array(boxCount);
      arena.readBoxTokens(idx, out);
      for (let b = 0; b < boxCount; b++) {
        assert.equal(out[b], b * 10);
      }
    }
  });

  it("estimatedRetainedBytes grows with allocations", () => {
    const arena = createCompactNodeArena(3);
    const before = arena.estimatedRetainedBytes();
    arena.allocate();
    arena.allocate();
    assert.ok(arena.estimatedRetainedBytes() >= before);
  });

  it("estimatedBytesPerNode matches spec for Uint16 tokens", () => {
    const arena = createCompactNodeArena(3);
    assert.equal(arena.estimatedBytesPerNode(), 17 + 3 * 2);
  });

  it("uses wide tokens when maxToken > 65535", () => {
    const arena = createCompactNodeArena(2, 70000);
    const idx = arena.allocate();
    arena.writeBoxTokens(idx, new Uint32Array([70000, 1234]));
    const out = new Uint32Array(2);
    arena.readBoxTokens(idx, out);
    assert.equal(out[0], 70000);
    assert.equal(out[1], 1234);
    assert.equal(arena.estimatedBytesPerNode(), 17 + 2 * 4);
  });

  it("parentNode supports negative values", () => {
    const arena = createCompactNodeArena(1);
    const idx = arena.allocate();
    arena.setParentNode(idx, -1);
    assert.equal(arena.parentNode(idx), -1);
  });
});

// ---------------------------------------------------------------------------
// 2. NumericPriorityQueue
// ---------------------------------------------------------------------------

describe("NumericPriorityQueue", () => {
  it("dequeues in priority order", () => {
    const pq = new NumericPriorityQueue((a, b) => a - b);
    pq.enqueue(30);
    pq.enqueue(10);
    pq.enqueue(20);
    assert.equal(pq.dequeue(), 10);
    assert.equal(pq.dequeue(), 20);
    assert.equal(pq.dequeue(), 30);
    assert.equal(pq.dequeue(), undefined);
  });

  it("stable FIFO tie-breaking among equal values", () => {
    const pq = new NumericPriorityQueue((a, b) => {
      return (a % 100) - (b % 100);
    });

    pq.enqueue(100);
    pq.enqueue(200);
    pq.enqueue(300);

    const results: number[] = [];
    results.push(pq.dequeue()!);
    results.push(pq.dequeue()!);
    results.push(pq.dequeue()!);

    assert.deepStrictEqual(results, [100, 200, 300]);
  });

  it("empty queue returns undefined", () => {
    const pq = new NumericPriorityQueue((a, b) => a - b);
    assert.equal(pq.dequeue(), undefined);
    assert.equal(pq.peek(), undefined);
    assert.equal(pq.size, 0);
    assert.equal(pq.empty, true);
  });

  it("peek returns minimum without removing", () => {
    const pq = new NumericPriorityQueue((a, b) => a - b);
    pq.enqueue(50);
    pq.enqueue(10);
    pq.enqueue(30);
    assert.equal(pq.peek(), 10);
    assert.equal(pq.size, 3);
    assert.equal(pq.dequeue(), 10);
    assert.equal(pq.peek(), 30);
  });

  it("handles capacity doubling (>1024 entries)", () => {
    const pq = new NumericPriorityQueue((a, b) => a - b);
    for (let i = 2000; i > 0; i--) {
      pq.enqueue(i);
    }
    assert.equal(pq.size, 2000);
    let prev = 0;
    while (!pq.empty) {
      const val = pq.dequeue()!;
      assert.ok(val > prev, `dequeued ${val} should be > ${prev}`);
      prev = val;
    }
  });

  it("clear resets size to 0", () => {
    const pq = new NumericPriorityQueue((a, b) => a - b);
    pq.enqueue(1);
    pq.enqueue(2);
    pq.clear();
    assert.equal(pq.size, 0);
    assert.equal(pq.empty, true);
    assert.equal(pq.dequeue(), undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. Memory estimation
// ---------------------------------------------------------------------------

describe("arena memory estimation", () => {
  it("estimateArenaNodeBytes matches arena estimatedBytesPerNode (narrow)", () => {
    for (const boxCount of [1, 3, 5, 8]) {
      const arena = createCompactNodeArena(boxCount);
      assert.equal(
        estimateArenaNodeBytes(boxCount),
        arena.estimatedBytesPerNode(),
        `mismatch for boxCount=${boxCount}`,
      );
    }
  });

  it("estimateArenaNodeBytes matches arena estimatedBytesPerNode (wide)", () => {
    for (const boxCount of [1, 3, 5]) {
      const arena = createCompactNodeArena(boxCount, 70000);
      assert.equal(
        estimateArenaNodeBytes(boxCount, 4),
        arena.estimatedBytesPerNode(),
        `wide mismatch for boxCount=${boxCount}`,
      );
    }
  });

  it("arena node bytes are ≤50% of legacy estimate", () => {
    const legacyEstimate = 448 + 3 * 80 + 64;
    const arenaEstimate = estimateArenaNodeBytes(3);
    assert.ok(
      arenaEstimate <= legacyEstimate * 0.5,
      `arena (${arenaEstimate}) must be ≤50% of legacy (${legacyEstimate})`,
    );
  });

  it("estimatedArenaMemoryBytes uses reduced frontier cost", () => {
    const result = estimatedArenaMemoryBytes(0, 0, 0, 1000, 0, 3);
    assert.equal(result, Math.ceil(1000 * 8));
  });
});

// ---------------------------------------------------------------------------
// 4. Integration: exact A* with arena produces correct results
// ---------------------------------------------------------------------------

import {
  parsePuzzleRows,
} from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";
import {
  runExactMoveAStar,
} from "../../src/solver/search/exact-move-astar.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

function oracleContext(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    now: () => performance.now(),
  };
}

function requestFromRows(rows: string[]): SolverRequest {
  const parsed = parsePuzzleRows(rows);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "arena-test",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
  };
}

const ONE_BOX = ["OOOOO", "ORXSO", "OOOOO"];
const TWO_BOX = [
  "OOOOOO",
  "OR   O",
  "O XX O",
  "O SS O",
  "OOOOOO",
];

describe("exact A* arena integration", () => {
  it("solves a 1-box puzzle optimally", async () => {
    const req = requestFromRows(ONE_BOX);
    const result = await runExactMoveAStar(req, oracleContext());
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.proof?.kind, "optimal");
    const v = verifySolverSolution(req, result.solution);
    assert.ok(v.valid, `solution must replay: ${!v.valid ? v.message : ""}`);

  });

  it("solves a 2-box puzzle optimally", async () => {
    const req = requestFromRows(TWO_BOX);
    const result = await runExactMoveAStar(req, oracleContext());
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.proof?.kind, "optimal");
    const v = verifySolverSolution(req, result.solution);
    assert.ok(v.valid, `solution must replay: ${!v.valid ? v.message : ""}`);

  });

  it("reconstruction replays correctly", async () => {
    const req = requestFromRows(TWO_BOX);
    const result = await runExactMoveAStar(req, oracleContext());
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.ok(result.solution.steps.length > 0);
    const v = verifySolverSolution(req, result.solution);
    assert.ok(v.valid);
  });
});
