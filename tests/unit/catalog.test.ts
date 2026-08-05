import assert from "node:assert/strict";
import test from "node:test";

import {
  DIFFICULTY_ORDER,
  PUZZLE_BY_ID,
  PUZZLES,
  getOrderedPuzzles,
  getEffectiveCollection,
  getPuzzleIndexById,
  getPuzzlesByDifficulty,
} from "../../src/catalog/puzzles.ts";
import { PUZZLE_METADATA } from "../../src/catalog/puzzle-metadata.ts";
import { validatePuzzle } from "../../src/core/puzzle.ts";

const RESERVED_UPPERCASE = new Set(["O", "R", "S", "X"]);
const RESERVED_LOWERCASE = new Set(["o", "r", "s", "x"]);

function countCharacters(rows: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const character of rows.join("")) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  return counts;
}

function isDedicatedBox(character: string): boolean {
  return /^[A-Z]$/.test(character) && !RESERVED_UPPERCASE.has(character);
}

test("catalog contains canonical + generated puzzles with unique ids", () => {
  assert.ok(PUZZLES.length >= 2095, `expected >=2095 puzzles, got ${PUZZLES.length}`);
  assert.equal(new Set(PUZZLES.map((puzzle) => puzzle.id)).size, PUZZLES.length);
  assert.equal(Object.keys(PUZZLE_BY_ID).length, PUZZLES.length);
});

test("catalog indexes every puzzle id without repeated scans", () => {
  for (let index = 0; index < PUZZLES.length; index += 1) {
    assert.equal(getPuzzleIndexById(PUZZLES[index].id), index);
  }
  assert.equal(getPuzzleIndexById("missing-puzzle"), -1);
});

test("lightweight metadata stays aligned with the board catalog", () => {
  assert.deepEqual(
    PUZZLE_METADATA,
    PUZZLES.map((puzzle, index) => ({
      id: puzzle.id,
      title: puzzle.title,
      difficulty: puzzle.difficulty,
      boxes: puzzle.boxes,
      width: puzzle.rows[0]?.length ?? 0,
      height: puzzle.rows.length,
      collection: getEffectiveCollection(puzzle),
      shard: `puzzle-shard-${String(Math.floor(index / 50)).padStart(3, "0")}`,
    })),
  );
});

test("every puzzle has rectangular rows and exactly one robot", () => {
  for (const puzzle of PUZZLES) {
    assert.ok(puzzle.rows.length > 0, `${puzzle.id}: expected at least one row`);
    const width = puzzle.rows[0].length;
    assert.ok(width > 0, `${puzzle.id}: expected non-empty rows`);
    assert.ok(
      puzzle.rows.every((row) => row.length === width),
      `${puzzle.id}: rows must be rectangular`,
    );
    assert.equal(
      puzzle.rows.join("").split("R").length - 1,
      1,
      `${puzzle.id}: expected exactly one robot`,
    );
  }
});

test("box labels, goal labels, and declared box counts agree", () => {
  for (const puzzle of PUZZLES) {
    const counts = countCharacters(puzzle.rows);
    const dedicatedLabels = new Set(
      [...counts.keys()]
        .filter(isDedicatedBox)
        .map((label) => label.toLocaleLowerCase()),
    );

    for (const character of counts.keys()) {
      if (/^[a-z]$/.test(character) && !RESERVED_LOWERCASE.has(character)) {
        dedicatedLabels.add(character);
      }
    }

    assert.equal(
      counts.get("X") ?? 0,
      counts.get("S") ?? 0,
      `${puzzle.id}: generic X boxes must match S goals`,
    );

    for (const label of dedicatedLabels) {
      assert.equal(
        counts.get(label.toLocaleUpperCase()) ?? 0,
        counts.get(label) ?? 0,
        `${puzzle.id}: ${label.toLocaleUpperCase()} boxes must match ${label} goals`,
      );
    }

    const actualBoxCount = [...counts.entries()].reduce(
      (total, [character, count]) =>
        total + (character === "X" || isDedicatedBox(character) ? count : 0),
      0,
    );
    assert.equal(
      actualBoxCount,
      puzzle.boxes,
      `${puzzle.id}: declared box count must match its board`,
    );
  }
});

test("Grand Hall retains the historic huge id", () => {
  assert.equal(PUZZLE_BY_ID["huge"]?.title, "Grand Hall");
});

test("migration corrects the six stale legacy box-count labels", () => {
  const corrections = {
    medium: { legacy: 5, actual: 8 },
    "garden-2": { legacy: 4, actual: 2 },
    large: { legacy: 5, actual: 6 },
    "adv-rotary": { legacy: 4, actual: 2 },
    "sym-diamond": { legacy: 4, actual: 3 },
    huge: { legacy: 12, actual: 17 },
  } as const;

  for (const [id, counts] of Object.entries(corrections)) {
    assert.notEqual(counts.legacy, counts.actual);
    assert.equal(PUZZLE_BY_ID[id]?.boxes, counts.actual);
  }
});

test("catalog helpers preserve curriculum order and support filters", () => {
  const ordered = getOrderedPuzzles();
  assert.equal(ordered.length, PUZZLES.length);

  // Ordered list is sorted by difficulty
  const difficultyRank = new Map(DIFFICULTY_ORDER.map((d, i) => [d, i]));
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(
      (difficultyRank.get(ordered[i].difficulty) ?? 0) >=
        (difficultyRank.get(ordered[i - 1].difficulty) ?? 0),
      `ordering violation at index ${i}: ${ordered[i - 1].difficulty} > ${ordered[i].difficulty}`,
    );
  }

  for (const difficulty of DIFFICULTY_ORDER) {
    assert.ok(
      getPuzzlesByDifficulty(difficulty).every(
        (puzzle) => puzzle.difficulty === difficulty,
      ),
    );
  }

  // Canonical expert puzzles still appear in expert filter results
  const expertSmall = getOrderedPuzzles({ difficulty: "expert", maxBoxes: 6 });
  const expertIds = new Set(expertSmall.map((p) => p.id));
  assert.ok(expertIds.has("expert-maze"));
  assert.ok(expertIds.has("expert-tetris"));
  assert.ok(expertIds.has("theme-museum"));

  assert.deepEqual(
    getOrderedPuzzles({ search: "grand hall" }).map((puzzle) => puzzle.id),
    ["huge"],
  );
});

test("every puzzle passes validatePuzzle", () => {
  for (const puzzle of PUZZLES) {
    const result = validatePuzzle(puzzle);
    assert.ok(
      result.valid,
      `${puzzle.id}: validation failed — ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }
});
