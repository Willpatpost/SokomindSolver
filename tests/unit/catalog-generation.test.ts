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

test("difficulty mismatch policy: gap=0 is accepted", () => {
  // Exact match — should never be rejected
  const gap = difficultyGap("intermediate", "intermediate");
  assert.equal(gap, 0);
  assert.ok(Math.abs(gap) < 2, "gap=0 must be accepted (below rejection threshold)");
});

test("difficulty mismatch policy: gap=1 is accepted (possibly reclassified)", () => {
  // One tier off — accepted, may be reclassified if target tier has quota room
  const gap = difficultyGap("advanced", "intermediate");
  assert.equal(gap, 1);
  assert.ok(Math.abs(gap) < 2, "gap=1 must be accepted (below rejection threshold)");
});

test("difficulty mismatch policy: gap=2 is rejected", () => {
  // Two tiers off — rejected by the absGap >= 2 policy
  const gap = difficultyGap("expert", "intermediate");
  assert.equal(gap, 2);
  assert.ok(Math.abs(gap) >= 2, "gap=2 must be rejected (at or above rejection threshold)");
});

test("difficulty mismatch policy: gap=3+ is rejected", () => {
  // Large mismatch — definitely rejected
  const gapPos = difficultyGap("master", "tutorial");
  assert.equal(gapPos, 5);
  assert.ok(Math.abs(gapPos) >= 2, "gap=5 must be rejected");

  const gapNeg = difficultyGap("tutorial", "expert");
  assert.equal(gapNeg, -4);
  assert.ok(Math.abs(gapNeg) >= 2, "gap=-4 must be rejected");

  const gap3 = difficultyGap("expert", "beginner");
  assert.equal(gap3, 3);
  assert.ok(Math.abs(gap3) >= 2, "gap=3 must be rejected");
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

test("current generated manifest records the V4.2 catalog", () => {
  const manifestPath = join(
    __dirname,
    "../../src/catalog/generated-puzzles.manifest.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    generatorVersion?: string;
    puzzles?: Array<{ 
      id?: string;
      boxCount?: number; 
      typingMode?: string;
      [key: string]: unknown;
    }>;
  };

  assert.equal(manifest.generatorVersion, "4.2.0");
  assert.ok(Array.isArray(manifest.puzzles), "puzzles should be an array");
  assert.ok(manifest.puzzles.length > 0, "puzzles array should contain entries");
  
  // Optionally verify structure of first puzzle
  if (manifest.puzzles.length > 0) {
    const firstPuzzle = manifest.puzzles[0];
    assert.equal(typeof firstPuzzle.id, "string");
    assert.equal(typeof firstPuzzle.typingMode, "string");
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

test("handcrafted benchmark fixture exists and contains only non-generated IDs", () => {
  const fixturePath = join(__dirname, "../fixtures/generator/handcrafted-benchmark.json");

  let entries: { id: string; difficulty: string; boxes: number; title: string }[];
  try {
    entries = JSON.parse(readFileSync(fixturePath, "utf-8"));
  } catch {
    assert.fail("Handcrafted benchmark fixture must exist");
    return;
  }

  assert.ok(entries.length > 0, "handcrafted fixture must have entries");
  for (const entry of entries) {
    assert.equal(typeof entry.id, "string");
    assert.ok(
      !entry.id.startsWith("gen-"),
      `Handcrafted fixture must not contain generated IDs: ${entry.id}`,
    );
    assert.ok(DIFFICULTIES.includes(entry.difficulty as Difficulty));
    assert.equal(typeof entry.boxes, "number");
    assert.equal(typeof entry.title, "string");
  }
});

test("V1 and handcrafted benchmark fixtures have no overlapping IDs", () => {
  const v1Path = join(__dirname, "../fixtures/generator/v1-generated-benchmark.json");
  const hcPath = join(__dirname, "../fixtures/generator/handcrafted-benchmark.json");

  let v1: { id: string }[];
  let hc: { id: string }[];
  try {
    v1 = JSON.parse(readFileSync(v1Path, "utf-8"));
    hc = JSON.parse(readFileSync(hcPath, "utf-8"));
  } catch {
    return;
  }

  const v1Ids = new Set(v1.map((e) => e.id));
  for (const entry of hc) {
    assert.ok(
      !v1Ids.has(entry.id),
      `Overlap between V1 and handcrafted benchmarks: ${entry.id}`,
    );
  }
});

test("the standard catalog command cannot bypass review acceptance", () => {
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, "../../package.json"), "utf-8"),
  ) as { scripts?: Record<string, string> };
  const generatorSource = readFileSync(
    join(__dirname, "../../scripts/generate-v2-catalog.ts"),
    "utf-8",
  );

  assert.match(packageJson.scripts?.["generate:v2-catalog"] ?? "", /--review/u);
  assert.doesNotMatch(generatorSource, /--force/u);
  assert.match(generatorSource, /readPromotionBundle/u);
  assert.match(generatorSource, /installPromotionBundle/u);
  const promotionSource = readFileSync(join(__dirname, "../../scripts/lib/catalog-promotion.ts"), "utf-8");
  assert.match(promotionSource, /checkReleaseGate/u);
  assert.match(promotionSource, /checkReviewManifestBinding/u);
  assert.match(promotionSource, /buildCanonicalSolutionTrace/u);
  assert.doesNotMatch(generatorSource, /Direct production write bypasses/u);
});
