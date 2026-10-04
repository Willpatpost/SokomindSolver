import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import type { SolverRequest } from "../../src/solver/contracts.ts";
import {
  buildPartitionRequest,
  enumerateFirstPushPartitions,
  type ProofResult,
  type ProofStartPartition,
} from "../../src/solver/implementations/sokomind-proof-protocol.ts";
import { createProofWorkerRuntime } from "../../src/solver/implementations/sokomind-proof-runtime.ts";
import { configureSearchScheduler } from "../../src/solver/search/scheduling.ts";

// One partition: walk right, push the box right. The inner search then needs
// one more push, so the full route costs 3 moves and 2 pushes.
function corridorRequest(): SolverRequest {
  const parsed = parsePuzzleRows([
    "OOOOOOO",
    "OR X SO",
    "OOOOOOO",
  ]);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "proof-runtime",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
  };
}

function startCommand(
  initialUpperBound: number,
  algorithm: ProofStartPartition["algorithm"],
  runId = 7,
): ProofStartPartition {
  const request = corridorRequest();
  const partitions = enumerateFirstPushPartitions(request);
  assert.equal(partitions.length, 1);
  const [partition] = partitions;
  assert.equal(partition.prefixCost, 2);
  return {
    type: "proof/start-partition",
    runId,
    partitionId: partition.partitionId,
    request: buildPartitionRequest(request, partition),
    initialUpperBound,
    prefixCost: partition.prefixCost,
    prefixSteps: partition.prefixSteps,
    algorithm,
  };
}

