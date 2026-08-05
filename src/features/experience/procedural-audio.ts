import type { ExperiencePreferences } from "./experience-preferences";

export const AUDIO_CUES = [
  "step",
  "push",
  "goal-enter",
  "goal-leave",
  "blocked",
  "undo",
  "reset",
  "solve",
] as const;

export type AudioCue = (typeof AUDIO_CUES)[number];

type AudioContextConstructor = new () => AudioContext;

interface ToneOptions {
  readonly frequency: number;
  readonly endFrequency?: number;
  readonly start: number;
  readonly duration: number;
  readonly volume: number;
  readonly type?: OscillatorType;
  readonly music?: boolean;
}

const MUSIC_NOTES = [
  220,
  261.63,
  293.66,
  329.63,
  392,
  329.63,
  293.66,
  261.63,
] as const;

const MUSIC_STEP_SECONDS = 1.35;
const MUSIC_LOOKAHEAD_SECONDS = 0.35;

function audioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const extendedWindow = window as typeof window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return window.AudioContext ?? extendedWindow.webkitAudioContext;
}

export function supportsProceduralAudio(): boolean {
  return Boolean(audioContextConstructor());
}

/**
 * A tiny dependency-free Web Audio synthesizer.
 *
 * Construction is side-effect free. An AudioContext is allocated only when
 * `unlock()` or `playCue()` is called, so importing this module is safe during
 * static builds and tests.
 */
export class ProceduralAudioController {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private preferences: ExperiencePreferences;
  private visible = true;
  private disposed = false;
  private unlockPromise: Promise<boolean> | null = null;
  private musicTimer: number | null = null;
  private musicStep = 0;
  private nextMusicTime = 0;
  private readonly musicSources = new Set<OscillatorNode>();

  constructor(preferences: ExperiencePreferences) {
    this.preferences = preferences;
  }

  get supported(): boolean {
    return supportsProceduralAudio();
  }

  get ready(): boolean {
    return this.context?.state === "running";
  }

  setPreferences(preferences: ExperiencePreferences): void {
    this.preferences = preferences;
    this.applyMix();
    this.syncMusic();
  }

  setPageVisible(visible: boolean): void {
    this.visible = visible;
    this.applyMix();
    this.syncMusic();
  }

  /**
   * Call from a click, pointer, or keyboard handler before relying on sound.
   * Browsers may reject `resume()` outside a user activation.
   */
  unlock(): Promise<boolean> {
    if (this.disposed || !this.supported) return Promise.resolve(false);
    if (this.context?.state === "running") {
      this.syncMusic();
      return Promise.resolve(true);
    }
    if (this.unlockPromise) return this.unlockPromise;

    this.unlockPromise = this.createOrResumeContext()
      .catch(() => false)
      .finally(() => {
        this.unlockPromise = null;
      });
    return this.unlockPromise;
  }

  async playCue(cue: AudioCue): Promise<boolean> {
    if (this.disposed || !this.preferences.soundEnabled || !this.visible) {
      return false;
    }
    if (!(await this.unlock())) return false;

    const context = this.context;
    if (!context || context.state !== "running") return false;
    const now = context.currentTime + 0.006;

    switch (cue) {
      case "step":
        this.tone({
          frequency: 145,
          endFrequency: 112,
          start: now,
          duration: 0.045,
          volume: 0.055,
          type: "triangle",
        });
        break;
      case "push":
        this.tone({
          frequency: 112,
          endFrequency: 66,
          start: now,
          duration: 0.13,
          volume: 0.14,
          type: "sine",
        });
        this.tone({
          frequency: 218,
          endFrequency: 154,
          start: now,
          duration: 0.07,
          volume: 0.035,
          type: "triangle",
        });
        break;
      case "goal-enter":
        this.tone({
          frequency: 392,
          start: now,
          duration: 0.16,
          volume: 0.075,
          type: "sine",
        });
        this.tone({
          frequency: 587.33,
          start: now + 0.075,
          duration: 0.22,
          volume: 0.065,
          type: "sine",
        });
        break;
      case "goal-leave":
        this.tone({
          frequency: 392,
          endFrequency: 293.66,
          start: now,
          duration: 0.16,
          volume: 0.055,
          type: "sine",
        });
        break;
      case "blocked":
        this.tone({
          frequency: 92,
          endFrequency: 74,
          start: now,
          duration: 0.075,
          volume: 0.045,
          type: "square",
        });
        break;
      case "undo":
        this.tone({
          frequency: 329.63,
          endFrequency: 246.94,
          start: now,
          duration: 0.15,
          volume: 0.055,
          type: "triangle",
        });
        break;
      case "reset":
        this.tone({
          frequency: 196,
          endFrequency: 110,
          start: now,
          duration: 0.22,
          volume: 0.065,
          type: "sine",
        });
        break;
      case "solve":
        [261.63, 329.63, 392, 523.25].forEach((frequency, index) => {
          this.tone({
            frequency,
            start: now + index * 0.085,
            duration: 0.42,
            volume: index === 3 ? 0.07 : 0.052,
            type: index % 2 === 0 ? "sine" : "triangle",
          });
        });
        break;
    }

    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopMusic();

    const context = this.context;
    this.context = null;
    this.masterGain = null;
    this.effectsGain = null;
    this.musicGain = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }

