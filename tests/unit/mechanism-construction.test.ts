import assert from "node:assert/strict";
import test from "node:test";

import type { PuzzleDefinition } from "../../src/core/model.ts";
import type { SolutionStep, SolverSolution } from "../../src/solver/contracts.ts";
import { createRng } from "../../src/features/generator/board-template.ts";
import {
  assignPartialLabels,
  buildHybridTypingConstructionPlan,
  VALID_LABELS,
} from "../../src/features/generator/label-assignment.ts";
import {
  analyzePassiveSolutionStory,
  assignRoomRoles,
  buildCanonicalSolutionTrace,
  buildMechanismConstructionPlan,
  createMechanismPlan,
  DEFAULT_BLUEPRINT_PARAMS,
  generateBlueprintWithRetry,
  placeGoalsFromPlan,
  verifyMechanismConstruction,
  type CanonicalSolutionTrace,
  type ConstructedStoryEvidenceKind,
  type GoalCell,
  type MechanismConstructionPlan,
} from "../../src/features/generator/v2/index.ts";

function canonical(
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

function constructionForGoals(
  trace: CanonicalSolutionTrace,
  goalIndices: readonly number[],
  requiredEvidence: readonly ConstructedStoryEvidenceKind[],
  options: { minPerKind?: number; requireCrossType?: boolean } = {},
): MechanismConstructionPlan {
  const goals = goalIndices.map((index) => {
    const goal = trace.goals[index];
    assert.ok(goal);
    return {
      goalIndex: index,
      goalId: goal.id,
      position: goal.position,
      roomId: index,
      depthFromDoorway: index,
      role: "test-target",
    };
  });
  return {
    seed: 1,
    tier: "advanced",
    boxCount: trace.boxes.length,
    minGenericBoxes: options.minPerKind ?? 0,
    minTypedBoxes: options.minPerKind ?? 0,
    crossTypeInteractionRequired: options.requireCrossType ?? false,
    targets: [{
      id: "mechanism-0",
      mechanismIndex: 0,
      type: "corridor-traffic",
      directive: "shared-passage",
      roomIds: [0, 1],
      goals,
      requiredEvidence,
      dependsOnTargetIds: [],
    }],
  };
}

const roomRows = [
  "OOOOOOOOOOO",
  "O   O     O",
  "O X RX  SSO",
  "O   O     O",
  "OOOOOOOOOOO",
];

const roomSteps: SolutionStep[] = [
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

test("mechanism construction preserves placed goal cells as explicit targets", () => {
  for (let seed = 100; seed < 260; seed++) {
    const blueprint = generateBlueprintWithRetry({
      ...DEFAULT_BLUEPRINT_PARAMS,
      seed,
      family: "linear",
      boardWidth: 14,
      boardHeight: 14,
    }, 30);
    if (!blueprint) continue;
    const functional = assignRoomRoles(blueprint, seed, 4);
    const plan = createMechanismPlan(functional, "advanced", 4, seed, ["packing-chain"]);
    if (!plan) continue;
    const placement = placeGoalsFromPlan(functional, plan);
    if (!placement) continue;

    const construction = buildMechanismConstructionPlan(placement);
    assert.equal(construction.targets.length, 1);
    assert.equal(construction.targets[0].directive, "ordered-goal-depth");
    assert.deepEqual(construction.targets[0].requiredEvidence, [
      "ordered-packing",
      "cross-type-interaction",
    ]);
    assert.equal(construction.targets[0].goals.length, 4);
    assert.equal(construction.minGenericBoxes, 2);
    assert.equal(construction.minTypedBoxes, 2);
    for (const target of construction.targets[0].goals) {
      const placedGoal: GoalCell = placement.solved.goals[target.goalIndex];
      assert.deepEqual(target.position, {
        row: placedGoal.row,
        column: placedGoal.column,
      });
    }
    return;
  }
  assert.fail("could not construct a packing-chain placement");
});

test("mechanism verification requires evidence localized to its target boxes", () => {
  const trace = canonical("localized-mechanism", roomRows, roomSteps);
  const story = analyzePassiveSolutionStory(roomRows.map((row) => [...row]), trace);

  const allGoals = constructionForGoals(trace, [0, 1], ["multi-room-journey"]);
  const realized = verifyMechanismConstruction(allGoals, trace, story);
  assert.equal(realized.passed, true);
  assert.equal(realized.realizedTargetCount, 1);
  assert.equal(realized.targetResults[0].evidence[0].boxIds.length, 1);

  const journeyBoxId = story.multiRoomJourneys.evidence[0].boxId;
  const stationaryGoalIndex = trace.goals.findIndex((goal) =>
    trace.boxes.find((box) => box.finalGoalId === goal.id)?.id !== journeyBoxId);
  assert.ok(stationaryGoalIndex >= 0);
  const wrongGoal = constructionForGoals(
    trace,
    [stationaryGoalIndex],
    ["multi-room-journey"],
  );
  const missing = verifyMechanismConstruction(wrongGoal, trace, story);
  assert.equal(missing.passed, false);
  assert.deepEqual(missing.targetResults[0].missingEvidence, ["multi-room-journey"]);
});

test("cross-type construction requires concrete shared-work evidence", () => {
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
  const trace = canonical("cross-type-construction", rows, steps);
  const story = analyzePassiveSolutionStory(rows.map((row) => [...row]), trace);
  const construction = constructionForGoals(
    trace,
    [0, 1],
    ["cross-type-interaction"],
    { minPerKind: 1, requireCrossType: true },
  );

  const verification = verifyMechanismConstruction(construction, trace, story);
  assert.equal(verification.passed, true);
  assert.equal(verification.genericBoxCount, 1);
  assert.equal(verification.typedBoxCount, 1);
  assert.equal(verification.crossTypeInteractionSatisfied, true);
  assert.equal(verification.targetResults[0].evidence[0].kind, "cross-type-interaction");
});

test("hybrid typing constructs two of each kind outside beginner and cuts interactions", () => {
  const puzzle: PuzzleDefinition = {
    id: "four-box-typing",
    title: "Four Box Typing",
    difficulty: "intermediate",
    boxes: 4,
    rows: [
      "OOOOOOOOOOO",
      "O R       O",
      "O X X X X O",
      "O S S S S O",
      "O         O",
      "OOOOOOOOOOO",
    ],
  };
  const steps: SolutionStep[] = [
    { direction: "down", kind: "push" },
    { direction: "up", kind: "walk" },
    { direction: "right", kind: "walk" },
    { direction: "right", kind: "walk" },
    { direction: "down", kind: "push" },
    { direction: "up", kind: "walk" },
    { direction: "right", kind: "walk" },
    { direction: "right", kind: "walk" },
    { direction: "down", kind: "push" },
    { direction: "up", kind: "walk" },
    { direction: "right", kind: "walk" },
    { direction: "right", kind: "walk" },
    { direction: "down", kind: "push" },
  ];
  const solution: SolverSolution = {
    steps,
    moves: steps.length,
    pushes: 4,
    objective: { kind: "moves" },
    objectiveScore: steps.length,
    optimality: "proven",
  };

  const construction = buildHybridTypingConstructionPlan(
    puzzle,
    steps,
    createRng(44),
    0.5,
  );
  assert.ok(construction);
  assert.equal(construction.minPerKind, 2);
  assert.equal(construction.typedCount, 2);
  assert.equal(construction.genericCount, 2);
  assert.equal(construction.typedBoxIndices.size, 2);
  assert.equal(construction.genericBoxIndices.size, 2);
  assert.ok(construction.interactionEdges.some((edge) =>
    edge.kinds.includes("push-switch")));
  assert.ok(construction.interactionCutWeight > 0);

  const labeled = assignPartialLabels(puzzle, solution, createRng(44), 0.5);
  const contents = labeled.rows.join("");
  const typedLabels = [...contents].filter((character) =>
    (VALID_LABELS as readonly string[]).includes(character));
  assert.equal((contents.match(/X/g) ?? []).length, 2);
  assert.equal(typedLabels.length, 2);
  canonical("four-box-labeled", labeled.rows, steps);
});
