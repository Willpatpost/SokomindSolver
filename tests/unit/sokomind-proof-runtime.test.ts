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
): ProofStartPartition {
  const request = corridorRequest();
  const partitions = enumerateFirstPushPartitions(request);
  assert.equal(partitions.length, 1);
  const [partition] = partitions;
  assert.equal(partition.prefixCost, 2);
  return {
    type: "proof/start-partition",
    partitionId: partition.partitionId,
    request: buildPartitionRequest(request, partition),
    initialUpperBound,
    prefixCost: partition.prefixCost,
    prefixSteps: partition.prefixSteps,
    algorithm,
  };
}

function collectingRuntime() {
  const results: ProofResult[] = [];
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const handle = createProofWorkerRuntime((result) => {
    results.push(result);
    if (result.type === "proof/partition-complete" || result.type === "proof/error") {
      settle();
    }
  });
  return { handle, results, settled };
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

  it("ignores messages that are not proof commands", () => {
    const { handle, results } = collectingRuntime();
    handle({ type: "proof/unknown" });
    handle(null);
    assert.deepEqual(results, []);
  });
});
