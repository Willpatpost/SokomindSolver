import { useCallback } from "react";
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
  readonly selectPuzzle: (id: string) => void;
  readonly selectPreviousPuzzle: () => void;
  readonly selectNextPuzzle: () => void;
}

export function usePuzzleNavigation(
  currentPuzzleId: string,
  onBeforeNavigate: () => void,
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

  return {
    puzzleIndex,
    totalPuzzles: PUZZLE_METADATA.length,
    nextPuzzle,
    selectPuzzle,
    selectPreviousPuzzle,
    selectNextPuzzle,
  };
}
