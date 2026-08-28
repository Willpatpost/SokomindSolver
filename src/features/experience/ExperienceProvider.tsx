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
  themeColor,
  updateExperiencePreferences,
  type AppearancePreference,
  type ExperiencePreferencePatch,
  type MotionPreference,
  type ThemeFamily,
} from "./experience-preferences";
import {
  ProceduralAudioController,
  supportsProceduralAudio,
  type AudioCue,
  type AudioCueOptions,
} from "./procedural-audio";
import { useResolvedMotion } from "./use-resolved-motion";
import { useResolvedAppearance } from "./use-resolved-appearance";

export interface ExperienceProviderProps {
  readonly children: ReactNode;
}

export function ExperienceProvider({ children }: ExperienceProviderProps) {
  const [preferences, setPreferences] = useState(loadExperiencePreferences);
  const reducedMotion = useResolvedMotion(preferences.motion);
  const resolvedAppearance = useResolvedAppearance(preferences.appearance);
  const [audioAnnouncement, setAudioAnnouncement] = useState("");
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
    const previousAppearance = root.dataset.theme;
    const previousFamily = root.dataset.themeFamily;
    root.dataset.theme = resolvedAppearance;
    root.dataset.themeFamily = preferences.themeFamily;

    const color = themeColor(preferences.themeFamily, resolvedAppearance);
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    metas.forEach((meta) => meta.setAttribute("content", color));

    return () => {
      if (previousAppearance === undefined) {
        delete root.dataset.theme;
      } else {
        root.dataset.theme = previousAppearance;
      }
      if (previousFamily === undefined) {
        delete root.dataset.themeFamily;
      } else {
        root.dataset.themeFamily = previousFamily;
      }
    };
  }, [preferences.themeFamily, resolvedAppearance]);

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
      setPreferences((current) => {
        const next = updateExperiencePreferences(current, patch);
        latestPreferences.current = next;
        return next;
      });
    },
    [],
  );

  const unlockAudio = useCallback(
    () => ensureAudio().unlock(),
    [ensureAudio],
  );

  const playCue = useCallback(
    (cue: AudioCue, options?: AudioCueOptions) =>
      ensureAudio().playCue(cue, options),
    [ensureAudio],
  );

  const previewEffects = useCallback(
    () => ensureAudio().previewEffects(),
    [ensureAudio],
  );

  const previewMusic = useCallback(
    () => ensureAudio().previewMusic(),
    [ensureAudio],
  );

  const setSoundEnabled = useCallback(
    (enabled: boolean) => {
      updatePreferences({ soundEnabled: enabled });
      setAudioAnnouncement(enabled ? "Audio on." : "Audio muted.");
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

  const setThemeFamily = useCallback(
    (themeFamily: ThemeFamily) => updatePreferences({ themeFamily }),
    [updatePreferences],
  );

  const setAppearancePreference = useCallback(
    (appearance: AppearancePreference) => updatePreferences({ appearance }),
    [updatePreferences],
  );

  const setZenMode = useCallback(
    (zenMode: boolean) => updatePreferences({ zenMode }),
    [updatePreferences],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("dialog[open], [role='dialog']")) return;

      if (!event.shiftKey && event.key.toLowerCase() === "m") {
        if (!supportsProceduralAudio()) return;
        event.preventDefault();
        setSoundEnabled(!latestPreferences.current.soundEnabled);
        return;
      }

      if (event.shiftKey && event.key === "T") {
        event.preventDefault();
        const nextAppearance: AppearancePreference =
          latestPreferences.current.appearance === "dark" ? "light" : "dark";
        updatePreferences({ appearance: nextAppearance });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSoundEnabled, updatePreferences]);

  const value = useMemo(
    () => ({
      preferences,
      reducedMotion,
      resolvedAppearance,
      audioSupported: supportsProceduralAudio(),
      updatePreferences,
      setSoundEnabled,
      setMusicEnabled,
      setEffectsVolume,
      setMusicVolume,
      setMotionPreference,
      setThemeFamily,
      setAppearancePreference,
      setZenMode,
      unlockAudio,
      playCue,
      previewEffects,
      previewMusic,
    }),
    [
      playCue,
      preferences,
      previewEffects,
      previewMusic,
      reducedMotion,
      resolvedAppearance,
      setEffectsVolume,
      setMotionPreference,
      setMusicEnabled,
      setMusicVolume,
      setSoundEnabled,
      setAppearancePreference,
      setThemeFamily,
      setZenMode,
      unlockAudio,
      updatePreferences,
    ],
  );

  return (
    <ExperienceContext.Provider value={value}>
      {children}
      <span
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-testid="audio-status"
      >
        {audioAnnouncement}
      </span>
    </ExperienceContext.Provider>
  );
}
