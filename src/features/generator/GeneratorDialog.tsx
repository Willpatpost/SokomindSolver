import { useCallback, useRef, useState } from "react";
import type { Difficulty, PuzzleDefinition } from "@/src/core/model";
import { DIFFICULTIES } from "@/src/core/model";
import { Modal } from "@/src/shared/ui/Modal";
import {
  DEFAULT_GENERATOR_PARAMS,
  DIFFICULTY_PRESETS,
  type GeneratorParams,
  type GeneratorProgress,
  type GenerationResult,
} from "./generator-types";
import { generatePuzzle } from "./generate-puzzle";
import styles from "./GeneratorDialog.module.css";

export interface GeneratorDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onAccept: (puzzle: PuzzleDefinition) => void;
}

type DialogStatus = "idle" | "running" | "success" | "failed";

export function GeneratorDialog({
  open,
  onClose,
  onAccept,
}: GeneratorDialogProps) {
  const [params, setParams] = useState<GeneratorParams>(
    DEFAULT_GENERATOR_PARAMS,
  );
  const [status, setStatus] = useState<DialogStatus>("idle");
  const [progress, setProgress] = useState<GeneratorProgress | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const updateParam = useCallback(
    <K extends keyof GeneratorParams>(key: K, value: GeneratorParams[K]) => {
      setParams((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleDifficultyChange = useCallback((difficulty: Difficulty) => {
    const preset = DIFFICULTY_PRESETS[difficulty];
    setParams((prev) => ({
      ...prev,
      targetDifficulty: difficulty,
      width: preset.width,
      height: preset.height,
      boxCount: preset.boxCount,
    }));
  }, []);

  const handleGenerate = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("running");
    setProgress(null);
    setResult(null);

    const genResult = await generatePuzzle(
      params,
      (p) => setProgress(p),
      controller.signal,
    );

    abortRef.current = null;
    setResult(genResult);
    setStatus(genResult.status === "success" ? "success" : "failed");
  }, [params]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
    setProgress(null);
  }, []);

  const handleAccept = useCallback(() => {
    if (result?.status === "success") {
      onAccept(result.puzzle);
    }
  }, [onAccept, result]);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
    setProgress(null);
    setResult(null);
    onClose();
  }, [onClose]);

  const progressFraction =
    progress && progress.maxAttempts > 0
      ? progress.attempt / progress.maxAttempts
      : 0;

  return (
    <Modal
      className={styles.modal}
      labelledBy="generator-dialog-title"
      describedBy="generator-dialog-description"
      mobileSheet
      onClose={handleClose}
      open={open}
    >
      <section className={styles.dialog}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Workshop</p>
            <h2 id="generator-dialog-title">Generate a puzzle</h2>
            <p id="generator-dialog-description">
              Configure parameters and generate a new Sokoban puzzle
              procedurally.
            </p>
          </div>
          <button
            aria-label="Close generator"
            className={styles.close}
            onClick={handleClose}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className={styles.content}>
          <section className={styles.card}>
            <div className={styles.sectionHeading}>
              <div>
                <p>Configuration</p>
                <h3>Puzzle parameters</h3>
              </div>
              <span data-state={status === "running" ? "running" : undefined}>
                {status}
              </span>
            </div>

            <div className={styles.fields}>
              <label>
                <span>Difficulty</span>
                <select
                  disabled={status === "running"}
                  value={params.targetDifficulty}
                  onChange={(e) =>
                    handleDifficultyChange(e.currentTarget.value as Difficulty)
                  }
                >
                  {DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>
                      {d.charAt(0).toUpperCase() + d.slice(1)}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Max attempts</span>
                <input
                  type="number"
                  disabled={status === "running"}
                  min={1}
                  max={500}
                  value={params.maxAttempts}
                  onChange={(e) =>
                    updateParam("maxAttempts", Number(e.currentTarget.value))
                  }
                />
              </label>

              <label>
                <span>Width</span>
                <input
                  type="number"
                  disabled={status === "running"}
                  min={5}
                  max={20}
                  value={params.width}
                  onChange={(e) =>
                    updateParam("width", Number(e.currentTarget.value))
                  }
                />
              </label>

              <label>
                <span>Height</span>
                <input
                  type="number"
                  disabled={status === "running"}
                  min={5}
                  max={20}
                  value={params.height}
                  onChange={(e) =>
                    updateParam("height", Number(e.currentTarget.value))
                  }
                />
              </label>

              <label>
                <span>Boxes</span>
                <input
                  type="number"
                  disabled={status === "running"}
                  min={1}
                  max={10}
                  value={params.boxCount}
                  onChange={(e) =>
                    updateParam("boxCount", Number(e.currentTarget.value))
                  }
                />
              </label>

              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  disabled={status === "running" || params.boxCount < 2}
                  checked={params.useLabels}
                  onChange={(e) =>
                    updateParam("useLabels", e.currentTarget.checked)
                  }
                />
                <span>Labeled boxes (A/a matching pairs)</span>
              </label>
            </div>

            <div className={styles.primaryActions}>
              <button
                className={styles.generate}
                disabled={status === "running"}
                onClick={() => void handleGenerate()}
                type="button"
              >
                Generate puzzle
              </button>
              <button
                className={styles.cancel}
                disabled={status !== "running"}
                onClick={handleCancel}
                type="button"
              >
                Cancel
              </button>
            </div>
          </section>

          {status === "running" && progress ? (
            <section className={`${styles.card} ${styles.progressCard}`}>
              <p className={styles.progressMessage}>{progress.message}</p>
              <progress
                aria-label="Generation progress"
                max={1}
                value={progressFraction}
              />
            </section>
          ) : null}

          {result?.status === "success" ? (
            <section className={styles.result} data-status="success">
              <h3>Puzzle generated</h3>
              <p>
                A {result.puzzle.difficulty}-level puzzle was generated
                successfully.
              </p>

              <dl className={styles.metrics}>
                <div>
                  <dt>Moves</dt>
                  <dd>{result.solverMoves}</dd>
                </div>
                <div>
                  <dt>Pushes</dt>
                  <dd>{result.solverPushes}</dd>
                </div>
                <div>
                  <dt>Attempts</dt>
                  <dd>{result.attempts}</dd>
                </div>
              </dl>

              <button
                className={styles.accept}
                onClick={handleAccept}
                type="button"
              >
                Load into editor
              </button>
            </section>
          ) : null}

          {result?.status === "failed" ? (
            <section className={styles.result} data-status="failed">
              <h3>Generation failed</h3>
              <p>
                Could not produce a valid puzzle after {result.attempts}{" "}
                attempt{result.attempts !== 1 ? "s" : ""}. {result.lastReason}
              </p>
            </section>
          ) : null}
        </div>
      </section>
    </Modal>
  );
}
