import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCounterfactualStory,
  type CounterfactualBudget,
} from "../../src/features/generator/v2/index.ts";
import {
  DELAYED_FALSE_START, RECOVERABLE_CORRIDOR, NECESSARY_GOAL_VACANCY,
  OPTIONAL_GOAL_VACANCY, NECESSARY_ENABLER, UNRELATED_CONTINUATION, type CounterfactualFixture,
} from "../fixtures/generator/counterfactual-stories.ts";
import { fixtureTrace, replayPushes, oracleProbe } from "../support/counterfactual-replay.ts";

const FULL: CounterfactualBudget = {
  maxProbes: 200, maxStatesPerProbe: 10000, maxTotalStates: 200000,
  maxElapsedMs: 100000, minDelayedPushes: 2,
};

function analyze(fixture: CounterfactualFixture, budget: Partial<CounterfactualBudget> = {}) {
  const { grid, trace } = fixtureTrace(fixture);
  return analyzeCounterfactualStory(grid, trace, { ...FULL, ...budget }, { now: () => 0 });
}

test("counterfactual story proves a plausible delayed false start, not a corner death", () => {
  const profile = analyze(DELAYED_FALSE_START);
  const probe = profile.probes.find((item) => item.kind === "alternative-push" &&
    item.checkpointPushIndex === 0 && item.boxId === 0 && item.alternative?.direction === "right");
  assert.ok(probe);
  assert.equal(probe.plausible, true);
  assert.equal(probe.classification, "delayed-false-start");
  assert.equal(probe.outcome, "exhausted");
  assert.equal(probe.stopReason, "exhausted");
  assert.ok(probe.nonDeadContinuationPushes >= 2);
  assert.ok(probe.continuationWitness.length >= 3);
  assert.ok(profile.immediateDeadEnds > 0);
  assert.ok(profile.probes.filter((item) => item.stopReason === "static-dead-square")
    .every((item) => item.classification === "immediate-dead-end"));
});

test("counterfactual story finds recovery when the same corridor has a bypass", () => {
  const profile = analyze(RECOVERABLE_CORRIDOR);
  const probe = profile.probes.find((item) => item.kind === "alternative-push" &&
    item.checkpointPushIndex === 0 && item.boxId === 0 && item.alternative?.direction === "right");
  assert.ok(probe);
  assert.equal(probe.classification, "recoverable-alternative");
  assert.equal(probe.outcome, "solved");
  assert.ok(probe.witness.length > 1);
});

test("unrelated box work cannot inflate a short dead end into a delayed false start", () => {
  const profile = analyze(UNRELATED_CONTINUATION);
  const probe = profile.probes.find((item) => item.kind === "alternative-push" &&
    item.checkpointPushIndex === 0 && item.boxId === 1 && item.alternative?.direction === "right");
  assert.ok(probe);
  assert.equal(probe.plausible, true);
  assert.equal(probe.outcome, "exhausted");
  assert.equal(probe.classification, "dead-end");
  assert.ok(probe.nonDeadContinuationPushes >= 3);
  assert.equal(probe.alternativeBoxContinuationPushes, 1);
});

test("bounded-search conclusions agree with an independent exhaustive game-engine oracle", () => {
  for (const fixture of [DELAYED_FALSE_START, RECOVERABLE_CORRIDOR]) {
    const profile = analyze(fixture);
    const probe = profile.probes.find((item) => item.kind === "alternative-push" &&
      item.checkpointPushIndex === 0 && item.boxId === 0 && item.alternative?.direction === "right");
    assert.ok(probe);
    assert.notEqual(probe.outcome, "unknown");
    assert.equal(oracleProbe(fixture, probe), probe.outcome === "solved");
  }
  for (const fixture of [NECESSARY_GOAL_VACANCY, OPTIONAL_GOAL_VACANCY, NECESSARY_ENABLER]) {
    const profile = analyze(fixture);
    const probe = profile.probes.find((item) => item.kind ===
      (fixture === NECESSARY_ENABLER ? "freeze-enabler" : "preserve-goal"));
    assert.ok(probe);
    assert.notEqual(probe.outcome, "unknown");
    assert.equal(oracleProbe(fixture, probe), probe.outcome === "solved");
  }
});

test("20-box traces respect the bounded search budget without requiring a proof", () => {
  const width = 44;
  const rows: string[][] = Array.from({ length: 7 }, (_, row) => Array.from({ length: width }, (_, column) =>
    row === 0 || row === 6 || column === 0 || column === width - 1 ? "O" : " "));
  rows[2][1] = "R";
  for (let id = 0; id < 20; id++) {
    rows[2][3 + 2 * id] = id === 0 ? "A" : "X";
    rows[4][3 + 2 * id] = id === 0 ? "a" : "S";
  }
  const fixture: CounterfactualFixture = {
    puzzle: { id: "cf-20", title: "Large Search Budget", difficulty: "master", boxes: 20,
      rows: rows.map((row) => row.join("")) },
    pushes: Array.from({ length: 20 }, (_, id) => [id, "down", 2] as const),
  };
  const profile = analyze(fixture, { maxProbes: 8, maxStatesPerProbe: 16, maxTotalStates: 32 });
  assert.equal(profile.probes.length, 8);
  assert.ok(profile.expandedStates <= 32);
  assert.ok(profile.probes.every((probe) => probe.visitedStates <= 16));
  assert.ok(profile.unknownProbes > 0);
  assert.equal(profile.delayedFalseStarts, 0);
});

