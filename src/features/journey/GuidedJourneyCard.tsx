import { useEffect, useMemo, useState } from "react";
import {
  PUZZLE_METADATA,
  getPuzzleMetadataById,
} from "../../catalog/puzzle-metadata.ts";
import type { ProgressData } from "../../shared/progress.ts";
import { STORAGE_KEYS } from "../../shared/storage.ts";
import {
  getJourneyChapterProgress,
  getJourneyRecommendation,
} from "./guided-journey.ts";
import {
  loadGuidedJourneyPreferences,
  saveGuidedJourneyPreferences,
} from "./guided-journey-preferences.ts";
import styles from "./GuidedJourneyCard.module.css";

interface GuidedJourneyCardProps {
  readonly progress: ProgressData;
  readonly onPlay: (puzzleId: string) => void;
  readonly onBrowse: () => void;
}

export function GuidedJourneyCard({
  progress,
  onPlay,
  onBrowse,
}: GuidedJourneyCardProps) {
  const [preferences, setPreferences] = useState(loadGuidedJourneyPreferences);
  const chapters = useMemo(
    () => getJourneyChapterProgress(progress, PUZZLE_METADATA),
    [progress],
  );
  const recommendation = useMemo(
    () => getJourneyRecommendation(progress, PUZZLE_METADATA),
    [progress],
  );
  const journeySolved = chapters.reduce((sum, chapter) => sum + chapter.solved, 0);
  const journeyTotal = chapters.reduce((sum, chapter) => sum + chapter.total, 0);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.guidedJourney) {
        setPreferences(loadGuidedJourneyPreferences());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setDismissed = (dismissed: boolean) => {
    const next = { version: 1, dismissed } as const;
    if (saveGuidedJourneyPreferences(next).ok) setPreferences(next);
  };

  if (preferences.dismissed) {
    return (
      <section className={styles.resumeCard} aria-labelledby="guided-path-resume-title">
        <div>
          <p className={styles.eyebrow}>Guided path paused</p>
          <h2 id="guided-path-resume-title">Explore your own way</h2>
          <p>Your chapter progress is safe. Resume whenever you want a suggestion.</p>
        </div>
        <button type="button" onClick={() => setDismissed(false)}>
          Resume guided path
        </button>
      </section>
    );
  }

  return (
    <section className={styles.card} aria-labelledby="guided-path-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Optional journey · {journeySolved}/{journeyTotal}</p>
          <h2 id="guided-path-title">Build your Sokoban instincts</h2>
          <p>Five concept chapters offer direction, never gates.</p>
        </div>
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => setDismissed(true)}
          aria-label="Pause guided path"
        >
          Pause
        </button>
      </header>

      {recommendation ? (
        <div className={styles.recommendation} data-testid="journey-recommendation">
          <div>
            <span>Suggested next · {recommendation.chapterTitle}</span>
            <strong>{getPuzzleMetadataById(recommendation.puzzleId)?.title}</strong>
            <p>{recommendation.reason}</p>
          </div>
          <button type="button" onClick={() => onPlay(recommendation.puzzleId)}>
            Play suggestion
          </button>
        </div>
      ) : (
        <div className={styles.recommendation} data-complete>
          <div>
            <span>Journey complete</span>
            <strong>Every chapter cleared</strong>
            <p>Your next direction is yours: revisit a favorite route or explore the full catalog.</p>
          </div>
          <button type="button" onClick={onBrowse}>Browse catalog</button>
        </div>
      )}

      <ol className={styles.map} aria-label="Guided journey chapters">
        {chapters.map((chapter) => (
          <li
            key={chapter.id}
            className={styles.chapter}
            data-complete={chapter.complete || undefined}
          >
            <div className={styles.chapterHeading}>
              <span className={styles.chapterNumber}>{chapter.number}</span>
              <div>
                <h3>{chapter.title}</h3>
                <p>{chapter.concept}</p>
              </div>
              <span className={styles.chapterCount}>{chapter.solved}/{chapter.total}</span>
            </div>
            <p className={styles.explanation}>{chapter.explanation}</p>
            {chapter.prerequisiteChapterIds.length > 0 && !chapter.prerequisitesMet ? (
              <p className={styles.prerequisite}>
                Recommended first: {chapters.find(({ id }) => id === chapter.prerequisiteChapterIds[0])?.title}
              </p>
            ) : null}
            <div className={styles.nodes} aria-label={`${chapter.title} rooms`}>
              {chapter.puzzleIds.map((puzzleId, index) => {
                const metadata = getPuzzleMetadataById(puzzleId);
                const complete = progress.completed[puzzleId] !== undefined;
                return (
                  <button
                    key={puzzleId}
                    type="button"
                    className={styles.node}
                    data-complete={complete || undefined}
                    onClick={() => onPlay(puzzleId)}
                    aria-label={`${metadata?.title ?? puzzleId}${complete ? ", cleared" : ", not cleared"}`}
                    title={metadata?.title ?? puzzleId}
                  >
                    {complete ? "✓" : index + 1}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ol>

      <button type="button" className={styles.catalogLink} onClick={onBrowse}>
        Browse all {PUZZLE_METADATA.length} puzzles
      </button>
    </section>
  );
}
