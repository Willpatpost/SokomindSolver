import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  boardHash,
  symmetryHash,
  canonicalizeRows,
  createGeneratedPuzzleId,
} from "../../src/features/generator/v2/index.ts";

import { classifyFromMetrics } from "../../src/features/generator/difficulty-classifier.ts";
import { DIFFICULTIES, type Difficulty } from "../../src/core/model.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIER_RANK = new Map<Difficulty, number>(
  DIFFICULTIES.map((d, i) => [d, i]),
);

function difficultyGap(intended: Difficulty, classified: Difficulty): number {
  return (TIER_RANK.get(intended) ?? 0) - (TIER_RANK.get(classified) ?? 0);
}

// ---------------------------------------------------------------------------
// Difficulty classification tests
// ---------------------------------------------------------------------------

test("classifyFromMetrics returns correct tier for known thresholds", () => {
  assert.equal(classifyFromMetrics(5, 3, 1), "tutorial");
  assert.equal(classifyFromMetrics(10, 5, 2), "tutorial");
  assert.equal(classifyFromMetrics(20, 10, 3), "beginner");
  assert.equal(classifyFromMetrics(50, 30, 4), "intermediate");
  assert.equal(classifyFromMetrics(150, 60, 5), "advanced");
  assert.equal(classifyFromMetrics(400, 150, 8), "expert");
  assert.equal(classifyFromMetrics(1000, 500, 12), "master");
});

test("difficultyGap is correct for matching and mismatched tiers", () => {
  assert.equal(difficultyGap("intermediate", "intermediate"), 0);
  assert.equal(difficultyGap("advanced", "intermediate"), 1);
  assert.equal(difficultyGap("intermediate", "advanced"), -1);
  assert.equal(difficultyGap("master", "tutorial"), 5);
  assert.equal(difficultyGap("tutorial", "master"), -5);
});

test("difficulty mismatch policy: gap >= 2 should be rejected", () => {
  const intended: Difficulty = "expert";
  const classified = classifyFromMetrics(10, 5, 2);
  const gap = difficultyGap(intended, classified);
  assert.ok(Math.abs(gap) >= 2, `gap ${gap} should be >= 2 for expert vs tutorial metrics`);
});

test("difficulty mismatch policy: gap 0-1 should be accepted", () => {
  const intended: Difficulty = "beginner";
  const classified = classifyFromMetrics(20, 10, 3);
  const gap = difficultyGap(intended, classified);
  assert.ok(Math.abs(gap) <= 1, `gap ${gap} should be <= 1 for beginner vs beginner metrics`);
});

// ---------------------------------------------------------------------------
// Board identity tests
// ---------------------------------------------------------------------------

const SAMPLE_ROWS = [
  "OOOOO",
  "O R O",
  "O X O",
  "O S O",
  "OOOOO",
];

const PADDED_ROWS = [
  "OOOOOOOO",
  "OOOOOOOO",
  "OOO R OO",
  "OOO X OO",
  "OOO S OO",
  "OOOOOOOO",
  "OOOOOOOO",
];

test("canonicalizeRows strips wall-only padding", () => {
  const canonical1 = canonicalizeRows(SAMPLE_ROWS);
  const canonical2 = canonicalizeRows(PADDED_ROWS);
  assert.deepEqual(canonical1, canonical2);
});

test("boardHash is stable for identical boards", () => {
  const hash1 = boardHash(SAMPLE_ROWS);
  const hash2 = boardHash([...SAMPLE_ROWS]);
  assert.equal(hash1, hash2);
});

test("boardHash matches for padded variants", () => {
  assert.equal(boardHash(SAMPLE_ROWS), boardHash(PADDED_ROWS));
});

test("symmetryHash matches for mirrored boards", () => {
  const mirrored = SAMPLE_ROWS.map((r) => [...r].reverse().join(""));
  assert.equal(symmetryHash(SAMPLE_ROWS), symmetryHash(mirrored));
});

