import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseEditorDraft,
  serializeEditorDraft,
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
