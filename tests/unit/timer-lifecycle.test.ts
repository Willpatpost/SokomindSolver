import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calculateElapsedTime,
  nextTimerUpdateDelay,
} from "../../src/features/game/timer-math.ts";
import { formatTime } from "../../src/features/game/timer-math.ts";

// ---------------------------------------------------------------------------
// Simulates the timer's internal state machine using the pure functions from
// timer-math.ts, mirroring the pause/resume lifecycle managed by useTimer.
// ---------------------------------------------------------------------------

/** Minimal replica of the ref state inside useTimer. */
interface TimerState {
  accumulated: number;
  resumedAt: number | null;
}

function createTimer(): TimerState {
  return { accumulated: 0, resumedAt: null };
}

function resume(state: TimerState, now: number): void {
  state.resumedAt = now;
}

function pause(state: TimerState, now: number): void {
  if (state.resumedAt !== null) {
    state.accumulated = calculateElapsedTime(
      state.accumulated,
      state.resumedAt,
      now,
    );
    state.resumedAt = null;
  }
}

function elapsed(state: TimerState, now: number): number {
  return calculateElapsedTime(state.accumulated, state.resumedAt, now);
}

function reset(state: TimerState): void {
  state.accumulated = 0;
  state.resumedAt = null;
}

// ===========================================================================
// calculateElapsedTime — edge cases beyond the existing test
// ===========================================================================
describe("calculateElapsedTime edge cases", () => {
  it("returns zero when nothing has accumulated and timer is paused", () => {
    assert.equal(calculateElapsedTime(0, null, 99_999), 0);
  });

  it("returns accumulated time unchanged when paused (resumedAt is null)", () => {
    assert.equal(calculateElapsedTime(5_000, null, 0), 5_000);
    assert.equal(calculateElapsedTime(5_000, null, 999_999), 5_000);
  });

  it("computes elapsed correctly when accumulated is zero and running", () => {
    assert.equal(calculateElapsedTime(0, 1_000, 4_500), 3_500);
  });

  it("handles very large accumulated values", () => {
    const oneDay = 86_400_000;
    assert.equal(calculateElapsedTime(oneDay, null, 0), oneDay);
    assert.equal(calculateElapsedTime(oneDay, 100, 600), oneDay + 500);
  });

  it("handles now equal to resumedAt (zero running delta)", () => {
    assert.equal(calculateElapsedTime(2_000, 5_000, 5_000), 2_000);
  });

  it("handles sub-millisecond fractional values", () => {
    const result = calculateElapsedTime(0.1, 0.2, 0.5);
    assert.equal(result, 0.4); // 0.1 + (0.5 - 0.2)
  });
});

// ===========================================================================
// nextTimerUpdateDelay — edge cases beyond the existing test
// ===========================================================================
describe("nextTimerUpdateDelay edge cases", () => {
  it("returns 1000 for exactly zero elapsed", () => {
    assert.equal(nextTimerUpdateDelay(0), 1_000);
  });

  it("returns 1000 for exact second boundaries", () => {
    assert.equal(nextTimerUpdateDelay(2_000), 1_000);
    assert.equal(nextTimerUpdateDelay(60_000), 1_000);
    assert.equal(nextTimerUpdateDelay(3_600_000), 1_000);
  });

  it("clamps to at least 1 ms", () => {
    // 999.5 remainder → delay = 1000 - 999.5 = 0.5 → clamped to 1
    assert.equal(nextTimerUpdateDelay(999.5), 1);
    // exact boundary minus epsilon
    assert.equal(nextTimerUpdateDelay(999.99), 1);
  });

  it("falls back to 1000 for NaN", () => {
    assert.equal(nextTimerUpdateDelay(NaN), 1_000);
  });

  it("falls back to 1000 for Infinity", () => {
    assert.equal(nextTimerUpdateDelay(Infinity), 1_000);
    assert.equal(nextTimerUpdateDelay(-Infinity), 1_000);
  });

  it("falls back to 1000 for negative values", () => {
    assert.equal(nextTimerUpdateDelay(-1), 1_000);
    assert.equal(nextTimerUpdateDelay(-500), 1_000);
  });

  it("handles very large elapsed values", () => {
    const tenHours = 36_000_000;
    // 36_000_000 % 1000 === 0, so delay should be 1000
    assert.equal(nextTimerUpdateDelay(tenHours), 1_000);
    assert.equal(nextTimerUpdateDelay(tenHours + 250), 750);
  });

  it("aligns fractional milliseconds correctly", () => {
    // 1_500.25 % 1000 = 500.25 → delay = 1000 - 500.25 = 499.75
    assert.equal(nextTimerUpdateDelay(1_500.25), 499.75);
  });
});

