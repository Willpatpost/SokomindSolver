import assert from "node:assert/strict";
import test from "node:test";

import { createCompletionPresentation } from "../../src/features/game/completion-presentation.ts";
import type { PuzzleRecord } from "../../src/shared/progress.ts";

function record(moves: number, pushes: number): PuzzleRecord {
  return {
    moves,
    pushes,
    completedAt: "2026-08-28T12:00:00.000Z",
  };
}

test("presents a first clear as a saved personal milestone", () => {
  const presentation = createCompletionPresentation({ moves: 7, pushes: 2 });

  assert.equal(presentation.eyebrow, "Personal milestone");
  assert.equal(
    presentation.summary,
    "First clear saved as your personal best.",
  );
  assert.equal(presentation.celebration, "personal-best");
  assert.equal(presentation.movesDelta, undefined);
  assert.equal(presentation.pushesDelta, undefined);
  assert.deepEqual(
    presentation.milestones.map(({ kind }) => kind),
    ["first-clear"],
  );
  assert.equal(Object.isFrozen(presentation), true);
  assert.equal(Object.isFrozen(presentation.milestones), true);
});

test("does not claim a first clear was saved after persistence fails", () => {
  const presentation = createCompletionPresentation({
    moves: 7,
    pushes: 2,
    progressSaved: false,
  });

  assert.equal(
    presentation.summary,
    "First clear completed, but browser storage could not save it.",
  );
  assert.match(presentation.milestones[0].detail, /could not save/u);
  assert.doesNotMatch(presentation.summary, /saved as/u);
});

test("labels an unsaved improvement without calling it a durable record", () => {
  const presentation = createCompletionPresentation({
    moves: 16,
    pushes: 6,
    previousBest: record(20, 8),
    progressSaved: false,
  });

  assert.match(presentation.summary, /could not save/u);
  assert.match(presentation.milestones[0].detail, /could not save/u);
  assert.match(presentation.milestones[1].detail, /could not save/u);
});

test("presents a move record and durable push improvement together", () => {
  const presentation = createCompletionPresentation({
    moves: 16,
    pushes: 6,
    previousBest: record(20, 8),
  });

  assert.equal(
    presentation.summary,
    "New personal best — 4 moves fewer.",
  );
  assert.equal(presentation.movesDelta, -4);
  assert.equal(presentation.pushesDelta, -2);
  assert.deepEqual(
    presentation.milestones.map(({ kind }) => kind),
    ["move-best", "push-improvement"],
  );
});

test("does not claim an unsaved push record for a worse-move route", () => {
  const presentation = createCompletionPresentation({
    moves: 22,
    pushes: 6,
    previousBest: record(20, 8),
  });

  assert.equal(presentation.celebration, "default");
  assert.deepEqual(presentation.milestones, []);
  assert.equal(
    presentation.summary,
    "Personal best: 20 moves. This route used 2 moves more.",
  );
});

test("reports a matched personal best without fabricating a milestone", () => {
  const presentation = createCompletionPresentation({
    moves: 20,
    pushes: 8,
    previousBest: record(20, 8),
  });

  assert.equal(presentation.summary, "Matched your personal best exactly.");
  assert.equal(presentation.celebration, "default");
  assert.deepEqual(presentation.milestones, []);
});

test("gives verified optimal and collection completion highest billing", () => {
  const presentation = createCompletionPresentation({
    moves: 1,
    pushes: 1,
    isOptimal: true,
    completedCollection: "Starter Rooms",
  });

  assert.equal(presentation.eyebrow, "Optimal solution");
  assert.equal(presentation.celebration, "optimal");
  assert.equal(presentation.isOptimal, true);
  assert.deepEqual(
    presentation.milestones.map(({ kind }) => kind),
    ["optimal-clear", "collection-complete", "first-clear"],
  );
  assert.match(presentation.milestones[0].detail, /known optimum/u);
  assert.match(presentation.milestones[1].detail, /Starter Rooms/u);
});
