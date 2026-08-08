import { useMemo, useState } from "react";
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
import { DIFFICULTY_LABELS, DIFFICULTY_COLORS } from "./selector-constants";
import { ProgressRing } from "./ProgressRing";
import styles from "./PuzzleSelectorPage.module.css";

type CollectionSort = "name" | "progress" | "count";

const SORT_OPTIONS: ReadonlyArray<{ value: CollectionSort; label: string }> = [
  { value: "name", label: "Name" },
  { value: "progress", label: "Progress" },
  { value: "count", label: "Size" },
];

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
  const [sort, setSort] = useState<CollectionSort>("name");
  const puzzles = useMemo(
    () => getPuzzleMetadataByDifficulty(difficulty),
    [difficulty],
  );
  const nextId = useMemo(() => findNextUnsolved(puzzles), [findNextUnsolved, puzzles]);

  const sortedCollections = useMemo(() => {
    const withStats = collections.map((col) => {
      const colPuzzles = puzzles.filter((p) => p.collection === col.name);
      const solved = colPuzzles.filter((p) => completedIds.has(p.id)).length;
      const pct = col.count > 0 ? solved / col.count : 0;
      return { ...col, solved, pct, colPuzzles };
    });
    const sorted = [...withStats];
    if (sort === "progress") sorted.sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
    else if (sort === "count") sorted.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return sorted;
  }, [collections, puzzles, completedIds, sort]);

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
          <span className={styles.breadcrumbCurrent} aria-current="page">{DIFFICULTY_LABELS[difficulty]}</span>
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

        <div className={styles.filters}>
          <div className={styles.filterGroup}>
            <span className={styles.filterLabel}>Sort</span>
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={styles.filterChip}
                data-active={sort === opt.value || undefined}
                aria-pressed={sort === opt.value}
                onClick={() => setSort(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.grid}>
          {sortedCollections.map((col) => {
            const pct = col.pct * 100;
            return (
              <button
                key={col.name}
                type="button"
                className={styles.collectionCard}
                data-complete={col.count > 0 && col.solved === col.count || undefined}
                onClick={() => navigate(puzzleCollectionHash(difficulty, col.name))}
              >
                <div className={styles.cardHeader}>
                  <ProgressRing
                    percentage={pct}
                    color={DIFFICULTY_COLORS[difficulty]}
                    size={40}
                    strokeWidth={3}
                  />
                  <div>
                    <h2 className={styles.cardName}>{col.name}</h2>
                    <div className={styles.cardStats}>
                      <strong>{col.solved}</strong> of {col.count} cleared
                      {col.count > 0 && ` (${Math.round(pct)}%)`}
                    </div>
                  </div>
                </div>
                <div className={styles.cardTrack}>
                  <span style={{ width: `${pct}%` }} />
                </div>
                {col.colPuzzles.length > 0 && (
                  <div className={styles.cardMeta}>
                    {(() => {
                      const boxes = col.colPuzzles.map((p) => p.boxes);
                      const minBox = Math.min(...boxes);
                      const maxBox = Math.max(...boxes);
                      const boxRange = minBox === maxBox ? `${minBox}` : `${minBox}–${maxBox}`;
                      const avgW = Math.round(col.colPuzzles.reduce((s, p) => s + p.width, 0) / col.colPuzzles.length);
                      const avgH = Math.round(col.colPuzzles.reduce((s, p) => s + p.height, 0) / col.colPuzzles.length);
                      return (
                        <>
                          <span>{boxRange} boxes</span>
                          <span>~{avgW}&times;{avgH} avg</span>
                        </>
                      );
                    })()}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </main>
  );
}
