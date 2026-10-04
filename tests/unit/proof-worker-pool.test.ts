import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProofCommand } from "../../src/solver/implementations/sokomind-proof-protocol.ts";
import {
  createProofWorkerPool,
  proofWorkerSourceFromFactory,
} from "../../src/solver/implementations/sokomind-proof-pool.ts";
import type { SokomindProofWorker } from "../../src/solver/implementations/sokomind-proof.ts";

type MessageListener = (event: { data: unknown }) => void;
type ErrorListener = (event: { message?: string; error?: unknown }) => void;
type Listener = (event: { data?: unknown; message?: string }) => void;

class FakeLane implements SokomindProofWorker {
  readonly received: ProofCommand[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();
  terminated = false;

  postMessage(message: ProofCommand): void {
    this.received.push(message);
  }

  addEventListener(type: string, listener: MessageListener | ErrorListener): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(listener as Listener);
  }

  removeEventListener(type: string, listener: MessageListener | ErrorListener): void {
    this.#listeners.get(type)?.delete(listener as Listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  get listenerCount(): number {
    return [...this.#listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }

  idle(runId: number, partitionId: string): void {
    this.#emit("message", { data: { type: "proof/idle", runId, partitionId } });
  }

  crash(type: "error" | "messageerror" = "error"): void {
    this.#emit(type, { message: "worker crash" });
  }

  #emit(type: string, event: { data?: unknown; message?: string }): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
  }
}

function countingFactory() {
  const created: FakeLane[] = [];
  const create = (): FakeLane => {
    const lane = new FakeLane();
    created.push(lane);
    return lane;
  };
  return { created, create };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createProofWorkerPool", () => {
  it("lends a released lane again instead of starting a new one", () => {
    const { created, create } = countingFactory();
    const pool = createProofWorkerPool(create);
    const lane = pool.acquire() as FakeLane;
    pool.release(lane);
    assert.equal(lane.listenerCount, 2);

    assert.equal(pool.acquire(), lane);
    assert.equal(created.length, 1);
    assert.equal(lane.terminated, false);
    // A lent lane carries no pool listener into the run that holds it.
    assert.equal(lane.listenerCount, 0);
    pool.dispose();
  });

  it("lends a drained lane only after the idle that ends its partition", () => {
    const { created, create } = countingFactory();
    const pool = createProofWorkerPool(create);
    const lane = pool.acquire() as FakeLane;
    pool.drain(lane, 3, "p1");
    lane.idle(2, "p1");
    lane.idle(3, "p2");
    lane.idle(3, "p1");

    assert.equal(lane.terminated, false);
    assert.equal(lane.listenerCount, 2, "only the parked lane's crash watch remains");
    assert.equal(pool.acquire(), lane);
    assert.equal(created.length, 1);
    pool.dispose();
  });

  it("replaces the oldest lane still draining rather than wait for it", () => {
    const { created, create } = countingFactory();
    const pool = createProofWorkerPool(create);
    const older = pool.acquire() as FakeLane;
    const newer = pool.acquire() as FakeLane;
    pool.drain(older, 1, "a");
    pool.drain(newer, 1, "b");
    // An idle for another run or partition does not end the drain.
    older.idle(1, "b");

    const replacement = pool.acquire();
    assert.equal(created.length, 3);
    assert.equal(replacement, created[2]);
    assert.equal(older.terminated, true);
    assert.equal(older.listenerCount, 0);
    assert.equal(newer.terminated, false);

    newer.idle(1, "b");
    assert.equal(pool.acquire(), newer);
    pool.dispose();
  });

  it("terminates a lane whose idle never arrives", async () => {
    const { created, create } = countingFactory();
    const pool = createProofWorkerPool(create, { drainTimeoutMs: 10 });
    const lane = pool.acquire() as FakeLane;
    pool.drain(lane, 1, "p");
    await delay(40);

    assert.equal(lane.terminated, true);
    assert.equal(lane.listenerCount, 0);
    lane.idle(1, "p");
    assert.notEqual(pool.acquire(), lane);
    assert.equal(created.length, 2);
    pool.dispose();
  });

  for (const type of ["error", "messageerror"] as const) {
    it(`never lends a lane that reports ${type} while it drains or waits`, () => {
      const { created, create } = countingFactory();
      const pool = createProofWorkerPool(create);
      const draining = pool.acquire() as FakeLane;
      const parked = pool.acquire() as FakeLane;
      pool.drain(draining, 1, "p");
      pool.release(parked);
      draining.crash(type);
      parked.crash(type);

      assert.equal(draining.terminated, true);
      assert.equal(parked.terminated, true);
      assert.equal(draining.listenerCount + parked.listenerCount, 0);
      const next = pool.acquire();
      assert.notEqual(next, draining);
      assert.notEqual(next, parked);
      assert.equal(created.length, 3);
      pool.dispose();
    });
  }

  it("never lends a discarded lane", () => {
    const { created, create } = countingFactory();
    const pool = createProofWorkerPool(create);
    const lane = pool.acquire() as FakeLane;
    pool.discard(lane);

    assert.equal(lane.terminated, true);
    assert.notEqual(pool.acquire(), lane);
    assert.equal(created.length, 2);
    pool.dispose();
  });

  it("terminates every lane it holds on dispose, and every lane handed back after", () => {
    const { create } = countingFactory();
    const pool = createProofWorkerPool(create);
    const [parked, draining, lateRelease, lateDrain] =
      [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()] as FakeLane[];
    pool.release(parked);
    pool.drain(draining, 1, "p");
    pool.dispose();

    assert.equal(parked.terminated, true);
    assert.equal(draining.terminated, true);
    assert.equal(parked.listenerCount + draining.listenerCount, 0);

    pool.release(lateRelease);
    pool.drain(lateDrain, 1, "q");
    assert.equal(lateRelease.terminated, true);
    assert.equal(lateDrain.terminated, true);
    assert.equal(lateRelease.listenerCount + lateDrain.listenerCount, 0);
  });
});

describe("proofWorkerSourceFromFactory", () => {
  it("starts a lane for every acquire and terminates every lane handed back", () => {
    const { created, create } = countingFactory();
    const source = proofWorkerSourceFromFactory(create);
    const lanes = [source.acquire(), source.acquire(), source.acquire()] as FakeLane[];
    source.release(lanes[0]);
    source.drain(lanes[1], 1, "p");
    source.discard(lanes[2]);

    assert.equal(created.length, 3);
    assert.deepEqual(lanes.map((lane) => lane.terminated), [true, true, true]);
    assert.notEqual(source.acquire(), lanes[0]);
  });
});
