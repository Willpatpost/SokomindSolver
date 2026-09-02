import assert from "node:assert/strict";
import test from "node:test";

import type { PuzzleDefinition } from "../../src/core/model.ts";
import {
  analyzePassiveSolutionStory,
  explainPassiveStory,
  summarizePassiveStory,
} from "../../src/features/generator/v2/passive-story-analysis.ts";
import { evaluatePuzzleWithSteps } from "../../src/features/generator/v2/puzzle-evaluator.ts";
import {
  buildCanonicalSolutionTrace,
  type CanonicalSolutionTrace,
} from "../../src/features/generator/v2/solution-trace.ts";
import type { SolutionStep } from "../../src/solver/contracts.ts";

function traceFor(
  id: string,
  rows: readonly string[],
  steps: readonly SolutionStep[],
): CanonicalSolutionTrace {
  const result = buildCanonicalSolutionTrace(
    rows.map((row) => [...row]),
    steps,
    { puzzleId: id, requireSolved: true },
  );
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  return result.trace;
}

function analyze(
  id: string,
  rows: readonly string[],
  steps: readonly SolutionStep[],
) {
  const grid = rows.map((row) => [...row]);
  return analyzePassiveSolutionStory(grid, traceFor(id, rows, steps));
}

test("straight one-box solution is a near miss for passive story signals", () => {
  const rows = ["OOOOOO", "ORX SO", "OOOOOO"];
  const steps: SolutionStep[] = [
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
  ];
  const story = analyze("straight", rows, steps);

  assert.equal(story.genericGoalMisdirection.misdirectedBoxCount, 0);
  assert.equal(story.progressReversals.reversalCount, 0);
  assert.equal(story.multiRoomJourneys.journeyBoxCount, 0);
  assert.equal(story.goalRoomPacking.eligibleRoomCount, 0);
  assert.equal(story.gateTraffic.gateStoryCount, 0);
  assert.equal(story.mixedBoxInteraction.crossTypeSwitchCount, 0);
  assert.equal(story.solutionPhases.phaseCount, 1);
});

