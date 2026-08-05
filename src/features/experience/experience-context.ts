import { createContext } from "react";
import type { AudioCue } from "./procedural-audio";
import type {
  ExperiencePreferencePatch,
  ExperiencePreferences,
  MotionPreference,
  ResolvedTheme,
  ThemePreference,
} from "./experience-preferences";

export interface ExperienceContextValue {
  readonly preferences: ExperiencePreferences;
  readonly reducedMotion: boolean;
  readonly resolvedTheme: ResolvedTheme;
  readonly audioSupported: boolean;
  readonly updatePreferences: (patch: ExperiencePreferencePatch) => void;
  readonly setSoundEnabled: (enabled: boolean) => void;
  readonly setMusicEnabled: (enabled: boolean) => void;
  readonly setEffectsVolume: (volume: number) => void;
  readonly setMusicVolume: (volume: number) => void;
  readonly setMotionPreference: (motion: MotionPreference) => void;
  readonly setThemePreference: (theme: ThemePreference) => void;
  readonly unlockAudio: () => Promise<boolean>;
  readonly playCue: (cue: AudioCue) => Promise<boolean>;
}

export const ExperienceContext =
  createContext<ExperienceContextValue | null>(null);
