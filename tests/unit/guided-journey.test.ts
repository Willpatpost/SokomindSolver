import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PuzzleMetadata } from "../../src/catalog/puzzle-metadata.ts";
import {
  GUIDED_JOURNEY_CHAPTERS,
  getJourneyChapterProgress,
  getJourneyRecommendation,
} from "../../src/features/journey/guided-journey.ts";
import {
  DEFAULT_GUIDED_JOURNEY_PREFERENCES,
  parseGuidedJourneyPreferences,
  saveGuidedJourneyPreferences,
} from "../../src/features/journey/guided-journey-preferences.ts";
import type { ProgressData } from "../../src/shared/progress.ts";
import { STORAGE_KEYS } from "../../src/shared/storage.ts";

const EMPTY: ProgressData = { version: 2, completed: {}, daily: {}, activity: {} };

function metadata(id: string, title = id): PuzzleMetadata {
  return {
    id,
    title,
    difficulty: "tutorial",
    boxes: 1,
    width: 3,
    height: 3,
    collection: "Test",
    shard: "puzzle-shard-000",
    puzzleFingerprint: "puzzle-v1:12345678",
  };
}

function completed(...ids: string[]): ProgressData {
  return {
    ...EMPTY,
    completed: Object.fromEntries(ids.map((id) => [id, {
      moves: 5,
      pushes: 2,
      completedAt: "2026-08-28T12:00:00.000Z",
    }])),
  };
}

describe("guided journey", () => {
  it("curates ordered concept chapters with explicit prerequisites", () => {
    assert.equal(GUIDED_JOURNEY_CHAPTERS.length, 5);
    assert.deepEqual(GUIDED_JOURNEY_CHAPTERS[0].prerequisiteChapterIds, []);
    for (let index = 1; index < GUIDED_JOURNEY_CHAPTERS.length; index++) {
      assert.deepEqual(
        GUIDED_JOURNEY_CHAPTERS[index].prerequisiteChapterIds,
        [GUIDED_JOURNEY_CHAPTERS[index - 1].id],
      );
      assert.ok(GUIDED_JOURNEY_CHAPTERS[index].explanation.length > 30);
    }
  });

  it("recommends the first unsolved curated room deterministically", () => {
    const chapter = GUIDED_JOURNEY_CHAPTERS[0];
    const puzzles = chapter.puzzleIds.map((id, index) => metadata(id, `Room ${index + 1}`));
    const progress = completed(chapter.puzzleIds[0]);
    const first = getJourneyRecommendation(progress, puzzles);
    const second = getJourneyRecommendation(progress, [...puzzles].reverse());

    assert.deepEqual(first, second);
    assert.equal(first?.puzzleId, chapter.puzzleIds[1]);
    assert.match(first?.reason ?? "", /next unsolved room/i);
    assert.match(first?.reason ?? "", /2 of 4/i);
  });

  it("explains an earlier foundation without treating prerequisites as locks", () => {
    const chapters = [
      {
        ...GUIDED_JOURNEY_CHAPTERS[0],
        id: "missing-foundation",
        puzzleIds: ["not-in-catalog"],
      },
      {
        ...GUIDED_JOURNEY_CHAPTERS[1],
        prerequisiteChapterIds: ["missing-foundation"],
        puzzleIds: ["later-room"],
      },
    ];
    const recommendation = getJourneyRecommendation(
      EMPTY,
      [metadata("later-room", "Later Room")],
      chapters,
    );

    assert.equal(recommendation?.puzzleId, "later-room");
    assert.match(recommendation?.reason ?? "", /may still play any later room/i);
  });

  it("reports chapter progress using only puzzle ids present in the catalog", () => {
    const chapter = GUIDED_JOURNEY_CHAPTERS[0];
    const catalog = chapter.puzzleIds.slice(0, 2).map((id) => metadata(id));
    const [state] = getJourneyChapterProgress(completed(chapter.puzzleIds[0]), catalog);

    assert.equal(state.total, 2);
    assert.equal(state.solved, 1);
    assert.equal(state.complete, false);
    assert.deepEqual(state.puzzleIds, chapter.puzzleIds.slice(0, 2));
  });

  it("returns no recommendation after every curated catalog room is cleared", () => {
    const ids = GUIDED_JOURNEY_CHAPTERS.flatMap(({ puzzleIds }) => puzzleIds);
    assert.equal(
      getJourneyRecommendation(completed(...ids), ids.map((id) => metadata(id))),
      null,
    );
  });
});

describe("guided journey preferences", () => {
  it("reports an unavailable durable pause or resume write", () => {
    assert.deepEqual(
      saveGuidedJourneyPreferences({ version: 1, dismissed: true }),
      {
        ok: false,
        key: STORAGE_KEYS.guidedJourney,
        operation: "write",
        reason: "unavailable",
      },
    );
  });

  it("fails closed for malformed or incompatible state", () => {
    assert.equal(parseGuidedJourneyPreferences(null), DEFAULT_GUIDED_JOURNEY_PREFERENCES);
    assert.equal(parseGuidedJourneyPreferences("not-json"), DEFAULT_GUIDED_JOURNEY_PREFERENCES);
    assert.equal(
      parseGuidedJourneyPreferences('{"version":2,"dismissed":true}'),
      DEFAULT_GUIDED_JOURNEY_PREFERENCES,
    );
  });

  it("retains a valid dismiss or resume choice", () => {
    assert.deepEqual(
      parseGuidedJourneyPreferences('{"version":1,"dismissed":true}'),
      { version: 1, dismissed: true },
    );
    assert.deepEqual(
      parseGuidedJourneyPreferences('{"version":1,"dismissed":false}'),
      { version: 1, dismissed: false },
    );
  });
});