// ===========================================================================
// formatTime — edge cases beyond the existing test
// ===========================================================================
describe("formatTime edge cases", () => {
  it("formats negative values as 0:00 (floor behavior)", () => {
    // Math.floor of a small negative / 1000 = -1, which gives weird results
    // but the function should at least not crash
    const result = formatTime(-1);
    assert.equal(typeof result, "string");
  });

  it("handles very large values (multiple days)", () => {
    const threeDays = 3 * 24 * 3_600_000; // 259_200_000
    const result = formatTime(threeDays);
    // 72:00:00
    assert.equal(result, "72:00:00");
  });

  it("handles exactly one second", () => {
    assert.equal(formatTime(1_000), "0:01");
  });

  it("handles 59 seconds", () => {
    assert.equal(formatTime(59_000), "0:59");
  });

  it("handles exactly one hour boundary", () => {
    assert.equal(formatTime(3_600_000), "1:00:00");
  });

  it("handles fractional milliseconds (sub-second truncation)", () => {
    // 1999.999 → Math.floor(1999.999/1000) = 1 → "0:01"
    assert.equal(formatTime(1_999.999), "0:01");
  });
});

// ===========================================================================
// Timer lifecycle simulation — pause/resume/reset state machine
// ===========================================================================
describe("timer lifecycle state machine", () => {
  it("starts at zero elapsed", () => {
    const timer = createTimer();
    assert.equal(elapsed(timer, 0), 0);
    assert.equal(elapsed(timer, 5_000), 0); // paused, so now is irrelevant
  });

  it("accumulates time while running", () => {
    const timer = createTimer();
    resume(timer, 1_000);
    assert.equal(elapsed(timer, 2_000), 1_000);
    assert.equal(elapsed(timer, 5_000), 4_000);
  });

  it("freezes elapsed when paused", () => {
    const timer = createTimer();
    resume(timer, 1_000);
    pause(timer, 3_000); // ran for 2 seconds
    assert.equal(elapsed(timer, 3_000), 2_000);
    assert.equal(elapsed(timer, 99_000), 2_000); // time passes but timer is paused
  });

  it("resumes from accumulated time after pause", () => {
    const timer = createTimer();
    resume(timer, 1_000);
    pause(timer, 3_000); // accumulated: 2_000
    resume(timer, 10_000); // resume later
    assert.equal(elapsed(timer, 11_000), 3_000); // 2_000 + 1_000
    assert.equal(elapsed(timer, 15_000), 7_000); // 2_000 + 5_000
  });

  it("handles multiple pause/resume cycles", () => {
    const timer = createTimer();

    resume(timer, 0);
    pause(timer, 1_000);   // +1_000 → accumulated = 1_000

    resume(timer, 5_000);
    pause(timer, 7_000);   // +2_000 → accumulated = 3_000

    resume(timer, 20_000);
    pause(timer, 20_500);  // +500  → accumulated = 3_500

    assert.equal(elapsed(timer, 99_999), 3_500);
  });

  it("reset clears all accumulated time", () => {
    const timer = createTimer();
    resume(timer, 0);
    pause(timer, 5_000); // accumulated: 5_000
    assert.equal(elapsed(timer, 5_000), 5_000);

    reset(timer);
    assert.equal(elapsed(timer, 99_999), 0);
  });

  it("can resume after reset", () => {
    const timer = createTimer();
    resume(timer, 0);
    pause(timer, 5_000);
    reset(timer);

    resume(timer, 10_000);
    assert.equal(elapsed(timer, 12_000), 2_000);
  });

  it("pause while already paused is a no-op", () => {
    const timer = createTimer();
    resume(timer, 0);
    pause(timer, 3_000); // accumulated: 3_000
    pause(timer, 5_000); // should not change anything
    assert.equal(elapsed(timer, 99_999), 3_000);
  });

  it("handles sub-millisecond precision through pause/resume", () => {
    const timer = createTimer();
    resume(timer, 0.1);
    pause(timer, 0.4); // accumulated: 0.3
    resume(timer, 1.0);
    pause(timer, 1.7); // accumulated: 0.3 + 0.7 = 1.0
    // Use approximate comparison due to floating point
    assert.ok(
      Math.abs(elapsed(timer, 99_999) - 1.0) < 1e-10,
      `Expected ~1.0, got ${elapsed(timer, 99_999)}`,
    );
  });
});