function collectingRuntime(options?: Parameters<typeof createProofWorkerRuntime>[1]) {
  const results: ProofResult[] = [];
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const idleWaiters: (() => void)[] = [];
  const handle = createProofWorkerRuntime((result) => {
    results.push(result);
    if (result.type === "proof/partition-complete" || result.type === "proof/error") {
      settle();
    }
    if (result.type === "proof/idle") {
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  }, options);
  /** Resolves at the first idle posted after the call. */
  const nextIdle = () => new Promise<void>((resolve) => idleWaiters.push(resolve));
  return { handle, results, settled, nextIdle };
}

function completion(results: readonly ProofResult[]) {
  const complete = results.find((result) => result.type === "proof/partition-complete");
  assert.ok(complete, `expected partition-complete, got ${JSON.stringify(results.map((r) => r.type))}`);
  return complete;
}

describe("createProofWorkerRuntime", () => {
  for (const algorithm of ["astar", "ida-star"] as const) {
    it(`prepends the partition prefix to a ${algorithm} route and closes the partition`, async () => {
      const { handle, results, settled } = collectingRuntime();
      handle(startCommand(100, algorithm));
      await settled;

      const found = results.find((result) => result.type === "proof/solution");
      assert.ok(found);
      assert.equal(found.solution.moves, 3);
      assert.equal(found.solution.pushes, 2);
      assert.equal(found.totalCost, 3);
      assert.equal(found.solution.steps[1]?.kind, "push");
      const complete = completion(results);
      assert.equal(complete.exhausted, true);
    });

    it(`closes a ${algorithm} partition at its exclusive upper bound plus the prefix`, async () => {
      const { handle, results, settled } = collectingRuntime();
      handle(startCommand(1, algorithm));
      await settled;

      assert.equal(results.some((result) => result.type === "proof/solution"), false);
      const complete = completion(results);
      assert.equal(complete.exhausted, true);
      assert.equal(complete.lowerBound, 3);
    });
  }

  it("reports a cancelled partition as not exhausted", async () => {
    const { handle, results, settled } = collectingRuntime();
    handle(startCommand(100, "astar"));
    handle({ type: "proof/cancel" });
    await settled;

    assert.equal(results.some((result) => result.type === "proof/solution"), false);
    assert.equal(completion(results).exhausted, false);
  });

  it("ignores an upper-bound update that does not exceed the prefix", async () => {
    const { handle, results, settled } = collectingRuntime();
    handle(startCommand(100, "astar"));
    handle({ type: "solver/update-upper-bound", moves: 2 });
    await settled;

    const found = results.find((result) => result.type === "proof/solution");
    assert.ok(found);
    assert.equal(found.solution.moves, 3);
    assert.equal(completion(results).exhausted, true);
  });

  for (const algorithm of ["astar", "ida-star"] as const) {
    it(`resends ${algorithm} progress through slow preparation and stops after the partition`, async () => {
      // Each yield takes 30 ms, so preparation alone outlasts several heartbeats.
      configureSearchScheduler(() => new Promise((resolve) => setTimeout(resolve, 30)));
      try {
        const { handle, results, nextIdle } = collectingRuntime({ heartbeatMs: 5 });
        const command = startCommand(100, algorithm);
        const idle = nextIdle();
        handle(command);
        await idle;

        const progress = results.filter((result) => result.type === "proof/progress");
        assert.ok(progress.length >= 3, `expected heartbeats, got ${progress.length} progress messages`);
        assert.ok(progress.every((message) => message.partitionId === command.partitionId));
        const bounds = progress.map((message) => message.lowerBound);
        assert.ok(bounds[0] >= command.prefixCost);
        assert.deepEqual(bounds, [...bounds].sort((a, b) => a - b));

        const posted = results.length;
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(results.length, posted);
        assert.deepEqual(
          results.slice(-2).map((result) => result.type),
          ["proof/partition-complete", "proof/idle"],
        );
      } finally {
        configureSearchScheduler();
      }
    });
  }

  it("echoes the run id and goes idle after the partition's last result", async () => {
    const { handle, results, nextIdle } = collectingRuntime();
    const command = startCommand(100, "astar", 11);
    const idle = nextIdle();
    handle(command);
    await idle;

    assert.ok(results.every((result) => result.runId === 11));
    assert.ok(results.every((result) => result.partitionId === command.partitionId));
    assert.deepEqual(
      results.slice(-2).map((result) => result.type),
      ["proof/partition-complete", "proof/idle"],
    );
    assert.equal(results.filter((result) => result.type === "proof/idle").length, 1);
  });

  it("rejects a start while a partition runs, then takes the next one once idle", async () => {
    const { handle, results, nextIdle } = collectingRuntime();
    const running = startCommand(100, "astar", 1);
    const overlapping = { ...startCommand(100, "astar", 2), partitionId: "overlap" };
    const firstIdle = nextIdle();
    handle(running);
    handle(overlapping);
    await firstIdle;

    const rejected = results.filter((result) => result.runId === 2);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].type, "proof/error");
    assert.equal(rejected[0].partitionId, "overlap");
    assert.equal(completion(results).exhausted, true);
    const idles = results.filter((result) => result.type === "proof/idle");
    assert.deepEqual(idles, [{ type: "proof/idle", runId: 1, partitionId: running.partitionId }]);

    // The same lane serves a later run once it has gone idle.
    const posted = results.length;
    const secondIdle = nextIdle();
    handle(startCommand(100, "astar", 3));
    await secondIdle;
    const later = results.slice(posted);
    assert.ok(later.every((result) => result.runId === 3));
    assert.equal(later.some((result) => result.type === "proof/error"), false);
    const found = later.find((result) => result.type === "proof/solution");
    assert.ok(found);
    assert.equal(found.solution.moves, 3);
  });

  for (const algorithm of ["astar", "ida-star"] as const) {
    it(`reuses the ${algorithm} tables of an earlier partition on the same board`, async () => {
      const { handle, results, nextIdle } = collectingRuntime();
      for (const runId of [1, 2]) {
        const idle = nextIdle();
        handle(startCommand(100, algorithm, runId));
        await idle;
      }

      const [first, second] = results.filter((result) => result.type === "proof/partition-complete");
      assert.ok(first && second);
      const counters = (complete: typeof first) => complete.metrics.counters ?? {};
      assert.equal(counters(first).preprocessingCacheMisses, 1);
      assert.equal(counters(second).preprocessingCacheHits, 1);
      assert.equal(counters(second).pdbBuildTimeMs, 0);
      assert.ok((counters(first).pdbTableEntries ?? 0) > 0);
      const searchCounters = (complete: typeof first) => Object.fromEntries(
        Object.entries(counters(complete)).filter(([key]) =>
          !key.endsWith("Ms") && !key.startsWith("preprocessingCache")),
      );
      assert.deepEqual(searchCounters(second), searchCounters(first));
      assert.equal(second.metrics.expandedStates, first.metrics.expandedStates);
      assert.equal(second.lowerBound, first.lowerBound);
    });
  }

  it("posts an error then idle when the partition cannot start", async () => {
    const { handle, results, nextIdle } = collectingRuntime();
    const command = startCommand(100, "astar", 5);
    const idle = nextIdle();
    handle({ ...command, request: { ...command.request, board: { rows: 0 } } });
    await idle;

    assert.deepEqual(results.map((result) => result.type), ["proof/error", "proof/idle"]);
    assert.ok(results.every((result) => result.runId === 5));
  });

  it("ignores messages that are not proof commands", () => {
    const { handle, results } = collectingRuntime();
    handle({ type: "proof/unknown" });
    handle(null);
    assert.deepEqual(results, []);
  });
});
