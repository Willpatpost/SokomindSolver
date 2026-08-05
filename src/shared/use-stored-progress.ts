import { useEffect, useState } from "react";
import { loadProgress, type ProgressData } from "./progress";
import { STORAGE_KEYS } from "./storage";

export function useStoredProgress(): ProgressData {
  const [progress, setProgress] = useState(loadProgress);

  useEffect(() => {
    const refresh = () => setProgress(loadProgress());
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key !== STORAGE_KEYS.progress &&
        event.key !== STORAGE_KEYS.reset
      ) {
        return;
      }
      refresh();
    };

    window.addEventListener("storage", handleStorage);
    // Re-read after subscribing so an update between render and this effect is
    // not missed.
    refresh();
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return progress;
}
