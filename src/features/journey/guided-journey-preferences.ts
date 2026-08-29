import {
  STORAGE_KEYS,
  readStoredValue,
  writeStoredValue,
} from "../../shared/storage.ts";

export interface GuidedJourneyPreferences {
  readonly version: 1;
  readonly dismissed: boolean;
}

export const DEFAULT_GUIDED_JOURNEY_PREFERENCES: GuidedJourneyPreferences =
  Object.freeze({ version: 1, dismissed: false });

export function parseGuidedJourneyPreferences(
  value: string | null,
): GuidedJourneyPreferences {
  if (!value) return DEFAULT_GUIDED_JOURNEY_PREFERENCES;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("dismissed" in parsed) ||
      typeof parsed.dismissed !== "boolean"
    ) {
      return DEFAULT_GUIDED_JOURNEY_PREFERENCES;
    }
    return Object.freeze({ version: 1, dismissed: parsed.dismissed });
  } catch {
    return DEFAULT_GUIDED_JOURNEY_PREFERENCES;
  }
}

export function loadGuidedJourneyPreferences(): GuidedJourneyPreferences {
  return parseGuidedJourneyPreferences(readStoredValue(STORAGE_KEYS.guidedJourney));
}

export function saveGuidedJourneyPreferences(
  preferences: GuidedJourneyPreferences,
): GuidedJourneyPreferences {
  writeStoredValue(STORAGE_KEYS.guidedJourney, JSON.stringify(preferences));
  return preferences;
}