  private async createOrResumeContext(): Promise<boolean> {
    if (!this.context) {
      const AudioContextClass = audioContextConstructor();
      if (!AudioContextClass) return false;

      const context = new AudioContextClass();
      const masterGain = context.createGain();
      const effectsGain = context.createGain();
      const musicGain = context.createGain();

      effectsGain.connect(masterGain);
      musicGain.connect(masterGain);
      masterGain.connect(context.destination);

      this.context = context;
      this.masterGain = masterGain;
      this.effectsGain = effectsGain;
      this.musicGain = musicGain;
      this.applyMix(true);
    }

    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    const ready = this.context.state === "running";
    if (ready) this.syncMusic();
    return ready;
  }

  private applyMix(immediate = false): void {
    const context = this.context;
    if (!context) return;

    const master = this.preferences.soundEnabled && this.visible ? 0.9 : 0;
    const music =
      this.preferences.soundEnabled &&
      this.preferences.musicEnabled &&
      this.visible
        ? this.preferences.musicVolume
        : 0;

    this.setGain(this.masterGain, master, immediate);
    this.setGain(
      this.effectsGain,
      this.preferences.effectsVolume,
      immediate,
    );
    this.setGain(this.musicGain, music, immediate);
  }

  private setGain(
    node: GainNode | null,
    value: number,
    immediate: boolean,
  ): void {
    if (!node || !this.context) return;
    const now = this.context.currentTime;
    node.gain.cancelScheduledValues(now);
    if (immediate) {
      node.gain.setValueAtTime(value, now);
    } else {
      node.gain.setTargetAtTime(value, now, 0.025);
    }
  }

  private tone(options: ToneOptions): OscillatorNode | null {
    const context = this.context;
    const output = options.music ? this.musicGain : this.effectsGain;
    if (!context || !output || context.state !== "running") return null;

    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const attack = Math.min(0.025, options.duration * 0.22);
    const end = options.start + options.duration;
    const peak = Math.max(0.0001, options.volume);

    oscillator.type = options.type ?? "sine";
    oscillator.frequency.setValueAtTime(options.frequency, options.start);
    if (
      options.endFrequency !== undefined &&
      options.endFrequency !== options.frequency
    ) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(1, options.endFrequency),
        end,
      );
    }

    envelope.gain.setValueAtTime(0.0001, options.start);
    envelope.gain.exponentialRampToValueAtTime(
      peak,
      options.start + attack,
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);

    oscillator.connect(envelope);
    envelope.connect(output);
    oscillator.start(options.start);
    oscillator.stop(end + 0.01);

    if (options.music) this.musicSources.add(oscillator);
    oscillator.addEventListener(
      "ended",
      () => {
        this.musicSources.delete(oscillator);
        oscillator.disconnect();
        envelope.disconnect();
      },
      { once: true },
    );
    return oscillator;
  }

  private syncMusic(): void {
    const shouldPlay =
      !this.disposed &&
      this.visible &&
      this.preferences.soundEnabled &&
      this.preferences.musicEnabled &&
      this.context?.state === "running";

    if (shouldPlay) {
      this.startMusic();
    } else {
      this.stopMusic();
    }
  }

  private startMusic(): void {
    if (this.musicTimer !== null || !this.context) return;
    this.nextMusicTime = this.context.currentTime + 0.08;
    this.scheduleMusic();
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 100);
  }

  private scheduleMusic(): void {
    const context = this.context;
    if (!context || context.state !== "running") return;

    const horizon = context.currentTime + MUSIC_LOOKAHEAD_SECONDS;
    while (this.nextMusicTime < horizon) {
      const frequency = MUSIC_NOTES[this.musicStep % MUSIC_NOTES.length];
      this.tone({
        frequency,
        start: this.nextMusicTime,
        duration: 1.55,
        volume: 0.07,
        type: this.musicStep % 3 === 0 ? "sine" : "triangle",
        music: true,
      });

      if (this.musicStep % 4 === 0) {
        this.tone({
          frequency: frequency / 2,
          start: this.nextMusicTime,
          duration: 2.2,
          volume: 0.04,
          type: "sine",
          music: true,
        });
      }

      this.musicStep = (this.musicStep + 1) % MUSIC_NOTES.length;
      this.nextMusicTime += MUSIC_STEP_SECONDS;
    }
  }

  private stopMusic(): void {
    if (this.musicTimer !== null && typeof window !== "undefined") {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }

    for (const source of this.musicSources) {
      try {
        source.stop();
      } catch {
        // An already-ended oscillator is harmless.
      }
    }
    this.musicSources.clear();
    this.nextMusicTime = 0;
  }
}
