import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_PROGRESS,
  mergeProgress,
  normalizeProgress,
  parseProgress,
  recordCompletion,
  recordDailyCompletion,
  summarizeProgressMerge,
  tryParseProgress,
} from "../../src/shared/progress.ts";

test("invalid persisted progress fails closed", () => {
  assert.deepEqual(parseProgress("not json"), EMPTY_PROGRESS);
  assert.deepEqual(parseProgress('{"version":2,"completed":{}}'), EMPTY_PROGRESS);
});

test("migrates v1 lifetime progress into v2 without inventing daily participation", () => {
  const migrated = parseProgress(JSON.stringify({
    version: 1,
    completed: {
      room: { moves: 4, pushes: 1, completedAt: "2026-08-01T00:00:00.000Z" },
    },
  }));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.completed.room?.moves, 4);
  assert.deepEqual(migrated.daily, {});
});

test("distinguishes invalid imports and merges only better records", () => {
  assert.equal(tryParseProgress("not json"), null);

  const current = recordCompletion(EMPTY_PROGRESS, "room", 20, 5);
  const worse = recordCompletion(EMPTY_PROGRESS, "room", 40, 6);
  const better = recordCompletion(EMPTY_PROGRESS, "room", 18, 6);

  assert.deepEqual(mergeProgress(current, worse).completed.room, current.completed.room);
  const merged = mergeProgress(current, better);
  assert.equal(merged.completed.room?.moves, 18);
  assert.equal(
    merged.completed.room?.completedAt,
    better.completed.room?.completedAt,
  );
});

test("drops impossible records before they can outrank valid completions", () => {
  const parsed = tryParseProgress(JSON.stringify({
    version: 1,
    completed: {
      valid: {
        moves: 10,
        pushes: 3,
        completedAt: "2026-08-01T00:00:00.000Z",
      },
      impossibleCounters: {
        moves: 2,
        pushes: 3,
        completedAt: "2026-08-01T00:00:00.000Z",
      },
      unsafeCounters: {
        moves: Number.MAX_SAFE_INTEGER + 1,
        pushes: 1,
        completedAt: "2026-08-01T00:00:00.000Z",
      },
      invalidTimestamp: {
        moves: 8,
        pushes: 2,
        completedAt: "not-a-timestamp",
      },
    },
  }));

  assert.deepEqual(Object.keys(parsed?.completed ?? {}), ["valid"]);
});

test("completion records retain the route with the fewest moves", () => {
  const first = recordCompletion(EMPTY_PROGRESS, "tiny", 30, 8);
  const slower = recordCompletion(first, "tiny", 35, 8);
  const fewerPushes = recordCompletion(slower, "tiny", 50, 7);
  const fewerMoves = recordCompletion(fewerPushes, "tiny", 20, 9);

  assert.equal(slower, first);
  assert.equal(fewerPushes, first);
  assert.equal(fewerMoves.completed.tiny.pushes, 9);
  assert.equal(fewerMoves.completed.tiny.moves, 20);
});

test("normalizes imported progress against known puzzle ids and reports stale records", () => {
  const imported = recordCompletion(
    recordCompletion(EMPTY_PROGRESS, "known", 12, 4),
    "retired-room",
    8,
    3,
  );
  const normalized = normalizeProgress(imported, ["known", "another-known"]);

  assert.deepEqual(Object.keys(normalized.progress.completed), ["known"]);
  assert.equal(normalized.progress.completed.known, imported.completed.known);
  assert.deepEqual(normalized.ignoredPuzzleIds, ["retired-room"]);
  assert.ok(Object.isFrozen(normalized.ignoredPuzzleIds));
});

test("normalization preserves progress identity when every record is known", () => {
  const imported = recordCompletion(EMPTY_PROGRESS, "known", 12, 4);
  const normalized = normalizeProgress(imported, new Set(["known"]));

  assert.equal(normalized.progress, imported);
  assert.deepEqual(normalized.ignoredPuzzleIds, []);
});

test("daily participation is date-indexed and merges without replacing an existing date", () => {
  const firstDate = new Date(2026, 7, 10, 12);
  const secondDate = new Date(2026, 7, 11, 12);
  const first = recordDailyCompletion(EMPTY_PROGRESS, "room-a", firstDate);
  const second = recordDailyCompletion(EMPTY_PROGRESS, "room-b", secondDate);
  const merged = mergeProgress(first, second);
  assert.equal(Object.keys(merged.daily).length, 2);

  const conflict = recordDailyCompletion(EMPTY_PROGRESS, "other", firstDate);
  assert.equal(
    mergeProgress(first, conflict).daily["2026-08-10"]?.puzzleId,
    "room-a",
  );
});

test("merge summaries distinguish added, improved, unchanged, and rejected records", () => {
  let current = recordCompletion(EMPTY_PROGRESS, "same", 10, 3);
  current = recordCompletion(current, "better", 20, 4);
  current = recordCompletion(current, "worse", 8, 2);
  let imported = recordCompletion(EMPTY_PROGRESS, "added", 5, 1);
  imported = recordCompletion(imported, "better", 15, 4);
  imported = recordCompletion(imported, "worse", 12, 2);
  imported = {
    ...imported,
    completed: { ...imported.completed, same: current.completed.same },
  };
  assert.deepEqual(summarizeProgressMerge(current, imported), {
    added: 1,
    improved: 1,
    unchanged: 1,
    rejected: 1,
  });
});
