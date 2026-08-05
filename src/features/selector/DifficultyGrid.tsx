import { useMemo } from "react";
import {
  DIFFICULTY_ORDER,
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
            const solved = puzzles.filter((p) => completedIds.has(p.id)).length;
            const pct = puzzles.length > 0 ? (solved / puzzles.length) * 100 : 0;
            return (
              <button
                key={difficulty}
                type="button"
                className={styles.difficultyCard}
                onClick={() => navigate(puzzleDifficultyHash(difficulty))}
              >
                <div className={styles.cardHeader}>
                  <span
                    className={styles.cardDot}
                    style={{ background: DIFFICULTY_COLORS[difficulty] }}
                  />
                  <h2 className={styles.cardName}>{DIFFICULTY_LABELS[difficulty]}</h2>
                </div>
                <div className={styles.cardStats}>
                  <strong>{solved}</strong> of {puzzles.length} cleared
                </div>
                <div className={styles.cardTrack}>
                  <span style={{ width: `${pct}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </main>
  );
}
