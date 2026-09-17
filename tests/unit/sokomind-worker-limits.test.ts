import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  effectiveProofWorkerCount,
  effectiveWorkerCount,
} from "../../src/solver/implementations/sokomind-worker-limits.ts";

const MIB = 1024 * 1024;

describe("Sokomind worker resource controls", () => {
  it("limits Auto by memory, logical processors, and the application cap", () => {
    assert.deepEqual(effectiveWorkerCount(768 * MIB, 16), { count: 2, limitedBy: "memory" });
    assert.deepEqual(effectiveWorkerCount(4_096 * MIB, 4), { count: 3, limitedBy: "hardware" });
    assert.deepEqual(effectiveWorkerCount(4_096 * MIB, 16), { count: 12, limitedBy: "cap" });
    assert.deepEqual(effectiveWorkerCount(Infinity, 1), { count: 1, limitedBy: "hardware" });
  });

  it("treats a manual selection as a ceiling without bypassing memory or hardware", () => {
    assert.deepEqual(effectiveWorkerCount(4_096 * MIB, 16, 4), { count: 4, limitedBy: "requested" });
    assert.deepEqual(effectiveWorkerCount(768 * MIB, 16, 8), { count: 2, limitedBy: "memory" });
    assert.deepEqual(effectiveWorkerCount(4_096 * MIB, 4, 8), { count: 3, limitedBy: "hardware" });
  });

  it("falls back to one lane for invalid hardware reports", () => {
    for (const hardware of [NaN, Infinity, -Infinity, 0, -1]) {
      assert.deepEqual(effectiveWorkerCount(Infinity, hardware), { count: 1, limitedBy: "hardware" });
      assert.deepEqual(effectiveProofWorkerCount(Infinity, hardware), { count: 1, limitedBy: "hardware" });
    }
    assert.deepEqual(effectiveWorkerCount(NaN, 16), { count: 1, limitedBy: "memory" });
  });

  it("reserves coordinator memory and twice the discovery memory per proof lane", () => {
    for (const [memoryMiB, expected] of [[768, 1], [1_536, 2], [3_072, 5], [4_096, 7]]) {
      const proof = effectiveProofWorkerCount(memoryMiB * MIB, 16);
      assert.equal(proof.count, expected);
      assert.equal(proof.limitedBy, "memory");
      assert.ok((memoryMiB * MIB - 128 * MIB) / proof.count >= 512 * MIB);
      assert.ok(proof.count <= effectiveWorkerCount(memoryMiB * MIB, 16).count);
    }
    assert.deepEqual(effectiveProofWorkerCount(4_096 * MIB, 16, 2), { count: 2, limitedBy: "requested" });
  });
});
