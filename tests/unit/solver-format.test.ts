import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatCount,
  formatDuration,
  formatBytes,
  formatRate,
  phaseLabel,
  resultSummary,
} from "../../src/features/solver/solver-format.ts";
import type { SolverResult } from "../../src/solver/contracts.ts";

const STUB_METRICS = { elapsedMs: 100 } as const;

describe("formatCount", () => {
  it("returns em-dash for undefined", () => {
    assert.equal(formatCount(undefined), "—");
  });

  it("formats zero", () => {
    assert.equal(formatCount(0), "0");
  });

  it("formats small integers without decimals", () => {
    assert.equal(formatCount(42), "42");
  });

  it("formats large numbers with grouping separators", () => {
    const result = formatCount(1_000_000);
    assert.match(result, /1[,.]?000[,.]?000/);
  });
});

describe("formatDuration", () => {
  it("returns em-dash for negative values", () => {
    assert.equal(formatDuration(-1), "—");
  });

  it("returns em-dash for NaN", () => {
    assert.equal(formatDuration(NaN), "—");
  });

  it("returns em-dash for Infinity", () => {
    assert.equal(formatDuration(Infinity), "—");
  });

  it("returns em-dash for negative Infinity", () => {
    assert.equal(formatDuration(-Infinity), "—");
  });

  it("formats 0 ms", () => {
    assert.equal(formatDuration(0), "0 ms");
  });

  it("formats sub-second values as ms", () => {
    assert.equal(formatDuration(500), "500 ms");
    assert.equal(formatDuration(999), "999 ms");
  });

  it("rounds sub-second values", () => {
    assert.equal(formatDuration(1.7), "2 ms");
    assert.equal(formatDuration(0.4), "0 ms");
  });

  it("formats values >= 1s as decimal seconds", () => {
    const result = formatDuration(1_000);
    assert.match(result, /1/);
    assert.match(result, /s$/);
  });

  it("formats values under 60s with one decimal", () => {
    const result = formatDuration(1_500);
    assert.match(result, /1\.5\s*s/);
  });

  it("formats exact seconds", () => {
    const result = formatDuration(30_000);
    assert.match(result, /30/);
    assert.match(result, /s$/);
  });

  it("formats values >= 60s as Mm SSs", () => {
    assert.equal(formatDuration(60_000), "1m 00s");
    assert.equal(formatDuration(90_000), "1m 30s");
  });

  it("pads remaining seconds with leading zero", () => {
    assert.equal(formatDuration(61_000), "1m 01s");
    assert.equal(formatDuration(69_000), "1m 09s");
  });

  it("handles multi-minute durations", () => {
    assert.equal(formatDuration(600_000), "10m 00s");
    assert.equal(formatDuration(3_599_000), "59m 59s");
  });

  it("handles very large durations", () => {
    assert.equal(formatDuration(3_600_000), "60m 00s");
  });
});

describe("formatBytes", () => {
  it("returns em-dash for undefined", () => {
    assert.equal(formatBytes(undefined), "—");
  });

  it("returns em-dash for negative values", () => {
    assert.equal(formatBytes(-1), "—");
  });

  it("returns em-dash for NaN", () => {
    assert.equal(formatBytes(NaN), "—");
  });

  it("returns em-dash for Infinity", () => {
    assert.equal(formatBytes(Infinity), "—");
  });

  it("formats zero bytes", () => {
    assert.equal(formatBytes(0), "0 B");
  });

  it("formats values under 1 KiB as bytes", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1023), "1023 B");
  });

  it("formats values >= 1 KiB as KiB with one decimal", () => {
    const result = formatBytes(1_024);
    assert.match(result, /1/);
    assert.match(result, /KiB/);
  });

  it("formats fractional KiB", () => {
    const result = formatBytes(1_536);
    assert.match(result, /1\.5/);
    assert.match(result, /KiB/);
  });

  it("formats values >= 1 MiB", () => {
    const result = formatBytes(1_048_576);
    assert.match(result, /1/);
    assert.match(result, /MiB/);
  });

  it("formats fractional MiB", () => {
    const result = formatBytes(1_572_864);
    assert.match(result, /1\.5/);
    assert.match(result, /MiB/);
  });

  it("rounds byte values", () => {
    assert.equal(formatBytes(0.7), "1 B");
  });
});