test("detects path-aware generic-goal assignment misdirection", () => {
  const rows = [
    "OOOOOOOO",
    "ORX   SO",
    "O X S  O",
    "O      O",
    "OOOOOOOO",
  ];
  const steps: SolutionStep[] = [
    { direction: "down", kind: "walk" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "down", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "up", kind: "walk" },
    { direction: "up", kind: "walk" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
  ];
  const story = analyze("misdirection", rows, steps);

  assert.equal(story.genericGoalMisdirection.eligibleBoxCount, 2);
  assert.equal(story.genericGoalMisdirection.misdirectedBoxCount, 1);
  assert.equal(story.genericGoalMisdirection.evidence[0].boxId, 0);
  assert.equal(story.genericGoalMisdirection.evidence[0].actualGoalRank, 2);
  assert.ok(story.genericGoalMisdirection.totalExcessDistance > 0);
});

test("requires displacement, another box's benefit, and recovery for reversals", () => {
  const rows = [
    "OOOOOOOOOOO",
    "O         O",
    "O  XRX S  O",
    "O     S   O",
    "O         O",
    "OOOOOOOOOOO",
  ];
  const steps: SolutionStep[] = [
    { direction: "left", kind: "push" },
    { direction: "right", kind: "walk" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "down", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "up", kind: "walk" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "up", kind: "walk" },
    { direction: "right", kind: "walk" },
    { direction: "down", kind: "push" },
  ];
  const story = analyze("reversal", rows, steps);

  assert.equal(story.progressReversals.reversalCount, 1);
  assert.equal(story.progressReversals.evidence[0].boxId, 0);
  assert.deepEqual(story.progressReversals.evidence[0].benefitingBoxIds, [1]);
  assert.ok(
    story.progressReversals.evidence[0].recoveryPushIndex >
      story.progressReversals.evidence[0].reversalPushIndex,
  );
  assert.equal(story.solutionPhases.phaseCount, 3);
  assert.equal(story.solutionPhases.boxRevisitPhaseCount, 1);
  assert.equal(story.solutionPhases.phases[2].revisitsBox, true);
});

test("does not call an unproductive one-box detour a story reversal", () => {
  const rows = [
    "OOOOOOOOO",
    "O       O",
    "O  XR S O",
    "O       O",
    "OOOOOOOOO",
  ];
  const steps: SolutionStep[] = [
    { direction: "left", kind: "push" },
    { direction: "down", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "up", kind: "walk" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
  ];
  const story = analyze("unproductive-detour", rows, steps);

  assert.equal(story.progressReversals.reversalCount, 0);
});

test("detects multi-room transport, ordered packing, and doorway gate traffic", () => {
  const rows = [
    "OOOOOOOOOOO",
    "O   O     O",
    "O X RX  SSO",
    "O   O     O",
    "OOOOOOOOOOO",
  ];
  const steps: SolutionStep[] = [
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "up", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "down", kind: "walk" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
  ];
  const story = analyze("rooms-and-gate", rows, steps);

  assert.equal(story.multiRoomJourneys.journeyBoxCount, 1);
  assert.deepEqual(story.multiRoomJourneys.evidence[0].roomIds, ["room-0", "room-1"]);
  assert.equal(story.goalRoomPacking.eligibleRoomCount, 1);
  assert.equal(story.goalRoomPacking.orderedPairs, 1);
  assert.equal(story.goalRoomPacking.violatedPairs, 0);
  assert.equal(story.gateTraffic.gateStoryCount, 1);
  assert.deepEqual(story.gateTraffic.evidence[0].trafficBoxIds, [0]);
  assert.ok(story.structuralIdentity.doorwayCount > 0);
  assert.ok(story.structuralIdentity.crossZonePushCount > 0);
  assert.notEqual(story.structuralIdentity.traversalSignature, "");
});

test("reports typed/generic interleaving and concrete shared cells", () => {
  const rows = [
    "OOOOOOOOOO",
    "O R X aS O",
    "O   A    O",
    "O        O",
    "OOOOOOOOOO",
  ];
  const steps: SolutionStep[] = [
    { direction: "right", kind: "walk" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
    { direction: "down", kind: "walk" },
    { direction: "down", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "left", kind: "walk" },
    { direction: "up", kind: "push" },
    { direction: "left", kind: "walk" },
    { direction: "up", kind: "walk" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
  ];
  const story = analyze("mixed", rows, steps);

  assert.equal(story.mixedBoxInteraction.crossTypeSwitchCount, 1);
  assert.deepEqual(story.mixedBoxInteraction.switchEvidence, [{
    pushIndex: 3,
    fromBoxId: 0,
    toBoxId: 1,
  }]);
  assert.ok(story.mixedBoxInteraction.crossTypeSharedRouteCells >= 3);
  assert.ok(story.mixedBoxInteraction.sharedCellEvidence.some((cell) =>
    cell.role === "route" && cell.boxIds.length === 2));
  const summary = summarizePassiveStory(story);
  assert.equal(summary.crossTypeSwitches, 1);
  assert.ok(explainPassiveStory(story).some((line) => line.includes("Typed and generic")));
});

test("rejects a board that does not match the trace identity", () => {
  const rows = ["OOOOOO", "ORX SO", "OOOOOO"];
  const steps: SolutionStep[] = [
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
  ];
  const trace = traceFor("identity", rows, steps);
  const changed = rows.map((row) => [...row]);
  changed[1][3] = "O";

  assert.throws(
    () => analyzePassiveSolutionStory(changed, trace),
    /board hash does not match/,
  );
});

test("evaluation exposes passive evidence without adding it to difficulty metrics", async () => {
  const puzzle: PuzzleDefinition = {
    id: "passive-evaluator",
    title: "Passive Evaluator",
    difficulty: "beginner",
    boxes: 1,
    rows: ["OOOOO", "O R O", "O X O", "O S O", "OOOOO"],
  };
  const result = await evaluatePuzzleWithSteps(puzzle);

  assert.equal(result.vector.solved, true);
  assert.equal(result.passiveStory?.puzzleId, puzzle.id);
  assert.equal(result.passiveStory?.solved, true);
  assert.equal("passiveStory" in result.vector, false);
});
