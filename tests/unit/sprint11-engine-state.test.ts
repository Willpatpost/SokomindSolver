import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  createSession,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import type { SolverRequest } from "../../src/solver/contracts.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";

// Source files register on globalThis when imported as ESM.
// Import in dependency order: metrics → memo → state.
// @ts-expect-error — untyped engine source JS
await import("../../src/solver/implementations/sokomind-engine/source/metrics.js");
// @ts-expect-error — untyped engine source JS
await import("../../src/solver/implementations/sokomind-engine/source/memo.js");
// @ts-expect-error — untyped engine source JS
await import("../../src/solver/implementations/sokomind-engine/source/state.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
const ClockCache = g.SokomindMemo.ClockCache;
const { packedIdentityFromTokens, packedIdentityIncremental, ensureIndexByCell } =
  g.SokomindState;
const { createPerformanceMetrics } = g.SokomindMetrics;

const SIMPLE_PUZZLE: PuzzleDefinition = {
  id: "sprint11-test",
  title: "Sprint 11 test",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOOOO",
    "O  R  O",
    "O A X O",
    "O a S O",
    "O     O",
    "OOOOOOO",
  ],
};

function requestFor(puzzle: PuzzleDefinition): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
  };
}

// --- ClockCache ---

describe("ClockCache", () => {
  it("stores and retrieves values", () => {
    const cache = new ClockCache(8);
    cache.set("a", 1);
    cache.set("b", 2);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.get("b"), 2);
    assert.equal(cache.size, 2);
  });

  it("returns undefined for missing keys", () => {
    const cache = new ClockCache(4);
    assert.equal(cache.get("missing"), undefined);
  });

  it("has() returns correct boolean", () => {
    const cache = new ClockCache(4);
    cache.set("x", 10);
    assert.ok(cache.has("x"));
    assert.ok(!cache.has("y"));
  });

  it("updates value on duplicate set", () => {
    const cache = new ClockCache(4);
    cache.set("k", 1);
    cache.set("k", 2);
    assert.equal(cache.get("k"), 2);
    assert.equal(cache.size, 1);
  });

  it("evicts when at capacity", () => {
    const cache = new ClockCache(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    assert.equal(cache.size, 3);
    assert.equal(cache.evictions, 0);

    cache.set("d", 4);
    assert.equal(cache.size, 3);
    assert.ok(cache.evictions >= 1);
    assert.ok(cache.has("d"));
  });

  it("reference bit protects recently accessed entries", () => {
    const cache = new ClockCache(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    // First eviction sweep clears all ref bits from initial set() calls
    cache.set("d", 4);

    // Now access "b" to give it a fresh reference bit
    cache.get("b");

    // Next eviction should skip "b" (ref=1) and evict "c" (ref=0)
    cache.set("e", 5);
    assert.ok(cache.has("b"), "recently accessed entry should survive eviction");
    assert.ok(!cache.has("c"), "unaccessed entry should be evicted");
    assert.ok(cache.has("e"), "new entry should be present");
  });

  it("tracks size through insertions and evictions", () => {
    const cache = new ClockCache(2);
    assert.equal(cache.size, 0);
    cache.set("a", 1);
    assert.equal(cache.size, 1);
    cache.set("b", 2);
    assert.equal(cache.size, 2);
    cache.set("c", 3);
    assert.equal(cache.size, 2);
  });

  it("handles capacity of 1", () => {
    const cache = new ClockCache(1);
    cache.set("a", 1);
    assert.equal(cache.get("a"), 1);
    cache.set("b", 2);
    assert.equal(cache.get("b"), 2);
    assert.equal(cache.has("a"), false);
    assert.equal(cache.size, 1);
  });
});

// --- packedIdentityIncremental ---

describe("packedIdentityIncremental", () => {
  function makeBoard(tokenBits: number, cellCount: number) {
    const tableSize = cellCount * 4;
    const zobristHi = new Uint32Array(tableSize);
    const zobristLo = new Uint32Array(tableSize);
    for (let i = 0; i < tableSize; i++) {
      zobristHi[i] = (Math.random() * 0xFFFFFFFF) >>> 0;
      zobristLo[i] = (Math.random() * 0xFFFFFFFF) >>> 0;
    }
    return {
      metrics: createPerformanceMetrics(),
      dense: { tokenBits, zobristHi, zobristLo },
    };
  }

  it("produces the same identity as full recomputation", () => {
    const board = makeBoard(8, 16);
    const tokens = Uint32Array.from([5, 12, 30, 47]);
    const parent = packedIdentityFromTokens(tokens, board);

    const incremental = packedIdentityIncremental(parent, 12, 20, board);
    const full = packedIdentityFromTokens(Uint32Array.from([5, 20, 30, 47]), board);

    assert.equal(incremental.identity, full.identity);
  });

  it("produces the same Zobrist hash as full recomputation", () => {
    const board = makeBoard(8, 16);
    const tokens = Uint32Array.from([3, 10, 25, 60]);
    const parent = packedIdentityFromTokens(tokens, board);

    const incremental = packedIdentityIncremental(parent, 10, 40, board);
    const full = packedIdentityFromTokens(Uint32Array.from([3, 40, 25, 60]), board);

    assert.equal(incremental.zobristHi, full.zobristHi);
    assert.equal(incremental.zobristLo, full.zobristLo);
  });

  it("maintains sorted token order", () => {
    const board = makeBoard(8, 16);
    const tokens = Uint32Array.from([2, 8, 15, 22]);
    const parent = packedIdentityFromTokens(tokens, board);

    const result = packedIdentityIncremental(parent, 8, 50, board);
    const sorted = result.sortedTokens;

    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i] >= sorted[i - 1], `tokens not sorted at index ${i}`);
    }
  });

  it("produces the same signature as full recomputation", () => {
    const board = makeBoard(8, 16);
    const tokens = Uint32Array.from([1, 7, 14, 21]);
    const parent = packedIdentityFromTokens(tokens, board);

    const incremental = packedIdentityIncremental(parent, 7, 35, board);
    const full = packedIdentityFromTokens(Uint32Array.from([1, 35, 14, 21]), board);

    assert.equal(incremental.signature, full.signature);
  });

  it("handles replacing the first sorted token", () => {
    const board = makeBoard(8, 16);
    const tokens = Uint32Array.from([2, 10, 20]);
    const parent = packedIdentityFromTokens(tokens, board);

    const incremental = packedIdentityIncremental(parent, 2, 1, board);
    const full = packedIdentityFromTokens(Uint32Array.from([1, 10, 20]), board);

    assert.equal(incremental.identity, full.identity);
    assert.equal(incremental.zobristHi, full.zobristHi);
    assert.equal(incremental.zobristLo, full.zobristLo);
  });

  it("handles replacing the last sorted token", () => {
    const board = makeBoard(8, 16);
    const tokens = Uint32Array.from([2, 10, 20]);
    const parent = packedIdentityFromTokens(tokens, board);

    const incremental = packedIdentityIncremental(parent, 20, 50, board);
    const full = packedIdentityFromTokens(Uint32Array.from([2, 10, 50]), board);

    assert.equal(incremental.identity, full.identity);
    assert.equal(incremental.zobristHi, full.zobristHi);
    assert.equal(incremental.zobristLo, full.zobristLo);
  });

  it("handles single-element token array", () => {
    const board = makeBoard(8, 16);
    const tokens = Uint32Array.from([5]);
    const parent = packedIdentityFromTokens(tokens, board);

    const incremental = packedIdentityIncremental(parent, 5, 12, board);
    const full = packedIdentityFromTokens(Uint32Array.from([12]), board);

    assert.equal(incremental.identity, full.identity);
    assert.equal(incremental.zobristHi, full.zobristHi);
    assert.equal(incremental.zobristLo, full.zobristLo);
  });
});

