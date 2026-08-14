import { useCallback } from "react";
import type { PuzzleDifficulty } from "@/src/catalog/puzzle-metadata";
import type { ProgressData } from "@/src/shared/progress";
import { isOptimal, type OptimalCache } from "@/src/shared/optimal-cache";
import type { RatingsData } from "@/src/shared/puzzle-ratings";
import { ExperienceControls } from "@/src/features/experience";
import {
  Link,
  puzzlesHash,
  puzzleDifficultyHash,
  playHash,
} from "@/src/router";
import type { RouterValue } from "@/src/router";
import { DIFFICULTY_LABELS } from "./selector-constants";
import { usePuzzleListState } from "./use-puzzle-list-state";
import { PuzzleFilters } from "./PuzzleFilters";
import { PuzzleMinimap } from "./PuzzleMinimap";
import { Pagination } from "./Pagination";
import styles from "./PuzzleSelectorPage.module.css";

export interface PuzzleListViewProps {
  readonly difficulty: PuzzleDifficulty;
  readonly collection: string;
  readonly completedIds: ReadonlySet<string>;
  readonly favoriteIds?: ReadonlySet<string>;
  readonly optimalCache: OptimalCache;
  readonly progress: ProgressData;
  readonly ratings?: RatingsData;
  readonly navigate: RouterValue["navigate"];
  readonly pageNumber?: number;
  readonly directDifficultyView?: boolean;
  readonly restoreContext?: boolean;
}

