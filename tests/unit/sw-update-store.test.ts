import assert from "node:assert/strict";
import test from "node:test";

import {
  activateWaitingUpdate,
  getUpdateSnapshot,
  notifyUpdateAvailable,
} from "../../src/shared/sw-update-store.ts";

function fakeWorker(state: ServiceWorkerState) {
  const messages: unknown[] = [];
  const worker = {
    state,
    postMessage: (message: unknown) => messages.push(message),
  } as unknown as ServiceWorker;
  return { worker, messages };
}

function withReloadSpy(run: () => void): number {
  let reloads = 0;
  const previous = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", { location: { reload: () => { reloads += 1; } } });
  try {
    run();
  } finally {
    Reflect.set(globalThis, "window", previous);
  }
  return reloads;
}

test("a waiting worker is asked to skip waiting", () => {
  const { worker, messages } = fakeWorker("installed");
  const reloads = withReloadSpy(() => activateWaitingUpdate(worker));
  assert.deepEqual(messages, [{ type: "SKIP_WAITING" }]);
  assert.equal(reloads, 0);
});

test("a worker that already took over reloads the page instead", () => {
  for (const state of ["activating", "activated"] as const) {
    const { worker, messages } = fakeWorker(state);
    const reloads = withReloadSpy(() => activateWaitingUpdate(worker));
    assert.deepEqual(messages, [], state);
    assert.equal(reloads, 1, state);
  }
});

test("repeated notices for the same worker publish one update", () => {
  const { worker } = fakeWorker("installed");
  notifyUpdateAvailable(worker);
  const first = getUpdateSnapshot();
  notifyUpdateAvailable(worker);
  assert.equal(getUpdateSnapshot(), first);
  assert.equal(first?.waitingWorker, worker);
});
