import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  assertUniquePuzzleIds,
  assertValidPuzzleCatalog,
  createPuzzleByIdIndex,
} from "../../src/catalog/catalog-validation.ts";
import {
  getMetadataBoxCounts,
  getMetadataCollectionsForDifficulty,
  getPuzzleMetadataByDifficulty,
  getPuzzleMetadataById,
  getPuzzleMetadataIndexById,
  parsePuzzleMetadata,
} from "../../src/catalog/puzzle-metadata.ts";
import {
  configurePuzzleLoader,
  loadPuzzleById,
  resetPuzzleLoader,
} from "../../src/catalog/puzzle-loader.ts";
import {
  estimatePuzzleComplexity,
  getBoxCountsForFilter,
  getCatalogDiversityStats,
  getCollectionsForDifficulty,
  getOrderedPuzzleIds,
  getPuzzleById,
  groupPuzzlesByDifficulty,
  PUZZLE_BY_ID,
  SOKOMIND_ORIGINALS,
} from "../../src/catalog/puzzles.ts";

const originalFetch = globalThis.fetch;
const shardUrls = {
  "./puzzle-shards/puzzle-shard-000.json": "/puzzle-shard-000.json",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetPuzzleLoader();
});

function respondWith(value: unknown): void {
  globalThis.fetch = async () => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const VALID_METADATA_TUPLE: readonly unknown[] = [
  "example",
  "Example",
  "tutorial",
  1,
  5,
  5,
  "Test Collection",
  "puzzle-shard-000",
];

function metadataDocument(tuple: unknown): unknown {
  return { version: 1, puzzles: [tuple] };
}

test("catalog and metadata documents reject malformed top-level values", () => {
  for (const value of [null, {}, "catalog", 42]) {
    assert.throws(
      () => assertValidPuzzleCatalog(value, "Imported catalog"),
      /Imported catalog must be an array/,
      `catalog value ${JSON.stringify(value)}`,
    );
  }

  assert.throws(
    () => assertValidPuzzleCatalog([null], "Imported catalog"),
    /Imported catalog entry 0 is invalid: Puzzle must be an object/,
  );

  for (const value of [
    null,
    [],
    {},
    { version: 2, puzzles: [] },
    { version: 1, puzzles: null },
  ]) {
    assert.throws(
      () => parsePuzzleMetadata(value),
      /Puzzle metadata must contain version 1 and a puzzles array/,
      `metadata value ${JSON.stringify(value)}`,
    );
  }
});

test("catalog validation fails fast with source, index, id, and validation errors", () => {
  assert.throws(
    () => assertValidPuzzleCatalog([
      {
        id: "broken",
        title: "Broken",
        difficulty: "tutorial",
        boxes: 1,
        rows: ["OOO", "ORO", "OOO"],
      },
    ], "Imported catalog"),
    /Imported catalog entry 0 \("broken"\) is invalid:.*box/i,
  );
});

test("catalog validation rejects malformed optional metadata and freezes valid values", () => {
  const ultraTiny = PUZZLE_BY_ID["ultra-tiny"];
  assert.ok(ultraTiny);

  const invalidValues: readonly (readonly [string, unknown, RegExp])[] = [
    ["collection type", { ...ultraTiny, collection: 7 }, /collection must be a non-empty string/i],
    ["blank collection", { ...ultraTiny, collection: "  " }, /collection must be a non-empty string/i],
    ["null complexity", { ...ultraTiny, complexity: null }, /complexity\.estimatedDifficulty/i],
    ["array complexity", { ...ultraTiny, complexity: [] }, /complexity\.estimatedDifficulty/i],
    ["complexity type", { ...ultraTiny, complexity: "hard" }, /complexity\.estimatedDifficulty/i],
    [
      "estimated difficulty type",
      { ...ultraTiny, complexity: { estimatedDifficulty: "hard" } },
      /finite non-negative number/i,
    ],
    [
      "non-finite estimated difficulty",
      { ...ultraTiny, complexity: { estimatedDifficulty: Number.POSITIVE_INFINITY } },
      /finite non-negative number/i,
    ],
    [
      "negative estimated difficulty",
      { ...ultraTiny, complexity: { estimatedDifficulty: -1 } },
      /finite non-negative number/i,
    ],
  ];

  for (const [label, value, message] of invalidValues) {
    assert.throws(
      () => assertValidPuzzleCatalog([value], "Optional metadata catalog"),
      message,
      label,
    );
  }

  const [validated] = assertValidPuzzleCatalog([
    {
      ...ultraTiny,
      collection: "Test Collection",
      complexity: { estimatedDifficulty: 0 },
    },
  ], "Optional metadata catalog");
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.rows), true);
  assert.equal(Object.isFrozen(validated.complexity), true);
});

