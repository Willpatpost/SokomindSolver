import { useEffect, useMemo, useState } from "react";
import {
  PUZZLE_METADATA,
  getPuzzleMetadataById,
} from "@/src/catalog/puzzle-metadata";
import { useStoredProgress } from "@/src/shared/use-stored-progress";
import { loadSessionPuzzleId } from "@/src/shared/session-persistence";
import { computeStats } from "@/src/features/progress/compute-stats";
import { ExperienceControls } from "@/src/features/experience";
import { HowToPlay } from "@/src/features/help/HowToPlay";
import { useRouter, playHash, puzzlesHash, editorHash } from "@/src/router";
import styles from "./HomePage.module.css";

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

  useEffect(() => {
    document.title = "Sokomind";
  }, []);

  const progress = useStoredProgress();
  const stats = useMemo(
    () => computeStats(progress, PUZZLE_METADATA),
    [progress],
  );

  const continueTarget = useMemo(() => {
    return loadSessionPuzzleId(
      (puzzleId) => getPuzzleMetadataById(puzzleId) !== undefined,
    );
  }, []);

  const nextUnsolved = useMemo(() => {
    const completed = new Set(Object.keys(progress.completed));
    return PUZZLE_METADATA.find((p) => !completed.has(p.id))?.id;
  }, [progress]);

  const continueId =
    continueTarget ?? nextUnsolved ?? PUZZLE_METADATA[0]?.id ?? "ultra-tiny";
  const pct = stats.completionPercentage;

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
            {stats.byDifficulty.map((tier) => (
              <div key={tier.difficulty} className={styles.tier}>
                <span
                  className={styles.tierDot}
                  style={{ background: DIFFICULTY_COLORS[tier.difficulty] }}
                />
                <span>
                  {tier.label} <strong>{tier.solved}/{tier.total}</strong>
                </span>
              </div>
            ))}
          </div>
        </div>

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

      <HowToPlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </main>
  );
}
