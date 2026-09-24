import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import { SolverCancelledError } from "../../src/solver/cancellation.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import { buildPatternDatabaseAsync } from "../../src/solver/search/pattern-database.ts";
import { AssignmentHeuristic } from "../../src/solver/search/heuristic.ts";
import { PdbHeuristicEvaluator } from "../../src/solver/search/pdb-heuristic.ts";
import { ExactPreprocessingLimitError } from "../../src/solver/search/preprocessing-budget.ts";
import { configureSearchScheduler } from "../../src/solver/search/scheduling.ts";
import { ALL_OFF_EXACT_SEARCH_FEATURES } from "../../src/solver/search/exact-search-features.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import type { SolverRequest } from "../../src/solver/contracts.ts";

function corridorFixture(cellCount: number) {
  const base = compileSearchBoard(parsePuzzleRows(["OOOOOO", "OR XSO", "OOOOOO"]));
  const board = {
    ...base,
    cellCount,
    neighbors: Array.from({ length: cellCount }, (_, i) =>
      Int32Array.from([-1, -1, i > 0 ? i - 1 : -1, i < cellCount - 1 ? i + 1 : -1])),
    positions: Array.from({ length: cellCount }, (_, column) => ({ row: 0, column })),
  };
  const goalCells = [cellCount - 2];
  const regionCells = Array.from({ length: cellCount }, (_, i) => i);
  return { board, config: { goalCells, regionCells, labelIds: ["X"] } };
}

describe("PDB resource budgets", () => {
  it("rejects insufficient memory before allocating the distance table", async () => {
    const { board, config } = corridorFixture(100);
    const signal = new AbortController().signal;
    const original = globalThis.Uint16Array;
    let allocations = 0;
    globalThis.Uint16Array = new Proxy(original, {
      construct(target, args) {
        allocations++;
        return Reflect.construct(target, args);
      },
    });
    try {
      await assert.rejects(buildPatternDatabaseAsync(board, config, signal, {
        signal, now: () => 0, deadline: Infinity, baseMemoryBytes: 0,
        // Metadata fits (3080 bytes), but adding the table does not (3280 bytes).
        maxMemoryBytes: 3100,
      }), (error: unknown) => error instanceof ExactPreprocessingLimitError && error.reason === "memory");
      assert.equal(allocations, 0);
    } finally {
      globalThis.Uint16Array = original;
    }
  });

  it("yields cumulatively and observes cancellation across narrow BFS levels", async () => {
    const { board, config } = corridorFixture(4200);
    const controller = new AbortController();
    let yields = 0;
    configureSearchScheduler(async () => {
      yields++;
      controller.abort("cancel preprocessing");
    });
    try {
      await assert.rejects(buildPatternDatabaseAsync(board, config, controller.signal), SolverCancelledError);
      assert.equal(yields, 1);
    } finally {
      configureSearchScheduler();
    }
  });

  it("budgets live queue chunks rather than all previously processed ranks", async () => {
    const { board, config } = corridorFixture(9000);
    const signal = new AbortController().signal;
    const pdb = await buildPatternDatabaseAsync(board, config, signal, {
      signal, now: () => 0, deadline: Infinity, baseMemoryBytes: 0,
      // Fits metadata, distance table, scratch and one live 4096-rank chunk.
      // Retaining/counting all processed ranks would exceed this allowance.
      maxMemoryBytes: 296_000,
    });
    assert.equal(pdb.lookup([1]), 8997);
  });

  it("bounds missing entries by the BFS frontier after a build deadline", async () => {
    const { board, config } = corridorFixture(1000);
    const signal = new AbortController().signal;
    let checks = 0;
    const pdb = await buildPatternDatabaseAsync(board, config, signal, {
      signal, now: () => ++checks <= 6 ? 0 : 10, deadline: 10, baseMemoryBytes: 0,
    });
    const goal = config.goalCells[0];
    assert.equal(pdb.lookup(config.goalCells), 0);
    assert.equal(pdb.lookup([goal - 5]), 5);
    // The deadline hits after depth 255 was dequeued, so depth 256 is the
    // deepest stored entry and every missing entry needs at least 256 pushes.
    // Missing entries used to read UNSOLVED, which a subset minimum skips.
    assert.equal(pdb.lookup([goal - 256]), 256);
    assert.equal(pdb.lookup([goal - 257]), 256);
    assert.equal(pdb.lookup([1]), 256);
    const evaluator = new PdbHeuristicEvaluator([
      { ...config, labels: ["X"] },
    ], [pdb]);
    assert.equal(evaluator.evaluate([{ id: "X:0", label: "X", cell: 1 }]), 256);
  });
});

