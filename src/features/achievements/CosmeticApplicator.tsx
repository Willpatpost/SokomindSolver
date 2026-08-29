import { useEffect, useMemo, useState } from "react";
import { PUZZLE_METADATA } from "../../catalog/puzzle-metadata.ts";
import { useExperience } from "../experience/use-experience.ts";
import { computeStats } from "../progress/compute-stats.ts";
import { loadProgress } from "../../shared/progress.ts";
import { STORAGE_KEYS } from "../../shared/storage.ts";
import {
  COSMETIC_CHANGE_EVENT,
  loadCosmeticPreference,
  resolveActiveBoardFrame,
} from "./cosmetics.ts";

function loadCosmeticSnapshot() {
  return {
    preference: loadCosmeticPreference(),
    progress: loadProgress(),
  };
}

export function CosmeticApplicator() {
  const { preferences } = useExperience();
  const [snapshot, setSnapshot] = useState(loadCosmeticSnapshot);
  const stats = useMemo(
    () => computeStats(snapshot.progress, PUZZLE_METADATA),
    [snapshot.progress],
  );
  const activeFrame = resolveActiveBoardFrame(
    snapshot.preference,
    preferences.themeFamily,
    stats,
    snapshot.progress,
  );

  useEffect(() => {
    const refresh = () => setSnapshot(loadCosmeticSnapshot());
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === STORAGE_KEYS.cosmetics ||
        event.key === STORAGE_KEYS.progress ||
        event.key === STORAGE_KEYS.reset
      ) {
        refresh();
      }
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(COSMETIC_CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(COSMETIC_CHANGE_EVENT, refresh);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.boardFrame;
    root.dataset.boardFrame = activeFrame;
    return () => {
      if (previous === undefined) delete root.dataset.boardFrame;
      else root.dataset.boardFrame = previous;
    };
  }, [activeFrame]);

  return null;
}
