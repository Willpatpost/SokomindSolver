import { useId, useRef, useState } from "react";
import { Modal } from "@/src/shared/ui/Modal";
import type {
  AppearancePreference,
  MotionPreference,
  ThemeFamily,
} from "./experience-preferences";
import { useExperience } from "./use-experience";
import styles from "./ExperienceControls.module.css";

export interface ExperienceControlsProps {
  readonly className?: string;
  readonly placement?: "start" | "end";
}

function SpeakerIcon({ muted }: { readonly muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.2v5.6h3.5l4.7 3.8V5.4L7.5 9.2H4Z" />
      {muted ? (
        <path d="m16.3 9 4 4m0-4-4 4" />
      ) : (
        <>
          <path d="M15.4 8.2a5.2 5.2 0 0 1 0 7.6" />
          <path d="M18 5.8a8.5 8.5 0 0 1 0 12.4" />
        </>
      )}
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6h14M5 12h14M5 18h14" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="11" cy="18" r="2" />
    </svg>
  );
}

const THEME_FAMILY_OPTIONS: readonly {
  readonly value: ThemeFamily;
  readonly label: string;
}[] = [
  { value: "cozy-study", label: "Cozy Study" },
  { value: "midnight-neon", label: "Midnight Neon" },
  { value: "minimal-ink", label: "Minimal Ink" },
];

