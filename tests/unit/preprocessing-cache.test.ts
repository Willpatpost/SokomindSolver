import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import {
  buildPartitionRequest,
  enumerateFirstPushPartitions,
} from "../../src/solver/implementations/sokomind-proof-protocol.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { buildDeadlockTablesAsync } from "../../src/solver/search/deadlock-tables.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import {
  DEFAULT_EXACT_SEARCH_FEATURES,
  resolveExactSearchFeatures,
} from "../../src/solver/search/exact-search-features.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import { PdbHeuristicEvaluator } from "../../src/solver/search/pdb-heuristic.ts";
import {
  ExactPreprocessingCache,
  exactPreprocessingCacheKey,
} from "../../src/solver/search/preprocessing-cache.ts";

// Wall-adjacent regions, a pattern database and room tables all apply here.
const ROWS = [
  "OOOOOOOOOOO",
  "O    O    O",
  "O RX   XS O",
  "O XO O OX O",
  "OSSO   OS O",
  "OOOOOOOOOOO",
] as const;

function request(rows: readonly string[] = ROWS): SolverRequest {
  const board = parsePuzzleRows(rows);
  return {
    board,
    snapshot: {
      puzzleId: "preprocessing-cache",
      robot: board.initialRobot,
      boxes: board.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
    limits: {
      maxElapsedMs: 30_000,
      maxExpandedStates: 500_000,
      maxGeneratedStates: 5_000_000,
    },
  };
}

function context(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress() {},
    now: performance.now.bind(performance),
  };
}

const KERNELS = [
  ["astar", runExactMoveAStar],
  ["ida-star", runIdaStarSearch],
] as const;

// Wall-clock counters, and the counters that describe the cache itself.
const UNCOMPARED_COUNTERS = new Set([
  "firstExpansionMs",
  "pdbBuildTimeMs",
  "deadlockTableBuildTimeMs",
  "backwardPerimeterBuildTimeMs",
  "componentPdbBuildTimeMs",
  "moveCostPdbBuildTimeMs",
  "preprocessingCacheHits",
  "preprocessingCacheMisses",
  "preprocessingCacheRetainedBytes",
]);

function comparable(result: SolverResult) {
  const counters = Object.fromEntries(
    Object.entries(result.metrics.counters ?? {})
      .filter(([key]) => !UNCOMPARED_COUNTERS.has(key)),
  );
  return { ...result, metrics: { ...result.metrics, elapsedMs: 0, counters } };
}

function counter(result: SolverResult, key: string): number | undefined {
  return result.metrics.counters?.[key];
}

describe("exactPreprocessingCacheKey", () => {
  it("names the board, features, algorithm, box count and memory limit, not the snapshot", () => {
    const base = request();
    const key = exactPreprocessingCacheKey(base, "astar", DEFAULT_EXACT_SEARCH_FEATURES);
    const [partition] = enumerateFirstPushPartitions(base);
    assert.ok(partition);

    assert.equal(
      exactPreprocessingCacheKey(buildPartitionRequest(base, partition), "astar", DEFAULT_EXACT_SEARCH_FEATURES),
      key,
    );
    // The time limit only decides whether a build is cut short, and such
    // builds are never stored.
    assert.equal(
      exactPreprocessingCacheKey(
        { ...base, limits: { ...base.limits, maxElapsedMs: 5_000 } },
        "astar",
        DEFAULT_EXACT_SEARCH_FEATURES,
      ),
      key,
    );

    const otherWall = ROWS.map((row, index) => index === 3 ? "O XO   OX O" : row);
    const otherLabel = ROWS.map((row, index) =>
      index === 2 ? "O RA   XS O" : index === 4 ? "OaSO   OS O" : row);
    const variants = [
      exactPreprocessingCacheKey(base, "ida-star", DEFAULT_EXACT_SEARCH_FEATURES),
      exactPreprocessingCacheKey(base, "astar", resolveExactSearchFeatures({ patternDatabase: false })),
      exactPreprocessingCacheKey(
        { ...base, limits: { ...base.limits, maxMemoryBytes: 64 * 1024 * 1024 } },
        "astar",
        DEFAULT_EXACT_SEARCH_FEATURES,
      ),
      exactPreprocessingCacheKey(
        { ...base, snapshot: { ...base.snapshot, boxes: base.snapshot.boxes.slice(1) } },
        "astar",
        DEFAULT_EXACT_SEARCH_FEATURES,
      ),
      exactPreprocessingCacheKey(request(otherWall), "astar", DEFAULT_EXACT_SEARCH_FEATURES),
      exactPreprocessingCacheKey(request(otherLabel), "astar", DEFAULT_EXACT_SEARCH_FEATURES),
    ];
    for (const variant of variants) assert.notEqual(variant, key);
    assert.equal(new Set(variants).size, variants.length);
  });
});