test("catalog validation rejects duplicate ids instead of overwriting them", () => {
  const puzzle = PUZZLE_BY_ID["ultra-tiny"];
  assert.ok(puzzle);
  assert.throws(
    () => assertValidPuzzleCatalog([puzzle, puzzle], "Imported catalog"),
    /entry 1.*duplicates puzzle id "ultra-tiny"/,
  );
  assert.throws(
    () => assertUniquePuzzleIds([puzzle, puzzle], "Combined catalog"),
    /entry 1.*duplicates puzzle id "ultra-tiny"/,
  );
});

test("puzzle indexes treat prototype-looking ids as ordinary keys", () => {
  const ultraTiny = PUZZLE_BY_ID["ultra-tiny"];
  assert.ok(ultraTiny);
  const [reservedIdPuzzle] = assertValidPuzzleCatalog([
    { ...ultraTiny, id: "__proto__" },
  ], "Reserved-id catalog");
  const index = createPuzzleByIdIndex([reservedIdPuzzle]);

  assert.equal(Object.getPrototypeOf(index), null);
  assert.equal(Object.hasOwn(index, "__proto__"), true);
  assert.equal(index.__proto__, reservedIdPuzzle);
});

test("metadata parsing reports every malformed tuple field", () => {
  for (const [label, tuple] of [
    ["non-array tuple", null],
    ["wrong tuple length", VALID_METADATA_TUPLE.slice(0, 7)],
  ] as const) {
    assert.throws(
      () => parsePuzzleMetadata(metadataDocument(tuple)),
      /Puzzle metadata entry 0(?: \("example"\))? must be an eight-field tuple/,
      label,
    );
  }

  const failures: readonly (readonly [
    label: string,
    index: number,
    value: unknown,
    message: RegExp,
  ])[] = [
    ["id type", 0, 7, /entry 0 has an invalid puzzle id/],
    ["blank id", 0, "   ", /entry 0 \(" {3}"\) has an invalid puzzle id/],
    ["title type", 1, null, /entry 0 \("example"\) has an invalid title/],
    ["blank title", 1, "\t", /entry 0 \("example"\) has an invalid title/],
    ["difficulty type", 2, 1, /entry 0 \("example"\) has an invalid difficulty/],
    ["unknown difficulty", 2, "impossible", /has an invalid difficulty/],
    ["fractional boxes", 3, 1.5, /has an invalid box count/],
    ["negative boxes", 3, -1, /has an invalid box count/],
    ["fractional width", 4, 2.5, /has an invalid width/],
    ["zero width", 4, 0, /has an invalid width/],
    ["fractional height", 5, 2.5, /has an invalid height/],
    ["negative height", 5, -1, /has an invalid height/],
    ["collection type", 6, false, /has an invalid collection/],
    ["blank collection", 6, " ", /has an invalid collection/],
    ["shard type", 7, 3, /has an invalid shard name/],
    ["malformed shard", 7, "puzzle-shard-1", /has an invalid shard name/],
  ];

  for (const [label, index, value, message] of failures) {
    const tuple = [...VALID_METADATA_TUPLE];
    tuple[index] = value;
    assert.throws(
      () => parsePuzzleMetadata(metadataDocument(tuple)),
      message,
      label,
    );
  }
});