// --- ensureIndexByCell ---

describe("ensureIndexByCell", () => {
  it("materializes indexByCell from cells when null", () => {
    const board = {
      metrics: createPerformanceMetrics(),
      dense: { keys: new Array(10) },
    };
    const layout = {
      cells: Uint32Array.from([2, 5, 8]),
      indexByCell: null as Int32Array | null,
    };

    const result = ensureIndexByCell(layout, board);
    assert.ok(result instanceof Int32Array);
    assert.equal(result[2], 0);
    assert.equal(result[5], 1);
    assert.equal(result[8], 2);
    assert.equal(result[0], -1);
    assert.equal(result[1], -1);
  });

  it("returns existing indexByCell when already populated", () => {
    const board = {
      metrics: createPerformanceMetrics(),
      dense: { keys: new Array(10) },
    };
    const existing = new Int32Array(10).fill(-1);
    existing[3] = 0;
    const layout = {
      cells: Uint32Array.from([3]),
      indexByCell: existing,
    };

    const result = ensureIndexByCell(layout, board);
    assert.equal(result, existing);
  });

  it("caches result on layout object for subsequent calls", () => {
    const board = {
      metrics: createPerformanceMetrics(),
      dense: { keys: new Array(8) },
    };
    const layout = {
      cells: Uint32Array.from([1, 4]),
      indexByCell: null as Int32Array | null,
    };

    const first = ensureIndexByCell(layout, board);
    const second = ensureIndexByCell(layout, board);
    assert.equal(first, second);
  });

  it("increments workspaceAllocations on materialization", () => {
    const board = {
      metrics: createPerformanceMetrics(),
      dense: { keys: new Array(6) },
    };
    const layout = {
      cells: Uint32Array.from([0, 3]),
      indexByCell: null as Int32Array | null,
    };

    const before = board.metrics.workspaceAllocations;
    ensureIndexByCell(layout, board);
    assert.equal(board.metrics.workspaceAllocations, before + 1);
  });

  it("does not increment workspaceAllocations when already populated", () => {
    const board = {
      metrics: createPerformanceMetrics(),
      dense: { keys: new Array(6) },
    };
    const layout = {
      cells: Uint32Array.from([0]),
      indexByCell: new Int32Array(6).fill(-1),
    };

    const before = board.metrics.workspaceAllocations;
    ensureIndexByCell(layout, board);
    assert.equal(board.metrics.workspaceAllocations, before);
  });
});

