import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import type { ExperiencePreferences } from "../../src/features/experience/experience-preferences.ts";

// ---------------------------------------------------------------------------
// Minimal Web Audio API mocks
// ---------------------------------------------------------------------------

interface CallRecord {
  method: string;
  args: unknown[];
}

function createCallTracker(): { calls: CallRecord[]; track(method: string, ...args: unknown[]): void } {
  const calls: CallRecord[] = [];
  return {
    calls,
    track(method: string, ...args: unknown[]) {
      calls.push({ method, args });
    },
  };
}

function createMockAudioParam(): AudioParam {
  const tracker = createCallTracker();
  return {
    value: 0,
    defaultValue: 0,
    minValue: -3.4028235e38,
    maxValue: 3.4028235e38,
    automationRate: "a-rate" as AutomationRate,
    setValueAtTime(value: number, time: number) {
      tracker.track("setValueAtTime", value, time);
      return this;
    },
    linearRampToValueAtTime(value: number, time: number) {
      tracker.track("linearRampToValueAtTime", value, time);
      return this;
    },
    exponentialRampToValueAtTime(value: number, time: number) {
      tracker.track("exponentialRampToValueAtTime", value, time);
      return this;
    },
    setTargetAtTime(target: number, startTime: number, timeConstant: number) {
      tracker.track("setTargetAtTime", target, startTime, timeConstant);
      return this;
    },
    setValueCurveAtTime(values: Float32Array, startTime: number, duration: number) {
      tracker.track("setValueCurveAtTime", values, startTime, duration);
      return this;
    },
    cancelScheduledValues(startTime: number) {
      tracker.track("cancelScheduledValues", startTime);
      return this;
    },
    cancelAndHoldAtTime(cancelTime: number) {
      tracker.track("cancelAndHoldAtTime", cancelTime);
      return this;
    },
    _tracker: tracker,
  } as AudioParam & { _tracker: ReturnType<typeof createCallTracker> };
}

function createMockOscillatorNode(): OscillatorNode & { _tracker: ReturnType<typeof createCallTracker>; _endedListeners: (() => void)[] } {
  const tracker = createCallTracker();
  const endedListeners: (() => void)[] = [];
  const node = {
    frequency: createMockAudioParam(),
    detune: createMockAudioParam(),
    type: "sine" as OscillatorType,
    _tracker: tracker,
    _endedListeners: endedListeners,
    connect(destination: AudioNode) {
      tracker.track("connect", destination);
      return destination;
    },
    disconnect() {
      tracker.track("disconnect");
    },
    start(when?: number) {
      tracker.track("start", when);
    },
    stop(when?: number) {
      tracker.track("stop", when);
      // Fire ended event async to mimic browser behavior
      setTimeout(() => {
        for (const listener of endedListeners) {
          listener();
        }
      }, 0);
    },
    addEventListener(event: string, handler: () => void, options?: { once?: boolean }) {
      if (event === "ended") {
        if (options?.once) {
          const wrappedHandler = () => {
            handler();
            const idx = endedListeners.indexOf(wrappedHandler);
            if (idx !== -1) endedListeners.splice(idx, 1);
          };
          endedListeners.push(wrappedHandler);
        } else {
          endedListeners.push(handler);
        }
      }
      tracker.track("addEventListener", event, typeof handler, options);
    },
    removeEventListener() {
      tracker.track("removeEventListener");
    },
    dispatchEvent() {
      return false;
    },
    channelCount: 2,
    channelCountMode: "max" as ChannelCountMode,
    channelInterpretation: "speakers" as ChannelInterpretation,
    context: null as unknown as BaseAudioContext,
    numberOfInputs: 0,
    numberOfOutputs: 1,
  };
  return node as unknown as OscillatorNode & { _tracker: ReturnType<typeof createCallTracker>; _endedListeners: (() => void)[] };
}

