import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PROGRESS_IMPORT_BYTES,
  MAX_PROGRESS_IMPORT_RECORDS,
  parseProgressImport,
  readProgressImportFile,
} from "../../src/shared/progress-import.ts";

const record = (moves: number) => ({
  moves,
  pushes: 1,
  completedAt: "2026-08-11T12:00:00.000Z",
});

test("bounded progress import reports invalid and unavailable records", () => {
  const result = parseProgressImport(JSON.stringify({
    version: 2,
    completed: {
      known: record(4),
      retired: record(5),
      invalid: { moves: 1, pushes: 2, completedAt: "bad" },
    },
    daily: {},
    activity: {},
  }), ["known"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.progress.completed), ["known"]);
  assert.equal(result.invalid, 1);
  assert.equal(result.rejected, 1);
});

test("progress import rejects oversized bytes before reading", async () => {
  let read = false;
  const result = await readProgressImportFile({
    size: MAX_PROGRESS_IMPORT_BYTES + 1,
    text: async () => { read = true; return "{}"; },
  }, []);
  assert.equal(result.ok, false);
  assert.equal(read, false);
});

test("progress import rejects excessive record counts", () => {
  const result = parseProgressImport(JSON.stringify({
    version: 2,
    completed: {},
    daily: {},
    activity: {
      "2026-08-11": Array.from(
        { length: MAX_PROGRESS_IMPORT_RECORDS + 1 },
        (_, index) => `p${index}`,
      ),
    },
  }), []);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /too many records/iu);
});

test("a maximum retained progress export can be imported again", () => {
  const puzzleIds = Array.from({ length: 57 }, (_, index) => `p${index}`);
  const activity: Record<string, string[]> = {};
  const daily: Record<string, { puzzleId: string; completedAt: string }> = {};
  let retained = 0;
  for (let day = 0; day < 366; day++) {
    const date = new Date(Date.UTC(2025, 0, day + 1));
    const dateKey = date.toISOString().slice(0, 10);
    const completedAt = `${dateKey}T12:00:00.000Z`;
    activity[dateKey] = [];
    for (const puzzleId of puzzleIds) {
      if (retained >= 10_000) break;
      activity[dateKey].push(puzzleId);
      retained++;
    }
    daily[dateKey] = { puzzleId: puzzleIds[day % puzzleIds.length], completedAt };
  }
  const completed = Object.fromEntries(puzzleIds.map((puzzleId) => [
    puzzleId,
    record(4),
  ]));
  const result = parseProgressImport(JSON.stringify({
    version: 2,
    completed,
    daily,
    activity,
  }), puzzleIds);
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  if (!result.ok) return;
  assert.equal(Object.values(result.progress.activity).flat().length, 10_000);
  assert.equal(Object.keys(result.progress.completed).length, 57);
  assert.equal(Object.keys(result.progress.daily).length, 366);
});

test("progress import bounds and filters the activity ledger", () => {
  const result = parseProgressImport(JSON.stringify({
    version: 2,
    completed: {},
    daily: {},
    activity: {
      "2026-08-11": ["known", "retired", 42],
    },
  }), ["known"]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.progress.activity, { "2026-08-11": ["known"] });
  assert.equal(result.invalid, 1);
  assert.equal(result.rejected, 1);

  const oversized = parseProgressImport(JSON.stringify({
    version: 2,
    completed: {},
    daily: {},
    activity: {
      "2026-08-11": Array.from(
        { length: MAX_PROGRESS_IMPORT_RECORDS + 1 },
        (_, index) => `p${index}`,
      ),
    },
  }), []);
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.message, /too many records/iu);
});