test("symmetryHash matches for vertically flipped boards", () => {
  const flipped = [...SAMPLE_ROWS].reverse();
  assert.equal(symmetryHash(SAMPLE_ROWS), symmetryHash(flipped));
});

test("symmetryHash matches for 180-degree rotated boards", () => {
  const rotated = [...SAMPLE_ROWS].reverse().map((r) => [...r].reverse().join(""));
  assert.equal(symmetryHash(SAMPLE_ROWS), symmetryHash(rotated));
});

test("exactHash differs for different boards", () => {
  const other = [
    "OOOOOO",
    "O R  O",
    "O X  O",
    "O  S O",
    "OOOOOO",
  ];
  assert.notEqual(boardHash(SAMPLE_ROWS), boardHash(other));
});

// ---------------------------------------------------------------------------
// Cross-tier dedup tests
// ---------------------------------------------------------------------------

test("cross-tier dedup keeps best difficulty match", () => {
  const rows = ["OOOOO", "OR  O", "OX  O", "OS  O", "OOOOO"];

  const cands = [
    { rows, intended: "beginner" as Difficulty, classified: "beginner" as Difficulty },
    { rows, intended: "advanced" as Difficulty, classified: "beginner" as Difficulty },
  ];

  const gapA = Math.abs(difficultyGap(cands[0].intended, cands[0].classified));
  const gapB = Math.abs(difficultyGap(cands[1].intended, cands[1].classified));

  assert.ok(gapA < gapB, "beginner-intended has smaller gap than advanced-intended");

  assert.equal(boardHash(cands[0].rows), boardHash(cands[1].rows));
});

test("symmetry dedup rejects mirror-equivalent boards", () => {
  const original = ["OOOOO", "OR  O", "OX  O", "OS  O", "OOOOO"];
  const mirrored = original.map((r) => [...r].reverse().join(""));

  assert.notEqual(boardHash(original), boardHash(mirrored));
  assert.equal(symmetryHash(original), symmetryHash(mirrored));
});

// ---------------------------------------------------------------------------
// createGeneratedPuzzleId tests
// ---------------------------------------------------------------------------

test("createGeneratedPuzzleId uses gen-v2- prefix", () => {
  const id = createGeneratedPuzzleId(12345, SAMPLE_ROWS);
  assert.ok(id.startsWith("gen-v2-"), `expected gen-v2- prefix, got ${id}`);
  assert.ok(id.includes("12345"), `expected seed in id, got ${id}`);
});

test("createGeneratedPuzzleId is deterministic", () => {
  const id1 = createGeneratedPuzzleId(99, SAMPLE_ROWS);
  const id2 = createGeneratedPuzzleId(99, [...SAMPLE_ROWS]);
  assert.equal(id1, id2);
});

test("createGeneratedPuzzleId differs for different seeds", () => {
  const id1 = createGeneratedPuzzleId(1, SAMPLE_ROWS);
  const id2 = createGeneratedPuzzleId(2, SAMPLE_ROWS);
  assert.notEqual(id1, id2);
});

test("createGeneratedPuzzleId differs for different boards", () => {
  const other = ["OOOOOO", "OR   O", "OX   O", "OS   O", "OOOOOO"];
  const id1 = createGeneratedPuzzleId(1, SAMPLE_ROWS);
  const id2 = createGeneratedPuzzleId(1, other);
  assert.notEqual(id1, id2);
});

// ---------------------------------------------------------------------------
// Manifest structure tests (using type contracts)
// ---------------------------------------------------------------------------

