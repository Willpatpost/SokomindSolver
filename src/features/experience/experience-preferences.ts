import {
  LEGACY_STORAGE_KEYS,
  STORAGE_KEYS,
  readStoredValue,
  writeStoredValue,
  type StorageMutationResult,
} from "../../shared/storage.ts";
import { trackPersistenceResult } from "../../shared/persistence-health.ts";
import { isRecord } from "../../core/type-guards.ts";

export const EXPERIENCE_PREFERENCES_VERSION = 1 as const;
export const EXPERIENCE_PREFERENCES_STORAGE_KEY = STORAGE_KEYS.experience;

export const MOTION_PREFERENCES = ["system", "full", "reduced"] as const;

export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export type ResolvedTheme = "light" | "dark";

export interface ExperiencePreferences {
  readonly version: typeof EXPERIENCE_PREFERENCES_VERSION;
  /** Master switch. Music and effects retain their individual preferences. */
  readonly soundEnabled: boolean;
  readonly musicEnabled: boolean;
  readonly effectsVolume: number;
  readonly musicVolume: number;
  readonly motion: MotionPreference;
  readonly theme: ThemePreference;
}

export type ExperiencePreferencePatch = Partial<
  Omit<ExperiencePreferences, "version">
>;

export const DEFAULT_EXPERIENCE_PREFERENCES: ExperiencePreferences =
  Object.freeze({
    version: EXPERIENCE_PREFERENCES_VERSION,
    soundEnabled: true,
    musicEnabled: true,
    effectsVolume: 0.5,
    musicVolume: 0.5,
    motion: "system",
    theme: "system",
  });

function isMotionPreference(value: unknown): value is MotionPreference {
  return (
    typeof value === "string" &&
    MOTION_PREFERENCES.includes(value as MotionPreference)
  );
}

function isThemePreference(value: unknown): value is ThemePreference {
  return (
    typeof value === "string" &&
    THEME_PREFERENCES.includes(value as ThemePreference)
  );
}

function normalizedVolume(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizePreferences(
  value: Partial<ExperiencePreferences>,
): ExperiencePreferences {
  return Object.freeze({
    version: EXPERIENCE_PREFERENCES_VERSION,
    soundEnabled:
      typeof value.soundEnabled === "boolean"
        ? value.soundEnabled
        : DEFAULT_EXPERIENCE_PREFERENCES.soundEnabled,
    musicEnabled:
      typeof value.musicEnabled === "boolean"
        ? value.musicEnabled
        : DEFAULT_EXPERIENCE_PREFERENCES.musicEnabled,
    effectsVolume: normalizedVolume(
      value.effectsVolume,
      DEFAULT_EXPERIENCE_PREFERENCES.effectsVolume,
    ),
    musicVolume: normalizedVolume(
      value.musicVolume,
      DEFAULT_EXPERIENCE_PREFERENCES.musicVolume,
    ),
    motion: isMotionPreference(value.motion)
      ? value.motion
      : DEFAULT_EXPERIENCE_PREFERENCES.motion,
    theme: isThemePreference(value.theme)
      ? value.theme
      : DEFAULT_EXPERIENCE_PREFERENCES.theme,
  });
}

export function parseExperiencePreferences(
  serialized: string | null,
): ExperiencePreferences {
  if (!serialized) return DEFAULT_EXPERIENCE_PREFERENCES;

  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      value.version !== EXPERIENCE_PREFERENCES_VERSION
    ) {
      return DEFAULT_EXPERIENCE_PREFERENCES;
    }
    return normalizePreferences(value);
  } catch {
    return DEFAULT_EXPERIENCE_PREFERENCES;
  }
}

export function updateExperiencePreferences(
  current: ExperiencePreferences,
  patch: ExperiencePreferencePatch,
): ExperiencePreferences {
  return normalizePreferences({ ...current, ...patch });
}

export function resolveReducedMotion(
  preference: MotionPreference,
  systemPrefersReducedMotion: boolean,
): boolean {
  if (preference === "reduced") return true;
  if (preference === "full") return false;
  return systemPrefersReducedMotion;
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}

export function loadExperiencePreferences(): ExperiencePreferences {
  return parseExperiencePreferences(
    readStoredValue(EXPERIENCE_PREFERENCES_STORAGE_KEY, [
      LEGACY_STORAGE_KEYS.experience,
    ]),
  );
}

export function saveExperiencePreferences(
  preferences: ExperiencePreferences,
): StorageMutationResult {
  return trackPersistenceResult(
    writeStoredValue(
      EXPERIENCE_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    ),
  );
}
