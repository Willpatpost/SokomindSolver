import { useCallback, useMemo } from "react";
import {
  PUZZLE_METADATA,
  type PuzzleMetadata,
} from "@/src/catalog/puzzle-metadata";
import type { Difficulty } from "@/src/core/model";
import { useRouter, playHash } from "@/src/router";

const puzzlesByTier = new Map<Difficulty, readonly PuzzleMetadata[]>();
for (const puzzle of PUZZLE_METADATA) {
  const existing = puzzlesByTier.get(puzzle.difficulty) ?? [];
  puzzlesByTier.set(puzzle.difficulty, [...existing, puzzle]);
}

const tierIndexById = new Map<string, number>();
for (const [, tier] of puzzlesByTier) {
  for (let i = 0; i < tier.length; i++) {
    tierIndexById.set(tier[i].id, i);
  }
}

function getTierPuzzles(difficulty: Difficulty): readonly PuzzleMetadata[] {
  return puzzlesByTier.get(difficulty) ?? [];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface UsePuzzleNavigationResult {
  readonly puzzleIndex: number;
  readonly totalPuzzles: number;
  readonly tierLabel: string;
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

  const currentMeta = useMemo(
    () => PUZZLE_METADATA.find((p) => p.id === currentPuzzleId),
    [currentPuzzleId],
  );

  const tierPuzzles = useMemo(
    () => (currentMeta ? getTierPuzzles(currentMeta.difficulty) : []),
    [currentMeta],
  );

  const selectPuzzle = useCallback((id: string) => {
    onBeforeNavigate();
    navigate(playHash(id));
  }, [navigate, onBeforeNavigate]);

  const puzzleIndex = tierIndexById.get(currentPuzzleId) ?? -1;

  const selectPreviousPuzzle = useCallback(() => {
    if (puzzleIndex > 0) {
      selectPuzzle(tierPuzzles[puzzleIndex - 1].id);
    }
  }, [puzzleIndex, selectPuzzle, tierPuzzles]);

  const selectNextPuzzle = useCallback(() => {
    if (puzzleIndex < tierPuzzles.length - 1) {
      selectPuzzle(tierPuzzles[puzzleIndex + 1].id);
    }
  }, [puzzleIndex, selectPuzzle, tierPuzzles]);

  const nextPuzzle =
    puzzleIndex >= 0 && puzzleIndex < tierPuzzles.length - 1
      ? tierPuzzles[puzzleIndex + 1]
      : undefined;

  const nextUnsolvedPuzzle = useMemo(() => {
    if (!completedIds || completedIds.size === 0) return nextPuzzle;
    for (let i = puzzleIndex + 1; i < tierPuzzles.length; i++) {
      if (!completedIds.has(tierPuzzles[i].id)) return tierPuzzles[i];
    }
    for (let i = 0; i < puzzleIndex; i++) {
      if (!completedIds.has(tierPuzzles[i].id)) return tierPuzzles[i];
    }
    return undefined;
  }, [puzzleIndex, completedIds, nextPuzzle, tierPuzzles]);

  return {
    puzzleIndex,
    totalPuzzles: tierPuzzles.length,
    tierLabel: currentMeta ? capitalize(currentMeta.difficulty) : "",
    nextPuzzle,
    nextUnsolvedPuzzle,
    selectPuzzle,
    selectPreviousPuzzle,
    selectNextPuzzle,
  };
}
