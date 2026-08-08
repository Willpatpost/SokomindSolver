import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DIFFICULTIES,
  type Difficulty,
  type PuzzleDefinition,
} from "@/src/core/model";
import { validatePuzzle } from "@/src/core";
import { ExperienceControls } from "@/src/features/experience";
import {
  stateToPuzzle,
  validateEditorState,
  MIN_SIZE,
  MAX_SIZE,
  type EditorAction,
} from "@/src/features/editor/editor-model";
import {
  encodePuzzleUrl,
  decodeCustomPuzzle,
} from "@/src/features/editor/editor-serialization";
import { Modal } from "@/src/shared/ui/Modal";
import { useEditorState } from "@/src/features/editor/use-editor-state";
import { EditorGrid } from "@/src/features/editor/EditorGrid";
import { EditorPlaytest } from "@/src/features/editor/EditorPlaytest";
import { EditorToolbar } from "@/src/features/editor/EditorToolbar";
import { ConfirmDialog } from "@/src/shared/ui/ConfirmDialog";
import { GeneratorDialog } from "@/src/features/generator/GeneratorDialog";
import { editorHash, homeHash, useRouter } from "@/src/router";
import styles from "./EditorPage.module.css";

interface EditorPageProps {
  readonly customData?: string;
}

interface Notice {
  readonly kind: "success" | "error" | "info";
  readonly message: string;
  readonly sourceCustomData?: string;
}

interface PlaytestDraft {
  readonly puzzle: PuzzleDefinition;
  readonly sourceCustomData?: string;
}

