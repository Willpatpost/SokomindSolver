import assert from "node:assert/strict";
import test from "node:test";

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession, move } from "../../src/core/game-session.ts";
import type { Direction, PuzzleDefinition } from "../../src/core/model.ts";
import type { SolutionStep, SolverSolution } from "../../src/solver/contracts.ts";
import { createRng } from "../../src/features/generator/board-template.ts";
import {
  analyzePassiveSolutionStory,
  applyStoryAwareTyping,
  buildCanonicalSolutionTrace,
  verifyStoryAwareTyping,
  type MechanismConstructionPlan,
} from "../../src/features/generator/v2/index.ts";
import { GRAND_HALL_CALIBRATION_ROUTE } from "../fixtures/generator/solution-story-routes.ts";

function solution(steps: readonly SolutionStep[]): SolverSolution {
  return {
    steps,
    moves: steps.length,
    pushes: steps.filter((step) => step.kind === "push").length,
    objective: { kind: "moves" },
    objectiveScore: steps.length,
    optimality: "unknown",
  };
}

test("story-aware typing splits boxes across a real gate and packing relationship", () => {
  const puzzle: PuzzleDefinition = {
    id: "story-typing-gate",
    title: "Story Typing Gate",
    difficulty: "beginner",
    boxes: 2,
    rows: [
      "OOOOOOOOOOO",
      "O   O     O",
      "O X RX  SSO",
      "O   O     O",
      "OOOOOOOOOOO",
    ],
  };
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

  const result = applyStoryAwareTyping(puzzle, solution(steps), createRng(77), 0.5);
  assert.ok(result);
  assert.equal(result.plan.hybridPlan.typedCount, 1);
  assert.equal(result.plan.hybridPlan.genericCount, 1);
  assert.equal(result.plan.hybridPlan.constraintResults[0].satisfied, true);

  const traceResult = buildCanonicalSolutionTrace(
    result.puzzle.rows.map((row) => [...row]),
    steps,
    { puzzleId: result.puzzle.id, requireSolved: true },
  );
  assert.equal(traceResult.ok, true, traceResult.ok ? undefined : traceResult.error.message);
  const story = analyzePassiveSolutionStory(
    result.puzzle.rows.map((row) => [...row]),
    traceResult.trace,
  );
  const verification = verifyStoryAwareTyping(result.plan, traceResult.trace, story);
  assert.equal(verification.passed, true);
  assert.equal(verification.targets[0].strongInteractionSatisfied, true);
  assert.equal(story.goalRoomPacking.orderedPairs, 1);
});

test("story-aware typing rejects boxes that only happen to be in the same puzzle", () => {
  const puzzle: PuzzleDefinition = {
    id: "story-typing-independent",
    title: "Story Typing Independent",
    difficulty: "beginner",
    boxes: 2,
    rows: [
      "OOOOOOOOOOO",
      "O RXS O   O",
      "O     O   O",
      "O      X SO",
      "OOOOOOOOOOO",
    ],
  };
  const steps: SolutionStep[] = [
    { direction: "right", kind: "push" },
    { direction: "down", kind: "walk" },
    { direction: "down", kind: "walk" },
    { direction: "right", kind: "walk" },
    { direction: "right", kind: "walk" },
    { direction: "right", kind: "walk" },
    { direction: "right", kind: "push" },
    { direction: "right", kind: "push" },
  ];

  assert.equal(
    applyStoryAwareTyping(puzzle, solution(steps), createRng(91), 0.5),
    null,
  );
});

test("assignment-misdirection keeps the surprising box and a nearer alternative generic", () => {
  const original = PUZZLE_BY_ID.huge;
  assert.ok(original);
  const genericRows = original.rows.map((row) => [...row].map((character) => {
    if (/^[A-Z]$/.test(character) && !"ORSX".includes(character)) return "X";
    if (/^[a-z]$/.test(character)) return "S";
    return character;
  }).join(""));
  const puzzle: PuzzleDefinition = { ...original, id: "story-typing-misdirection", rows: genericRows };
  const directions: Readonly<Record<string, Direction>> = {
    U: "up", D: "down", L: "left", R: "right",
  };
  let session = createSession(puzzle);
  const steps: SolutionStep[] = [];
  for (const symbol of GRAND_HALL_CALIBRATION_ROUTE) {
    const next = move(session, directions[symbol]);
    assert.notEqual(next, session);
    steps.push({
      direction: directions[symbol],
      kind: next.pushes > session.pushes ? "push" : "walk",
    });
    session = next;
  }
  assert.equal(session.solved, true);
  const genericTrace = buildCanonicalSolutionTrace(
    puzzle.rows.map((row) => [...row]),
    steps,
    { puzzleId: puzzle.id, requireSolved: true },
  );
  assert.equal(genericTrace.ok, true, genericTrace.ok ? undefined : genericTrace.error.message);
  const genericStory = analyzePassiveSolutionStory(
    puzzle.rows.map((row) => [...row]),
    genericTrace.trace,
  );
  assert.ok(genericStory.genericGoalMisdirection.misdirectedBoxCount > 0);
  const construction: MechanismConstructionPlan = {
    seed: 12,
    tier: "expert",
    boxCount: genericTrace.trace.boxes.length,
    minGenericBoxes: 2,
    minTypedBoxes: 2,
    crossTypeInteractionRequired: true,
    targets: [{
      id: "mechanism-0",
      mechanismIndex: 0,
      type: "assignment-misdirection",
      directive: "misdirected-assignment",
      roomIds: [0],
      goals: genericTrace.trace.goals.map((goal, index) => ({
        goalIndex: index,
        goalId: goal.id,
        position: goal.position,
        roomId: index,
        depthFromDoorway: index,
        role: index === 0 ? "misdirection-anchor" : "misdirection-alternative",
      })),
      requiredEvidence: [
        "assignment-misdirection",
        "multi-room-journey",
        "cross-type-interaction",
      ],
      dependsOnTargetIds: [],
    }],
  };

  const result = applyStoryAwareTyping(
    puzzle,
    solution(steps),
    createRng(103),
    0.5,
    construction,
  );
  assert.ok(result);
  assert.ok(result.plan.hybridPlan.genericCount >= 2);
  assert.ok(result.plan.hybridPlan.typedCount >= 2);

  const typedTrace = buildCanonicalSolutionTrace(
    result.puzzle.rows.map((row) => [...row]),
    steps,
    { puzzleId: result.puzzle.id, requireSolved: true },
  );
  assert.equal(typedTrace.ok, true, typedTrace.ok ? undefined : typedTrace.error.message);
  const typedStory = analyzePassiveSolutionStory(
    result.puzzle.rows.map((row) => [...row]),
    typedTrace.trace,
  );
  const verification = verifyStoryAwareTyping(result.plan, typedTrace.trace, typedStory);
  assert.equal(verification.passed, true);
  assert.ok(typedStory.genericGoalMisdirection.misdirectedBoxCount > 0);
  assert.equal(verification.targets[1].assignmentAmbiguitySatisfied, true);
});
