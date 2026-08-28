import {
  LEGACY_STORAGE_KEYS,
  STORAGE_KEYS,
  readStoredValue,
  writeStoredValue,
  type StorageMutationResult,
} from "../../shared/storage.ts";
import { trackPersistenceResult } from "../../shared/persistence-health.ts";
import { isRecord } from "../../core/type-guards.ts";

export const EXPERIENCE_PREFERENCES_VERSION = 2 as const;
export const EXPERIENCE_PREFERENCES_STORAGE_KEY = STORAGE_KEYS.experience;

export const MOTION_PREFERENCES = ["system", "full", "reduced"] as const;

export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const THEME_FAMILIES = [
  "cozy-study",
  "midnight-neon",
  "minimal-ink",
] as const;

export type ThemeFamily = (typeof THEME_FAMILIES)[number];

export interface ExperiencePreferences {
  readonly version: typeof EXPERIENCE_PREFERENCES_VERSION;
  /** Master switch. Music and effects retain their individual preferences. */
  readonly soundEnabled: boolean;
  readonly musicEnabled: boolean;
  readonly effectsVolume: number;
  readonly musicVolume: number;
  readonly motion: MotionPreference;
  readonly themeFamily: ThemeFamily;
  readonly appearance: AppearancePreference;
  /** Use the compact, board-first layout on puzzle play routes. */
  readonly zenMode: boolean;
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
    themeFamily: "cozy-study",
    appearance: "system",
    zenMode: false,
  });

function isMotionPreference(value: unknown): value is MotionPreference {
  return (
    typeof value === "string" &&
    MOTION_PREFERENCES.includes(value as MotionPreference)
  );
}

function isAppearancePreference(value: unknown): value is AppearancePreference {
  return (
    typeof value === "string" &&
    APPEARANCE_PREFERENCES.includes(value as AppearancePreference)
  );
}

function isThemeFamily(value: unknown): value is ThemeFamily {
  return (
    typeof value === "string" &&
    THEME_FAMILIES.includes(value as ThemeFamily)
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
    themeFamily: isThemeFamily(value.themeFamily)
      ? value.themeFamily
      : DEFAULT_EXPERIENCE_PREFERENCES.themeFamily,
    appearance: isAppearancePreference(value.appearance)
      ? value.appearance
      : DEFAULT_EXPERIENCE_PREFERENCES.appearance,
    zenMode:
      typeof value.zenMode === "boolean"
        ? value.zenMode
        : DEFAULT_EXPERIENCE_PREFERENCES.zenMode,
  });
}

export function parseExperiencePreferences(
  serialized: string | null,
): ExperiencePreferences {
  if (!serialized) return DEFAULT_EXPERIENCE_PREFERENCES;

  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value)) return DEFAULT_EXPERIENCE_PREFERENCES;
    if (value.version === EXPERIENCE_PREFERENCES_VERSION) {
      return normalizePreferences(value);
    }
    if (value.version === 1) {
      return normalizePreferences({
        ...value,
        themeFamily: "cozy-study",
        appearance: isAppearancePreference(value.theme)
          ? value.theme
          : DEFAULT_EXPERIENCE_PREFERENCES.appearance,
      });
    }
    return DEFAULT_EXPERIENCE_PREFERENCES;
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

export function resolveAppearance(
  preference: AppearancePreference,
  systemPrefersDark: boolean,
): ResolvedAppearance {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}

export function themeColor(
  family: ThemeFamily,
  appearance: ResolvedAppearance,
): string {
  const colors: Readonly<
    Record<ThemeFamily, Readonly<Record<ResolvedAppearance, string>>>
  > = {
    "cozy-study": { light: "#f3f0e7", dark: "#171916" },
    "midnight-neon": { light: "#eef2ff", dark: "#080b18" },
    "minimal-ink": { light: "#f6f6f3", dark: "#111212" },
  };
  return colors[family][appearance];
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
