import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  createInitialState,
  editorReducer,
  type EditorAction,
  type EditorState,
} from "./editor-model";

const MAX_UNDO = 50;
const DRAFT_KEY = "sokomind.editor-draft.v1";
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

function saveDraft(state: EditorState): void {
  try {
    const serializable = {
      width: state.width,
      height: state.height,
      cells: state.cells,
      title: state.title,
      difficulty: state.difficulty,
      hint: state.hint,
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(serializable));
  } catch {
    // Storage may be full or unavailable
  }
}

function loadDraft(): EditorState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.width !== "number" ||
      typeof parsed.height !== "number" ||
      !Array.isArray(parsed.cells) ||
      typeof parsed.title !== "string" ||
      typeof parsed.difficulty !== "string"
    ) {
      return null;
    }
    return {
      width: parsed.width,
      height: parsed.height,
      cells: parsed.cells as string[][],
      title: parsed.title,
      difficulty: parsed.difficulty as EditorState["difficulty"],
      hint: typeof parsed.hint === "string" ? parsed.hint : "",
      selectedTool: "O",
    };
  } catch {
    return null;
  }
}

export function clearEditorDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // silently ignore
  }
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
}

export function useEditorState(): EditorStateResult {
  const [history, rawDispatch] = useReducer(historyReducer, undefined, createInitialHistory);
  const saveTimerRef = useRef<number | undefined>(undefined);

  const dispatch = useCallback(
    (action: EditorAction) => rawDispatch({ type: "dispatch", action }),
    [],
  );
  const undo = useCallback(() => rawDispatch({ type: "undo" }), []);
  const redo = useCallback(() => rawDispatch({ type: "redo" }), []);

  const currentState = history.current;
  useEffect(() => {
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveDraft(currentState);
    }, SAVE_DELAY);
    return () => window.clearTimeout(saveTimerRef.current);
  }, [currentState]);

  return {
    state: history.current,
    dispatch,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