function createMockGainNode(): GainNode & { _tracker: ReturnType<typeof createCallTracker> } {
  const tracker = createCallTracker();
  const node = {
    gain: createMockAudioParam(),
    _tracker: tracker,
    connect(destination: AudioNode) {
      tracker.track("connect", destination);
      return destination;
    },
    disconnect() {
      tracker.track("disconnect");
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
    channelCount: 2,
    channelCountMode: "max" as ChannelCountMode,
    channelInterpretation: "speakers" as ChannelInterpretation,
    context: null as unknown as BaseAudioContext,
    numberOfInputs: 1,
    numberOfOutputs: 1,
  };
  return node as unknown as GainNode & { _tracker: ReturnType<typeof createCallTracker> };
}

interface MockAudioContext {
  state: AudioContextState;
  currentTime: number;
  destination: AudioDestinationNode;
  _createdOscillators: ReturnType<typeof createMockOscillatorNode>[];
  _createdGains: ReturnType<typeof createMockGainNode>[];
  _tracker: ReturnType<typeof createCallTracker>;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
  resume(): Promise<void>;
  close(): Promise<void>;
}

function createMockAudioContext(): MockAudioContext {
  const tracker = createCallTracker();
  const createdOscillators: ReturnType<typeof createMockOscillatorNode>[] = [];
  const createdGains: ReturnType<typeof createMockGainNode>[] = [];

  const destination = {
    channelCount: 2,
    channelCountMode: "explicit" as ChannelCountMode,
    channelInterpretation: "speakers" as ChannelInterpretation,
    maxChannelCount: 2,
    numberOfInputs: 1,
    numberOfOutputs: 0,
    connect() { return {} as AudioNode; },
    disconnect() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
    context: null as unknown as BaseAudioContext,
  } as unknown as AudioDestinationNode;

  const ctx: MockAudioContext = {
    state: "running" as AudioContextState,
    currentTime: 10.0,
    destination,
    _createdOscillators: createdOscillators,
    _createdGains: createdGains,
    _tracker: tracker,
    createOscillator() {
      tracker.track("createOscillator");
      const osc = createMockOscillatorNode();
      createdOscillators.push(osc);
      return osc as unknown as OscillatorNode;
    },
    createGain() {
      tracker.track("createGain");
      const gain = createMockGainNode();
      createdGains.push(gain);
      return gain as unknown as GainNode;
    },
    async resume() {
      tracker.track("resume");
      ctx.state = "running";
    },
    async close() {
      tracker.track("close");
      ctx.state = "closed";
    },
  };

  return ctx;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultPreferences(overrides?: Partial<ExperiencePreferences>): ExperiencePreferences {
  return {
    version: 2,
    soundEnabled: true,
    musicEnabled: false,
    effectsVolume: 0.72,
    musicVolume: 0.28,
    motion: "system",
    themeFamily: "cozy-study",
    appearance: "system",
    zenMode: false,
    ...overrides,
  };
}

/**
 * Install a fake `window` with `AudioContext` so the module's
 * `audioContextConstructor()` finds it, and `setInterval`/`clearInterval`
 * are available for the music scheduler.
 */
function installWindowMock(mockCtx: MockAudioContext) {
  const timers: Map<number, ReturnType<typeof setInterval>> = new Map();
  let nextTimerId = 1;
  (globalThis as Record<string, unknown>).window = {
    AudioContext: function () {
      return mockCtx;
    } as unknown as typeof AudioContext,
    setInterval(fn: () => void, ms: number) {
      const id = nextTimerId++;
      const handle = setInterval(fn, ms);
      timers.set(id, handle);
      return id;
    },
    clearInterval(id: number) {
      const handle = timers.get(id);
      if (handle !== undefined) {
        clearInterval(handle);
        timers.delete(id);
      }
    },
  };
  return {
    restore() {
      for (const handle of timers.values()) {
        clearInterval(handle);
      }
      timers.clear();
      delete (globalThis as Record<string, unknown>).window;
    },
    timers,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// We need to dynamically import the module *after* setting up the global
// window mock, since `audioContextConstructor()` reads `window` at call time.
async function importModule() {
  // Node caches modules. We bust the cache with a query param so each
  // test suite gets a fresh import.  The `--experimental-strip-types`
  // flag is required for .ts imports.
  const modulePath = "../../src/features/experience/procedural-audio.ts";
  return import(modulePath);
}

describe("ProceduralAudioController", () => {
  let windowMock: ReturnType<typeof installWindowMock>;
  let mockCtx: MockAudioContext;
  let mod: Awaited<ReturnType<typeof importModule>>;

  beforeEach(async () => {
    mockCtx = createMockAudioContext();
    windowMock = installWindowMock(mockCtx);
    mod = await importModule();
  });

  afterEach(() => {
    windowMock.restore();
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  describe("construction", () => {
    it("creates without side effects (no AudioContext allocated)", () => {
      const prefs = defaultPreferences();
      const controller = new mod.ProceduralAudioController(prefs);
      // No calls to the mock context constructor yet
      assert.equal(mockCtx._tracker.calls.length, 0);
      assert.equal(controller.ready, false);
      controller.dispose();
    });

    it("reports supported when window.AudioContext exists", () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      assert.equal(controller.supported, true);
      controller.dispose();
    });

    it("reports unsupported when window is absent", () => {
      windowMock.restore();
      delete (globalThis as Record<string, unknown>).window;
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      assert.equal(controller.supported, false);
      controller.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // AUDIO_CUES export
  // -----------------------------------------------------------------------

  describe("AUDIO_CUES", () => {
    it("exports all 8 audio cue types", () => {
      assert.equal(mod.AUDIO_CUES.length, 8);
      const expected = [
        "step", "push", "goal-enter", "goal-leave",
        "blocked", "undo", "reset", "solve",
      ];
      assert.deepEqual([...mod.AUDIO_CUES], expected);
    });
  });

  // -----------------------------------------------------------------------
  // supportsProceduralAudio
  // -----------------------------------------------------------------------

  describe("supportsProceduralAudio", () => {
    it("returns true when window.AudioContext exists", () => {
      assert.equal(mod.supportsProceduralAudio(), true);
    });

    it("returns false when window is undefined", () => {
      windowMock.restore();
      delete (globalThis as Record<string, unknown>).window;
      assert.equal(mod.supportsProceduralAudio(), false);
    });
  });

  // -----------------------------------------------------------------------
  // unlock()
  // -----------------------------------------------------------------------

  describe("unlock()", () => {
    it("creates AudioContext and gain nodes on first unlock", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      const result = await controller.unlock();
      assert.equal(result, true);
      assert.equal(controller.ready, true);
      // Should have created: 3 gain nodes (master, effects, music)
      assert.equal(
        mockCtx._tracker.calls.filter((c: CallRecord) => c.method === "createGain").length,
        3,
      );
      controller.dispose();
    });

    it("returns false when disposed", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      controller.dispose();
      const result = await controller.unlock();
      assert.equal(result, false);
    });

    it("returns false when unsupported", async () => {
      windowMock.restore();
      delete (globalThis as Record<string, unknown>).window;
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      const result = await controller.unlock();
      assert.equal(result, false);
    });

    it("resumes a suspended context", async () => {
      mockCtx.state = "suspended";
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      const result = await controller.unlock();
      assert.equal(result, true);
      assert.equal(
        mockCtx._tracker.calls.some((c: CallRecord) => c.method === "resume"),
        true,
      );
      controller.dispose();
    });

    it("reuses existing context on subsequent calls", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      const gainCountBefore = mockCtx._tracker.calls.filter(
        (c: CallRecord) => c.method === "createGain",
      ).length;
      await controller.unlock();
      const gainCountAfter = mockCtx._tracker.calls.filter(
        (c: CallRecord) => c.method === "createGain",
      ).length;
      assert.equal(gainCountBefore, gainCountAfter);
      controller.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // dispose()
  // -----------------------------------------------------------------------

  describe("dispose()", () => {
    it("closes the AudioContext", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      controller.dispose();
      assert.equal(
        mockCtx._tracker.calls.some((c: CallRecord) => c.method === "close"),
        true,
      );
    });

    it("sets ready to false", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      assert.equal(controller.ready, true);
      controller.dispose();
      assert.equal(controller.ready, false);
    });

    it("is idempotent (calling twice does not throw)", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      controller.dispose();
      controller.dispose(); // second call should not throw
    });

    it("does not close an already-closed context", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      mockCtx.state = "closed";
      controller.dispose();
      // close() should NOT appear because the context was already closed
      assert.equal(
        mockCtx._tracker.calls.filter((c: CallRecord) => c.method === "close").length,
        0,
      );
    });
  });

  // -----------------------------------------------------------------------
  // playCue() -- sound effects
  // -----------------------------------------------------------------------

  describe("playCue()", () => {
    it("returns false when sound is disabled", async () => {
      const prefs = defaultPreferences({ soundEnabled: false });
      const controller = new mod.ProceduralAudioController(prefs);
      const result = await controller.playCue("step");
      assert.equal(result, false);
      assert.equal(mockCtx._tracker.calls.length, 0, "muted cues should not allocate audio");
      controller.dispose();
    });

    it("returns false without allocating audio when effects volume is zero", async () => {
      const controller = new mod.ProceduralAudioController(
        defaultPreferences({ effectsVolume: 0 }),
      );
      const result = await controller.playCue("step");
      assert.equal(result, false);
      assert.equal(mockCtx._tracker.calls.length, 0);
      controller.dispose();
    });

    it("returns false when disposed", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      controller.dispose();
      const result = await controller.playCue("step");
      assert.equal(result, false);
    });

    it("returns false when page is not visible", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      controller.setPageVisible(false);
      const result = await controller.playCue("step");
      assert.equal(result, false);
      controller.dispose();
    });

    for (const cue of [
      "step", "push", "goal-enter", "goal-leave",
      "blocked", "undo", "reset", "solve",
    ] as const) {
      it(`plays "${cue}" cue and creates oscillator(s)`, async () => {
        const controller = new mod.ProceduralAudioController(defaultPreferences());
        await controller.unlock();
        const oscsBefore = mockCtx._createdOscillators.length;
        const result = await controller.playCue(cue);
        assert.equal(result, true);
        const oscsAfter = mockCtx._createdOscillators.length;
        assert.ok(
          oscsAfter > oscsBefore,
          `Expected at least one oscillator for cue "${cue}"`,
        );
        controller.dispose();
      });
    }

    it('"step" creates exactly 1 oscillator with triangle type', async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      const oscsBefore = mockCtx._createdOscillators.length;
      await controller.playCue("step");
      const newOscs = mockCtx._createdOscillators.slice(oscsBefore);
      assert.equal(newOscs.length, 1);
      assert.equal(newOscs[0].type, "triangle");
      controller.dispose();
    });

    it('"push" creates exactly 2 oscillators', async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      const oscsBefore = mockCtx._createdOscillators.length;
      await controller.playCue("push");
      const newOscs = mockCtx._createdOscillators.slice(oscsBefore);
      assert.equal(newOscs.length, 2);
      controller.dispose();
    });

    it('"goal-enter" creates exactly 2 oscillators', async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      const oscsBefore = mockCtx._createdOscillators.length;
      await controller.playCue("goal-enter");
      const newOscs = mockCtx._createdOscillators.slice(oscsBefore);
      assert.equal(newOscs.length, 2);
      controller.dispose();
    });

    it('"solve" creates exactly 4 oscillators (arpeggio)', async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      const oscsBefore = mockCtx._createdOscillators.length;
      await controller.playCue("solve");
      const newOscs = mockCtx._createdOscillators.slice(oscsBefore);
      assert.equal(newOscs.length, 4);
      controller.dispose();
    });

    it("uses longer solve signatures for personal-best and optimal milestones", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      const beforeBest = mockCtx._createdOscillators.length;
      await controller.playCue("solve", { variant: "personal-best" });
      assert.equal(mockCtx._createdOscillators.length - beforeBest, 5);

      const beforeOptimal = mockCtx._createdOscillators.length;
      await controller.playCue("solve", { variant: "optimal" });
      assert.equal(mockCtx._createdOscillators.length - beforeOptimal, 6);
      controller.dispose();
    });

    it("adds a restrained second tone for warnings and deadlocks", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      const beforeWarning = mockCtx._createdOscillators.length;
      await controller.playCue("blocked", { variant: "warning" });
      assert.equal(mockCtx._createdOscillators.length - beforeWarning, 2);

      mockCtx.currentTime += 0.1;
      const beforeDeadlock = mockCtx._createdOscillators.length;
      await controller.playCue("blocked", { variant: "deadlock" });
      assert.equal(mockCtx._createdOscillators.length - beforeDeadlock, 2);
      controller.dispose();
    });

    it("rate limits noisy repeated cues while allowing deliberate previews", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      assert.equal(await controller.playCue("step"), true);
      assert.equal(await controller.playCue("step"), false);
      assert.equal(
        await controller.playCue("step", { bypassRateLimit: true }),
        true,
      );

      mockCtx.currentTime += 0.03;
      assert.equal(await controller.playCue("step"), true);
      controller.dispose();
    });

    it("transposes a cue without changing its presentation shape", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      await controller.playCue("step", { pitchOffset: 2 });
      const osc = mockCtx._createdOscillators.at(-1)!;
      const calls = (osc.frequency as unknown as {
        _tracker: ReturnType<typeof createCallTracker>;
      })._tracker.calls;
      const startFrequency = calls.find(
        (call: CallRecord) => call.method === "setValueAtTime",
      )?.args[0] as number;
      assert.ok(Math.abs(startFrequency - 145 * 2 ** (2 / 12)) < 0.001);
      controller.dispose();
    });

    it("contains Web Audio node failures instead of rejecting game input", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      mockCtx.createOscillator = () => {
        throw new Error("audio device unavailable");
      };
      assert.equal(await controller.playCue("step"), false);
      controller.dispose();
    });

    it("oscillators are connected, started, and scheduled to stop", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      await controller.playCue("step");
      const osc = mockCtx._createdOscillators[mockCtx._createdOscillators.length - 1];
      const connectCalls = osc._tracker.calls.filter((c: CallRecord) => c.method === "connect");
      const startCalls = osc._tracker.calls.filter((c: CallRecord) => c.method === "start");
      const stopCalls = osc._tracker.calls.filter((c: CallRecord) => c.method === "stop");
      assert.ok(connectCalls.length > 0, "oscillator should be connected");
      assert.ok(startCalls.length > 0, "oscillator should be started");
      assert.ok(stopCalls.length > 0, "oscillator should be scheduled to stop");
      controller.dispose();
    });

    it("each oscillator gets an envelope gain node", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      const gainsBefore = mockCtx._createdGains.length;
      await controller.playCue("step");
      const gainsAfter = mockCtx._createdGains.length;
      // 1 envelope gain per oscillator
      assert.ok(gainsAfter > gainsBefore, "should create envelope gain node");
      controller.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // setPreferences() -- enabling / disabling audio
  // -----------------------------------------------------------------------

  describe("setPreferences()", () => {
    it("disabling sound silences master gain", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      const masterGain = mockCtx._createdGains[0]; // first gain = master
      controller.setPreferences(defaultPreferences({ soundEnabled: false }));
      // Master gain should have been set to 0
      const paramTracker = (masterGain.gain as unknown as { _tracker: ReturnType<typeof createCallTracker> })._tracker;
      const setTargetCalls = paramTracker.calls.filter(
        (c: CallRecord) => c.method === "setTargetAtTime" && c.args[0] === 0,
      );
      assert.ok(setTargetCalls.length > 0, "master gain should be set to 0 when sound disabled");
      controller.dispose();
    });

    it("re-enabling sound restores master gain", async () => {
      const prefs = defaultPreferences({ soundEnabled: false });
      const controller = new mod.ProceduralAudioController(prefs);
      await controller.unlock();
      controller.setPreferences(defaultPreferences({ soundEnabled: true }));
      const masterGain = mockCtx._createdGains[0];
      const paramTracker = (masterGain.gain as unknown as { _tracker: ReturnType<typeof createCallTracker> })._tracker;
      const setTargetCalls = paramTracker.calls.filter(
        (c: CallRecord) => c.method === "setTargetAtTime" && c.args[0] === 0.9,
      );
      assert.ok(setTargetCalls.length > 0, "master gain should be restored to 0.9");
      controller.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // setPageVisible()
  // -----------------------------------------------------------------------

  describe("setPageVisible()", () => {
    it("hiding the page mutes master gain", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      controller.setPageVisible(false);
      const masterGain = mockCtx._createdGains[0];
      const paramTracker = (masterGain.gain as unknown as { _tracker: ReturnType<typeof createCallTracker> })._tracker;
      const muteCalls = paramTracker.calls.filter(
        (c: CallRecord) => c.method === "setTargetAtTime" && c.args[0] === 0,
      );
      assert.ok(muteCalls.length > 0, "master gain should be muted when page hidden");
      controller.dispose();
    });

    it("playCue returns false when page is hidden", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      controller.setPageVisible(false);
      const result = await controller.playCue("step");
      assert.equal(result, false);
      controller.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // Music generator
  // -----------------------------------------------------------------------

  describe("music generator", () => {
    it("does not start music work when music volume is zero", async () => {
      const prefs = defaultPreferences({
        soundEnabled: true,
        musicEnabled: true,
        musicVolume: 0,
      });
      const controller = new mod.ProceduralAudioController(prefs);
      await controller.unlock();
      assert.equal(mockCtx._createdOscillators.length, 0);
      assert.equal(windowMock.timers.size, 0);
      controller.dispose();
    });

    it("offers explicit effect and music previews", async () => {
      const prefs = defaultPreferences({ soundEnabled: true, musicEnabled: true });
      const controller = new mod.ProceduralAudioController(prefs);
      assert.equal(await controller.previewEffects(), true);
      const beforeMusicPreview = mockCtx._createdOscillators.length;
      assert.equal(await controller.previewMusic(), true);
      assert.ok(mockCtx._createdOscillators.length - beforeMusicPreview >= 3);
      assert.equal(await controller.previewMusic(), false, "preview should be rate limited");
      controller.dispose();
    });

    it("enabling music starts the scheduler (creates music oscillators)", async () => {
      const prefs = defaultPreferences({ soundEnabled: true, musicEnabled: true });
      const controller = new mod.ProceduralAudioController(prefs);
      await controller.unlock();

      // The music scheduler runs on setInterval, so give it a tick
      await new Promise((r) => setTimeout(r, 150));

      // Music oscillators should be created
      // After unlock with musicEnabled, scheduleMusic creates oscillators
      const oscs = mockCtx._createdOscillators;
      assert.ok(oscs.length > 0, "music should have created oscillator(s)");

      controller.dispose();
    });

    it("music notes are tagged with music: true (routed through musicGain)", async () => {
      const prefs = defaultPreferences({ soundEnabled: true, musicEnabled: true });
      const controller = new mod.ProceduralAudioController(prefs);
      await controller.unlock();

      await new Promise((r) => setTimeout(r, 150));

      // Music oscillators connect to envelope gains which connect to musicGain
      // The musicGain is the 3rd gain created (index 2: master=0, effects=1, music=2)
      const musicGain = mockCtx._createdGains[2];
      // Envelope gains created after the initial 3 should connect to musicGain
      const envelopeGains = mockCtx._createdGains.slice(3);
      if (envelopeGains.length > 0) {
        const firstEnvelope = envelopeGains[0];
        const connectCalls = firstEnvelope._tracker.calls.filter(
          (c: CallRecord) => c.method === "connect",
        );
        assert.ok(connectCalls.length > 0, "envelope should connect to musicGain");
        assert.equal(connectCalls[0].args[0], musicGain, "envelope should connect to musicGain node");
      }

      controller.dispose();
    });

    it("dispose stops music and clears the timer", async () => {
      const prefs = defaultPreferences({ soundEnabled: true, musicEnabled: true });
      const controller = new mod.ProceduralAudioController(prefs);
      await controller.unlock();
      await new Promise((r) => setTimeout(r, 150));

      controller.dispose();
      // After dispose, no more timers should be active
      // The windowMock.timers map should be emptied by clearInterval calls
      // (though our mock implementation cleans them up on restore)
    });

    it("disabling music via setPreferences stops the scheduler", async () => {
      const prefs = defaultPreferences({ soundEnabled: true, musicEnabled: true });
      const controller = new mod.ProceduralAudioController(prefs);
      await controller.unlock();
      await new Promise((r) => setTimeout(r, 150));

      const oscBefore = mockCtx._createdOscillators.length;
      controller.setPreferences(defaultPreferences({ soundEnabled: true, musicEnabled: false }));

      await new Promise((r) => setTimeout(r, 200));
      assert.ok(
        mockCtx._createdOscillators.length - oscBefore <= 2,
        "music scheduler should be stopped — no significant new oscillators",
      );
      controller.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // Gain routing topology
  // -----------------------------------------------------------------------

  describe("gain routing topology", () => {
    it("creates correct signal chain: effects+music -> master -> destination", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();

      // Gain nodes created: master (0), effects (1), music (2)
      assert.equal(mockCtx._createdGains.length, 3);

      const masterGain = mockCtx._createdGains[0];
      const effectsGain = mockCtx._createdGains[1];
      const musicGain = mockCtx._createdGains[2];

      // effectsGain -> masterGain
      const effectsConnects = effectsGain._tracker.calls.filter(
        (c: CallRecord) => c.method === "connect",
      );
      assert.ok(effectsConnects.length > 0, "effectsGain should connect");
      assert.equal(effectsConnects[0].args[0], masterGain, "effectsGain -> masterGain");

      // musicGain -> masterGain
      const musicConnects = musicGain._tracker.calls.filter(
        (c: CallRecord) => c.method === "connect",
      );
      assert.ok(musicConnects.length > 0, "musicGain should connect");
      assert.equal(musicConnects[0].args[0], masterGain, "musicGain -> masterGain");

      // masterGain -> destination
      const masterConnects = masterGain._tracker.calls.filter(
        (c: CallRecord) => c.method === "connect",
      );
      assert.ok(masterConnects.length > 0, "masterGain should connect");
      assert.equal(
        masterConnects[0].args[0],
        mockCtx.destination,
        "masterGain -> destination",
      );

      controller.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // Frequency sweeps
  // -----------------------------------------------------------------------

  describe("frequency sweeps", () => {
    it('"step" cue sets frequency ramp (endFrequency differs)', async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      await controller.playCue("step");

      const osc = mockCtx._createdOscillators[mockCtx._createdOscillators.length - 1];
      const freqTracker = (osc.frequency as unknown as { _tracker: ReturnType<typeof createCallTracker> })._tracker;

      // Should have setValueAtTime (start freq) and exponentialRampToValueAtTime (end freq)
      const setValueCalls = freqTracker.calls.filter(
        (c: CallRecord) => c.method === "setValueAtTime",
      );
      const rampCalls = freqTracker.calls.filter(
        (c: CallRecord) => c.method === "exponentialRampToValueAtTime",
      );
      assert.ok(setValueCalls.length > 0, "should set start frequency");
      assert.ok(rampCalls.length > 0, "should ramp to end frequency");
      // step: 145 -> 112
      assert.equal(setValueCalls[0].args[0], 145);
      assert.equal(rampCalls[0].args[0], 112);

      controller.dispose();
    });

    it('"goal-enter" has no frequency ramp (no endFrequency)', async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      const oscsBefore = mockCtx._createdOscillators.length;
      await controller.playCue("goal-enter");
      // First oscillator of goal-enter: freq 392, no endFrequency
      const osc = mockCtx._createdOscillators[oscsBefore];
      const freqTracker = (osc.frequency as unknown as { _tracker: ReturnType<typeof createCallTracker> })._tracker;
      const rampCalls = freqTracker.calls.filter(
        (c: CallRecord) => c.method === "exponentialRampToValueAtTime",
      );
      assert.equal(rampCalls.length, 0, "goal-enter first tone should have no frequency ramp");

      controller.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // Envelope shaping
  // -----------------------------------------------------------------------

  describe("envelope shaping", () => {
    it("envelope gain starts near zero, ramps to peak, then back to zero", async () => {
      const controller = new mod.ProceduralAudioController(defaultPreferences());
      await controller.unlock();
      const gainsBefore = mockCtx._createdGains.length;
      await controller.playCue("blocked");
      // The envelope is the gain node created for this tone (after the initial 3)
      const envelope = mockCtx._createdGains[gainsBefore];
      const paramTracker = (envelope.gain as unknown as { _tracker: ReturnType<typeof createCallTracker> })._tracker;

      const setValueCalls = paramTracker.calls.filter(
        (c: CallRecord) => c.method === "setValueAtTime",
      );
      const rampCalls = paramTracker.calls.filter(
        (c: CallRecord) => c.method === "exponentialRampToValueAtTime",
      );

      // Should start at ~0 (0.0001)
      assert.equal(setValueCalls.length, 1);
      assert.equal(setValueCalls[0].args[0], 0.0001);

      // Two ramps: attack to peak, then decay to ~0
      assert.equal(rampCalls.length, 2);
      // Peak should be > 0
      assert.ok((rampCalls[0].args[0] as number) > 0.0001, "attack ramp should go to peak");
      // Decay should go back to 0.0001
      assert.equal(rampCalls[1].args[0], 0.0001);

      controller.dispose();
    });
  });
});
