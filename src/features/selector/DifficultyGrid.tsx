import { useMemo } from "react";
import {
  DIFFICULTY_ORDER,
  getMetadataCollectionsForDifficulty,
  getPuzzleMetadataByDifficulty,
  PUZZLE_METADATA,
  type PuzzleMetadata,
} from "@/src/catalog/puzzle-metadata";
import { ExperienceControls } from "@/src/features/experience";
import {
  Link,
  homeHash,
  puzzleDifficultyHash,
  playHash,
} from "@/src/router";
import { DIFFICULTY_LABELS, DIFFICULTY_COLORS } from "./selector-constants";
import { ProgressRing } from "./ProgressRing";
import styles from "./PuzzleSelectorPage.module.css";

export interface DifficultyGridProps {
  readonly completedIds: ReadonlySet<string>;
  readonly findNextUnsolved: (p: readonly PuzzleMetadata[]) => string | undefined;
  readonly navigate: (hash: string) => void;
}

export function DifficultyGrid({
  completedIds,
  findNextUnsolved,
  navigate,
}: DifficultyGridProps) {
  const nextId = useMemo(
    () => findNextUnsolved(PUZZLE_METADATA),
    [findNextUnsolved],
  );

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <div className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <Link href={homeHash()} className={styles.backButton} aria-label="Back to home">
              <span aria-hidden="true">&larr;</span>
            </Link>
            <h1 className={styles.pageTitle}>Choose a difficulty</h1>
          </div>
          <ExperienceControls />
        </div>

        {nextId && (
          <button
            type="button"
            className={styles.nextButton}
            onClick={() => navigate(playHash(nextId))}
          >
            Play next unsolved
          </button>
        )}

        <div className={styles.grid}>
          {DIFFICULTY_ORDER.map((difficulty) => {
            const puzzles = getPuzzleMetadataByDifficulty(difficulty);
            const collections = getMetadataCollectionsForDifficulty(difficulty);
            const solved = puzzles.filter((p) => completedIds.has(p.id)).length;
            const unsolved = puzzles.filter((p) => !completedIds.has(p.id));
            const pct = puzzles.length > 0 ? (solved / puzzles.length) * 100 : 0;
            return (
              <div key={difficulty} className={styles.difficultyCard}>
                <button
                  type="button"
                  className={styles.difficultyCardMain}
                  onClick={() => navigate(puzzleDifficultyHash(difficulty))}
                >
                  <div className={styles.cardHeader}>
                    <ProgressRing
                      percentage={pct}
                      color={DIFFICULTY_COLORS[difficulty]}
                    />
                    <div>
                      <h2 className={styles.cardName}>{DIFFICULTY_LABELS[difficulty]}</h2>
                      <div className={styles.cardStats}>
                        <strong>{solved}</strong> of {puzzles.length} cleared
                      </div>
                    </div>
                  </div>
                  <div className={styles.cardTrack}>
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  {puzzles.length > 0 && (
                    <div className={styles.cardMeta}>
                      <span>{puzzles.length} puzzles</span>
                      {collections.length > 1 && (
                        <span>{collections.length} collections</span>
                      )}
                      <span>
                        {Math.round(puzzles.reduce((s, p) => s + p.boxes, 0) / puzzles.length)} avg boxes
                      </span>
                    </div>
                  )}
                </button>
                {unsolved.length > 0 && (
                  <button
                    type="button"
                    className={styles.randomButton}
                    aria-label={`Random unsolved ${DIFFICULTY_LABELS[difficulty]} puzzle`}
                    onClick={() => {
                      const pick = unsolved[Math.floor(Math.random() * unsolved.length)];
                      navigate(playHash(pick.id));
                    }}
                  >
                    Random unsolved
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
