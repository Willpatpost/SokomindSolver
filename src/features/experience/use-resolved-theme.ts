import { useSyncExternalStore } from "react";
import {
  resolveTheme,
  type ThemePreference,
  type ResolvedTheme,
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

export function useResolvedTheme(preference: ThemePreference): ResolvedTheme {
  const systemPrefersDark = useSyncExternalStore(
    subscribeToSystemPreference,
    readSystemPreference,
    serverPreference,
  );

  return resolveTheme(preference, systemPrefersDark);
}
