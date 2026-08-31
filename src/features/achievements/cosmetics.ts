import type { AggregateStats } from "../progress/compute-stats.ts";
import type { ThemeFamily } from "../experience/experience-preferences.ts";
import type { ProgressData } from "../../shared/progress.ts";
import {
  STORAGE_KEYS,
  readStoredValue,
  writeStoredValue,
  type StorageMutationResult,
} from "../../shared/storage.ts";
import { trackPersistenceResult } from "../../shared/persistence-health.ts";
import { ACHIEVEMENTS } from "./achievements.ts";

export type BoardFrameCosmeticId =
  | "classic"
  | "sage-thread"
  | "brass-edge"
  | "neon-orbit";

export interface BoardFrameCosmetic {
  readonly id: BoardFrameCosmeticId;
  readonly title: string;
  readonly description: string;
  readonly requirement: string;
  readonly achievementId?: string;
  readonly compatibleThemeFamilies: readonly ThemeFamily[];
}

export interface CosmeticPreference {
  readonly version: 1;
  readonly boardFrame: BoardFrameCosmeticId;
}

export interface CosmeticState extends BoardFrameCosmetic {
  readonly unlocked: boolean;
  readonly compatible: boolean;
  readonly selected: boolean;
  readonly active: boolean;
}

const ALL_THEME_FAMILIES: readonly ThemeFamily[] = Object.freeze([
  "cozy-study",
  "midnight-neon",
  "minimal-ink",
]);

export const BOARD_FRAME_COSMETICS: readonly BoardFrameCosmetic[] = Object.freeze([
  Object.freeze({
    id: "classic",
    title: "Classic frame",
    description: "The original quiet border and shadow.",
    requirement: "Available from the start",
    compatibleThemeFamilies: ALL_THEME_FAMILIES,
  }),
  Object.freeze({
    id: "sage-thread",
    title: "Sage thread",
    description: "A slim green outer thread around the board.",
    requirement: "Unlock Getting Started",
    achievementId: "ten-solved",
    compatibleThemeFamilies: ALL_THEME_FAMILIES,
  }),
  Object.freeze({
    id: "brass-edge",
    title: "Brass edge",
    description: "A warm study-lamp edge with a restrained glow.",
    requirement: "Unlock Graduate",
    achievementId: "tutorial-complete",
    compatibleThemeFamilies: Object.freeze(
      ["cozy-study", "minimal-ink"] satisfies ThemeFamily[],
    ),
  }),
  Object.freeze({
    id: "neon-orbit",
    title: "Neon orbit",
    description: "A cool double-line frame made for Midnight Neon.",
    requirement: "Unlock Puzzle Enthusiast",
    achievementId: "fifty-solved",
    compatibleThemeFamilies: Object.freeze(
      ["midnight-neon"] satisfies ThemeFamily[],
    ),
  }),
]);

export const DEFAULT_COSMETIC_PREFERENCE: CosmeticPreference = Object.freeze({
  version: 1,
  boardFrame: "classic",
});

export const COSMETIC_CHANGE_EVENT = "sokomind:cosmetic-change";

function isBoardFrameCosmeticId(value: unknown): value is BoardFrameCosmeticId {
  return typeof value === "string" && BOARD_FRAME_COSMETICS.some(({ id }) => id === value);
}

export function parseCosmeticPreference(value: string | null): CosmeticPreference {
  if (!value) return DEFAULT_COSMETIC_PREFERENCE;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("boardFrame" in parsed) ||
      !isBoardFrameCosmeticId(parsed.boardFrame)
    ) {
      return DEFAULT_COSMETIC_PREFERENCE;
    }
    return Object.freeze({ version: 1, boardFrame: parsed.boardFrame });
  } catch {
    return DEFAULT_COSMETIC_PREFERENCE;
  }
}

export function loadCosmeticPreference(): CosmeticPreference {
  return parseCosmeticPreference(readStoredValue(STORAGE_KEYS.cosmetics));
}

export function saveCosmeticPreference(
  preference: CosmeticPreference,
): StorageMutationResult {
  const result = trackPersistenceResult(
    writeStoredValue(STORAGE_KEYS.cosmetics, JSON.stringify(preference)),
  );
  if (result.ok && typeof window !== "undefined") {
    window.dispatchEvent(new Event(COSMETIC_CHANGE_EVENT));
  }
  return result;
}

export function isCosmeticUnlocked(
  cosmetic: BoardFrameCosmetic,
  stats: AggregateStats,
  progress: ProgressData,
): boolean {
  if (!cosmetic.achievementId) return true;
  return ACHIEVEMENTS.find(({ id }) => id === cosmetic.achievementId)?.check(stats, progress) ?? false;
}

export function getCosmeticStates(
  preference: CosmeticPreference,
  themeFamily: ThemeFamily,
  stats: AggregateStats,
  progress: ProgressData,
): readonly CosmeticState[] {
  const selected = BOARD_FRAME_COSMETICS.find(({ id }) => id === preference.boardFrame)
    ?? BOARD_FRAME_COSMETICS[0];
  const selectedActive = isCosmeticUnlocked(selected, stats, progress)
    && selected.compatibleThemeFamilies.includes(themeFamily);
  const activeId = selectedActive ? selected.id : "classic";
  return BOARD_FRAME_COSMETICS.map((cosmetic) => Object.freeze({
    ...cosmetic,
    unlocked: isCosmeticUnlocked(cosmetic, stats, progress),
    compatible: cosmetic.compatibleThemeFamilies.includes(themeFamily),
    selected: preference.boardFrame === cosmetic.id,
    active: activeId === cosmetic.id,
  }));
}

export function resolveActiveBoardFrame(
  preference: CosmeticPreference,
  themeFamily: ThemeFamily,
  stats: AggregateStats,
  progress: ProgressData,
): BoardFrameCosmeticId {
  return getCosmeticStates(preference, themeFamily, stats, progress)
    .find(({ active }) => active)?.id ?? "classic";
}
