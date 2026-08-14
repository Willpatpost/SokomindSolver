import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PUZZLE_METADATA } from "@/src/catalog/puzzle-metadata";
import { useStoredProgress } from "@/src/shared/use-stored-progress";
import {
  buildActivityHeatMap,
  computeStats,
} from "@/src/features/progress/compute-stats";
import {
  ACHIEVEMENTS,
  getUnlockedAchievements,
} from "@/src/features/achievements/achievements";
import { summarizeProgressMerge } from "@/src/shared/progress";
import { readProgressImportFile } from "@/src/shared/progress-import";
import {
  createProgressWriterId,
  loadProgressSyncSnapshot,
  persistProgressImport,
  resetStoredProgress,
} from "@/src/shared/progress-sync";
import { ExperienceControls } from "@/src/features/experience";
import { Link, homeHash } from "@/src/router";
import styles from "./StatsPage.module.css";

const DIFFICULTY_COLORS: Record<string, string> = {
  tutorial: "var(--sage-500)",
  beginner: "var(--sage-600)",
  intermediate: "var(--blue-500)",
  advanced: "var(--amber-500)",
  expert: "var(--coral-500)",
  master: "var(--ink-700)",
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function heatLevel(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 10) return 3;
  return 4;
}

export function StatsPage() {
  const progress = useStoredProgress();
  const stats = useMemo(
    () => computeStats(progress, PUZZLE_METADATA),
    [progress],
  );

  const heatMap = useMemo(
    () => buildActivityHeatMap(progress),
    [progress],
  );

  const unlocked = useMemo(
    () => getUnlockedAchievements(stats, progress),
    [stats, progress],
  );
  const unlockedIds = useMemo(
    () => new Set(unlocked.map((a) => a.id)),
    [unlocked],
  );

  const hasTrackedTime = stats.totalElapsedMs > 0;

  const [resetStep, setResetStep] = useState<"idle" | "confirm" | "typing">("idle");
  const [resetInput, setResetInput] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);

  const handleResetProgress = useCallback(() => {
    const update = resetStoredProgress();
    if (!update.result.ok) {
      const cause = update.result.reason === "quota-exceeded"
        ? "browser storage is full"
        : update.result.reason === "security-error"
          ? "the browser denied storage access"
          : "browser storage is unavailable";
      setResetError(`Progress was not reset because ${cause}.`);
      setResetStep("idle");
      return;
    }
    window.location.hash = "";
    window.location.reload();
  }, []);

  const [statsCopied, setStatsCopied] = useState(false);

  const handleCopyStats = useCallback(async () => {
    const {
      totalSolved, totalPuzzles, completionPercentage,
      totalMoves, totalPushes, averagePushesPerPuzzle,
      streak, byDifficulty,
    } = stats;
    const lines = [
      `Sokomind Stats`,
      `${totalSolved} of ${totalPuzzles} puzzles solved (${Math.round(completionPercentage)}%)`,
      `${totalMoves.toLocaleString()} total moves, ${totalPushes.toLocaleString()} total pushes`,
      `${averagePushesPerPuzzle.toFixed(1)} avg pushes per puzzle`,
      `Streak: ${streak.current} days current, ${streak.longest} days best`,
      ``,
      ...byDifficulty.map((t) => `${t.label}: ${t.solved}/${t.total}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setStatsCopied(true);
      setTimeout(() => setStatsCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  }, [stats]);

  const handleExport = useCallback(() => {
    const data = JSON.stringify(progress, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sokomind-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [progress]);

  const importInputRef = useRef<HTMLInputElement>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const handleImport = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (importInputRef.current) importInputRef.current.value = "";
    const parsed = await readProgressImportFile(
      file,
      PUZZLE_METADATA.map((p) => p.id),
    );
    if (!parsed.ok) {
      setImportStatus(parsed.message);
      return;
    }
    if (Object.keys(parsed.progress.completed).length === 0 &&
      Object.keys(parsed.progress.daily).length === 0 &&
      Object.keys(parsed.progress.activity).length === 0) {
      setImportStatus("No matching puzzles found in the file.");
      return;
    }

    const snapshot = loadProgressSyncSnapshot();
    const writerId = createProgressWriterId();
    const summary = summarizeProgressMerge(snapshot.progress, parsed.progress);
    const update = persistProgressImport(snapshot, writerId, parsed.progress);

    if (!update.result.ok) {
      setImportStatus("Storage error — could not save imported data.");
      return;
    }

    const rejected = summary.rejected + parsed.rejected;
    const parts = [
      `${summary.added} added`,
      `${summary.improved} improved`,
      `${summary.unchanged} unchanged`,
      `${rejected} rejected`,
      `${parsed.invalid} invalid`,
    ];
    if (update.changed) {
      setImportStatus(`Imported: ${parts.join(", ")}. Reloading…`);
      setTimeout(() => window.location.reload(), 1200);
    } else {
      setImportStatus(`No changes: ${parts.join(", ")}.`);
    }
  }, []);

  useEffect(() => {
    document.title = "Statistics · Sokomind";
  }, []);

  if (stats.totalSolved === 0) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <div className={styles.topBar}>
            <div className={styles.topBarLeft}>
              <Link href={homeHash()} className={styles.backButton} aria-label="Back to home">
                <span aria-hidden="true">&larr;</span>
              </Link>
              <h1 className={styles.pageTitle}>Statistics</h1>
            </div>
            <div className={styles.topBarRight}>
              <label className={styles.exportButton} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); importInputRef.current?.click(); } }}
              >
                Import progress
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".json,application/json"
                  className={styles.fileInput}
                  onChange={handleImport}
                />
              </label>
              <ExperienceControls />
            </div>
          </div>
          {importStatus && (
            <p className={styles.importStatus} role="status">{importStatus}</p>
          )}
          <div className={styles.empty}>
            <p>Solve some puzzles to see your statistics here.</p>
          </div>
        </div>
      </main>
    );
  }

  const maxTierTotal = Math.max(
    ...stats.byDifficulty.map((t) => t.total),
    1,
  );

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <div className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <Link href={homeHash()} className={styles.backButton} aria-label="Back to home">
              <span aria-hidden="true">&larr;</span>
            </Link>
            <h1 className={styles.pageTitle}>Statistics</h1>
          </div>
          <div className={styles.topBarRight}>
            <button
              type="button"
              className={styles.exportButton}
              onClick={() => void handleCopyStats()}
            >
              {statsCopied ? "Copied!" : "Copy stats"}
            </button>
            <button
              type="button"
              className={styles.exportButton}
              onClick={handleExport}
            >
              Export progress
            </button>
            <label className={styles.exportButton} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); importInputRef.current?.click(); } }}
            >
              Import progress
              <input
                ref={importInputRef}
                type="file"
                accept=".json,application/json"
                className={styles.fileInput}
                onChange={handleImport}
              />
            </label>
            <ExperienceControls />
          </div>
        </div>

        {importStatus && (
          <p className={styles.importStatus} role="status">{importStatus}</p>
        )}

        <div className={styles.grid}>
          <div className={styles.card}>
            <p className={styles.cardLabel}>Puzzles solved</p>
            <span className={styles.bigStat}>{stats.totalSolved}</span>
            <span className={styles.subStat}>
              of {stats.totalPuzzles} ({Math.round(stats.completionPercentage)}%)
            </span>
          </div>

          <div className={styles.card}>
            <p className={styles.cardLabel}>Total moves</p>
            <span className={styles.bigStat}>
              {stats.totalMoves.toLocaleString()}
            </span>
            <span className={styles.subStat}>
              {stats.totalPushes.toLocaleString()} pushes
            </span>
          </div>

          <div className={styles.card}>
            <p className={styles.cardLabel}>Avg pushes per puzzle</p>
            <span className={styles.bigStat}>
              {stats.averagePushesPerPuzzle.toFixed(1)}
            </span>
          </div>

          <div className={styles.card}>
            <p className={styles.cardLabel}>Streak</p>
            <span className={styles.bigStat}>{stats.streak.current}</span>
            <span className={styles.subStat}>
              {stats.streak.current === 1 ? "day" : "days"} current
              {stats.streak.longest > 0 && ` · ${stats.streak.longest} best`}
            </span>
          </div>

          <div className={styles.card}>
            <p className={styles.cardLabel}>
              {hasTrackedTime ? "Time played" : "Estimated time played"}
            </p>
            <span className={styles.bigStat}>
              {formatDuration(hasTrackedTime ? stats.totalElapsedMs : stats.totalSolved * 90_000)}
            </span>
            {!hasTrackedTime && (
              <span className={styles.subStat}>~90s per puzzle average</span>
            )}
          </div>

          {stats.bestEfficiency && (
            <div className={styles.card}>
              <p className={styles.cardLabel}>Best efficiency</p>
              <span className={styles.bigStat}>
                {stats.bestEfficiency.pushes}/{stats.bestEfficiency.boxes}
              </span>
              <span className={styles.subStat}>
                pushes/boxes on {stats.bestEfficiency.title}
              </span>
            </div>
          )}

          <div className={`${styles.card} ${styles.wideCard}`}>
            <p className={styles.cardLabel}>Solved by difficulty</p>
            <div className={styles.donutRow}>
              <svg viewBox="0 0 100 100" className={styles.donut}>
                {(() => {
                  const tiers = stats.byDifficulty.filter((t) => t.solved > 0);
                  if (tiers.length === 0) return (
                    <circle cx="50" cy="50" r="40" fill="none" stroke="var(--paper-200)" strokeWidth="16" />
                  );
                  let offset = 0;
                  const circumference = 2 * Math.PI * 40;
                  return tiers.map((tier) => {
                    const fraction = tier.solved / stats.totalSolved;
                    const dash = fraction * circumference;
                    const gap = circumference - dash;
                    const el = (
                      <circle
                        key={tier.difficulty}
                        cx="50" cy="50" r="40"
                        fill="none"
                        stroke={DIFFICULTY_COLORS[tier.difficulty]}
                        strokeWidth="16"
                        strokeDasharray={`${dash} ${gap}`}
                        strokeDashoffset={-offset}
                        transform="rotate(-90 50 50)"
                      />
                    );
                    offset += dash;
                    return el;
                  });
                })()}
                <text x="50" y="48" textAnchor="middle" className={styles.donutCenter}>
                  {stats.totalSolved}
                </text>
                <text x="50" y="58" textAnchor="middle" className={styles.donutLabel}>
                  solved
                </text>
              </svg>
              <div className={styles.donutLegend}>
                {stats.byDifficulty.filter((t) => t.solved > 0).map((tier) => (
                  <div key={tier.difficulty} className={styles.legendItem}>
                    <span
                      className={styles.legendDot}
                      style={{ background: DIFFICULTY_COLORS[tier.difficulty] }}
                    />
                    <span className={styles.legendLabel}>{tier.label}</span>
                    <span className={styles.legendValue}>{tier.solved}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className={`${styles.card} ${styles.wideCard}`}>
            <p className={styles.cardLabel}>Completion by difficulty</p>
            <div className={styles.barChart}>
              {stats.byDifficulty.map((tier) => {
                const pct = tier.total > 0
                  ? (tier.solved / tier.total) * 100
                  : 0;
                const barWidth = tier.total > 0
                  ? (tier.total / maxTierTotal) * 100
                  : 0;
                return (
                  <div key={tier.difficulty} className={styles.barRow}>
                    <span className={styles.barLabel}>{tier.label}</span>
                    <div className={styles.barTrack} style={{ width: `${barWidth}%` }}>
                      <span
                        className={styles.barFill}
                        style={{
                          width: `${pct}%`,
                          background: DIFFICULTY_COLORS[tier.difficulty],
                        }}
                      />
                    </div>
                    <span className={styles.barValue}>
                      {tier.solved}/{tier.total}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`${styles.card} ${styles.wideCard}`}>
            <p className={styles.cardLabel}>Activity — last 90 days</p>
            <div className={styles.heatGrid} role="img" aria-label={`Activity over the last 90 days: ${heatMap.reduce((s, d) => s + d.count, 0)} puzzles solved`}>
              {heatMap.map((day) => (
                <span
                  key={day.date}
                  className={styles.heatCell}
                  data-level={heatLevel(day.count) || undefined}
                  title={`${day.date}: ${day.count} solved`}
                />
              ))}
            </div>
            <div className={styles.heatLegend}>
              Less
              <span />
              <span />
              <span />
              <span />
              <span />
              More
            </div>
          </div>

          <div className={`${styles.card} ${styles.wideCard}`}>
            <p className={styles.cardLabel}>
              Achievements — {unlocked.length}/{ACHIEVEMENTS.length}
            </p>
            <div className={styles.achievementGrid}>
              {ACHIEVEMENTS.map((achievement) => {
                const earned = unlockedIds.has(achievement.id);
                return (
                  <div
                    key={achievement.id}
                    className={styles.achievement}
                    data-earned={earned || undefined}
                    title={
                      earned
                        ? `${achievement.title}: ${achievement.description}`
                        : achievement.description
                    }
                  >
                    <span className={styles.achievementIcon}>
                      {achievement.icon}
                    </span>
                    <span className={styles.achievementTitle}>
                      {achievement.title}
                    </span>
                    <span className={styles.achievementDesc}>
                      {achievement.description}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`${styles.card} ${styles.wideCard}`}>
            <p className={styles.cardLabel}>Danger zone</p>
            {resetError && (
              <p className={styles.resetError}>{resetError}</p>
            )}
            {resetStep === "idle" && (
              <button
                type="button"
                className={styles.resetButton}
                onClick={() => setResetStep("confirm")}
              >
                Reset all progress
              </button>
            )}
            {resetStep === "confirm" && (
              <div className={styles.resetConfirm}>
                <p>This will permanently delete all your solved puzzles, stats, and achievements.</p>
                <button
                  type="button"
                  className={styles.resetButton}
                  onClick={() => { setResetStep("typing"); setResetInput(""); }}
                >
                  I understand, continue
                </button>
                <button
                  type="button"
                  className={styles.resetCancel}
                  onClick={() => setResetStep("idle")}
                >
                  Cancel
                </button>
              </div>
            )}
            {resetStep === "typing" && (
              <div className={styles.resetConfirm}>
                <p>Type <strong>RESET</strong> to confirm:</p>
                <input
                  type="text"
                  value={resetInput}
                  onChange={(e) => setResetInput(e.target.value)}
                  className={styles.resetInput}
                  autoFocus
                  spellCheck={false}
                />
                <button
                  type="button"
                  className={styles.resetButton}
                  disabled={resetInput !== "RESET"}
                  onClick={handleResetProgress}
                >
                  Permanently reset progress
                </button>
                <button
                  type="button"
                  className={styles.resetCancel}
                  onClick={() => setResetStep("idle")}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
