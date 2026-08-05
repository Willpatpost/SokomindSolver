import assert from "node:assert/strict";
import test from "node:test";
import { parseHash } from "../../src/router/parse-hash.ts";
import {
  createShareUrl,
  playHash,
  editorHash,
  puzzleCollectionPageHash,
  puzzleDifficultyPageHash,
  puzzlesHash,
  homeHash,
} from "../../src/router/navigation.ts";

test("parses play route with action log", () => {
  const result = parseHash("#/play/grand-hall?play=UDLR");
  assert.equal(result.kind, "route");
  if (result.kind === "route") {
    assert.equal(result.route.page, "play");
    if (result.route.page === "play") {
      assert.equal(result.route.puzzleId, "grand-hall");
      assert.equal(result.route.actionLog, "UDLR");
    }
  }
});

test("parses play route without action log", () => {
  const result = parseHash("#/play/huge");
  assert.equal(result.kind, "route");
  if (result.kind === "route" && result.route.page === "play") {
    assert.equal(result.route.puzzleId, "huge");
    assert.equal(result.route.actionLog, undefined);
  }
});

test("falls back to home for a malformed encoded puzzle id", () => {
  const result = parseHash("#/play/%E0%A4%A");
  assert.equal(result.kind, "route");
  if (result.kind === "route") assert.equal(result.route.page, "home");
});

test("parses home route", () => {
  const r1 = parseHash("#/");
  const r2 = parseHash("");
  assert.equal(r1.kind, "route");
  assert.equal(r2.kind, "route");
  if (r1.kind === "route") assert.equal(r1.route.page, "home");
  if (r2.kind === "route") assert.equal(r2.route.page, "home");
});

test("parses puzzle selector routes", () => {
  const r1 = parseHash("#/puzzles");
  assert.equal(r1.kind, "route");
  if (r1.kind === "route") assert.equal(r1.route.page, "puzzles");

  const r2 = parseHash("#/puzzles/intermediate");
  assert.equal(r2.kind, "route");
  if (r2.kind === "route") assert.equal(r2.route.page, "puzzles-difficulty");

  const r3 = parseHash("#/puzzles/intermediate/Sokomind%20Generated");
  assert.equal(r3.kind, "route");
  if (r3.kind === "route") assert.equal(r3.route.page, "puzzles-collection");

  const paged = parseHash("#/puzzles/intermediate/Sokomind%20Generated?page=7");
  assert.equal(paged.kind, "route");
  if (paged.kind === "route" && paged.route.page === "puzzles-collection") {
    assert.equal(paged.route.pageNumber, 7);
  }

  const invalidPage = parseHash("#/puzzles/intermediate/Sokomind%20Generated?page=-1");
  assert.equal(invalidPage.kind, "route");
  if (
    invalidPage.kind === "route" &&
    invalidPage.route.page === "puzzles-collection"
  ) {
    assert.equal(invalidPage.route.pageNumber, undefined);
  }
});

test("decodes valid collection names and rejects malformed encodings", () => {
  const encoded = parseHash("#/puzzles/intermediate/Small%20Rooms");
  assert.equal(encoded.kind, "route");
  if (encoded.kind === "route") {
    assert.equal(encoded.route.page, "puzzles-collection");
    if (encoded.route.page === "puzzles-collection") {
      assert.equal(encoded.route.collection, "Small Rooms");
    }
  }

  const malformed = parseHash("#/puzzles/intermediate/%");
  assert.equal(malformed.kind, "route");
  if (malformed.kind === "route") {
    assert.equal(malformed.route.page, "home");
  }
});

test("parses editor route with custom data", () => {
  const result = parseHash("#/editor?custom=abc123");
  assert.equal(result.kind, "route");
  if (result.kind === "route" && result.route.page === "editor") {
    assert.equal(result.route.customData, "abc123");
  }
});

test("redirects legacy puzzle hash", () => {
  const result = parseHash("#puzzle=grand-hall");
  assert.equal(result.kind, "redirect");
  if (result.kind === "redirect") {
    assert.equal(result.hash, "#/play/grand-hall");
  }
});

test("redirects legacy puzzle hash with play", () => {
  const result = parseHash("#puzzle=huge&play=RR");
  assert.equal(result.kind, "redirect");
  if (result.kind === "redirect") {
    assert.equal(result.hash, "#/play/huge?play=RR");
  }
});

test("redirects legacy custom hash", () => {
  const result = parseHash("#custom=encodeddata");
  assert.equal(result.kind, "redirect");
  if (result.kind === "redirect") {
    assert.equal(result.hash, "#/editor?custom=encodeddata");
  }
});

test("navigation helpers produce correct hashes", () => {
  assert.equal(homeHash(), "#/");
  assert.equal(puzzlesHash(), "#/puzzles");
  assert.equal(playHash("huge"), "#/play/huge");
  assert.equal(playHash("huge", "UDLR"), "#/play/huge?play=UDLR");
  assert.equal(editorHash(), "#/editor");
  assert.equal(editorHash("abc"), "#/editor?custom=abc");
  assert.equal(
    puzzleDifficultyPageHash("intermediate", 2),
    "#/puzzles/intermediate?page=2",
  );
  assert.equal(
    puzzleCollectionPageHash("intermediate", "Sokomind Generated", 3),
    "#/puzzles/intermediate/Sokomind%20Generated?page=3",
  );
  assert.equal(
    puzzleCollectionPageHash("intermediate", "Sokomind Generated", 1),
    "#/puzzles/intermediate/Sokomind%20Generated",
  );
});

test("preserves a static-site path when creating share URLs", () => {
  const url = createShareUrl(
    { origin: "https://example.test", pathname: "/Sokomind/index.html" },
    "huge",
    "RR",
  );
  assert.equal(
    url,
    "https://example.test/Sokomind/index.html#/play/huge?play=RR",
  );
});