describe("ExactPreprocessingCache", () => {
  const board = compileSearchBoard(parsePuzzleRows(ROWS));
  const signal = new AbortController().signal;

  it("stores work-capped and memory-limited builds, which depend only on the key", async () => {
    const workCapped = await buildDeadlockTablesAsync(board, signal, undefined, { maxWorkUnits: 1 });
    const memoryLimited = await buildDeadlockTablesAsync(board, signal, {
      signal, now: () => 0, deadline: Infinity, maxMemoryBytes: 1, baseMemoryBytes: 0,
    });
    const memoryDegradedPdb = await PdbHeuristicEvaluator.createAsync(board, signal, {
      signal, now: () => 0, deadline: Infinity, maxMemoryBytes: 1, baseMemoryBytes: 0,
    });
    assert.equal(workCapped.stats.truncatedBy, "work");
    assert.equal(memoryLimited.stats.truncatedBy, "memory");
    assert.ok(memoryDegradedPdb.memoryFallbackCount > 0);
    assert.equal(memoryDegradedPdb.deadlineLimited, false);

    const cache = new ExactPreprocessingCache();
    for (const deadlockTables of [workCapped, memoryLimited]) {
      const tables = { deadlockTables, roomTables: null, pdbEvaluator: memoryDegradedPdb };
      assert.equal(cache.store("key", tables), true);
      assert.equal(cache.lookup("key"), tables);
      assert.equal(
        cache.retainedBytes,
        deadlockTables.estimatedRetainedBytes + memoryDegradedPdb.preprocessingRetainedBytes,
      );
    }
  });

  it("refuses builds the deadline cut short and drops what it held", async () => {
    const pastDeadline = { signal, now: () => 1, deadline: 0, baseMemoryBytes: 0 };
    const complete = await buildDeadlockTablesAsync(board, signal);
    const elapsed = await buildDeadlockTablesAsync(board, signal, pastDeadline);
    const completePdb = await PdbHeuristicEvaluator.createAsync(board, signal);
    const droppedPdb = await PdbHeuristicEvaluator.createAsync(board, signal, pastDeadline);
    assert.equal(complete.stats.truncated, false);
    assert.equal(elapsed.stats.truncatedBy, "elapsed");
    assert.equal(completePdb.deadlineLimited, false);
    assert.ok(completePdb.partitionCount > 0);
    assert.equal(droppedPdb.deadlineLimited, true);
    assert.equal(droppedPdb.view().deadlineLimited, true);

    const cache = new ExactPreprocessingCache();
    const stored = { deadlockTables: complete, roomTables: null, pdbEvaluator: completePdb };
    for (const refused of [
      { ...stored, deadlockTables: elapsed },
      { ...stored, pdbEvaluator: droppedPdb },
    ]) {
      assert.equal(cache.store("key", stored), true);
      assert.equal(cache.store("key", refused), false);
      assert.equal(cache.lookup("key"), undefined);
      assert.equal(cache.retainedBytes, 0);
    }
  });

  it("evicts its entry on a lookup with another key", async () => {
    const cache = new ExactPreprocessingCache();
    const tables = {
      deadlockTables: await buildDeadlockTablesAsync(board, signal),
      roomTables: null,
      pdbEvaluator: null,
    };
    cache.store("a", tables);
    assert.ok(cache.retainedBytes > 0);
    assert.equal(cache.lookup("b"), undefined);
    assert.equal(cache.lookup("a"), undefined);
    assert.equal(cache.retainedBytes, 0);
  });
});

describe("exact kernels with a preprocessing cache", () => {
  for (const [algorithm, run] of KERNELS) {
    it(`gives identical ${algorithm} results uncached, on a miss and on a hit`, async () => {
      const uncached = await run(request(), context());
      const cache = new ExactPreprocessingCache();
      const miss = await run(request(), context(), { preprocessingCache: cache });
      const hit = await run(request(), context(), { preprocessingCache: cache });

      assert.equal(uncached.status, "solved");
      assert.deepEqual(comparable(miss), comparable(uncached));
      assert.deepEqual(comparable(hit), comparable(uncached));

      assert.equal(counter(uncached, "preprocessingCacheMisses"), 0);
      assert.equal(counter(uncached, "preprocessingCacheRetainedBytes"), 0);
      assert.equal(counter(miss, "preprocessingCacheMisses"), 1);
      assert.equal(counter(miss, "preprocessingCacheHits"), 0);
      assert.equal(counter(hit, "preprocessingCacheHits"), 1);
      assert.equal(counter(hit, "preprocessingCacheMisses"), 0);
      assert.equal(counter(hit, "pdbBuildTimeMs"), 0);
      assert.equal(counter(hit, "deadlockTableBuildTimeMs"), 0);

      assert.ok((counter(miss, "pdbTableEntries") ?? 0) > 0);
      assert.ok((counter(miss, "deadlockTableRegions") ?? 0) > 0);
      assert.equal(counter(miss, "interactionBoostApplicable"), 1);
      // Each run counts its own lookups through a fresh view of the tables.
      assert.ok((counter(hit, "pdbLookups") ?? 0) > 0);
      assert.equal(counter(hit, "pdbLookups"), counter(miss, "pdbLookups"));
      // The cache holds exactly the tables the run built.
      assert.equal(
        counter(miss, "preprocessingCacheRetainedBytes"),
        counter(miss, "preprocessingRetainedBytes"),
      );
      assert.equal(
        counter(hit, "preprocessingCacheRetainedBytes"),
        counter(miss, "preprocessingCacheRetainedBytes"),
      );
    });

    it(`reuses ${algorithm} tables for another snapshot of the same board`, async () => {
      const root = request();
      const [partition] = enumerateFirstPushPartitions(root);
      assert.ok(partition);
      const partitionRequest = buildPartitionRequest(root, partition);
      const cache = new ExactPreprocessingCache();
      await run(root, context(), { preprocessingCache: cache });
      const hit = await run(partitionRequest, context(), { preprocessingCache: cache });
      const uncached = await run(partitionRequest, context());

      assert.equal(counter(hit, "preprocessingCacheHits"), 1);
      assert.deepEqual(comparable(hit), comparable(uncached));
    });
  }

  it("rebuilds when the algorithm changes", async () => {
    const cache = new ExactPreprocessingCache();
    await runExactMoveAStar(request(), context(), { preprocessingCache: cache });
    const ida = await runIdaStarSearch(request(), context(), { preprocessingCache: cache });
    assert.equal(counter(ida, "preprocessingCacheMisses"), 1);
    assert.ok((counter(ida, "pdbTableEntries") ?? 0) > 0);
  });
});
