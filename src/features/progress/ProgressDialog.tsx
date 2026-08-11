import { useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  summarizeProgressMerge,
  type ProgressData,
} from "@/src/shared/progress";
import { readProgressImportFile } from "@/src/shared/progress-import";
import { Modal } from "@/src/shared/ui/Modal";
import { computeStats, type StatsPuzzle } from "./compute-stats";
import styles from "./ProgressDialog.module.css";

interface ProgressDialogProps {
  readonly open: boolean;
  readonly progress: ProgressData;
  readonly puzzles: readonly StatsPuzzle[];
  readonly onClose: () => void;
  readonly onImport: (progress: ProgressData) => void;
  readonly onReset: () => void;
}

function downloadProgress(progress: ProgressData) {
  const serialized = JSON.stringify(progress, null, 2);
  const blob = new Blob([serialized], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `sokomind-progress-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ProgressDialog({
  open,
  progress,
  puzzles,
  onClose,
  onImport,
  onReset,
}: ProgressDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const stats = useMemo(() => computeStats(progress, puzzles), [progress, puzzles]);
  const knownPuzzleIds = useMemo(
    () => puzzles.map((puzzle) => puzzle.id),
    [puzzles],
  );

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const imported = await readProgressImportFile(file, knownPuzzleIds);
    if (!imported.ok) {
      setMessage(imported.message);
      return;
    }

    const summary = summarizeProgressMerge(progress, imported.progress);
    onImport(imported.progress);
    setMessage([
      "Progress imported:",
      `${summary.added} added,`,
      `${summary.improved} improved,`,
      `${summary.unchanged} unchanged,`,
      `${summary.rejected + imported.rejected} rejected,`,
      `${imported.invalid} invalid.`,
    ].join(" "));
  }

  return (
    <Modal
      className={styles.modal}
      labelledBy="progress-dialog-title"
      mobileSheet
      onClose={onClose}
      open={open}
    >
      <section className={styles.card}>
        <header>
          <div>
            <p>On this device</p>
            <h2 id="progress-dialog-title">Your progress</h2>
          </div>
          <button type="button" data-autofocus onClick={onClose}>Close</button>
        </header>

        <div className={styles.summary}>
          <strong data-testid="completed-count">{stats.totalSolved}</strong>
          <span>of {stats.totalPuzzles} rooms cleared</span>
          <div aria-hidden="true">
            <span style={{ width: `${stats.completionPercentage}%` }} />
          </div>
        </div>

        {stats.ignoredRecords > 0 ? (
          <p className={styles.status}>
            {stats.ignoredRecords} saved unavailable {stats.ignoredRecords === 1
              ? "record is"
              : "records are"} not counted.
          </p>
        ) : null}

        <p className={styles.explanation}>
          Export a portable backup, or import another backup. Imports merge
          records and keep the route with the fewest moves.
        </p>

        <div className={styles.actions}>
          <button type="button" onClick={() => downloadProgress(progress)}>
            Export backup
          </button>
          <button type="button" onClick={() => inputRef.current?.click()}>
            Import backup
          </button>
          <input
            accept="application/json,.json"
            aria-label="Import progress backup file"
            className="sr-only"
            onChange={(event) => void importFile(event)}
            ref={inputRef}
            tabIndex={-1}
            type="file"
          />
        </div>

        {stats.totalSolved > 0 ? (
          <section className={styles.statsSection}>
            <h3 className={styles.statsSectionTitle}>Statistics</h3>

            <div className={styles.tierList}>
              {stats.byDifficulty
                .filter((tier) => tier.total > 0)
                .map((tier) => (
                  <div className={styles.tierRow} key={tier.difficulty}>
                    <span className={styles.tierLabel}>{tier.label}</span>
                    <span className={styles.tierCount}>
                      {tier.solved} / {tier.total}
                    </span>
                    <div className={styles.tierBar}>
                      <span
                        style={{
                          width: `${(tier.solved / tier.total) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
            </div>

            <dl className={styles.aggregates}>
              <div>
                <dt>Total moves</dt>
                <dd>{stats.totalMoves.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Total pushes</dt>
                <dd>{stats.totalPushes.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Avg pushes</dt>
                <dd>{stats.averagePushesPerPuzzle.toFixed(1)}</dd>
              </div>
              {stats.bestEfficiency ? (
                <div>
                  <dt>Most efficient</dt>
                  <dd>
                    {stats.bestEfficiency.title} ({stats.bestEfficiency.pushes}{" "}
                    for {stats.bestEfficiency.boxes})
                  </dd>
                </div>
              ) : null}
            </dl>

            {stats.totalSolved === stats.totalPuzzles ? (
              <p className={styles.allCleared}>
                Every room cleared. You are a master of the warehouse.
              </p>
            ) : null}
          </section>
        ) : (
          <p className={styles.emptyStats}>
            Complete a puzzle to see your statistics.
          </p>
        )}

        <div className={styles.danger}>
          {confirmReset ? (
            <div role="alert">
              <span>Remove every personal best from this device?</span>
              <button
                type="button"
                onClick={() => {
                  onReset();
                  setConfirmReset(false);
                  setMessage("Saved progress was reset.");
                }}
              >
                Yes, reset progress
              </button>
              <button type="button" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmReset(true)}>
              Reset saved progress
            </button>
          )}
        </div>

        {message ? (
          <p className={styles.status} role="status" aria-live="polite">
            {message}
          </p>
        ) : null}
      </section>
    </Modal>
  );
}