export function ExperienceControls({
  className,
  placement = "end",
}: ExperienceControlsProps) {
  const {
    preferences,
    audioSupported,
    setSoundEnabled,
    setMusicEnabled,
    setEffectsVolume,
    setMusicVolume,
    setMotionPreference,
    setThemeFamily,
    setAppearancePreference,
    previewEffects,
    previewMusic,
  } = useExperience();
  const [open, setOpen] = useState(false);
  const [previewMessage, setPreviewMessage] = useState("");
  const panelId = useId();
  const titleId = useId();
  const effectsVolumeId = useId();
  const musicVolumeId = useId();
  const motionId = useId();
  const appearanceId = useId();
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);

  const rootClassName = className
    ? `${styles.controls} ${className}`
    : styles.controls;

  return (
    <div
      className={rootClassName}
      data-placement={placement}
    >
      <button
        className={styles.iconButton}
        type="button"
        aria-label={
          preferences.soundEnabled ? "Mute all audio" : "Turn on all audio"
        }
        aria-pressed={preferences.soundEnabled}
        aria-keyshortcuts="M"
        disabled={!audioSupported}
        onClick={() => setSoundEnabled(!preferences.soundEnabled)}
      >
        <SpeakerIcon muted={!preferences.soundEnabled} />
      </button>

      <button
        className={styles.iconButton}
        type="button"
        aria-label="Sound and motion settings"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        ref={settingsTriggerRef}
      >
        <SlidersIcon />
      </button>

      {open ? (
        <Modal
          className={styles.modal}
          labelledBy={titleId}
          onClose={() => setOpen(false)}
          open
          returnFocusRef={settingsTriggerRef}
        >
          <section className={styles.panel} id={panelId}>
            <div className={styles.panelHeading}>
            <div>
              <p>Atmosphere</p>
              <h2 id={titleId}>Sound &amp; motion</h2>
            </div>
            <button
              className={styles.closeButton}
              type="button"
              data-autofocus
              onClick={() => setOpen(false)}
            >
              Close
            </button>
            </div>

          {!audioSupported ? (
            <p className={styles.supportNote}>
              Audio is unavailable in this browser. Motion settings still work.
            </p>
          ) : null}

          <div className={styles.switches}>
            <label className={styles.setting}>
              <span>
                <strong>All audio</strong>
                <small>Master switch for effects and music</small>
              </span>
              <span className={styles.switchControl}>
                <input
                  type="checkbox"
                  checked={preferences.soundEnabled}
                  disabled={!audioSupported}
                  onChange={(event) =>
                    setSoundEnabled(event.currentTarget.checked)
                  }
                />
                <span className={styles.switchTrack} aria-hidden="true" />
              </span>
            </label>

            <label className={styles.setting}>
              <span>
                <strong>Music</strong>
                <small>A quiet procedural soundscape</small>
              </span>
              <span className={styles.switchControl}>
                <input
                  type="checkbox"
                  checked={preferences.musicEnabled}
                  disabled={!audioSupported || !preferences.soundEnabled}
                  onChange={(event) =>
                    setMusicEnabled(event.currentTarget.checked)
                  }
                />
                <span className={styles.switchTrack} aria-hidden="true" />
              </span>
            </label>
          </div>

          <div className={styles.rangeSetting}>
            <label htmlFor={effectsVolumeId}>Effects volume</label>
            <div className={styles.rangeActions}>
              <output htmlFor={effectsVolumeId}>
                {Math.round(preferences.effectsVolume * 100)}%
              </output>
              <button
                className={styles.previewButton}
                type="button"
                aria-label="Preview effects at current volume"
                disabled={
                  !audioSupported ||
                  !preferences.soundEnabled ||
                  preferences.effectsVolume <= 0
                }
                onClick={() => {
                  void previewEffects().then((played) => {
                    setPreviewMessage(
                      played
                        ? "Effects preview played."
                        : "Effects preview could not play.",
                    );
                  });
                }}
              >
                Preview
              </button>
            </div>
            <input
              id={effectsVolumeId}
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={preferences.effectsVolume}
              disabled={!audioSupported || !preferences.soundEnabled}
              onChange={(event) =>
                setEffectsVolume(Number(event.currentTarget.value))
              }
            />
          </div>

          <div className={styles.rangeSetting}>
            <label htmlFor={musicVolumeId}>Music volume</label>
            <div className={styles.rangeActions}>
              <output htmlFor={musicVolumeId}>
                {Math.round(preferences.musicVolume * 100)}%
              </output>
              <button
                className={styles.previewButton}
                type="button"
                aria-label="Preview music at current volume"
                disabled={
                  !audioSupported ||
                  !preferences.soundEnabled ||
                  !preferences.musicEnabled ||
                  preferences.musicVolume <= 0
                }
                onClick={() => {
                  void previewMusic().then((played) => {
                    setPreviewMessage(
                      played
                        ? "Music preview played."
                        : "Music preview could not play.",
                    );
                  });
                }}
              >
                Preview
              </button>
            </div>
            <input
              id={musicVolumeId}
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={preferences.musicVolume}
              disabled={!audioSupported || !preferences.soundEnabled}
              onChange={(event) =>
                setMusicVolume(Number(event.currentTarget.value))
              }
            />
          </div>

          <p
            className={styles.previewStatus}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="audio-preview-status"
          >
            {previewMessage}
          </p>

          <label className={styles.motionSetting} htmlFor={motionId}>
            <span>
              <strong>Motion</strong>
              <small>Controls decorative and game animation</small>
            </span>
            <select
              id={motionId}
              value={preferences.motion}
              onChange={(event) =>
                setMotionPreference(event.currentTarget.value as MotionPreference)
              }
            >
              <option value="system">Use system setting</option>
              <option value="full">Full motion</option>
              <option value="reduced">Reduced motion</option>
            </select>
          </label>

          <fieldset className={styles.themeFamilySetting}>
            <legend>
              <strong>Theme family</strong>
              <small>Choose a visual identity with a live preview</small>
            </legend>
            <div className={styles.themeFamilyGrid}>
              {THEME_FAMILY_OPTIONS.map((option) => (
                <label
                  className={styles.themeFamilyOption}
                  data-selected={preferences.themeFamily === option.value || undefined}
                  key={option.value}
                >
                  <input
                    className={styles.themeFamilyInput}
                    type="radio"
                    name="theme-family"
                    value={option.value}
                    checked={preferences.themeFamily === option.value}
                    onChange={(event) =>
                      setThemeFamily(event.currentTarget.value as ThemeFamily)
                    }
                  />
                  <span
                    className={styles.themeSwatch}
                    data-family={option.value}
                    aria-hidden="true"
                  >
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className={styles.motionSetting} htmlFor={appearanceId}>
            <span>
              <strong>Appearance</strong>
              <small>Follow the system or choose light or dark</small>
            </span>
            <select
              id={appearanceId}
              value={preferences.appearance}
              onChange={(event) =>
                setAppearancePreference(
                  event.currentTarget.value as AppearancePreference,
                )
              }
            >
              <option value="system">Use system setting</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>

            <p className={styles.autoplayNote}>
              Browsers require a click or key press before sound can begin.
              Press M outside a dialog to mute or restore audio.
            </p>
          </section>
        </Modal>
      ) : null}
    </div>
  );
}
