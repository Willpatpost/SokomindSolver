import { useId, useRef, useState } from "react";
import { Modal } from "@/src/shared/ui/Modal";
import type { MotionPreference, ThemePreference } from "./experience-preferences";
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
    setThemePreference,
  } = useExperience();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const titleId = useId();
  const effectsVolumeId = useId();
  const musicVolumeId = useId();
  const motionId = useId();
  const themeId = useId();
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
            <output htmlFor={effectsVolumeId}>
              {Math.round(preferences.effectsVolume * 100)}%
            </output>
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
            <output htmlFor={musicVolumeId}>
              {Math.round(preferences.musicVolume * 100)}%
            </output>
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

          <label className={styles.motionSetting} htmlFor={themeId}>
            <span>
              <strong>Theme</strong>
              <small>Controls the visual color scheme</small>
            </span>
            <select
              id={themeId}
              value={preferences.theme}
              onChange={(event) =>
                setThemePreference(event.currentTarget.value as ThemePreference)
              }
            >
              <option value="system">Use system setting</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>

            <p className={styles.autoplayNote}>
              Browsers require a click or key press before sound can begin.
            </p>
          </section>
        </Modal>
      ) : null}
    </div>
  );
}
