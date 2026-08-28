import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  summarizeProgressMerge,
  type ProgressData,
} from "@/src/shared/progress";
import { readProgressImportFile } from "@/src/shared/progress-import";
import type { PersistedProgressUpdate } from "@/src/shared/progress-sync";
import {
  clearPersonalBestRoutes,
  loadPersonalBestRouteStorageStats,
  type PersonalBestRouteStorageStats,
} from "@/src/shared/personal-best-routes";
import { Modal } from "@/src/shared/ui/Modal";
import { computeStats, type StatsPuzzle } from "./compute-stats";
import styles from "./ProgressDialog.module.css";

interface ProgressDialogProps {
  readonly open: boolean;
  readonly progress: ProgressData;
  readonly puzzles: readonly StatsPuzzle[];
  readonly onClose: () => void;
  readonly onImport: (
    progress: ProgressData,
  ) => PersistedProgressUpdate | Promise<PersistedProgressUpdate>;
  readonly onReset: () => PersistedProgressUpdate | Promise<PersistedProgressUpdate>;
}

function persistenceFailureMessage(
  action: "imported" | "reset",
  result: PersistedProgressUpdate["result"],
): string {
  if (result.ok) return "";
  const cause = result.reason === "quota-exceeded"
    ? "browser storage is full"
    : result.reason === "security-error"
      ? "the browser denied storage access"
      : "browser storage is unavailable";
  return `Progress was not ${action} because ${cause}.`;
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

function formatStorageSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
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
  const [confirmRouteClear, setConfirmRouteClear] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const [routeStorage, setRouteStorage] =
    useState<PersonalBestRouteStorageStats | null>(null);
  const stats = useMemo(() => computeStats(progress, puzzles), [progress, puzzles]);
  const knownPuzzleIds = useMemo(
    () => puzzles.map((puzzle) => puzzle.id),
    [puzzles],
  );

  useEffect(() => {
    if (!open) return;
    let active = true;
    void loadPersonalBestRouteStorageStats().then((stats) => {
      if (active) setRouteStorage(stats);
    });
    return () => {
      active = false;
    };
  }, [open]);

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
    setMutationPending(true);
    try {
      const outcome = await onImport(imported.progress);
      if (!outcome.result.ok) {
        setMessage(persistenceFailureMessage("imported", outcome.result));
        return;
      }
      setMessage([
        "Progress imported:",
        `${summary.added} added,`,
        `${summary.improved} improved,`,
        `${summary.unchanged} unchanged,`,
        `${summary.rejected + imported.rejected} rejected,`,
        `${imported.invalid} invalid.`,
      ].join(" "));
    } catch {
      setMessage("Progress was not imported because the save failed.");
    } finally {
      setMutationPending(false);
    }
  }

  async function resetSavedProgress() {
    setMutationPending(true);
    try {
      const outcome = await onReset();
      if (!outcome.result.ok) {
        setMessage(persistenceFailureMessage("reset", outcome.result));
        return;
      }
      const routesCleared = await clearPersonalBestRoutes();
      setConfirmReset(false);
      setConfirmRouteClear(false);
      if (routesCleared) {
        setRouteStorage({
          status: "missing",
          puzzleCount: 0,
          routeCount: 0,
          actionCount: 0,
          approximateBytes: 0,
          discardedRecords: 0,
        });
        setMessage("Saved progress and replay history were reset.");
      } else {
        setMessage("Progress was reset, but replay storage could not be accessed.");
      }
    } catch {
      setMessage("Progress was not reset because the save failed.");
    } finally {
      setMutationPending(false);
    }
  }

  async function clearSavedRoutes() {
    setMutationPending(true);
    try {
      const cleared = await clearPersonalBestRoutes();
      if (!cleared) {
        setMessage("Replay history could not be cleared because storage is unavailable.");
        return;
      }
      setConfirmRouteClear(false);
      setRouteStorage({
        status: "missing",
        puzzleCount: 0,
        routeCount: 0,
        actionCount: 0,
        approximateBytes: 0,
        discardedRecords: 0,
      });
      setMessage("Saved replay history was cleared. Personal-best summaries remain.");
    } finally {
      setMutationPending(false);
    }
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
          <button
            type="button"
            disabled={mutationPending}
            onClick={() => inputRef.current?.click()}
          >
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

        <section className={styles.routeStorage} aria-labelledby="saved-replays-title">
          <div>
            <h3 id="saved-replays-title">Saved replays</h3>
            <p aria-live="polite">
              {routeStorage === null
                ? "Checking replay storage…"
                : routeStorage.status === "unavailable"
                  ? "Replay storage is unavailable. Puzzle play and summary records still work."
                  : routeStorage.status === "corrupt"
                    ? "Invalid replay data was ignored. You can clear it safely."
                    : routeStorage.routeCount === 0
                      ? "No replay routes saved yet. Existing personal-best summaries are unchanged."
                      : `${routeStorage.routeCount} ${routeStorage.routeCount === 1 ? "route" : "routes"} across ${routeStorage.puzzleCount} ${routeStorage.puzzleCount === 1 ? "puzzle" : "puzzles"} · ${formatStorageSize(routeStorage.approximateBytes)}`}
            </p>
            {routeStorage && routeStorage.discardedRecords > 0 ? (
              <small>
                {routeStorage.discardedRecords} invalid saved {routeStorage.discardedRecords === 1
                  ? "entry was"
                  : "entries were"} ignored.
              </small>
            ) : null}
          </div>
          {confirmRouteClear ? (
            <div className={styles.routeClearConfirm} role="alert">
              <span>Clear saved routes but keep personal-best summaries?</span>
              <button
                type="button"
                disabled={mutationPending}
                onClick={() => void clearSavedRoutes()}
              >
                Clear routes
              </button>
              <button type="button" onClick={() => setConfirmRouteClear(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={
                mutationPending ||
                routeStorage === null ||
                routeStorage.status === "unavailable" ||
                (routeStorage.status !== "corrupt" && routeStorage.routeCount === 0)
              }
              onClick={() => setConfirmRouteClear(true)}
            >
              Clear replay history
            </button>
          )}
        </section>

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
              <span>Remove every personal best and saved replay from this device?</span>
              <button
                type="button"
                disabled={mutationPending}
                onClick={() => void resetSavedProgress()}
              >
                Yes, reset progress
              </button>
              <button type="button" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={mutationPending}
              onClick={() => setConfirmReset(true)}
            >
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