test("metadata parsing rejects malformed and duplicate records", () => {
  assert.throws(
    () => parsePuzzleMetadata({
      version: 1,
      puzzles: [["bad", "Bad", "unknown", 1, 5, 5, "Test", "puzzle-shard-000"]],
    }),
    /entry 0 \("bad"\) has an invalid difficulty/,
  );
  assert.throws(
    () => parsePuzzleMetadata({
      version: 1,
      puzzles: [
        ["same", "One", "tutorial", 1, 5, 5, "Test", "puzzle-shard-000"],
        ["same", "Two", "tutorial", 1, 5, 5, "Test", "puzzle-shard-000"],
      ],
    }),
    /entry 1 duplicates puzzle id "same"/,
  );
});

test("the pure puzzle loader requires explicit composition-root configuration", async () => {
  await assert.rejects(
    loadPuzzleById("ultra-tiny"),
    /Puzzle loader is not configured/,
  );
  assert.equal(await loadPuzzleById("not-in-generated-metadata"), undefined);
});

test("the puzzle loader rejects missing, failed, empty, and wrapped shard modules", async () => {
  configurePuzzleLoader({ shardUrls: {}, isProd: false });
  await assert.rejects(
    loadPuzzleById("ultra-tiny"),
    /Missing puzzle board shard: puzzle-shard-000/,
  );

  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) return new Response("Unavailable", { status: 503 });
    const ultraTiny = PUZZLE_BY_ID["ultra-tiny"];
    assert.ok(ultraTiny);
    return new Response(JSON.stringify([ultraTiny]), { status: 200 });
  };
  configurePuzzleLoader({ shardUrls, isProd: false });
  await assert.rejects(
    loadPuzzleById("ultra-tiny"),
    /Puzzle board shard request failed: 503/,
  );
  assert.equal((await loadPuzzleById("ultra-tiny"))?.id, "ultra-tiny");
  assert.equal(requests, 2, "a rejected shard request must remain retryable");

  respondWith({ default: [] });
  configurePuzzleLoader({ shardUrls, isProd: false });
  await assert.rejects(
    loadPuzzleById("ultra-tiny"),
    /Puzzle board shard puzzle-shard-000 must be an array/,
  );

  respondWith([]);
  configurePuzzleLoader({ shardUrls, isProd: false });
  await assert.rejects(
    loadPuzzleById("ultra-tiny"),
    /Puzzle board shard puzzle-shard-000 is missing "ultra-tiny"/,
  );
});

test("lazy shards reject valid puzzles that have no generated metadata", async () => {
  const ultraTiny = PUZZLE_BY_ID["ultra-tiny"];
  assert.ok(ultraTiny);
  respondWith([{ ...ultraTiny, id: "not-in-generated-metadata" }]);
  configurePuzzleLoader({ shardUrls, isProd: false });

  await assert.rejects(
    loadPuzzleById("ultra-tiny"),
    /entry 0 has no generated metadata: "not-in-generated-metadata"/,
  );
});

test("lazy shards receive the same complete validation as the source catalog", async () => {
  respondWith([{ id: "broken" }]);
  configurePuzzleLoader({ shardUrls, isProd: false });

  await assert.rejects(
    loadPuzzleById("ultra-tiny"),
    /Puzzle board shard puzzle-shard-000 entry 0 \("broken"\) is invalid/,
  );
});

test("lazy shards must match generated metadata and contain the requested puzzle", async () => {
  const ultraTiny = PUZZLE_BY_ID["ultra-tiny"];
  const tiny = PUZZLE_BY_ID.tiny;
  assert.ok(ultraTiny);
  assert.ok(tiny);

  respondWith([{ ...ultraTiny, title: "Changed after metadata generation" }]);
  configurePuzzleLoader({ shardUrls, isProd: false });
  await assert.rejects(
    loadPuzzleById("ultra-tiny"),
    /does not match generated metadata/,
  );

  resetPuzzleLoader();
  respondWith([tiny]);
  configurePuzzleLoader({ shardUrls, isProd: false });
  await assert.rejects(
    loadPuzzleById("ultra-tiny"),
    /is missing "ultra-tiny"/,
  );
});

