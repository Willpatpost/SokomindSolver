import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PUZZLE_METADATA,
  getPuzzleMetadataById,
  type PuzzleMetadata,
} from "@/src/catalog/puzzle-metadata";
import { useStoredProgress } from "@/src/shared/use-stored-progress";
import {
  loadSessionPuzzleId,
  loadSessionPuzzleIdFromIDB,
} from "@/src/shared/session-persistence";
import { toLocalDateKey } from "@/src/shared/progress";
import { computeStats } from "@/src/features/progress/compute-stats";
import { buildDailyChallengeView } from "@/src/features/progress/daily-challenge";
import { GuidedJourneyCard } from "@/src/features/journey/GuidedJourneyCard";
import { ExperienceControls } from "@/src/features/experience";
import { HowToPlay } from "@/src/features/help/HowToPlay";
import {
  useRouter,
  playHash,
  puzzlesHash,
  puzzleDifficultyHash,
  editorHash,
  statsHash,
} from "@/src/router";
import styles from "./HomePage.module.css";
import { DailyChallengeCard } from "./DailyChallengeCard";

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

const DIFFICULTY_COLORS: Record<string, string> = {
  tutorial: "var(--sage-500)",
  beginner: "var(--sage-600)",
  intermediate: "var(--blue-500)",
  advanced: "var(--amber-500)",
  expert: "var(--coral-500)",
  master: "var(--ink-700)",
};

