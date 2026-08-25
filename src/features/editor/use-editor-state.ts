import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
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
import {
  MAX_EDITOR_DRAFTS,
  createEditorDraftStore,
  parseEditorDraftStore,
  serializeEditorDraftStore,
  type EditorDraftDocument,
  type EditorDraftStore,
} from "./editor-draft";

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
  | { type: "redo" }
  | { type: "replace"; state: EditorState };

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
    case "replace":
      return { current: action.state, past: [], future: [] };
  }
}

function saveEditorDraftStore(store: EditorDraftStore): StorageMutationResult {
  const serialized = serializeEditorDraftStore(store);
  const retry = () => {
    trackPersistenceResult(
      writeStoredValue(STORAGE_KEYS.editorDraft, serialized),
      retry,
    );
  };
  return trackPersistenceResult(
    writeStoredValue(STORAGE_KEYS.editorDraft, serialized),
    retry,
  );
}

interface InitialEditorData {
  readonly store: EditorDraftStore;
  readonly needsSave: boolean;
  readonly recoveryDraft: string | null;
}

function loadEditorData(): InitialEditorData {
  const raw = readStoredValue(STORAGE_KEYS.editorDraft);
  const parsed = parseEditorDraftStore(raw);
  if (parsed) {
    return {
      store: parsed.store,
      needsSave: parsed.migrated,
      recoveryDraft: readStoredValue(STORAGE_KEYS.editorDraftRecovery),
    };
  }
  if (!raw) {
    return {
      store: createEditorDraftStore(),
      needsSave: true,
      recoveryDraft: readStoredValue(STORAGE_KEYS.editorDraftRecovery),
    };
  }

  // Preserve the raw payload for scoped recovery before replacing it.
  const backup = trackPersistenceResult(
    writeStoredValue(STORAGE_KEYS.editorDraftRecovery, raw),
  );
  if (backup.ok) trackPersistenceResult(removeStoredValue(STORAGE_KEYS.editorDraft));
  return {
    store: createEditorDraftStore(),
    needsSave: backup.ok,
    recoveryDraft: raw,
  };
}

export interface EditorDraftSummary {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string | null;
}

export type EditorDraftOperationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

interface EditorStateResult {
  readonly state: EditorState;
  readonly dispatch: (action: EditorAction) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasPendingChanges: boolean;
  readonly drafts: readonly EditorDraftSummary[];
  readonly activeDraft: EditorDraftSummary;
  readonly createDraft: (options?: {
    readonly state?: EditorState;
    readonly name?: string;
    readonly preserveCurrent?: boolean;
  }) => EditorDraftOperationResult;
  readonly duplicateDraft: () => EditorDraftOperationResult;
  readonly renameDraft: (name: string) => EditorDraftOperationResult;
  readonly deleteDraft: () => EditorDraftOperationResult;
  readonly switchDraft: (id: string) => EditorDraftOperationResult;
  readonly restoreActiveDraft: () => void;
  readonly recoveryDraft: string | null;
  readonly clearRecoveryDraft: () => void;
  readonly pausePendingDraft: () => void;
  readonly resumePendingDraft: () => void;
  /** Suppress the pending autosave when the user explicitly chooses discard. */
  readonly discardPendingDraft: () => void;
}

function createDraftId(existingIds: ReadonlySet<string>): string {
  for (;;) {
    const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const id = `draft-${suffix}`;
    if (!existingIds.has(id)) return id;
  }
}

function mutationFailure(result: StorageMutationResult): EditorDraftOperationResult {
  if (result.ok) return { ok: true };
  const cause = result.reason === "quota-exceeded"
    ? "browser storage is full"
    : result.reason === "security-error"
      ? "the browser denied storage access"
      : "browser storage is unavailable";
  return { ok: false, message: `The draft was not changed because ${cause}.` };
}