describe("formatRate", () => {
  it("returns em-dash when expandedStates is undefined", () => {
    assert.equal(formatRate(undefined, 1000), "—");
  });

  it("returns em-dash when elapsed is zero", () => {
    assert.equal(formatRate(100, 0), "—");
  });

  it("returns em-dash when elapsed is negative", () => {
    assert.equal(formatRate(100, -1), "—");
  });

  it("returns em-dash when elapsed is NaN", () => {
    assert.equal(formatRate(100, NaN), "—");
  });

  it("returns em-dash when elapsed is Infinity", () => {
    assert.equal(formatRate(100, Infinity), "—");
  });

  it("computes states per second", () => {
    const result = formatRate(5000, 1000);
    assert.match(result, /5.*\/s/);
  });

  it("formats zero states", () => {
    assert.equal(formatRate(0, 1000), "0/s");
  });

  it("formats high rates with grouping", () => {
    const result = formatRate(1_000_000, 1000);
    assert.match(result, /1[,.]?000[,.]?000\/s/);
  });
});

describe("phaseLabel", () => {
  it("maps preparing", () => {
    assert.equal(phaseLabel("preparing"), "Preparing search");
  });

  it("maps searching", () => {
    assert.equal(phaseLabel("searching"), "Searching states");
  });

  it("maps improving", () => {
    assert.equal(phaseLabel("improving"), "Improving solution");
  });

  it("maps verifying", () => {
    assert.equal(phaseLabel("verifying"), "Verifying solution");
  });

  it("returns Waiting for undefined", () => {
    assert.equal(phaseLabel(undefined), "Waiting");
  });
});

describe("resultSummary", () => {
  it("formats a solved result with move and push counts", () => {
    const result: SolverResult = {
      status: "solved",
      solution: {
        steps: [],
        moves: 42,
        pushes: 15,
        objective: { kind: "moves" },
        objectiveScore: 42,
        optimality: "unknown",
      },
      metrics: STUB_METRICS,
    };
    const summary = resultSummary(result);
    assert.match(summary, /42/);
    assert.match(summary, /15/);
    assert.match(summary, /moves/i);
    assert.match(summary, /pushes/i);
  });

  it("formats a cancelled result", () => {
    const result: SolverResult = {
      status: "cancelled",
      metrics: STUB_METRICS,
    };
    assert.equal(resultSummary(result), "Search cancelled.");
  });

  it("formats an unsolved-exhausted result", () => {
    const result: SolverResult = {
      status: "unsolved",
      reason: "exhausted",
      metrics: STUB_METRICS,
    };
    assert.match(resultSummary(result), /exhausted/i);
  });

  it("formats an unsolved-limit-reached result without detail", () => {
    const result: SolverResult = {
      status: "unsolved",
      reason: "limit-reached",
      metrics: STUB_METRICS,
    };
    assert.match(resultSummary(result), /limit/i);
  });

  it("formats an unsolved-limit-reached result with detail", () => {
    const result: SolverResult = {
      status: "unsolved",
      reason: "limit-reached",
      metrics: STUB_METRICS,
      detail: "time budget exceeded",
    };
    const summary = resultSummary(result);
    assert.match(summary, /time budget exceeded/);
  });

  it("formats an unsupported result with detail", () => {
    const result: SolverResult = {
      status: "unsolved",
      reason: "unsupported",
      metrics: STUB_METRICS,
      detail: "Cannot handle multi-goal puzzles.",
    };
    assert.equal(resultSummary(result), "Cannot handle multi-goal puzzles.");
  });

  it("formats an unsupported result without detail", () => {
    const result: SolverResult = {
      status: "unsolved",
      reason: "unsupported",
      metrics: STUB_METRICS,
    };
    assert.match(resultSummary(result), /does not support/i);
  });
});
