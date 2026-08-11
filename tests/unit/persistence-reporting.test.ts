import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { saveFavorite } from "../../src/shared/favorites.ts";
import { persistenceHealth } from "../../src/shared/persistence-health.ts";
import { saveRating } from "../../src/shared/puzzle-ratings.ts";
import { STORAGE_KEYS } from "../../src/shared/storage.ts";

let failWrites = true;
const values = new Map<string, string>();
const storage: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key); },
  setItem: (key, value) => {
    if (failWrites) throw new DOMException("blocked", "QuotaExceededError");
    values.set(key, value);
  },
};

(globalThis as Record<string, unknown>).window = { localStorage: storage };

afterEach(() => {
  failWrites = false;
  saveFavorite("cleanup");
  saveRating("cleanup", "right");
  failWrites = true;
  values.clear();
});

test("favorite failures are visible and a later retry clears the warning", () => {
  saveFavorite("room");
  assert.equal(
    persistenceHealth.getSnapshot().failures.some(({ key }) =>
      key === STORAGE_KEYS.favorites),
    true,
  );
  failWrites = false;
  saveFavorite("room");
  assert.equal(
    persistenceHealth.getSnapshot().failures.some(({ key }) =>
      key === STORAGE_KEYS.favorites),
    false,
  );
});

test("rating failures feed the shared persistence health signal", () => {
  saveRating("room", "hard");
  assert.equal(
    persistenceHealth.getSnapshot().failures.some(({ key }) =>
      key === STORAGE_KEYS.ratings),
    true,
  );
});
