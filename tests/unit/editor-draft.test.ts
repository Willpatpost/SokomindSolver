import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEditorDraftStore,
  parseEditorDraft,
  parseEditorDraftStore,
  serializeEditorDraft,
  serializeEditorDraftStore,
} from "../../src/features/editor/editor-draft.ts";
import { createInitialState } from "../../src/features/editor/editor-model.ts";

test("editor draft validation round-trips a valid bounded grid", () => {
  const state = createInitialState();
  assert.deepEqual(parseEditorDraft(serializeEditorDraft(state)), state);
});

test("editor draft validation rejects shallow, ragged, oversized, and invalid-symbol grids", () => {
  const base = {
    width: 3,
    height: 3,
    cells: [["O", "O", "O"], ["O", "R", "O"], ["O", "O", "O"]],
    title: "Draft",
    difficulty: "beginner",
    hint: "",
  };
  assert.equal(parseEditorDraft(JSON.stringify({ ...base, cells: ["x"] })), null);
  assert.equal(parseEditorDraft(JSON.stringify({ ...base, cells: [["O"]] })), null);
  assert.equal(parseEditorDraft(JSON.stringify({ ...base, width: 21 })), null);
  assert.equal(parseEditorDraft(JSON.stringify({
    ...base,
    cells: [["O", "O", "O"], ["O", "?", "O"], ["O", "O", "O"]],
  })), null);
  assert.equal(parseEditorDraft(JSON.stringify({ ...base, difficulty: "impossible" })), null);
});

test("migrates a legacy single draft into a named local document", () => {
  const state = { ...createInitialState(), title: "Legacy room" };
  const parsed = parseEditorDraftStore(serializeEditorDraft(state));

  assert.equal(parsed?.migrated, true);
  assert.equal(parsed?.store.drafts.length, 1);
  assert.equal(parsed?.store.drafts[0].name, "Legacy room");
  assert.equal(parsed?.store.drafts[0].updatedAt, null);
  assert.deepEqual(parsed?.store.drafts[0].state, state);
});

test("named draft stores round-trip content and last-saved metadata", () => {
  const state = createInitialState();
  const initial = createEditorDraftStore(state);
  const store = {
    ...initial,
    drafts: [
      { ...initial.drafts[0], name: "First", updatedAt: "2026-08-14T12:00:00.000Z" },
      {
        id: "draft-2",
        name: "Second",
        updatedAt: "2026-08-14T12:01:00.000Z",
        state: { ...state, title: "Second puzzle" },
      },
    ],
    activeId: "draft-2",
  };

  const parsed = parseEditorDraftStore(serializeEditorDraftStore(store));
  assert.equal(parsed?.migrated, false);
  assert.deepEqual(parsed?.store, store);
});

test("rejects named stores with duplicate ids, missing active ids, or bad metadata", () => {
  const state = createInitialState();
  const document = {
    id: "draft-1",
    name: "Draft",
    updatedAt: "2026-08-14T12:00:00.000Z",
    state: JSON.parse(serializeEditorDraft(state)),
  };
  const value = { version: 2, activeId: "draft-1", drafts: [document] };

  assert.equal(parseEditorDraftStore(JSON.stringify({
    ...value,
    activeId: "missing",
  })), null);
  assert.equal(parseEditorDraftStore(JSON.stringify({
    ...value,
    drafts: [document, document],
  })), null);
  assert.equal(parseEditorDraftStore(JSON.stringify({
    ...value,
    drafts: [{ ...document, updatedAt: "yesterday" }],
  })), null);
});
