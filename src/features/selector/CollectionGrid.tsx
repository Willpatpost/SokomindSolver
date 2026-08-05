import { useMemo } from "react";
import {
  getPuzzleMetadataByDifficulty,
  type PuzzleDifficulty,
  type PuzzleMetadata,
} from "@/src/catalog/puzzle-metadata";
import { ExperienceControls } from "@/src/features/experience";
import {
  Link,
  puzzlesHash,
  puzzleCollectionHash,
  playHash,
} from "@/src/router";
import { DIFFICULTY_LABELS } from "./selector-constants";
import styles from "./PuzzleSelectorPage.module.css";

export interface CollectionGridProps {
  readonly difficulty: PuzzleDifficulty;
  readonly collections: readonly { name: string; count: number }[];
  readonly completedIds: ReadonlySet<string>;
  readonly findNextUnsolved: (p: readonly PuzzleMetadata[]) => string | undefined;
  readonly navigate: (hash: string) => void;
}

export function CollectionGrid({
  difficulty,
  collections,
  completedIds,
  findNextUnsolved,
  navigate,
}: CollectionGridProps) {
  const puzzles = useMemo(
    () => getPuzzleMetadataByDifficulty(difficulty),
    [difficulty],
  );
  const nextId = useMemo(() => findNextUnsolved(puzzles), [findNextUnsolved, puzzles]);

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <div className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <Link href={puzzlesHash()} className={styles.backButton} aria-label="Back to difficulties">
              <span aria-hidden="true">&larr;</span>
            </Link>
            <h1 className={styles.pageTitle}>{DIFFICULTY_LABELS[difficulty]}</h1>
          </div>
          <ExperienceControls />
        </div>

        <nav className={styles.breadcrumb}>
          <Link href={puzzlesHash()}>Puzzles</Link>
          <span>&rsaquo;</span>
          <span className={styles.breadcrumbCurrent}>{DIFFICULTY_LABELS[difficulty]}</span>
        </nav>

        {nextId && (
          <button
            type="button"
            className={styles.nextButton}
            onClick={() => navigate(playHash(nextId))}
          >
            Play next unsolved in {DIFFICULTY_LABELS[difficulty]}
          </button>
        )}

        <div className={styles.grid}>
          {collections.map((col) => {
            const colPuzzles = puzzles.filter(
              (p) => p.collection === col.name,
            );
            const solved = colPuzzles.filter((p) => completedIds.has(p.id)).length;
            const pct = col.count > 0 ? (solved / col.count) * 100 : 0;
            return (
              <button
                key={col.name}
                type="button"
                className={styles.collectionCard}
                onClick={() => navigate(puzzleCollectionHash(difficulty, col.name))}
              >
                <h2 className={styles.cardName}>{col.name}</h2>
                <div className={styles.cardStats}>
                  <strong>{solved}</strong> of {col.count} cleared
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
