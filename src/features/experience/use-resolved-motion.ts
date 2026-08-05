import { useSyncExternalStore } from "react";
import {
  resolveReducedMotion,
  type MotionPreference,
} from "./experience-preferences";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function readSystemPreference(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

function subscribeToSystemPreference(onStoreChange: () => void): () => void {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => undefined;
  }

  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

function serverPreference(): boolean {
  return false;
}

export function useResolvedMotion(preference: MotionPreference): boolean {
  const systemPrefersReducedMotion = useSyncExternalStore(
    subscribeToSystemPreference,
    readSystemPreference,
    serverPreference,
  );

  return resolveReducedMotion(preference, systemPrefersReducedMotion);
}