test("a valid lazy shard returns a frozen, metadata-aligned puzzle", async () => {
  const ultraTiny = PUZZLE_BY_ID["ultra-tiny"];
  assert.ok(ultraTiny);
  respondWith([ultraTiny]);
  configurePuzzleLoader({ shardUrls, isProd: false });

  const loaded = await loadPuzzleById("ultra-tiny");
  assert.equal(loaded?.id, "ultra-tiny");
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded?.rows), true);
});

test("a validated shard is reused and production loading tolerates no service worker", async () => {
  const ultraTiny = PUZZLE_BY_ID["ultra-tiny"];
  const tiny = PUZZLE_BY_ID.tiny;
  assert.ok(ultraTiny);
  assert.ok(tiny);

  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify([ultraTiny, tiny]), { status: 200 });
  };
  configurePuzzleLoader({ shardUrls, isProd: true });

  assert.equal((await loadPuzzleById("ultra-tiny"))?.id, "ultra-tiny");
  assert.equal((await loadPuzzleById("tiny"))?.id, "tiny");
  assert.equal(requests, 1);
});

test("route-facing catalog helpers handle known, filtered, and missing values", () => {
  const metadata = getPuzzleMetadataById("ultra-tiny");
  assert.equal(metadata?.title, "First Steps");
  assert.ok(getPuzzleMetadataIndexById("ultra-tiny") >= 0);
  assert.equal(getPuzzleMetadataById("not-a-puzzle"), undefined);
  assert.equal(getPuzzleMetadataIndexById("not-a-puzzle"), -1);

  const tutorialMetadata = getPuzzleMetadataByDifficulty("tutorial");
  assert.ok(tutorialMetadata.length > 0);
  assert.ok(tutorialMetadata.every((puzzle) => puzzle.difficulty === "tutorial"));

  const collections = getMetadataCollectionsForDifficulty("intermediate");
  assert.equal(collections[0]?.name, SOKOMIND_ORIGINALS);
  assert.ok(collections.length >= 1);
  assert.deepEqual(
    collections.slice(1).map(({ name }) => name),
    collections.slice(1).map(({ name }) => name).sort((left, right) =>
      left.localeCompare(right)),
  );

  const boxCounts = getMetadataBoxCounts("intermediate", SOKOMIND_ORIGINALS);
  assert.ok(boxCounts.length > 0);
  assert.deepEqual(boxCounts, [...new Set(boxCounts)].sort((left, right) => left - right));

  assert.deepEqual(
    getCollectionsForDifficulty("intermediate"),
    collections,
  );
  assert.deepEqual(
    getBoxCountsForFilter("intermediate", SOKOMIND_ORIGINALS),
    boxCounts,
  );

  assert.equal(getPuzzleById("ultra-tiny")?.title, "First Steps");
  assert.equal(getPuzzleById("toString"), undefined);
  assert.equal(getPuzzleById("__proto__"), undefined);
  assert.equal(Object.getPrototypeOf(PUZZLE_BY_ID), null);
  assert.deepEqual(getOrderedPuzzleIds({ search: "grand hall" }), ["huge"]);
  assert.ok(
    groupPuzzlesByDifficulty().tutorial.some((puzzle) => puzzle.id === "ultra-tiny"),
  );

  const ultraTiny = getPuzzleById("ultra-tiny");
  assert.ok(ultraTiny);
  assert.ok(estimatePuzzleComplexity(ultraTiny) > 0);
  assert.equal(estimatePuzzleComplexity({ ...ultraTiny, rows: [""] }), 0);

  const diversity = getCatalogDiversityStats();
  assert.equal(
    Object.values(diversity.countPerDifficulty).reduce((sum, count) => sum + count, 0),
    diversity.totalPuzzles,
  );
  assert.equal(
    Object.values(diversity.countPerCollection).reduce((sum, count) => sum + count, 0),
    diversity.totalPuzzles,
  );
  assert.equal(diversity.hasLabeledBoxes, true);
});
