import { useCallback, useMemo } from "react";
import {
  PUZZLE_METADATA,
  getPuzzleMetadataIndexById,
  type PuzzleMetadata,
} from "@/src/catalog/puzzle-metadata";
import { useRouter, playHash } from "@/src/router";

interface UsePuzzleNavigationResult {
  readonly puzzleIndex: number;
  readonly totalPuzzles: number;
  readonly nextPuzzle: PuzzleMetadata | undefined;
  readonly nextUnsolvedPuzzle: PuzzleMetadata | undefined;
  readonly selectPuzzle: (id: string) => void;
  readonly selectPreviousPuzzle: () => void;
  readonly selectNextPuzzle: () => void;
}

export function usePuzzleNavigation(
  currentPuzzleId: string,
  onBeforeNavigate: () => void,
  completedIds?: ReadonlySet<string>,
): UsePuzzleNavigationResult {
  const { navigate } = useRouter();

  const selectPuzzle = useCallback((id: string) => {
    onBeforeNavigate();
    navigate(playHash(id));
  }, [navigate, onBeforeNavigate]);

  const selectPreviousPuzzle = useCallback(() => {
    const currentIndex = getPuzzleMetadataIndexById(currentPuzzleId);
    if (currentIndex > 0) {
      selectPuzzle(PUZZLE_METADATA[currentIndex - 1].id);
    }
  }, [currentPuzzleId, selectPuzzle]);

  const selectNextPuzzle = useCallback(() => {
    const currentIndex = getPuzzleMetadataIndexById(currentPuzzleId);
    if (currentIndex < PUZZLE_METADATA.length - 1) {
      selectPuzzle(PUZZLE_METADATA[currentIndex + 1].id);
    }
  }, [currentPuzzleId, selectPuzzle]);

  const puzzleIndex = getPuzzleMetadataIndexById(currentPuzzleId);
  const nextPuzzle = PUZZLE_METADATA[puzzleIndex + 1];

  const nextUnsolvedPuzzle = useMemo(() => {
    if (!completedIds || completedIds.size === 0) return nextPuzzle;
    for (let i = puzzleIndex + 1; i < PUZZLE_METADATA.length; i++) {
      if (!completedIds.has(PUZZLE_METADATA[i].id)) return PUZZLE_METADATA[i];
    }
    for (let i = 0; i < puzzleIndex; i++) {
      if (!completedIds.has(PUZZLE_METADATA[i].id)) return PUZZLE_METADATA[i];
    }
    return undefined;
  }, [puzzleIndex, completedIds, nextPuzzle]);

  return {
    puzzleIndex,
    totalPuzzles: PUZZLE_METADATA.length,
    nextPuzzle,
    nextUnsolvedPuzzle,
    selectPuzzle,
    selectPreviousPuzzle,
    selectNextPuzzle,
  };
}
