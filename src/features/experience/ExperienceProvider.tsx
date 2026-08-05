import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ExperienceContext } from "./experience-context";
import {
  loadExperiencePreferences,
  saveExperiencePreferences,
  updateExperiencePreferences,
  type ExperiencePreferencePatch,
  type MotionPreference,
  type ThemePreference,
} from "./experience-preferences";
import {
  ProceduralAudioController,
  supportsProceduralAudio,
  type AudioCue,
} from "./procedural-audio";
import { useResolvedMotion } from "./use-resolved-motion";
import { useResolvedTheme } from "./use-resolved-theme";

export interface ExperienceProviderProps {
  readonly children: ReactNode;
}

export function ExperienceProvider({ children }: ExperienceProviderProps) {
  const [preferences, setPreferences] = useState(loadExperiencePreferences);
  const reducedMotion = useResolvedMotion(preferences.motion);
  const resolvedTheme = useResolvedTheme(preferences.theme);
  const audioRef = useRef<ProceduralAudioController | null>(null);
  const latestPreferences = useRef(preferences);

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new ProceduralAudioController(
        latestPreferences.current,
      );
    }
    return audioRef.current;
  }, []);

  useEffect(() => {
    const audio = ensureAudio();
    return () => {
      if (audioRef.current === audio) {
        audio.dispose();
        audioRef.current = null;
      }
    };
  }, [ensureAudio]);

  useEffect(() => {
    latestPreferences.current = preferences;
    saveExperiencePreferences(preferences);
    ensureAudio().setPreferences(preferences);
  }, [ensureAudio, preferences]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const previous = root.dataset.motion;
    root.dataset.motion = reducedMotion ? "reduced" : "full";

    return () => {
      if (previous === undefined) {
        delete root.dataset.motion;
      } else {
        root.dataset.motion = previous;
      }
    };
  }, [reducedMotion]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const previousTheme = root.dataset.theme;
    root.dataset.theme = resolvedTheme;

    return () => {
      if (previousTheme === undefined) {
        delete root.dataset.theme;
      } else {
        root.dataset.theme = previousTheme;
      }
    };
  }, [resolvedTheme]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const updateVisibility = () => {
      ensureAudio().setPageVisible(document.visibilityState !== "hidden");
    };
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [ensureAudio]);

  const updatePreferences = useCallback(
    (patch: ExperiencePreferencePatch) => {
      setPreferences((current) =>
        updateExperiencePreferences(current, patch),
      );
    },
    [],
  );

  const unlockAudio = useCallback(
    () => ensureAudio().unlock(),
    [ensureAudio],
  );

  const playCue = useCallback(
    (cue: AudioCue) => ensureAudio().playCue(cue),
    [ensureAudio],
  );

  const setSoundEnabled = useCallback(
    (enabled: boolean) => {
      updatePreferences({ soundEnabled: enabled });
      if (enabled) void unlockAudio();
    },
    [unlockAudio, updatePreferences],
  );

  const setMusicEnabled = useCallback(
    (enabled: boolean) => {
      updatePreferences({
        musicEnabled: enabled,
        ...(enabled ? { soundEnabled: true } : {}),
      });
      if (enabled) void unlockAudio();
    },
    [unlockAudio, updatePreferences],
  );

  const setEffectsVolume = useCallback(
    (effectsVolume: number) => updatePreferences({ effectsVolume }),
    [updatePreferences],
  );

  const setMusicVolume = useCallback(
    (musicVolume: number) => updatePreferences({ musicVolume }),
    [updatePreferences],
  );

  const setMotionPreference = useCallback(
    (motion: MotionPreference) => updatePreferences({ motion }),
    [updatePreferences],
  );

  const setThemePreference = useCallback(
    (theme: ThemePreference) => updatePreferences({ theme }),
    [updatePreferences],
  );

  const value = useMemo(
    () => ({
      preferences,
      reducedMotion,
      resolvedTheme,
      audioSupported: supportsProceduralAudio(),
      updatePreferences,
      setSoundEnabled,
      setMusicEnabled,
      setEffectsVolume,
      setMusicVolume,
      setMotionPreference,
      setThemePreference,
      unlockAudio,
      playCue,
    }),
    [
      playCue,
      preferences,
      reducedMotion,
      resolvedTheme,
      setEffectsVolume,
      setMotionPreference,
      setMusicEnabled,
      setMusicVolume,
      setSoundEnabled,
      setThemePreference,
      unlockAudio,
      updatePreferences,
    ],
  );

  return (
    <ExperienceContext.Provider value={value}>
      {children}
    </ExperienceContext.Provider>
  );
}
