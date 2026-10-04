import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createEngineWorkerPool,
  engineWorkerSourceFromFactory,
} from "../../src/solver/implementations/sokomind-engine-pool.ts";
import type { SokomindEngineWorker } from "../../src/solver/implementations/sokomind-phase-runner.ts";

type MessageListener = (event: { data: unknown }) => void;
type ErrorListener = (event: { message?: string }) => void;
type Listener = (event: { data?: unknown; message?: string }) => void;

class FakeEngine implements SokomindEngineWorker {
  readonly #listeners = new Map<string, Set<Listener>>();
  terminated = false;

  postMessage(): void {}

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

  crash(type: "error" | "messageerror"): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener({ message: "worker crash" });
    }
  }
}

function countingFactory() {
  const created: FakeEngine[] = [];
  const create = (): FakeEngine => {
    const engine = new FakeEngine();
    created.push(engine);
    return engine;
  };
  return { created, create };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Lets a release leave the dispatch it happened in.
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("createEngineWorkerPool", () => {
  it("lends a worker that finished cleanly instead of starting a new one", async () => {
    const { created, create } = countingFactory();
    const pool = createEngineWorkerPool(create);
    const engine = pool.acquire() as FakeEngine;
    pool.release(engine, true);
    assert.equal(engine.listenerCount, 2);
    await settle();

    assert.equal(pool.acquire(), engine);
    assert.equal(created.length, 1);
    assert.equal(engine.terminated, false);
    // A lent worker carries no pool listener into the plan that holds it.
    assert.equal(engine.listenerCount, 0);
    pool.dispose();
  });

  it("lends a released worker only once the dispatch that released it ends", async () => {
    const { created, create } = countingFactory();
    const pool = createEngineWorkerPool(create);
    const engine = pool.acquire() as FakeEngine;
    pool.release(engine, true);
    // A plan started from the done that freed the worker takes another one,
    // so that done never reaches the new plan's listener.
    const next = pool.acquire();
    assert.notEqual(next, engine);
    await settle();

    assert.equal(pool.acquire(), engine);
    assert.equal(created.length, 2);
    pool.dispose();
  });

  it("lends parked workers oldest first and creates one when none is parked", async () => {
    const { created, create } = countingFactory();
    const pool = createEngineWorkerPool(create);
    const first = pool.acquire();
    const second = pool.acquire();
    pool.release(first, true);
    pool.release(second, true);
    await settle();

    assert.equal(pool.acquire(), first);
    assert.equal(pool.acquire(), second);
    assert.equal(pool.acquire(), created[2]);
    assert.equal(created.length, 3);
    pool.dispose();
  });

  it("terminates a worker handed back as not reusable", () => {
    const { created, create } = countingFactory();
    const pool = createEngineWorkerPool(create);
    const engine = pool.acquire() as FakeEngine;
    pool.release(engine, false);

    assert.equal(engine.terminated, true);
    assert.notEqual(pool.acquire(), engine);
    assert.equal(created.length, 2);
    pool.dispose();
  });

  for (const type of ["error", "messageerror"] as const) {
    it(`never lends a parked worker that reports ${type}`, async () => {
      const { created, create } = countingFactory();
      const pool = createEngineWorkerPool(create);
      const engine = pool.acquire() as FakeEngine;
      pool.release(engine, true);
      await settle();
      engine.crash(type);

      assert.equal(engine.terminated, true);
      assert.equal(engine.listenerCount, 0);
      assert.notEqual(pool.acquire(), engine);
      assert.equal(created.length, 2);
      pool.dispose();
    });
  }

  it("terminates a parked worker that no plan takes within the idle timeout", async () => {
    const { created, create } = countingFactory();
    const pool = createEngineWorkerPool(create, { idleTimeoutMs: 5 });
    const engine = pool.acquire() as FakeEngine;
    pool.release(engine, true);
    await delay(30);

    assert.equal(engine.terminated, true);
    assert.equal(engine.listenerCount, 0);
    assert.notEqual(pool.acquire(), engine);
    assert.equal(created.length, 2);
    pool.dispose();
  });

  it("keeps a lent worker past the idle timeout it was parked with", async () => {
    const { create } = countingFactory();
    const pool = createEngineWorkerPool(create, { idleTimeoutMs: 5 });
    const engine = pool.acquire() as FakeEngine;
    pool.release(engine, true);
    await settle();
    assert.equal(pool.acquire(), engine);
    await delay(30);

    assert.equal(engine.terminated, false);
    pool.release(engine, false);
    pool.dispose();
  });

  it("terminates every parked worker on dispose, and every worker handed back after", () => {
    const { create } = countingFactory();
    const pool = createEngineWorkerPool(create);
    const parked = pool.acquire() as FakeEngine;
    const busy = pool.acquire() as FakeEngine;
    pool.release(parked, true);
    pool.dispose();

    assert.equal(parked.terminated, true);
    assert.equal(parked.listenerCount, 0);
    assert.equal(busy.terminated, false);
    pool.release(busy, true);
    assert.equal(busy.terminated, true);
    assert.equal(busy.listenerCount, 0);
  });
});

describe("engineWorkerSourceFromFactory", () => {
  it("starts a worker for every acquire and terminates every worker handed back", () => {
    const { created, create } = countingFactory();
    const source = engineWorkerSourceFromFactory(create);
    const engine = source.acquire() as FakeEngine;
    source.release(engine, true);

    assert.equal(engine.terminated, true);
    assert.notEqual(source.acquire(), engine);
    assert.equal(created.length, 2);
  });
});
