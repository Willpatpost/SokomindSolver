import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession, move } from "../../src/core/game-session.ts";
import type { Direction } from "../../src/core/model.ts";
import { analyzePassiveSolutionStory, summarizePassiveStory } from "../../src/features/generator/v2/passive-story-analysis.ts";
import { buildCanonicalSolutionTrace } from "../../src/features/generator/v2/solution-trace.ts";
import {
  verifyMechanismConstruction,
  type ConstructedStoryEvidenceKind,
  type MechanismConstructionDirective,
  type MechanismConstructionPlan,
  type MechanismType,
} from "../../src/features/generator/v2/index.ts";
import type { SolutionStep } from "../../src/solver/contracts.ts";
import {
  GRAND_HALL_CALIBRATION_COUNTS,
  GRAND_HALL_CALIBRATION_ROUTE,
} from "../fixtures/generator/solution-story-routes.ts";

const REQUIRED_FEATURES = new Set([
  "generic-goal-misdirection",
  "temporary-progress-reversal",
  "multi-room-journey",
  "goal-room-packing",
  "gate-key-box",
  "interleaved-box-classes",
  "distinct-solution-phases",
  "controlled-false-start",
  "recovery-optionality",
  "visual-identity",
]);

interface CalibrationFeature {
  readonly id: string;
  readonly positivePuzzleIds: readonly string[];
  readonly nearMissPuzzleIds: readonly string[];
}

interface CalibrationFixture {
  readonly schemaVersion: number;
  readonly features: readonly CalibrationFeature[];
}

test("solution-story calibration covers every planned feature with retained puzzles", () => {
  const path = join(
    import.meta.dirname!,
    "../fixtures/generator/solution-story-calibration.json",
  );
  const fixture = JSON.parse(readFileSync(path, "utf-8")) as CalibrationFixture;

  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(new Set(fixture.features.map(({ id }) => id)), REQUIRED_FEATURES);

  for (const feature of fixture.features) {
    assert.ok(feature.positivePuzzleIds.length > 0, `${feature.id} needs positive calibration`);
    assert.ok(feature.nearMissPuzzleIds.length > 0, `${feature.id} needs near-miss calibration`);
    const positiveIds = new Set(feature.positivePuzzleIds);
    for (const id of [...feature.positivePuzzleIds, ...feature.nearMissPuzzleIds]) {
      assert.ok(PUZZLE_BY_ID[id], `${feature.id} references removed puzzle ${id}`);
      assert.ok(!id.startsWith("gen-"), `${feature.id} must use a retained original`);
    }
    for (const id of feature.nearMissPuzzleIds) {
      assert.ok(!positiveIds.has(id), `${feature.id} uses ${id} as both positive and near-miss`);
    }
  }

  const misdirection = fixture.features.find(({ id }) => id === "generic-goal-misdirection");
  assert.deepEqual(misdirection?.positivePuzzleIds, ["huge"]);
});

test("Grand Hall calibration is replay-valid and demonstrates its claimed story", () => {
  const puzzle = PUZZLE_BY_ID.huge;
  assert.ok(puzzle);
  const directions: Readonly<Record<string, Direction>> = {
    U: "up", D: "down", L: "left", R: "right",
  };
  let session = createSession(puzzle);
  const steps: SolutionStep[] = [];
  for (const symbol of GRAND_HALL_CALIBRATION_ROUTE) {
    const direction = directions[symbol];
    assert.ok(direction, `invalid route symbol ${symbol}`);
    const next = move(session, direction);
    assert.notEqual(next, session, `blocked calibration move ${steps.length}`);
    steps.push({ direction, kind: next.pushes > session.pushes ? "push" : "walk" });
    session = next;
  }
  assert.equal(session.solved, true);
  assert.equal(session.moves, GRAND_HALL_CALIBRATION_COUNTS.moves);
  assert.equal(session.pushes, GRAND_HALL_CALIBRATION_COUNTS.pushes);

  const trace = buildCanonicalSolutionTrace(
    puzzle.rows.map((row) => [...row]),
    steps,
    { puzzleId: puzzle.id, requireSolved: true },
  );
  assert.equal(trace.ok, true, trace.ok ? undefined : trace.error.message);
  const story = analyzePassiveSolutionStory(
    puzzle.rows.map((row) => [...row]),
    trace.trace,
  );
  assert.deepEqual(summarizePassiveStory(story), {
    assignmentMisdirections: 5,
    reversalEpisodes: 3,
    multiRoomJourneys: 10,
    orderedPackingPairs: 33,
    gateTransitions: 9,
    gateReopenings: 0,
    crossTypeDependencies: 155,
    crossTypeSwitches: 24,
    solutionPhases: 38,
    revisitedPhases: 21,
    usedZones: 5,
    crossZonePushes: 32,
    traversalSignature: "room-1>doorway-0|doorway-0>room-0|corridor-1>room-0|room-0>corridor-0|room-0>corridor-1|room-0>doorway-0|doorway-0>room-1",
  });

  const construction = (
    type: MechanismType,
    directive: MechanismConstructionDirective,
    goalIds: readonly string[],
    requiredEvidence: readonly ConstructedStoryEvidenceKind[],
  ): MechanismConstructionPlan => ({
    seed: 1,
    tier: "expert",
    boxCount: trace.trace.boxes.length,
    minGenericBoxes: 2,
    minTypedBoxes: 2,
    crossTypeInteractionRequired: true,
    targets: [{
      id: "mechanism-0",
      mechanismIndex: 0,
      type,
      directive,
      roomIds: [0, 1],
      goals: goalIds.map((goalId) => {
        const goalIndex = trace.trace.goals.findIndex((goal) => goal.id === goalId);
        const goal = trace.trace.goals[goalIndex];
        assert.ok(goal);
        return {
          goalIndex,
          goalId,
          position: goal.position,
          roomId: goal.zoneId === "room-1" ? 1 : 0,
          depthFromDoorway: 0,
          role: "calibration",
        };
      }),
      requiredEvidence,
      dependsOnTargetIds: [],
    }],
  });

  const cases = [
    construction(
      "assignment-misdirection",
      "misdirected-assignment",
      ["goal-2", "goal-6"],
      ["assignment-misdirection", "multi-room-journey", "cross-type-interaction"],
    ),
    construction(
      "support-square-contention",
      "shared-support-contention",
      ["goal-2", "goal-6"],
      ["support-contention", "box-revisit", "cross-type-interaction"],
    ),
    construction(
      "multi-chain-merge",
      "converging-chains",
      ["goal-2", "goal-6", "goal-14", "goal-15"],
      ["multi-chain-merge", "ordered-packing", "cross-type-interaction"],
    ),
  ];
  for (const planned of cases) {
    const verification = verifyMechanismConstruction(planned, trace.trace, story);
    assert.equal(verification.passed, true, `${planned.targets[0].type} should verify on Grand Hall`);
  }
});