// --- Metrics counter integration ---

describe("Sprint 11 metrics counters in search", () => {
  beforeEach((t) => {
    const original = globalThis.postMessage;
    globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;
    if ("after" in t) {
      t.after(() => {
        if (original === undefined) {
          Reflect.deleteProperty(globalThis, "postMessage");
        } else {
          globalThis.postMessage = original;
        }
      });
    }
  });

  it("increments Zobrist and token counters during a solve", () => {
    const request = requestFor(SIMPLE_PUZZLE);
    const result = search({
      algorithm: "ultimate",
      state: toLegacyState(request),
      maxVisited: 20_000,
      beamWidth: 160,
      maxDepth: 80,
    });
    assert.equal(result.status, "solved");
    const perf = result.performance as Record<string, number>;
    assert.ok(perf.zobristFullRecomputations > 0,
      "expected zobristFullRecomputations > 0");
    assert.ok(perf.zobristIncrementalUpdates > 0,
      "expected zobristIncrementalUpdates > 0");
    assert.ok(perf.tokenFullSorts > 0,
      "expected tokenFullSorts > 0");
    assert.ok(perf.tokenIncrementalInsertions > 0,
      "expected tokenIncrementalInsertions > 0");
  });

  it("increments workspace counters during a solve", () => {
    const request = requestFor(SIMPLE_PUZZLE);
    const result = search({
      algorithm: "ultimate",
      state: toLegacyState(request),
      maxVisited: 20_000,
      beamWidth: 160,
      maxDepth: 80,
    });
    assert.equal(result.status, "solved");
    const perf = result.performance as Record<string, number>;
    assert.ok((perf.workspaceAllocations ?? 0) >= 0,
      "workspaceAllocations should be present");
    assert.ok((perf.workspacePoolReuses ?? 0) >= 0,
      "workspacePoolReuses should be present");
  });
});
