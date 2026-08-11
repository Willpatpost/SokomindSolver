import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { trackPersistenceResult } from "@/src/shared/persistence-health";
import {
  STORAGE_KEYS,
  readStoredValue,
  removeStoredValue,
  writeStoredValue,
  type StorageMutationResult,
} from "@/src/shared/storage";
import {
  createInitialState,
  editorReducer,
  type EditorAction,
  type EditorState,
} from "./editor-model";
import { parseEditorDraft, serializeEditorDraft } from "./editor-draft";

const MAX_UNDO = 50;
const SAVE_DELAY = 1000;

interface HistoryState {
  readonly current: EditorState;
  readonly past: readonly EditorState[];
  readonly future: readonly EditorState[];
}

type HistoryAction =
  | { type: "dispatch"; action: EditorAction }
  | { type: "undo" }
  | { type: "redo" };

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case "dispatch": {
      const next = editorReducer(state.current, action.action);
      if (next === state.current) return state;
      const skipHistory = action.action.type === "set-tool";
      if (skipHistory) return { ...state, current: next };
      const past = state.past.length >= MAX_UNDO
        ? [...state.past.slice(1), state.current]
        : [...state.past, state.current];
      return { current: next, past, future: [] };
    }
    case "undo": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        current: { ...previous, selectedTool: state.current.selectedTool },
        past: state.past.slice(0, -1),
        future: [state.current, ...state.future],
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        current: { ...next, selectedTool: state.current.selectedTool },
        past: [...state.past, state.current],
        future: state.future.slice(1),
      };
    }
  }
}

export function saveEditorDraft(state: EditorState): StorageMutationResult {
  const serialized = serializeEditorDraft(state);
  const retry = () => {
    trackPersistenceResult(
      writeStoredValue(STORAGE_KEYS.editorDraft, serialized),
      retry,
    );
  };
  const result = writeStoredValue(STORAGE_KEYS.editorDraft, serialized);
  return trackPersistenceResult(result, retry);
}

function loadDraft(): EditorState | null {
  const raw = readStoredValue(STORAGE_KEYS.editorDraft);
  const draft = parseEditorDraft(raw);
  if (draft || !raw) return draft;

  // Preserve the raw payload for scoped recovery instead of allowing a bad
  // nested shape to reach rendering or asking the user to reset all app data.
  const backup = trackPersistenceResult(
    writeStoredValue(STORAGE_KEYS.editorDraftRecovery, raw),
  );
  if (backup.ok) {
    trackPersistenceResult(removeStoredValue(STORAGE_KEYS.editorDraft));
  }
  return null;
}

export function clearEditorDraft(): void {
  trackPersistenceResult(removeStoredValue(STORAGE_KEYS.editorDraft));
}

function createInitialHistory(): HistoryState {
  const draft = loadDraft();
  return { current: draft ?? createInitialState(), past: [], future: [] };
}

export interface EditorStateResult {
  readonly state: EditorState;
  readonly dispatch: (action: EditorAction) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly recoveryDraft: string | null;
  readonly clearRecoveryDraft: () => void;
}

export function useEditorState(options: { readonly autosave?: boolean } = {}): EditorStateResult {
  const [history, rawDispatch] = useReducer(historyReducer, undefined, createInitialHistory);
  const [recoveryDraft, setRecoveryDraft] = useState(
    () => readStoredValue(STORAGE_KEYS.editorDraftRecovery),
  );
  const saveTimerRef = useRef<number | undefined>(undefined);
  const latestStateRef = useRef(history.current);
  const autosaveEnabledRef = useRef(options.autosave !== false);

  const dispatch = useCallback(
    (action: EditorAction) => rawDispatch({ type: "dispatch", action }),
    [],
  );
  const undo = useCallback(() => rawDispatch({ type: "undo" }), []);
  const redo = useCallback(() => rawDispatch({ type: "redo" }), []);

  const currentState = history.current;
  useEffect(() => {
    latestStateRef.current = currentState;
    autosaveEnabledRef.current = options.autosave !== false;
  }, [currentState, options.autosave]);

  useEffect(() => {
    if (options.autosave === false) return;
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveEditorDraft(currentState);
    }, SAVE_DELAY);
    return () => window.clearTimeout(saveTimerRef.current);
  }, [currentState, options.autosave]);

  useEffect(() => {
    const flushDraft = () => {
      if (autosaveEnabledRef.current) saveEditorDraft(latestStateRef.current);
    };
    window.addEventListener("pagehide", flushDraft);
    return () => window.removeEventListener("pagehide", flushDraft);
  }, []);

  const clearRecoveryDraft = useCallback(() => {
    const result = trackPersistenceResult(
      removeStoredValue(STORAGE_KEYS.editorDraftRecovery),
    );
    if (result.ok) setRecoveryDraft(null);
  }, []);

  return {
    state: history.current,
    dispatch,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    recoveryDraft,
    clearRecoveryDraft,
  };
}
