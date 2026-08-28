import { createContext } from "react";
import type { AudioCue, AudioCueOptions } from "./procedural-audio";
import type {
  ExperiencePreferencePatch,
  ExperiencePreferences,
  AppearancePreference,
  MotionPreference,
  ResolvedAppearance,
  ThemeFamily,
} from "./experience-preferences";

export interface ExperienceContextValue {
  readonly preferences: ExperiencePreferences;
  readonly reducedMotion: boolean;
  readonly resolvedAppearance: ResolvedAppearance;
  readonly audioSupported: boolean;
  readonly updatePreferences: (patch: ExperiencePreferencePatch) => void;
  readonly setSoundEnabled: (enabled: boolean) => void;
  readonly setMusicEnabled: (enabled: boolean) => void;
  readonly setEffectsVolume: (volume: number) => void;
  readonly setMusicVolume: (volume: number) => void;
  readonly setMotionPreference: (motion: MotionPreference) => void;
  readonly setThemeFamily: (family: ThemeFamily) => void;
  readonly setAppearancePreference: (
    appearance: AppearancePreference,
  ) => void;
  readonly setZenMode: (enabled: boolean) => void;
  readonly unlockAudio: () => Promise<boolean>;
  readonly playCue: (
    cue: AudioCue,
    options?: AudioCueOptions,
  ) => Promise<boolean>;
  readonly previewEffects: () => Promise<boolean>;
  readonly previewMusic: () => Promise<boolean>;
}

export const ExperienceContext =
  createContext<ExperienceContextValue | null>(null);
