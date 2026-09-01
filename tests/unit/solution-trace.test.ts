import assert from "node:assert/strict";
import test from "node:test";

import { boardHash } from "../../src/features/generator/v2/puzzle-identity.ts";
import {
  buildCanonicalSolutionTrace,
  type CanonicalSolutionTrace,
  type TraceBuildErrorCode,
} from "../../src/features/generator/v2/solution-trace.ts";
import {
  analyzeInteraction,
  analyzeInteractionFromTrace,
} from "../../src/features/generator/v2/interaction-analysis.ts";
import {
  analyzeSolutionDepth,
  analyzeSolutionDepthFromTrace,
} from "../../src/features/generator/v2/solution-depth-analysis.ts";
import type { SolutionStep } from "../../src/solver/contracts.ts";

const mixedRows = [
  "OOOOOOOOO",
  "ORX S   O",
  "O       O",
  "O A a   O",
  "O       O",
  "OOOOOOOOO",
] as const;

const mixedSteps: readonly SolutionStep[] = [
  { direction: "right", kind: "push" },
  { direction: "right", kind: "push" },
  { direction: "down", kind: "walk" },
  { direction: "left", kind: "walk" },
  { direction: "left", kind: "walk" },
  { direction: "down", kind: "walk" },
  { direction: "right", kind: "push" },
  { direction: "right", kind: "push" },
];

function buildTrace(
  rows: readonly string[] = mixedRows,
  steps: readonly SolutionStep[] = mixedSteps,
): CanonicalSolutionTrace {
  const result = buildCanonicalSolutionTrace(
    rows.map((row) => [...row]),
    steps,
    { puzzleId: "mixed-fixture", requireSolved: true },
  );
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  return result.trace;
}

function assertError(
  rows: readonly string[],
  steps: readonly SolutionStep[],
  code: TraceBuildErrorCode,
  requireSolved = false,
): void {
  const result = buildCanonicalSolutionTrace(
    rows.map((row) => [...row]),
    steps,
    { requireSolved },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, code);
}

test("builds a deterministic replay-valid trace from exact final rows", () => {
  const trace = buildTrace();
  const repeated = buildTrace();

  assert.deepEqual(trace, repeated);
  assert.equal(trace.puzzleId, "mixed-fixture");
  assert.equal(trace.boardHash, boardHash(mixedRows));
  assert.equal(trace.solved, true);
  assert.equal(trace.steps.length, mixedSteps.length);
  assert.equal(trace.pushes.length, 4);
  assert.equal(trace.phases.length, 0);
  assert.ok(Object.isFrozen(trace));
  assert.ok(Object.isFrozen(trace.pushes));
});

test("retains row-major box identities, kinds, labels, and final goal pairing", () => {
  const trace = buildTrace();

  assert.deepEqual(
    trace.boxes.map((box) => ({
      id: box.id,
      kind: box.kind,
      label: box.label,
      pushes: box.pushCount,
      goal: box.finalGoalId,
    })),
    [
      { id: 0, kind: "generic", label: undefined, pushes: 2, goal: "goal-0" },
      { id: 1, kind: "typed", label: "A", pushes: 2, goal: "goal-1" },
    ],
  );
  assert.deepEqual(trace.pushes.map((push) => push.boxId), [0, 0, 1, 1]);
  assert.deepEqual(trace.goals.map((goal) => goal.id), ["goal-0", "goal-1"]);
  assert.equal(trace.goals[0].kind, "generic");
  assert.equal(trace.goals[1].kind, "typed");
  assert.equal(trace.goals[1].label, "a");
});

test("records canonical push evidence before and after every push", () => {
  const push = buildTrace().pushes[0];

  assert.equal(push.stepIndex, 0);
  assert.equal(push.pushIndex, 0);
  assert.deepEqual(push.keeperSupport, { row: 1, column: 1 });
  assert.deepEqual(push.from, { row: 1, column: 2 });
  assert.deepEqual(push.to, { row: 1, column: 3 });
  assert.match(push.fromZoneId, /^(room|corridor|doorway)-\d+$/);
  assert.match(push.toZoneId, /^(room|corridor|doorway)-\d+$/);
  assert.match(push.keeperRegionBefore, /^keeper-\d+-[0-9a-f]{8}$/);
  assert.match(push.keeperRegionAfter, /^keeper-\d+-[0-9a-f]{8}$/);
  assert.equal(push.reachableRegionBefore, push.keeperRegionBefore);
  assert.equal(push.reachableRegionAfter, push.keeperRegionAfter);
  assert.equal(push.goalBefore, push.fromGoalId);
  assert.equal(push.goalAfter, push.toGoalId);
  assert.ok(push.keeperReachableBefore > 0);
  assert.ok(push.keeperReachableAfter > 0);
  assert.deepEqual(
    push.enabledBoxIds,
    [...new Set(push.enabledPushes.map((option) => option.boxId))].sort(),
  );
  assert.deepEqual(
    push.disabledBoxIds,
    [...new Set(push.disabledPushes.map((option) => option.boxId))].sort(),
  );
});

test("strict replay rejects malformed boards and invalid routes", () => {
  assertError([], [], "empty-grid");
  assertError(["OOOO", "OR O", "OOO"], [], "ragged-grid");
  assertError(["OOO", "O O", "OOO"], [], "missing-robot");
  assertError(["OOOO", "ORRO", "OOOO"], [], "multiple-robots");
  assertError(["OOO", "ORO", "OOO"], [{ direction: "right", kind: "walk" }], "blocked-step");
  assertError(["OOOOO", "OR  O", "OOOOO"], [{ direction: "right", kind: "push" }], "step-kind-mismatch");
  assertError(["OOOOO", "ORX O", "OOOOO"], [{ direction: "right", kind: "walk" }], "step-kind-mismatch");
  assertError(["OOOO", "ORXO", "OOOO"], [{ direction: "right", kind: "push" }], "blocked-step");
  assertError(["OOOOOO", "ORX SO", "OOOOOO"], [{ direction: "right", kind: "push" }], "unsolved-final-state", true);
});

test("typed boxes only solve on matching typed goals", () => {
  const rows = ["OOOOOO", "ORAb O", "OOOOOO"];
  assertError(
    rows,
    [{ direction: "right", kind: "push" }],
    "unsolved-final-state",
    true,
  );
});

test("trace-native analyzers consume the same stable push identities", () => {
  const trace = buildTrace();
  const grid = mixedRows.map((row) => [...row]);
  const interaction = analyzeInteractionFromTrace(trace, new Set());
  const depth = analyzeSolutionDepthFromTrace(trace);

  assert.deepEqual(
    interaction,
    analyzeInteraction(grid, mixedSteps, new Set(), trace.boardWidth),
  );
  assert.deepEqual(depth, analyzeSolutionDepth(grid, mixedSteps));
  assert.equal(interaction.inactiveBoxCount, 0);
  assert.equal(interaction.onePushBoxCount, 0);
  assert.equal(interaction.minPushesPerBox, 2);
  assert.equal(depth.distinctBoxesMoved, 2);
  assert.equal(depth.boxSwitchRate, 1 / 3);
});
