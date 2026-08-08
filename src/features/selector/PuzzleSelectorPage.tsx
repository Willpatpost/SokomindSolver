import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getMetadataCollectionsForDifficulty,
  type PuzzleMetadata,
} from "@/src/catalog/puzzle-metadata";
import { useStoredProgress } from "@/src/shared/use-stored-progress";
import { useFavorites } from "@/src/shared/use-favorites";
import { loadRatings } from "@/src/shared/puzzle-ratings";
import {
  hydrateOptimalCacheFromIDB,
  loadOptimalCache,
  mergeOptimalCaches,
  parseOptimalCache,
  saveOptimalCache,
} from "@/src/shared/optimal-cache";
import { STORAGE_KEYS } from "@/src/shared/storage";
import { useRouter } from "@/src/router";
import type { Route } from "@/src/router";
import { DIFFICULTY_LABELS } from "./selector-constants";
import { DifficultyGrid } from "./DifficultyGrid";
import { CollectionGrid } from "./CollectionGrid";
import { PuzzleListView } from "./PuzzleListView";

type SelectorRoute = Extract<
  Route,
  { page: "puzzles" | "puzzles-difficulty" | "puzzles-collection" }
>;

interface PuzzleSelectorPageProps {
  readonly route: SelectorRoute;
}

export function PuzzleSelectorPage({ route }: PuzzleSelectorPageProps) {
  const { navigate } = useRouter();
  const progress = useStoredProgress();
  const completedIds = useMemo(
    () => new Set(Object.keys(progress.completed)),
    [progress],
  );
  const { favorites: favoriteIds } = useFavorites();
  const ratings = useMemo(() => loadRatings(), []);
  const [optimalCache, setOptimalCache] = useState(loadOptimalCache);

  useEffect(() => {
    let active = true;
    void hydrateOptimalCacheFromIDB(loadOptimalCache()).then((hydrated) => {
      if (!active) return;
      setOptimalCache((current) => {
        const merged = mergeOptimalCaches(current, hydrated);
        return merged === current ? current : saveOptimalCache(merged).cache;
      });
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEYS.optimal) return;
      const incoming = parseOptimalCache(event.newValue);
      if (event.newValue === null) {
        setOptimalCache(incoming);
        return;
      }
      setOptimalCache((current) => {
        const merged = mergeOptimalCaches(incoming, current);
        return merged === incoming ? incoming : saveOptimalCache(merged).cache;
      });
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    if (route.page === "puzzles") {
      document.title = "Puzzles · Sokomind";
    } else if (route.page === "puzzles-difficulty") {
      document.title = `${DIFFICULTY_LABELS[route.difficulty]} Puzzles · Sokomind`;
    } else {
      document.title = `${route.collection} · Sokomind`;
    }
  }, [route]);

  const findNextUnsolved = useCallback(
    (puzzles: readonly PuzzleMetadata[]) => {
      return puzzles.find((p) => !completedIds.has(p.id))?.id;
    },
    [completedIds],
  );

  if (route.page === "puzzles") {
    return (
      <DifficultyGrid
        completedIds={completedIds}
        findNextUnsolved={findNextUnsolved}
        navigate={navigate}
      />
    );
  }

  if (route.page === "puzzles-difficulty") {
    const collections = getMetadataCollectionsForDifficulty(route.difficulty);
    if (collections.length === 1) {
      return (
        <PuzzleListView
          difficulty={route.difficulty}
          collection={collections[0].name}
          completedIds={completedIds}
          favoriteIds={favoriteIds}
          directDifficultyView
          optimalCache={optimalCache}
          progress={progress}
          ratings={ratings}
          navigate={navigate}
          pageNumber={route.pageNumber}
        />
      );
    }
    return (
      <CollectionGrid
        difficulty={route.difficulty}
        collections={collections}
        completedIds={completedIds}
        findNextUnsolved={findNextUnsolved}
        navigate={navigate}
      />
    );
  }

  return (
    <PuzzleListView
      difficulty={route.difficulty}
      collection={route.collection}
      completedIds={completedIds}
      favoriteIds={favoriteIds}
      optimalCache={optimalCache}
      progress={progress}
      ratings={ratings}
      navigate={navigate}
      pageNumber={route.pageNumber}
    />
  );
}