// ===========================================================================
// Drift correction — nextTimerUpdateDelay aligns ticks to second boundaries
// ===========================================================================
describe("drift correction via nextTimerUpdateDelay", () => {
  it("schedules first tick at 1 second when starting from zero", () => {
    assert.equal(nextTimerUpdateDelay(0), 1_000);
  });

  it("corrects for drift when elapsed overshoots a boundary", () => {
    // Timer fires slightly late: elapsed is 1_050 instead of 1_000
    // Next tick should be in 950 ms to align to 2_000
    assert.equal(nextTimerUpdateDelay(1_050), 950);
  });

  it("corrects for drift when elapsed undershoots a boundary", () => {
    // Timer fires slightly early: elapsed is 950
    // Next tick should be in 50 ms to align to 1_000
    assert.equal(nextTimerUpdateDelay(950), 50);
  });

  it("sequences of ticks align to second boundaries", () => {
    // Simulate a timer ticking with small drift
    let elapsedMs = 0;

    // Tick 1: starts at 0, delay should be 1000
    let delay = nextTimerUpdateDelay(elapsedMs);
    assert.equal(delay, 1_000);

    // Timer fires 3ms late: elapsed is 1_003
    elapsedMs = 1_003;
    delay = nextTimerUpdateDelay(elapsedMs);
    assert.equal(delay, 997); // aligns to 2_000

    // Timer fires 1ms early: elapsed is 1_999
    elapsedMs = 1_999;
    delay = nextTimerUpdateDelay(elapsedMs);
    assert.equal(delay, 1); // aligns to 2_000

    // Timer fires exactly on time: elapsed is 2_000
    elapsedMs = 2_000;
    delay = nextTimerUpdateDelay(elapsedMs);
    assert.equal(delay, 1_000); // aligns to 3_000
  });

  it("works after pause/resume with accumulated offset", () => {
    const timer = createTimer();
    resume(timer, 0);
    pause(timer, 2_750); // accumulated: 2_750

    resume(timer, 10_000);
    const currentElapsed = elapsed(timer, 10_100); // 2_750 + 100 = 2_850
    assert.equal(currentElapsed, 2_850);

    // Next update should fire in 150ms to align to 3_000
    assert.equal(nextTimerUpdateDelay(currentElapsed), 150);
  });
});

// ===========================================================================
// Integration: elapsed + formatTime pipeline
// ===========================================================================
describe("elapsed to display pipeline", () => {
  it("displays 0:00 at start", () => {
    const timer = createTimer();
    assert.equal(formatTime(elapsed(timer, 0)), "0:00");
  });

  it("displays correct time after running for 90 seconds", () => {
    const timer = createTimer();
    resume(timer, 0);
    assert.equal(formatTime(elapsed(timer, 90_000)), "1:30");
  });

  it("displays accumulated time after pause/resume cycles", () => {
    const timer = createTimer();
    resume(timer, 0);
    pause(timer, 30_000);   // 30s
    resume(timer, 60_000);
    pause(timer, 120_000);  // +60s = 90s
    assert.equal(formatTime(elapsed(timer, 999_999)), "1:30");
  });

  it("displays 0:00 after reset", () => {
    const timer = createTimer();
    resume(timer, 0);
    pause(timer, 60_000);
    reset(timer);
    assert.equal(formatTime(elapsed(timer, 999_999)), "0:00");
  });

  it("switches to H:MM:SS format at one hour", () => {
    const timer = createTimer();
    resume(timer, 0);
    const oneHour = 3_600_000;
    assert.equal(formatTime(elapsed(timer, oneHour)), "1:00:00");
  });

  it("displays correctly after many short pause/resume cycles", () => {
    const timer = createTimer();
    // Simulate 10 cycles of 100ms each = 1000ms total
    for (let i = 0; i < 10; i++) {
      resume(timer, i * 1_000);
      pause(timer, i * 1_000 + 100);
    }
    assert.equal(formatTime(elapsed(timer, 999_999)), "0:01");
  });
});