describe("PDB surplus cache memory", () => {
  function fixture() {
    const parsed = parsePuzzleRows(["OOOOOOO", "OR XX O", "O  SS O", "O     O", "OOOOOOO"]);
    const board = compileSearchBoard(parsed);
    return { evaluator: new PdbHeuristicEvaluator(board), boxes: toDenseBoxes(board, parsed.initialBoxes) };
  }

  it("includes cache growth in retained bytes and avoids charging cache hits twice", () => {
    const { evaluator, boxes } = fixture();
    const before = evaluator.estimatedRetainedBytes;
    const costs = new Map([["X", 0]]);
    const value = evaluator.evaluateWithSurplus(boxes, costs, 1n, 1n);
    assert.ok(evaluator.searchCacheRetainedBytes > 0);
    assert.equal(evaluator.estimatedRetainedBytes, before + evaluator.searchCacheRetainedBytes);
    const after = evaluator.estimatedRetainedBytes;
    assert.equal(evaluator.evaluateWithSurplus(boxes, costs, 1n, 1n), value);
    assert.equal(evaluator.estimatedRetainedBytes, after);
    assert.equal(evaluator.surplusCacheStats.hits, 1);
  });

  it("skips optional cache allocation when the run has no spare memory", () => {
    const { evaluator, boxes } = fixture();
    const costs = new Map([["X", 0]]);
    const uncached = evaluator.evaluateWithSurplus(boxes, costs);
    const before = evaluator.estimatedRetainedBytes;
    evaluator.setSearchCacheMemoryBudget(() => false);
    assert.equal(evaluator.evaluateWithSurplus(boxes, costs, 2n, 2n), uncached);
    assert.equal(evaluator.surplusCacheStats.size, 0);
    assert.equal(evaluator.estimatedRetainedBytes, before);
  });

  it("uses the cache only for label costs of the same box key", () => {
    const parsed = parsePuzzleRows(["OOOOOOO", "O     O", "O XX  O", "O SS  O", "O   R O", "OOOOOOO"]);
    const board = compileSearchBoard(parsed);
    const boxesA = toDenseBoxes(board, parsed.initialBoxes);
    const boxesB = boxesA.map((box, index) => index === 0 ? { ...box, cell: board.cellAt(3, 2) } : box);
    const heuristic = new AssignmentHeuristic(board);
    heuristic.evaluate(boxesA);
    const costsA = heuristic.lastLabelCosts!;
    heuristic.evaluate(boxesB);
    const costsB = heuristic.lastLabelCosts!;
    const evaluator = new PdbHeuristicEvaluator(board);
    const keyA = 1n;
    const keyB = 2n;
    assert.equal(evaluator.evaluateWithSurplus(boxesA, costsA, keyA, keyA), 0);
    // B's assignment costs one push less than A's PDB value.
    assert.equal(evaluator.evaluateWithSurplus(boxesA, costsB, keyA, keyB), 1);
    assert.equal(evaluator.surplusCacheStats.hits, 0);
    assert.equal(evaluator.evaluateWithSurplus(boxesA, costsA, keyA, keyA), 0);
    assert.equal(evaluator.surplusCacheStats.hits, 1);

    // Without the label-cost key the value is neither read nor stored.
    evaluator.evaluateWithSurplus(boxesA, costsA, keyB);
    evaluator.evaluateWithSurplus(boxesA, costsA, keyB, keyB);
    assert.equal(evaluator.surplusCacheStats.hits, 1);
    assert.equal(evaluator.surplusCacheStats.size, 2);
  });

  for (const [name, run] of [["A*", runExactMoveAStar], ["IDA*", runIdaStarSearch]] as const) {
    it(`includes live cache bytes in ${name}'s run memory estimate`, async () => {
      const board = parsePuzzleRows(["OOOOOOO", "OS   SO", "O X X O", "O  R  O", "OOOOOOO"]);
      const request: SolverRequest = {
        board,
        snapshot: {
          puzzleId: "pdb-memory", robot: board.initialRobot, boxes: board.initialBoxes,
          moves: 0, pushes: 0, solved: false,
        },
        objective: { kind: "moves" },
      };
      const context = { signal: new AbortController().signal, now: () => performance.now(), reportProgress() {} };
      const options = { features: { ...ALL_OFF_EXACT_SEARCH_FEATURES, patternDatabase: true } };
      const uncachedEvaluator = PdbHeuristicEvaluator.prototype.evaluateWithSurplus;
      PdbHeuristicEvaluator.prototype.evaluateWithSurplus = function (boxes, costs) {
        return uncachedEvaluator.call(this, boxes, costs);
      };
      let uncached;
      try {
        uncached = await run(request, context, options);
      } finally {
        PdbHeuristicEvaluator.prototype.evaluateWithSurplus = uncachedEvaluator;
      }
      const cached = await run(request, context, options);
      assert.equal(uncached.status, "solved");
      assert.equal(cached.status, "solved");
      const uncachedCounters = uncached.metrics.counters!;
      const cachedCounters = cached.metrics.counters!;
      assert.ok(cachedCounters.pdbSearchCacheRetainedBytes > 0);
      assert.equal(
        cachedCounters.estimatedMemoryBytes - uncachedCounters.estimatedMemoryBytes,
        cachedCounters.pdbSearchCacheRetainedBytes,
      );
    });
  }
});