test("manifest entry fields are well-typed", () => {
  const entry = {
    id: "gen-v2-100000-abcd1234",
    title: "Tutorial 1",
    difficulty: "tutorial" as Difficulty,
    seed: 100000,
    family: "linear" as const,
    boxCount: 2,
    mode: "plain" as const,
    boardHash: "abcd1234",
    symmetryHash: "efgh5678",
    tightened: true,
    cellsRemoved: 3,
    intendedDifficulty: "tutorial" as Difficulty,
    classifiedDifficulty: "tutorial" as Difficulty,
    difficultyGap: 0,
    solutionMoves: 8,
    solutionPushes: 3,
    totalFloor: 12,
  };

  assert.equal(typeof entry.id, "string");
  assert.ok(entry.id.startsWith("gen-v2-"));
  assert.equal(typeof entry.seed, "number");
  assert.equal(typeof entry.boardHash, "string");
  assert.equal(entry.boardHash.length, 8);
  assert.equal(typeof entry.symmetryHash, "string");
  assert.equal(typeof entry.tightened, "boolean");
  assert.equal(typeof entry.difficultyGap, "number");
  assert.ok(DIFFICULTIES.includes(entry.difficulty));
  assert.ok(DIFFICULTIES.includes(entry.intendedDifficulty));
  assert.ok(DIFFICULTIES.includes(entry.classifiedDifficulty));
});

test("manifest schemaVersion must be 1", () => {
  const manifest = {
    schemaVersion: 1 as const,
    generatorVersion: "2.1.0",
    catalogHash: "00000000",
    tierQuotas: Object.fromEntries(DIFFICULTIES.map((d) => [d, { target: 0, actual: 0 }])),
    puzzles: [],
  };

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.generatorVersion, "2.1.0");
  assert.equal(typeof manifest.catalogHash, "string");
  assert.ok(Array.isArray(manifest.puzzles));
  for (const d of DIFFICULTIES) {
    const quota = manifest.tierQuotas[d];
    assert.equal(typeof quota.target, "number");
    assert.equal(typeof quota.actual, "number");
  }
});

// ---------------------------------------------------------------------------
// Existing generated catalog invariant tests
// ---------------------------------------------------------------------------

test("current generated catalog has no duplicate IDs", () => {
  const catalogPath = join(__dirname, "../../src/catalog/generated-puzzles.json");

  let puzzles: { id: string; rows: string[] }[];
  try {
    puzzles = JSON.parse(readFileSync(catalogPath, "utf-8"));
  } catch {
    return;
  }

  const ids = new Set<string>();
  for (const p of puzzles) {
    assert.ok(!ids.has(p.id), `Duplicate ID in generated catalog: ${p.id}`);
    ids.add(p.id);
  }
});

test("current generated catalog board hash uniqueness check", () => {
  const catalogPath = join(__dirname, "../../src/catalog/generated-puzzles.json");

  let puzzles: { id: string; rows: string[] }[];
  try {
    puzzles = JSON.parse(readFileSync(catalogPath, "utf-8"));
  } catch {
    return;
  }

  const hashes = new Map<string, string>();
  const duplicates: string[] = [];
  for (const p of puzzles) {
    const hash = boardHash(p.rows);
    const existing = hashes.get(hash);
    if (existing) {
      duplicates.push(`${p.id} duplicates ${existing} (hash=${hash})`);
    }
    hashes.set(hash, p.id);
  }

  if (puzzles.some((p) => p.id.startsWith("gen-v2-"))) {
    assert.equal(
      duplicates.length,
      0,
      `V2.1+ catalog must have no duplicate board hashes: ${duplicates.join("; ")}`,
    );
  }
});

test("V1 benchmark fixture exists and has expected structure", () => {
  const fixturePath = join(__dirname, "../fixtures/generator/v1-generated-benchmark.json");

  let entries: { id: string; difficulty: string; boxes: number }[];
  try {
    entries = JSON.parse(readFileSync(fixturePath, "utf-8"));
  } catch {
    assert.fail("V1 benchmark fixture must exist");
    return;
  }

  assert.ok(entries.length > 0, "benchmark fixture must have entries");
  for (const entry of entries) {
    assert.equal(typeof entry.id, "string");
    assert.ok(DIFFICULTIES.includes(entry.difficulty as Difficulty));
    assert.equal(typeof entry.boxes, "number");
  }
});
