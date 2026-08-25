import { DIFFICULTIES } from "../../core/model.ts";
import {
  createInitialState,
  isTypedBoxSymbol,
  isTypedGoalSymbol,
  MAX_SIZE,
  MIN_SIZE,
  type EditorState,
} from "./editor-model.ts";

export const EDITOR_DRAFT_STORE_VERSION = 2 as const;
export const MAX_EDITOR_DRAFTS = 25;

export interface EditorDraftDocument {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string | null;
  readonly state: EditorState;
}

export interface EditorDraftStore {
  readonly version: typeof EDITOR_DRAFT_STORE_VERSION;
  readonly activeId: string;
  readonly drafts: readonly EditorDraftDocument[];
}

interface ParsedEditorDraftStore {
  readonly store: EditorDraftStore;
  readonly migrated: boolean;
}

function isEditorCell(value: unknown): value is string {
  return typeof value === "string" && (
    value === " " || value === "O" || value === "R" ||
    value === "S" || value === "X" ||
    isTypedBoxSymbol(value) || isTypedGoalSymbol(value)
  );
}

function editorDraftValue(state: EditorState): Record<string, unknown> {
  return {
    width: state.width,
    height: state.height,
    cells: state.cells,
    title: state.title,
    difficulty: state.difficulty,
    hint: state.hint,
  };
}

function parseEditorDraftValue(parsed: unknown): EditorState | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (
    !Number.isSafeInteger(value.width) ||
    Number(value.width) < MIN_SIZE || Number(value.width) > MAX_SIZE ||
    !Number.isSafeInteger(value.height) ||
    Number(value.height) < MIN_SIZE || Number(value.height) > MAX_SIZE ||
    !Array.isArray(value.cells) ||
    value.cells.length !== Number(value.height) ||
    !value.cells.every((row) =>
      Array.isArray(row) &&
      row.length === Number(value.width) &&
      row.every(isEditorCell)
    ) ||
    typeof value.title !== "string" || value.title.length > 60 ||
    typeof value.difficulty !== "string" ||
    !(DIFFICULTIES as readonly string[]).includes(value.difficulty) ||
    (value.hint !== undefined &&
      (typeof value.hint !== "string" || value.hint.length > 200))
  ) return null;
  return {
    width: Number(value.width),
    height: Number(value.height),
    cells: value.cells as string[][],
    title: value.title,
    difficulty: value.difficulty as EditorState["difficulty"],
    hint: typeof value.hint === "string" ? value.hint : "",
    selectedTool: "O",
  };
}

export function serializeEditorDraft(state: EditorState): string {
  return JSON.stringify(editorDraftValue(state));
}

export function parseEditorDraft(raw: string | null): EditorState | null {
  if (!raw) return null;
  try {
    return parseEditorDraftValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function parseStoredDocument(value: unknown): EditorDraftDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const document = value as Record<string, unknown>;
  const state = parseEditorDraftValue(document.state);
  if (
    typeof document.id !== "string" ||
    document.id.length === 0 || document.id.length > 100 ||
    typeof document.name !== "string" ||
    document.name.trim().length === 0 || document.name.length > 60 ||
    (document.updatedAt !== null && !isIsoTimestamp(document.updatedAt)) ||
    !state
  ) {
    return null;
  }
  return {
    id: document.id,
    name: document.name.trim(),
    updatedAt: document.updatedAt,
    state,
  };
}

export function createEditorDraftStore(
  state: EditorState = createInitialState(),
): EditorDraftStore {
  return {
    version: EDITOR_DRAFT_STORE_VERSION,
    activeId: "draft-1",
    drafts: [{ id: "draft-1", name: state.title.trim() || "Untitled", updatedAt: null, state }],
  };
}

export function serializeEditorDraftStore(store: EditorDraftStore): string {
  return JSON.stringify({
    version: EDITOR_DRAFT_STORE_VERSION,
    activeId: store.activeId,
    drafts: store.drafts.map((draft) => ({
      id: draft.id,
      name: draft.name,
      updatedAt: draft.updatedAt,
      state: editorDraftValue(draft.state),
    })),
  });
}

/** Parse the named store, or migrate the original single-draft payload. */
export function parseEditorDraftStore(raw: string | null): ParsedEditorDraftStore | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;

  if (value.version === EDITOR_DRAFT_STORE_VERSION) {
    if (
      typeof value.activeId !== "string" ||
      !Array.isArray(value.drafts) ||
      value.drafts.length === 0 || value.drafts.length > MAX_EDITOR_DRAFTS
    ) return null;
    const drafts = value.drafts.map(parseStoredDocument);
    if (drafts.some((draft) => !draft)) return null;
    const validDrafts = drafts as EditorDraftDocument[];
    const ids = new Set(validDrafts.map((draft) => draft.id));
    if (ids.size !== validDrafts.length || !ids.has(value.activeId)) return null;
    return {
      store: {
        version: EDITOR_DRAFT_STORE_VERSION,
        activeId: value.activeId,
        drafts: validDrafts,
      },
      migrated: false,
    };
  }

  const legacyState = parseEditorDraftValue(parsed);
  if (!legacyState) return null;
  return { store: createEditorDraftStore(legacyState), migrated: true };
}
