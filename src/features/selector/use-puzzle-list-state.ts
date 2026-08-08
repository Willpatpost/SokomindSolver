import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getPuzzleMetadataByDifficulty,
  getMetadataBoxCounts,
  type PuzzleDifficulty,
} from "@/src/catalog/puzzle-metadata";
import type { RouterValue } from "@/src/router";
import {
  puzzleDifficultyHash,
  puzzleDifficultyPageHash,
  puzzleCollectionHash,
  puzzleCollectionPageHash,
} from "@/src/router";
import { DIFFICULTY_LABELS, PUZZLES_PER_PAGE } from "./selector-constants";

export type CompletionFilter = "all" | "cleared" | "open" | "favorites";

export interface UsePuzzleListStateOptions {
  readonly difficulty: PuzzleDifficulty;
  readonly collection: string;
  readonly completedIds: ReadonlySet<string>;
  readonly favoriteIds?: ReadonlySet<string>;
  readonly navigate: RouterValue["navigate"];
  readonly pageNumber?: number;
  readonly directDifficultyView: boolean;
}

export function usePuzzleListState({
  difficulty,
  collection,
  completedIds,
  favoriteIds,
  navigate,
  pageNumber,
  directDifficultyView,
}: UsePuzzleListStateOptions) {
  const [boxFilter, setBoxFilter] = useState<number | null>(null);
  const [completionFilter, setCompletionFilter] = useState<CompletionFilter>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pageStatusRef = useRef<HTMLParagraphElement>(null);
  const previousPageNumberRef = useRef(pageNumber);
  const preserveFilterFocusRef = useRef(false);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const allPuzzles = useMemo(
    () =>
      getPuzzleMetadataByDifficulty(difficulty).filter(
        (p) => p.collection === collection,
      ),
    [difficulty, collection],
  );

  const boxCounts = useMemo(
    () => getMetadataBoxCounts(difficulty, collection),
    [difficulty, collection],
  );

  const filteredPuzzles = useMemo(() => {
    const needle = debouncedQuery.trim().toLocaleLowerCase();
    return allPuzzles.filter((p) => {
      if (boxFilter !== null && p.boxes !== boxFilter) return false;
      if (completionFilter === "cleared" && !completedIds.has(p.id)) return false;
      if (completionFilter === "open" && completedIds.has(p.id)) return false;
      if (completionFilter === "favorites" && !favoriteIds?.has(p.id)) return false;
      if (needle && !p.title.toLocaleLowerCase().includes(needle)) return false;
      return true;
    });
  }, [allPuzzles, boxFilter, completionFilter, completedIds, favoriteIds, debouncedQuery]);

  const nextUnsolved = useMemo(
    () => allPuzzles.find((p) => !completedIds.has(p.id))?.id,
    [allPuzzles, completedIds],
  );

  const indexMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < allPuzzles.length; i++) map.set(allPuzzles[i].id, i);
    return map;
  }, [allPuzzles]);

  const viewLabel = directDifficultyView
    ? DIFFICULTY_LABELS[difficulty]
    : collection;
  const baseListHash = directDifficultyView
    ? puzzleDifficultyHash(difficulty)
    : puzzleCollectionHash(difficulty, collection);
  const pageHash = useCallback(
    (nextPage: number) =>
      directDifficultyView
        ? puzzleDifficultyPageHash(difficulty, nextPage)
        : puzzleCollectionPageHash(difficulty, collection, nextPage),
    [collection, difficulty, directDifficultyView],
  );

  const pageCount = Math.max(
    1,
    Math.ceil(filteredPuzzles.length / PUZZLES_PER_PAGE),
  );
  const requestedPage = pageNumber ?? 1;
  const currentPage = Math.min(requestedPage, pageCount);
  const pageStart = (currentPage - 1) * PUZZLES_PER_PAGE;
  const visiblePuzzles = filteredPuzzles.slice(
    pageStart,
    pageStart + PUZZLES_PER_PAGE,
  );
  const firstResult = filteredPuzzles.length === 0 ? 0 : pageStart + 1;
  const lastResult = Math.min(
    pageStart + visiblePuzzles.length,
    filteredPuzzles.length,
  );

  const resetPagination = useCallback(() => {
    if (pageNumber !== undefined) {
      preserveFilterFocusRef.current = true;
      navigate(baseListHash, { replace: true });
    }
  }, [baseListHash, navigate, pageNumber]);

  const handleSearchChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setQuery(value);
      resetPagination();
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setDebouncedQuery(value), 150);
    },
    [resetPagination],
  );

  const handleBoxFilterChange = useCallback(
    (value: number | null) => {
      setBoxFilter(value);
      resetPagination();
    },
    [resetPagination],
  );

  const handleCompletionFilterChange = useCallback(
    (value: CompletionFilter) => {
      setCompletionFilter(value);
      resetPagination();
    },
    [resetPagination],
  );

  useEffect(() => {
    if (requestedPage === currentPage) return;
    navigate(pageHash(currentPage), { replace: true });
  }, [currentPage, navigate, pageHash, requestedPage]);

  useEffect(() => {
    if (previousPageNumberRef.current === pageNumber) return;
    previousPageNumberRef.current = pageNumber;
    if (preserveFilterFocusRef.current) {
      preserveFilterFocusRef.current = false;
      return;
    }
    pageStatusRef.current?.focus();
  }, [pageNumber]);

  return {
    allPuzzles,
    boxCounts,
    boxFilter,
    completionFilter,
    query,
    filteredPuzzles,
    visiblePuzzles,
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
  };
}