export function HomePage() {
  const { navigate } = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const [dailyNow, setDailyNow] = useState(() => new Date());
  const isKnownPuzzleId = useCallback(
    (puzzleId: string) => getPuzzleMetadataById(puzzleId) !== undefined,
    [],
  );
  const [continueTarget, setContinueTarget] = useState<string | null>(() =>
    loadSessionPuzzleId(isKnownPuzzleId),
  );

  useEffect(() => {
    document.title = "Sokomind";
  }, []);

  useEffect(() => {
    let timer: number | undefined;

    const refreshForCurrentLocalDate = () => {
      setDailyNow((previous) => {
        const next = new Date();
        return toLocalDateKey(previous) === toLocalDateKey(next)
          ? previous
          : next;
      });
    };
    const scheduleRollover = () => {
      const now = new Date();
      const nextMidnight = new Date(now);
      nextMidnight.setHours(24, 0, 0, 50);
      timer = window.setTimeout(() => {
        refreshForCurrentLocalDate();
        scheduleRollover();
      }, Math.min(60_000, nextMidnight.getTime() - now.getTime()));
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshForCurrentLocalDate();
      }
    };

    scheduleRollover();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", refreshForCurrentLocalDate);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", refreshForCurrentLocalDate);
    };
  }, []);

  const progress = useStoredProgress();
  const stats = useMemo(
    () => computeStats(progress, PUZZLE_METADATA),
    [progress],
  );

  useEffect(() => {
    let active = true;
    void loadSessionPuzzleIdFromIDB(isKnownPuzzleId).then((puzzleId) => {
      if (active && puzzleId) setContinueTarget(puzzleId);
    });
    return () => { active = false; };
  }, [isKnownPuzzleId]);

  const nextUnsolved = useMemo(() => {
    const completed = new Set(Object.keys(progress.completed));
    return PUZZLE_METADATA.find((p) => !completed.has(p.id))?.id;
  }, [progress]);

  const dailyView = useMemo(
    () => buildDailyChallengeView(PUZZLE_METADATA, progress, dailyNow),
    [dailyNow, progress],
  );

  const continueId =
    continueTarget ?? nextUnsolved ?? PUZZLE_METADATA[0]?.id ?? "ultra-tiny";
  const pct = stats.completionPercentage;

  const recentPuzzles = useMemo(() => {
    const entries: { meta: PuzzleMetadata; completedAt: string; moves: number; pushes: number }[] = [];
    for (const [puzzleId, record] of Object.entries(progress.completed)) {
      const meta = getPuzzleMetadataById(puzzleId);
      if (meta) {
        entries.push({ meta, completedAt: record.completedAt, moves: record.moves, pushes: record.pushes });
      }
    }
    entries.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    return entries.slice(0, 4);
  }, [progress]);

  const pickRandom = useCallback(() => {
    const completed = new Set(Object.keys(progress.completed));
    const unsolved = PUZZLE_METADATA.filter((p) => !completed.has(p.id));
    const pool = unsolved.length > 0 ? unsolved : PUZZLE_METADATA;
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    navigate(playHash(pick.id));
  }, [progress, navigate]);

  return (
    <main className={styles.page}>
      <div className={styles.settings}>
        <ExperienceControls />
      </div>

      <div className={styles.card}>
        <div className={styles.hero}>
          <span className={styles.brandMark} aria-hidden="true">
            <span /><span /><span /><span />
          </span>
          <h1 className={styles.title}>Sokomind</h1>
          <p className={styles.subtitle}>Think before you push</p>
        </div>

        <div className={styles.progress}>
          <p className={styles.progressLabel}>
            <strong>{stats.totalSolved}</strong> of {stats.totalPuzzles} rooms cleared
          </p>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Puzzle completion progress"
          >
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className={styles.tiers}>
            {stats.byDifficulty.map((tier) => {
              const tierPct = tier.total > 0 ? (tier.solved / tier.total) * 100 : 0;
              return (
                <button
                  key={tier.difficulty}
                  type="button"
                  className={styles.tier}
                  title={`${tier.label}: ${tier.solved} of ${tier.total} solved (${Math.round(tierPct)}%)`}
                  onClick={() => navigate(puzzleDifficultyHash(tier.difficulty))}
                >
                  <span
                    className={styles.tierDot}
                    style={{ background: DIFFICULTY_COLORS[tier.difficulty] }}
                  />
                  <span className={styles.tierLabel}>
                    {tier.label} <strong>{tier.solved}/{tier.total}</strong>
                  </span>
                  <span className={styles.tierBar}>
                    <span style={{ width: `${tierPct}%`, background: DIFFICULTY_COLORS[tier.difficulty] }} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {stats.streak.current > 0 && (
          <div className={styles.streakBanner}>
            <span className={styles.streakFlame} aria-hidden="true" />
            <div className={styles.streakInfo}>
              <strong>{stats.streak.current}-day streak</strong>
              {stats.streak.longest > stats.streak.current && (
                <span>Best: {stats.streak.longest} days</span>
              )}
            </div>
          </div>
        )}

        <DailyChallengeCard
          view={dailyView}
          onPlay={(puzzleId) => navigate(playHash(puzzleId))}
          onBrowse={() => navigate(puzzlesHash())}
        />

        <GuidedJourneyCard
          progress={progress}
          onPlay={(puzzleId) => navigate(playHash(puzzleId))}
          onBrowse={() => navigate(puzzlesHash())}
        />

        {recentPuzzles.length > 0 && (
          <div className={styles.recentSection}>
            <p className={styles.recentLabel}>Recently cleared</p>
            <div className={styles.recentList}>
              {recentPuzzles.map((entry) => (
                <button
                  key={entry.meta.id}
                  type="button"
                  className={styles.recentItem}
                  onClick={() => navigate(playHash(entry.meta.id))}
                >
                  <strong>{entry.meta.title}</strong>
                  <span>{entry.moves}m / {entry.pushes}p · {timeAgo(entry.completedAt)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => navigate(playHash(continueId))}
          >
            {stats.totalSolved > 0 ? "Continue playing" : "Start playing"}
          </button>
          <div className={styles.secondaryButtons}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => navigate(puzzlesHash())}
            >
              Browse puzzles
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => navigate(editorHash())}
            >
              Create a puzzle
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => navigate(statsHash())}
            >
              Statistics
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={pickRandom}
            >
              Random puzzle
            </button>
          </div>
        </div>

        <button
          type="button"
          className={styles.helpLink}
          onClick={() => setHelpOpen(true)}
        >
          <span aria-hidden="true">?</span> How to play
        </button>
      </div>

      <footer className={styles.footer}>
        <span>A Sokoban puzzle game</span>
        <span>Built with care</span>
      </footer>

      <HowToPlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </main>
  );
}
