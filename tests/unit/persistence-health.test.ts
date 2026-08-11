import assert from "node:assert/strict";
import test from "node:test";

import { createPersistenceHealthStore } from "../../src/shared/persistence-health.ts";

test("deduplicates repeated failures and clears only the recovered key", () => {
  const store = createPersistenceHealthStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  const progressFailure = {
    ok: false as const,
    key: "progress",
    operation: "write" as const,
    reason: "quota-exceeded" as const,
  };
  store.report(progressFailure);
  store.report(progressFailure);
  assert.equal(notifications, 1);
  assert.deepEqual(store.getSnapshot().failures, [progressFailure]);

  const sessionFailure = {
    ok: false as const,
    key: "session",
    operation: "write" as const,
    reason: "security-error" as const,
  };
  store.report(sessionFailure);
  assert.equal(notifications, 2);
  assert.equal(store.getSnapshot().failures.length, 2);

  store.report({ ok: true, key: "progress", operation: "write" });
  assert.deepEqual(store.getSnapshot().failures, [sessionFailure]);
  store.report({ ok: true, key: "session", operation: "write" });
  assert.deepEqual(store.getSnapshot().failures, []);
  assert.equal(notifications, 4);
});

test("offers scoped retry callbacks only while retryable failures remain", () => {
  const store = createPersistenceHealthStore();
  let attempts = 0;
  const retry = () => {
    attempts++;
    store.report({ ok: true, key: "draft", operation: "write" });
  };
  store.report({
    ok: false,
    key: "draft",
    operation: "write",
    reason: "quota-exceeded",
  }, retry);
  assert.equal(store.getSnapshot().canRetry, true);
  store.retryFailures();
  assert.equal(attempts, 1);
  assert.equal(store.getSnapshot().canRetry, false);
  assert.deepEqual(store.getSnapshot().failures, []);
});
