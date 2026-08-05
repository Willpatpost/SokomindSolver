export {
  AmbientBackdrop,
  type AmbientBackdropProps,
} from "./AmbientBackdrop";
export {
  CelebrationOverlay,
  type CelebrationOverlayProps,
} from "./CelebrationOverlay";
export {
  ExperienceControls,
  type ExperienceControlsProps,
} from "./ExperienceControls";
export {
  ExperienceProvider,
  type ExperienceProviderProps,
} from "./ExperienceProvider";
export {
  DEFAULT_EXPERIENCE_PREFERENCES,
  EXPERIENCE_PREFERENCES_STORAGE_KEY,
  EXPERIENCE_PREFERENCES_VERSION,
  MOTION_PREFERENCES,
  loadExperiencePreferences,
  parseExperiencePreferences,
  resolveReducedMotion,
  saveExperiencePreferences,
  updateExperiencePreferences,
  type ExperiencePreferencePatch,
  type ExperiencePreferences,
  type MotionPreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./experience-preferences";
export {
  AUDIO_CUES,
  ProceduralAudioController,
  supportsProceduralAudio,
  type AudioCue,
} from "./procedural-audio";
export { useExperience } from "./use-experience";
export { useResolvedMotion } from "./use-resolved-motion";
export { useResolvedTheme } from "./use-resolved-theme";