test("counterfactual story distinguishes necessary and gratuitous goal vacancies", () => {
  const necessary = analyze(NECESSARY_GOAL_VACANCY).probes.filter((probe) => probe.kind === "preserve-goal");
  assert.ok(necessary.length > 0);
  assert.ok(necessary.some((probe) => probe.classification === "necessary"));
  const optional = analyze(OPTIONAL_GOAL_VACANCY).probes.filter((probe) => probe.kind === "preserve-goal");
  assert.equal(optional.length, 1);
  assert.equal(optional[0].classification, "optional");
  assert.ok(optional[0].witness.every((push) => push.boxId !== optional[0].boxId));
});

test("counterfactual story verifies a target-specific typed/generic enabler", () => {
  const profile = analyze(NECESSARY_ENABLER);
  const probe = profile.probes.find((item) => item.kind === "freeze-enabler" &&
    item.boxId === 0 && item.targetBoxId === 1 && item.classification === "necessary");
  assert.ok(probe);
  assert.equal(probe.outcome, "exhausted");
  assert.match(probe.explanation, /enabling a push of box 1/);
});

test("all recovery and continuation witnesses replay legally with stable typed/generic IDs", () => {
  for (const fixture of [DELAYED_FALSE_START, RECOVERABLE_CORRIDOR,
    NECESSARY_GOAL_VACANCY, OPTIONAL_GOAL_VACANCY, NECESSARY_ENABLER]) {
    const { session } = fixtureTrace(fixture);
    const profile = analyze(fixture);
    for (const probe of profile.probes) {
      const initial = {
        ...session.snapshot, robot: probe.state.robot,
        boxes: session.snapshot.boxes.map((box, index) => ({ ...box, position: probe.state.boxes[index] })),
      };
      if (probe.outcome === "solved") {
        const replay = replayPushes(session.board, initial, probe.witness);
        if (probe.kind === "freeze-enabler") {
          assert.ok(probe.witness.some((push) => push.boxId === probe.targetBoxId));
          assert.ok(probe.witness.every((push) => push.boxId !== probe.boxId));
        } else assert.ok(replay.snapshot.solved);
      }
      replayPushes(session.board, initial, probe.continuationWitness);
    }
  }
});

test("counterfactual state/frontier limits report unknown, never necessity or false starts", () => {
  const profile = analyze(RECOVERABLE_CORRIDOR, { maxStatesPerProbe: 1 });
  assert.ok(profile.unknownProbes > 0);
  assert.equal(profile.delayedFalseStarts, 0);
  for (const probe of profile.probes.filter((item) => item.stopReason === "state-budget")) {
    assert.equal(probe.outcome, "unknown");
    assert.equal(probe.classification, "unknown");
    assert.ok(probe.visitedStates <= 1);
    assert.ok(probe.expandedStates <= 1);
  }
  const totalLimited = analyze(RECOVERABLE_CORRIDOR, { maxTotalStates: 0 });
  assert.equal(totalLimited.expandedStates, 0);
  assert.ok(totalLimited.unknownProbes > 0);
  assert.equal(totalLimited.delayedFalseStarts, 0);
  const zeroStates = analyze(RECOVERABLE_CORRIDOR, { maxStatesPerProbe: 0 });
  assert.ok(zeroStates.probes.every((probe) => probe.outcome === "unknown" && probe.visitedStates === 0));
});

test("counterfactual cancellation and time limits are explicit unknowns", () => {
  const { grid, trace } = fixtureTrace(DELAYED_FALSE_START);
  const timed = analyzeCounterfactualStory(grid, trace, { ...FULL, maxElapsedMs: 0 }, { now: () => 0 });
  assert.ok(timed.probes.length > 0);
  assert.ok(timed.probes.every((probe) => probe.stopReason === "time-budget" && probe.outcome === "unknown"));
  const controller = new AbortController();
  controller.abort();
  const aborted = analyzeCounterfactualStory(grid, trace, FULL, { signal: controller.signal });
  assert.ok(aborted.probes.every((probe) => probe.stopReason === "aborted" && probe.outcome === "unknown"));
});

test("counterfactual analysis is deterministic, serializable, immutable and bounded in probe count", () => {
  const first = analyze(DELAYED_FALSE_START, { maxProbes: 5 });
  assert.deepEqual(first, analyze(DELAYED_FALSE_START, { maxProbes: 5 }));
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(first.probes.length, 5);
  assert.equal(first.omittedProbes, first.eligibleProbes - 5);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.probes));
  const disabled = analyze(DELAYED_FALSE_START, { maxProbes: 0 });
  assert.equal(disabled.probes.length, 0);
  assert.equal(disabled.expandedStates, 0);
});

test("counterfactual analysis refuses stale/unsolved evidence and invalid budgets", () => {
  const { grid, trace } = fixtureTrace(DELAYED_FALSE_START);
  assert.throws(() => analyzeCounterfactualStory(grid, { ...trace, solved: false }), /solved trace/);
  assert.throws(() => analyzeCounterfactualStory(grid, { ...trace, boardHash: "stale" }), /exact final board/);
  for (const budget of [{ maxProbes: NaN }, { maxTotalStates: -1 },
    { maxStatesPerProbe: 1.5 }, { minDelayedPushes: 1 }, { maxElapsedMs: Infinity }]) {
    assert.throws(() => analyzeCounterfactualStory(grid, trace, budget), /budget|at least two/);
  }
});
