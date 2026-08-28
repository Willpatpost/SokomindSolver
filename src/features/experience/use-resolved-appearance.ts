import { useSyncExternalStore } from "react";
import {
  resolveAppearance,
  type AppearancePreference,
  type ResolvedAppearance,
} from "./experience-preferences";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

function readSystemPreference(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(DARK_SCHEME_QUERY).matches
  );
}

function subscribeToSystemPreference(onStoreChange: () => void): () => void {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => undefined;
  }

  const media = window.matchMedia(DARK_SCHEME_QUERY);
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

function serverPreference(): boolean {
  return false;
}

export function useResolvedAppearance(
  preference: AppearancePreference,
): ResolvedAppearance {
  const systemPrefersDark = useSyncExternalStore(
    subscribeToSystemPreference,
    readSystemPreference,
    serverPreference,
  );

  return resolveAppearance(preference, systemPrefersDark);
}