export function useEditorState(options: { readonly autosave?: boolean } = {}): EditorStateResult {
  const [initial] = useState(loadEditorData);
  const activeInitial = initial.store.drafts.find(
    (draft) => draft.id === initial.store.activeId,
  )!;
  const [history, rawDispatch] = useReducer(historyReducer, {
    current: activeInitial.state,
    past: [],
    future: [],
  });
  const [drafts, setDrafts] = useState(initial.store.drafts);
  const [activeDraftId, setActiveDraftId] = useState(initial.store.activeId);
  const [recoveryDraft, setRecoveryDraft] = useState(initial.recoveryDraft);
  const [hasPendingChanges, setHasPendingChanges] = useState(initial.needsSave);
  const draftsRef = useRef(initial.store.drafts);
  const activeDraftIdRef = useRef(initial.store.activeId);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const latestStateRef = useRef(history.current);
  const autosaveEnabledRef = useRef(options.autosave !== false);
  const discardPendingRef = useRef(false);
  const pendingSaveRef = useRef(initial.needsSave);

  const publishStore = useCallback((
    nextDrafts: readonly EditorDraftDocument[],
    nextActiveId: string,
  ) => {
    draftsRef.current = nextDrafts;
    activeDraftIdRef.current = nextActiveId;
    setDrafts(nextDrafts);
    setActiveDraftId(nextActiveId);
  }, []);

  const savedCurrentDocuments = useCallback((
    state: EditorState,
    force = false,
  ): readonly EditorDraftDocument[] => {
    if (!pendingSaveRef.current && !force) return draftsRef.current;
    const updatedAt = new Date().toISOString();
    return draftsRef.current.map((draft) => draft.id === activeDraftIdRef.current
      ? { ...draft, state, updatedAt }
      : draft);
  }, []);

  const saveCurrentDraft = useCallback((state: EditorState, publish: boolean) => {
    if (!pendingSaveRef.current) return;
    const nextDrafts = savedCurrentDocuments(state);
    const result = saveEditorDraftStore({
      version: 2,
      activeId: activeDraftIdRef.current,
      drafts: nextDrafts,
    });
    if (!result.ok) {
      // Keep the latest in-memory document even when durable storage is
      // unavailable. A shared-preview route can then restore or import it
      // without reverting to the last successfully persisted revision.
      draftsRef.current = nextDrafts;
      return;
    }
    pendingSaveRef.current = false;
    if (publish) {
      publishStore(nextDrafts, activeDraftIdRef.current);
      setHasPendingChanges(false);
    }
    else draftsRef.current = nextDrafts;
  }, [publishStore, savedCurrentDocuments]);

  const dispatch = useCallback((action: EditorAction) => {
    if (action.type !== "set-tool") {
      pendingSaveRef.current = true;
      setHasPendingChanges(true);
    }
    rawDispatch({ type: "dispatch", action });
  }, []);
  const undo = useCallback(() => {
    pendingSaveRef.current = true;
    setHasPendingChanges(true);
    rawDispatch({ type: "undo" });
  }, []);
  const redo = useCallback(() => {
    pendingSaveRef.current = true;
    setHasPendingChanges(true);
    rawDispatch({ type: "redo" });
  }, []);

  const currentState = history.current;
  useLayoutEffect(() => {
    const nextAutosaveEnabled = options.autosave !== false;
    if (
      autosaveEnabledRef.current &&
      !nextAutosaveEnabled &&
      pendingSaveRef.current
    ) {
      // Entering a read-only shared preview keeps the component mounted. Flush
      // the editable document before the preview replaces the reducer state.
      saveCurrentDraft(currentState, true);
    }
    latestStateRef.current = currentState;
    autosaveEnabledRef.current = nextAutosaveEnabled;
    discardPendingRef.current = false;
  }, [currentState, options.autosave, saveCurrentDraft]);

  useEffect(() => {
    if (options.autosave === false || !pendingSaveRef.current) return;
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveCurrentDraft(currentState, true);
    }, SAVE_DELAY);
    return () => window.clearTimeout(saveTimerRef.current);
  }, [currentState, options.autosave, saveCurrentDraft]);

  useEffect(() => {
    const flushDraft = () => {
      window.clearTimeout(saveTimerRef.current);
      if (
        autosaveEnabledRef.current &&
        pendingSaveRef.current &&
        !discardPendingRef.current
      ) {
        saveCurrentDraft(latestStateRef.current, false);
      }
    };
    window.addEventListener("pagehide", flushDraft);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      flushDraft();
    };
  }, [saveCurrentDraft]);

  const commitOperation = useCallback((
    nextDrafts: readonly EditorDraftDocument[],
    nextActiveId: string,
    nextState?: EditorState,
  ): EditorDraftOperationResult => {
    const result = saveEditorDraftStore({
      version: 2,
      activeId: nextActiveId,
      drafts: nextDrafts,
    });
    if (!result.ok) return mutationFailure(result);
    pendingSaveRef.current = false;
    setHasPendingChanges(false);
    discardPendingRef.current = false;
    publishStore(nextDrafts, nextActiveId);
    if (nextState) {
      latestStateRef.current = nextState;
      rawDispatch({ type: "replace", state: nextState });
    }
    return { ok: true };
  }, [publishStore]);

  const createDraft = useCallback((createOptions: {
    readonly state?: EditorState;
    readonly name?: string;
    readonly preserveCurrent?: boolean;
  } = {}): EditorDraftOperationResult => {
    if (draftsRef.current.length >= MAX_EDITOR_DRAFTS) {
      return { ok: false, message: `You can keep up to ${MAX_EDITOR_DRAFTS} local drafts.` };
    }
    const state = createOptions.state ?? createInitialState();
    const requestedName = (createOptions.name ?? state.title ?? "New draft").trim();
    if (!requestedName) return { ok: false, message: "Give the draft a name." };
    const name = requestedName.slice(0, 60);
    const baseDrafts = createOptions.preserveCurrent
      ? draftsRef.current
      : savedCurrentDocuments(latestStateRef.current);
    const id = createDraftId(new Set(baseDrafts.map((draft) => draft.id)));
    const document: EditorDraftDocument = {
      id,
      name,
      updatedAt: new Date().toISOString(),
      state,
    };
    return commitOperation([...baseDrafts, document], id, state);
  }, [commitOperation, savedCurrentDocuments]);

  const duplicateDraft = useCallback((): EditorDraftOperationResult => {
    if (draftsRef.current.length >= MAX_EDITOR_DRAFTS) {
      return { ok: false, message: `You can keep up to ${MAX_EDITOR_DRAFTS} local drafts.` };
    }
    const baseDrafts = savedCurrentDocuments(latestStateRef.current, true);
    const active = baseDrafts.find((draft) => draft.id === activeDraftIdRef.current)!;
    const id = createDraftId(new Set(baseDrafts.map((draft) => draft.id)));
    const copy: EditorDraftDocument = {
      ...active,
      id,
      name: `${active.name} copy`.slice(0, 60),
      updatedAt: new Date().toISOString(),
      state: latestStateRef.current,
    };
    return commitOperation([...baseDrafts, copy], id, copy.state);
  }, [commitOperation, savedCurrentDocuments]);

  const renameDraft = useCallback((requestedName: string): EditorDraftOperationResult => {
    const name = requestedName.trim();
    if (!name) return { ok: false, message: "Give the draft a name." };
    if (name.length > 60) {
      return { ok: false, message: "Draft names can contain at most 60 characters." };
    }
    const baseDrafts = savedCurrentDocuments(latestStateRef.current);
    const nextDrafts = baseDrafts.map((draft) =>
      draft.id === activeDraftIdRef.current ? { ...draft, name } : draft);
    return commitOperation(nextDrafts, activeDraftIdRef.current);
  }, [commitOperation, savedCurrentDocuments]);

  const deleteDraft = useCallback((): EditorDraftOperationResult => {
    if (draftsRef.current.length <= 1) {
      return { ok: false, message: "Keep at least one local draft." };
    }
    const nextDrafts = draftsRef.current.filter(
      (draft) => draft.id !== activeDraftIdRef.current,
    );
    const next = nextDrafts[0];
    return commitOperation(nextDrafts, next.id, next.state);
  }, [commitOperation]);

  const switchDraft = useCallback((id: string): EditorDraftOperationResult => {
    if (id === activeDraftIdRef.current) return { ok: true };
    const target = draftsRef.current.find((draft) => draft.id === id);
    if (!target) return { ok: false, message: "That draft is no longer available." };
    const nextDrafts = savedCurrentDocuments(latestStateRef.current);
    return commitOperation(nextDrafts, id, target.state);
  }, [commitOperation, savedCurrentDocuments]);

  const restoreActiveDraft = useCallback(() => {
    const raw = readStoredValue(STORAGE_KEYS.editorDraft);
    const persisted = parseEditorDraftStore(raw);
    if (persisted) {
      publishStore(persisted.store.drafts, persisted.store.activeId);
    }
    const active = draftsRef.current.find(
      (draft) => draft.id === activeDraftIdRef.current,
    );
    if (!active) return;
    window.clearTimeout(saveTimerRef.current);
    pendingSaveRef.current = false;
    setHasPendingChanges(false);
    discardPendingRef.current = false;
    latestStateRef.current = active.state;
    rawDispatch({ type: "replace", state: active.state });
  }, [publishStore]);

  const pausePendingDraft = useCallback(() => {
    autosaveEnabledRef.current = false;
    window.clearTimeout(saveTimerRef.current);
  }, []);

  const resumePendingDraft = useCallback(() => {
    autosaveEnabledRef.current = options.autosave !== false;
    if (!autosaveEnabledRef.current || !pendingSaveRef.current) return;
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveCurrentDraft(latestStateRef.current, true);
    }, SAVE_DELAY);
  }, [options.autosave, saveCurrentDraft]);

  const discardPendingDraft = useCallback(() => {
    discardPendingRef.current = true;
    pendingSaveRef.current = false;
    setHasPendingChanges(false);
    window.clearTimeout(saveTimerRef.current);
  }, []);

  const clearRecoveryDraft = useCallback(() => {
    const result = trackPersistenceResult(
      removeStoredValue(STORAGE_KEYS.editorDraftRecovery),
    );
    if (result.ok) setRecoveryDraft(null);
  }, []);

  const summaries = drafts.map(({ id, name, updatedAt }) => ({ id, name, updatedAt }));
  const activeDraft = summaries.find((draft) => draft.id === activeDraftId)!;
  return {
    state: history.current,
    dispatch,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    hasPendingChanges,
    drafts: summaries,
    activeDraft,
    createDraft,
    duplicateDraft,
    renameDraft,
    deleteDraft,
    switchDraft,
    restoreActiveDraft,
    recoveryDraft,
    clearRecoveryDraft,
    pausePendingDraft,
    resumePendingDraft,
    discardPendingDraft,
  };
}