export function PuzzleListView({
  difficulty,
  collection,
  completedIds,
  favoriteIds,
  optimalCache,
  progress,
  ratings,
  navigate,
  pageNumber,
  directDifficultyView = false,
  restoreContext = false,
}: PuzzleListViewProps) {
  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const { key } = event;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;

      const container = event.currentTarget;
      const items = Array.from(
        container.querySelectorAll<HTMLElement>("button[data-testid='puzzle-row']"),
      );
      if (items.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      const idx = active ? items.indexOf(active) : -1;
      let next: number;

      if (key === "ArrowDown") {
        next = idx < items.length - 1 ? idx + 1 : 0;
      } else if (key === "ArrowUp") {
        next = idx > 0 ? idx - 1 : items.length - 1;
      } else if (key === "Home") {
        next = 0;
      } else {
        next = items.length - 1;
      }

      event.preventDefault();
      items[next].focus();
    },
    [],
  );

  const {
    boxCounts,
    boxFilter,
    completionFilter,
    query,
    filteredPuzzles,
    visiblePuzzles,
    recentPuzzle,
    nextUnsolved,
    indexMap,
    viewLabel,
    pageHash,
    pageCount,
    currentPage,
    firstResult,
    lastResult,
    pageStatusRef,
    handleSearchChange,
    handleBoxFilterChange,
    handleCompletionFilterChange,
    rememberPuzzleFocus,
  } = usePuzzleListState({
    difficulty,
    collection,
    completedIds,
    favoriteIds,
    navigate,
    pageNumber,
    directDifficultyView,
    restoreContext,
  });

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <div className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <Link
              href={
                directDifficultyView
                  ? puzzlesHash()
                  : puzzleDifficultyHash(difficulty)
              }
              className={styles.backButton}
              aria-label={
                directDifficultyView
                  ? "Back to difficulties"
                  : "Back to collections"
              }
            >
              <span aria-hidden="true">&larr;</span>
            </Link>
            <h1 className={styles.pageTitle}>{viewLabel}</h1>
          </div>
          <ExperienceControls />
        </div>

        <nav className={styles.breadcrumb}>
          <Link href={puzzlesHash()}>Puzzles</Link>
          <span>&rsaquo;</span>
          {directDifficultyView ? (
            <span className={styles.breadcrumbCurrent} aria-current="page">
              {DIFFICULTY_LABELS[difficulty]}
            </span>
          ) : (
            <>
              <Link href={puzzleDifficultyHash(difficulty)}>
                {DIFFICULTY_LABELS[difficulty]}
              </Link>
              <span>&rsaquo;</span>
              <span className={styles.breadcrumbCurrent} aria-current="page">{collection}</span>
            </>
          )}
        </nav>

        {restoreContext && recentPuzzle ? (
          <aside className={styles.recentPuzzle} aria-label="Recently played puzzle">
            <span>
              <small>Back where you left off</small>
              <strong>{recentPuzzle.title}</strong>
            </span>
            <Link
              href={playHash(recentPuzzle.id)}
              onClick={() => rememberPuzzleFocus(recentPuzzle.id)}
            >
              Continue
            </Link>
          </aside>
        ) : null}

        {nextUnsolved && (
          <button
            type="button"
            className={styles.nextButton}
            onClick={() => {
              rememberPuzzleFocus(nextUnsolved);
              navigate(playHash(nextUnsolved));
            }}
          >
            Play next unsolved in {viewLabel}
          </button>
        )}

        <PuzzleFilters
          boxCounts={boxCounts}
          boxFilter={boxFilter}
          completionFilter={completionFilter}
          query={query}
          onBoxFilterChange={handleBoxFilterChange}
          onCompletionFilterChange={handleCompletionFilterChange}
          onSearchChange={handleSearchChange}
        />

        {filteredPuzzles.length > 0 ? (
          <>
            <p
              className={styles.resultSummary}
              ref={pageStatusRef}
              role="status"
              tabIndex={-1}
            >
              Showing {firstResult}&ndash;{lastResult} of{" "}
              {filteredPuzzles.length}
              {" puzzles"}
            </p>
            <div
              className={styles.puzzleList}
              role="list"
              aria-label={`${viewLabel} puzzles`}
              onKeyDown={handleListKeyDown}
            >
              {visiblePuzzles.map((puzzle) => {
                const complete = completedIds.has(puzzle.id);
                const record = progress.completed[puzzle.id];
                const optimal = record
                  ? isOptimal(optimalCache, puzzle.id, record.moves)
                  : false;
                const num = (indexMap.get(puzzle.id) ?? 0) + 1;
                const tooltip = record
                  ? `Best: ${record.moves} moves, ${record.pushes} pushes${optimal ? " (optimal)" : ""}`
                  : puzzle.title;
                return (
                  <button
                    key={puzzle.id}
                    type="button"
                    className={styles.puzzleItem}
                    data-testid="puzzle-row"
                    data-puzzle-id={puzzle.id}
                    data-solved={complete || undefined}
                    data-optimal={optimal || undefined}
                    title={tooltip}
                    onClick={() => {
                      rememberPuzzleFocus(puzzle.id);
                      navigate(playHash(puzzle.id));
                    }}
                  >
                    <PuzzleMinimap
                      width={puzzle.width}
                      height={puzzle.height}
                      boxes={puzzle.boxes}
                      puzzleId={puzzle.id}
                    />
                    <span className={styles.puzzleNumber}>
                      {String(num).padStart(2, "0")}
                    </span>
                    <span className={styles.puzzleCopy}>
                      <strong>{puzzle.title}</strong>
                      <small>
                        {puzzle.width} &times; {puzzle.height}
                        {" · "}
                        {puzzle.boxes} {puzzle.boxes === 1 ? "box" : "boxes"}
                        {record && (
                          <>
                            {" · "}
                            {record.moves}m {record.pushes}p
                          </>
                        )}
                        {ratings?.[puzzle.id] && (
                          <>
                            {" · "}
                            <span
                              className={styles.ratingDot}
                              data-rating={ratings[puzzle.id]}
                            />
                          </>
                        )}
                      </small>
                    </span>
                    {favoriteIds?.has(puzzle.id) && (
                      <span className={styles.puzzleFavorite}>♥</span>
                    )}
                    {complete && (
                      <span
                        className={styles.puzzleComplete}
                        style={
                          optimal ? { color: "var(--amber-400)" } : undefined
                        }
                      >
                        {optimal ? "★" : "✓"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <Pagination
              ariaLabel={`${viewLabel} puzzle pages`}
              currentPage={currentPage}
              pageCount={pageCount}
              pageHash={pageHash}
            />
          </>
        ) : (
          <div className={styles.empty}>
            <strong>No puzzles match</strong>
            <span>Try adjusting your filters.</span>
          </div>
        )}
      </div>
    </main>
  );
}
