import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  configureSearchScheduler,
  createEventLoopYield,
  delayForEventLoop,
} from "../../src/solver/search/scheduling.ts";

function fakeHost(used: string[]) {
  const setImmediate = (callback: () => void) => {
    used.push("setImmediate");
    queueMicrotask(callback);
  };
  const setTimeout = (callback: () => void, delayMs: number) => {
    used.push(`setTimeout ${delayMs}`);
    queueMicrotask(callback);
  };
  class MessageChannel {
    readonly port1: { onmessage: ((event: never) => void) | null } = { onmessage: null };
    readonly port2 = {
      postMessage: () => {
        used.push("postMessage");
        queueMicrotask(() => this.port1.onmessage?.(undefined as never));
      },
    };
  }
  return { setImmediate, setTimeout, MessageChannel };
}

describe("search event-loop yield", () => {
  it("prefers setImmediate, then a MessageChannel, then setTimeout", async () => {
    const used: string[] = [];
    const { setImmediate, setTimeout, MessageChannel } = fakeHost(used);
    await createEventLoopYield({ setImmediate, MessageChannel, setTimeout })();
    await createEventLoopYield({ MessageChannel, setTimeout })();
    await createEventLoopYield({ setTimeout })();
    assert.deepEqual(used, ["setImmediate", "postMessage", "setTimeout 0"]);
  });

  it("resolves overlapping MessageChannel yields in order over one channel", async () => {
    const used: string[] = [];
    let channels = 0;
    const { setTimeout, MessageChannel: Channel } = fakeHost(used);
    class MessageChannel extends Channel {
      constructor() {
        super();
        channels++;
      }
    }
    const yieldOnce = createEventLoopYield({ MessageChannel, setTimeout });
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => yieldOnce().then(() => order.push(n))));
    assert.deepEqual(order, [1, 2, 3]);
    assert.deepEqual(used, ["postMessage", "postMessage", "postMessage"]);
    assert.equal(channels, 1);
  });

  it("does not wait on setTimeout under Node", async (t) => {
    // With setTimeout frozen, only a setImmediate yield can settle first.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stalled = new Promise((resolve) => {
      setImmediate(() => setImmediate(() => resolve("stalled")));
    });
    assert.equal(await Promise.race([delayForEventLoop().then(() => "yielded"), stalled]), "yielded");
  });

  it("uses a configured scheduler until it is cleared", async () => {
    let calls = 0;
    configureSearchScheduler(async () => { calls++; });
    try {
      await delayForEventLoop();
      await delayForEventLoop();
    } finally {
      configureSearchScheduler();
    }
    await delayForEventLoop();
    assert.equal(calls, 2);
  });
});