interface ShareResult {
  readonly url: string;
  readonly sourceCustomData?: string;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based compatibility path.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export function EditorPage({ customData }: EditorPageProps) {
  const editor = useEditorState();
  const { state, dispatch } = editor;
  const [playtestDraft, setPlaytestDraft] = useState<PlaytestDraft | null>(
    null,
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [shareResult, setShareResult] = useState<ShareResult | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [fillMode, setFillMode] = useState(false);
  const { navigate } = useRouter();
  const isDirtyRef = useRef(false);
  const draftRevisionRef = useRef(0);
  const shareOperationRef = useRef(0);
  const restoreEditorFocusRef = useRef(false);
  const testButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.title = "Puzzle Editor · Sokomind";
  }, []);

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (isDirtyRef.current) event.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const testPuzzleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "z" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
        event.preventDefault();
        editor.undo();
      } else if (
        (event.key === "z" && (event.ctrlKey || event.metaKey) && event.shiftKey) ||
        (event.key === "y" && (event.ctrlKey || event.metaKey))
      ) {
        event.preventDefault();
        editor.redo();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        testPuzzleRef.current?.();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor]);

  const handleBackClick = useCallback(() => {
    if (isDirtyRef.current) {
      setLeaveConfirmOpen(true);
    } else {
      navigate(homeHash());
    }
  }, [navigate]);

  const handleLeaveConfirm = useCallback(() => {
    isDirtyRef.current = false;
    navigate(homeHash());
  }, [navigate]);

  const sharedPuzzle = useMemo(
    () =>
      customData
        ? decodeCustomPuzzle(`#custom=${encodeURIComponent(customData)}`)
        : null,
    [customData],
  );
  const customDataError =
    customData && !sharedPuzzle
      ? "This shared puzzle link is invalid or incomplete. Your current draft was left unchanged."
      : null;
  const activePlaytest =
    playtestDraft && playtestDraft.sourceCustomData === customData
      ? playtestDraft.puzzle
      : null;
  const activeShareUrl =
    shareResult && shareResult.sourceCustomData === customData
      ? shareResult.url
      : null;
  const activeNotice =
    notice && notice.sourceCustomData === customData
      ? notice
      : null;

  useEffect(() => {
    if (sharedPuzzle) {
      draftRevisionRef.current += 1;
      shareOperationRef.current += 1;
      dispatch({ type: "load", puzzle: sharedPuzzle });
    }
  }, [dispatch, sharedPuzzle]);

  const applyEditorAction = useCallback(
    (action: EditorAction) => {
      if (action.type !== "set-tool") {
        draftRevisionRef.current += 1;
        shareOperationRef.current += 1;
        isDirtyRef.current = true;
      }
      dispatch(action);
      if (action.type !== "set-tool") {
        setShareResult(null);
        setNotice(null);
      }
    },
    [dispatch],
  );

  const editorValidation = useMemo(
    () => validateEditorState(state),
    [state],
  );

  const coreValidation = useMemo(() => {
    if (!editorValidation.valid) return null;
    return validatePuzzle(stateToPuzzle(state));
  }, [editorValidation.valid, state]);

  const isValid = editorValidation.valid && (coreValidation?.valid ?? false);

  const handleTest = useCallback(() => {
    if (!isValid) return;
    setPlaytestDraft({
      puzzle: stateToPuzzle(state),
      sourceCustomData: customData,
    });
    setNotice(null);
  }, [customData, isValid, state]);

  useEffect(() => {
    testPuzzleRef.current =
      isValid && !activePlaytest ? handleTest : null;
  }, [isValid, activePlaytest, handleTest]);

  const handleShare = useCallback(async () => {
    if (!isValid) return;
    const encoded = encodePuzzleUrl(stateToPuzzle(state)).slice(
      "#custom=".length,
    );
    const url = `${window.location.origin}${window.location.pathname}${editorHash(encoded)}`;
    const draftRevision = draftRevisionRef.current;
    const operation = ++shareOperationRef.current;
    setShareResult({
      url,
      sourceCustomData: customData,
    });

    const copied = await copyText(url);
    if (
      operation !== shareOperationRef.current ||
      draftRevision !== draftRevisionRef.current
    ) {
      return;
    }
    setNotice(
      copied
        ? {
            kind: "success",
            message: "Share link copied to the clipboard.",
            sourceCustomData: customData,
          }
        : {
            kind: "info",
            message: "The share link is ready below. Select it to copy manually.",
            sourceCustomData: customData,
          },
    );
  }, [customData, isValid, state]);

  const handleClearRequest = useCallback(() => {
    setClearConfirmOpen(true);
  }, []);

  const handleClearConfirm = useCallback(() => {
    applyEditorAction({ type: "clear" });
  }, [applyEditorAction]);

  const handleExitPlaytest = useCallback(() => {
    restoreEditorFocusRef.current = true;
    setPlaytestDraft(null);
  }, []);

  const handleGeneratorAccept = useCallback(
    (puzzle: PuzzleDefinition) => {
      draftRevisionRef.current += 1;
      shareOperationRef.current += 1;
      dispatch({ type: "load", puzzle });
      setGeneratorOpen(false);
      setShareResult(null);
      setNotice(null);
    },
    [dispatch],
  );

  const handleImportOpen = useCallback(() => {
    setImportText("");
    setImportError(null);
    setImportOpen(true);
  }, []);

  const handleImportConfirm = useCallback(() => {
    const lines = importText.split("\n").filter((line) => line.length > 0);
    if (lines.length < 2) {
      setImportError("Paste at least 2 rows of puzzle text.");
      return;
    }
    const width = Math.max(...lines.map((line) => [...line].length));
    if (width < 3 || lines.length < 3) {
      setImportError("Puzzle must be at least 3x3.");
      return;
    }
    if (width > 20 || lines.length > 20) {
      setImportError("Puzzle must be at most 20x20.");
      return;
    }
    const rows = lines.map((line) => {
      const chars = [...line];
      while (chars.length < width) chars.push("O");
      return chars.join("");
    });
    const puzzle: PuzzleDefinition = {
      id: `import-${Date.now()}`,
      title: "Imported puzzle",
      difficulty: "beginner",
      boxes: rows.reduce((count, row) => count + [...row].filter((c) => c === "X").length, 0),
      rows,
    };
    draftRevisionRef.current += 1;
    shareOperationRef.current += 1;
    dispatch({ type: "load", puzzle });
    isDirtyRef.current = true;
    setImportOpen(false);
    setShareResult(null);
    setNotice(null);
  }, [dispatch, importText]);

  useEffect(() => {
    if (!activePlaytest && restoreEditorFocusRef.current) {
      restoreEditorFocusRef.current = false;
      testButtonRef.current?.focus();
    }
  }, [activePlaytest]);

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <div className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <button
              type="button"
              className={styles.backButton}
              aria-label="Back to home"
              onClick={handleBackClick}
            >
              <span aria-hidden="true">←</span>
            </button>
            <div className={styles.titleGroup}>
              <span className={styles.eyebrow}>Workshop</span>
              <h1 className={styles.pageTitle}>Puzzle Editor</h1>
            </div>
          </div>
          <ExperienceControls />
        </div>

        {customDataError ? (
          <p className={styles.loadError} role="alert">
            {customDataError}
          </p>
        ) : null}

        {activePlaytest ? (
          <div
            className={`${styles.content} ${styles.playtestContent}`}
            data-testid="editor-playtest-layout"
          >
            <div
              className={`${styles.gridWrap} ${styles.playtestWrap}`}
              data-testid="editor-playtest-viewport"
            >
              <EditorPlaytest
                puzzle={activePlaytest}
                onExit={handleExitPlaytest}
              />
            </div>
          </div>
        ) : (
          <div className={styles.content}>
            <div className={styles.sidebar}>
              <EditorToolbar
                selectedTool={state.selectedTool}
                dispatch={applyEditorAction}
              />

              <div className={styles.sizeControls}>
                <label>
                  Width
                  <input
                    aria-label="Board width"
                    type="number"
                    min={MIN_SIZE}
                    max={MAX_SIZE}
                    value={state.width}
                    onChange={(event) =>
                      applyEditorAction({
                        type: "resize",
                        width: Number(event.currentTarget.value),
                        height: state.height,
                      })
                    }
                  />
                </label>
                <label>
                  Height
                  <input
                    aria-label="Board height"
                    type="number"
                    min={MIN_SIZE}
                    max={MAX_SIZE}
                    value={state.height}
                    onChange={(event) =>
                      applyEditorAction({
                        type: "resize",
                        width: state.width,
                        height: Number(event.currentTarget.value),
                      })
                    }
                  />
                </label>
              </div>
            </div>

            <div className={styles.gridWrap}>
              <EditorGrid state={state} dispatch={applyEditorAction} fillMode={fillMode} />
            </div>

            <div className={styles.sidebar}>
              <div className={styles.fields}>
                <label>
                  Title
                  <input
                    type="text"
                    value={state.title}
                    maxLength={60}
                    onChange={(event) =>
                      applyEditorAction({
                        type: "set-title",
                        title: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label>
                  Difficulty
                  <select
                    value={state.difficulty}
                    onChange={(event) =>
                      applyEditorAction({
                        type: "set-difficulty",
                        difficulty: event.currentTarget.value as Difficulty,
                      })
                    }
                  >
                    {DIFFICULTIES.map((difficulty) => (
                      <option key={difficulty} value={difficulty}>
                        {difficulty.charAt(0).toUpperCase() +
                          difficulty.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Hint
                  <textarea
                    value={state.hint}
                    maxLength={200}
                    rows={2}
                    onChange={(event) =>
                      applyEditorAction({
                        type: "set-hint",
                        hint: event.currentTarget.value,
                      })
                    }
                  />
                </label>
              </div>

              <div className={styles.validation} aria-live="polite">
                {editorValidation.errors.map((error) => (
                  <p key={error} className={styles.validationError}>
                    {error}
                  </p>
                ))}
                {!editorValidation.valid
                  ? null
                  : coreValidation && !coreValidation.valid
                    ? coreValidation.errors.map((error) => (
                        <p
                          key={`${error.code}-${error.message}`}
                          className={styles.validationError}
                        >
                          {error.message}
                        </p>
                      ))
                    : isValid
                      ? (
                          <p className={styles.validOk}>Puzzle is valid</p>
                        )
                      : null}
              </div>

              <div className={styles.undoRedo}>
                <button
                  type="button"
                  disabled={!editor.canUndo}
                  onClick={editor.undo}
                  aria-label="Undo"
                  title="Undo (Ctrl+Z)"
                >
                  ↩ Undo
                </button>
                <button
                  type="button"
                  disabled={!editor.canRedo}
                  onClick={editor.redo}
                  aria-label="Redo"
                  title="Redo (Ctrl+Shift+Z)"
                >
                  ↪ Redo
                </button>
              </div>

              <button
                type="button"
                className={styles.fillToggle}
                aria-pressed={fillMode}
                data-active={fillMode || undefined}
                onClick={() => setFillMode((v) => !v)}
                title="Fill mode — click to flood-fill connected cells"
              >
                {fillMode ? "◆ Fill on" : "◇ Fill off"}
              </button>

              <div className={styles.actions}>
                <button
                  ref={testButtonRef}
                  type="button"
                  data-primary
                  disabled={!isValid}
                  onClick={handleTest}
                  title="Test puzzle (Ctrl+Enter)"
                >
                  Test puzzle
                </button>
                <button
                  type="button"
                  disabled={!isValid}
                  onClick={() => void handleShare()}
                >
                  Share (copy URL)
                </button>
                <button
                  type="button"
                  onClick={() => setGeneratorOpen(true)}
                >
                  Generate puzzle
                </button>
                <button type="button" onClick={handleImportOpen}>
                  Import from text
                </button>
                <button type="button" data-danger onClick={handleClearRequest}>
                  Clear board
                </button>
              </div>

              {activeNotice ? (
                <p
                  className={styles.notice}
                  data-kind={activeNotice.kind}
                  role="status"
                >
                  {activeNotice.message}
                </p>
              ) : null}

              {activeShareUrl ? (
                <label className={styles.shareResult}>
                  Share link
                  <input
                    type="text"
                    readOnly
                    value={activeShareUrl}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={leaveConfirmOpen}
        title="Leave the editor?"
        message="You have unsaved changes. Leaving will discard your current draft."
        confirmLabel="Leave"
        destructive
        onConfirm={handleLeaveConfirm}
        onClose={() => setLeaveConfirmOpen(false)}
      />

      <ConfirmDialog
        open={clearConfirmOpen}
        title="Clear the board?"
        message="Clear every cell in this puzzle? This cannot be undone."
        confirmLabel="Clear board"
        destructive
        onConfirm={handleClearConfirm}
        onClose={() => setClearConfirmOpen(false)}
      />

      <GeneratorDialog
        open={generatorOpen}
        onClose={() => setGeneratorOpen(false)}
        onAccept={handleGeneratorAccept}
      />

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        label="Import puzzle from text"
        className={styles.importModal}
      >
        <div className={styles.importContent}>
          <h2 className={styles.importTitle}>Import from text</h2>
          <p className={styles.importHint}>
            Paste puzzle rows using: O (wall), R (robot), X (box), S (goal), space (floor).
          </p>
          <textarea
            className={styles.importTextarea}
            data-autofocus
            rows={10}
            placeholder={"OOOOO\nO R O\nO X O\nO S O\nOOOOO"}
            value={importText}
            onChange={(event) => {
              setImportText(event.currentTarget.value);
              setImportError(null);
            }}
          />
          {importError && (
            <p className={styles.validationError} role="alert">{importError}</p>
          )}
          <div className={styles.importActions}>
            <button type="button" onClick={() => setImportOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              data-primary
              disabled={!importText.trim()}
              onClick={handleImportConfirm}
            >
              Import
            </button>
          </div>
        </div>
      </Modal>
    </main>
  );
}
