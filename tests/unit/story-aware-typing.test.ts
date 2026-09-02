import assert from "node:assert/strict";
import test from "node:test";

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession, move } from "../../src/core/game-session.ts";
import type { Direction, PuzzleDefinition } from "../../src/core/model.ts";
import { DIRECTIONS } from "../../src/core/model.ts";
import { directionDelta } from "../../src/core/position.ts";
import { buildHybridTypingConstructionPlan } from "../../src/features/generator/label-assignment.ts";
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

function replay(puzzle: PuzzleDefinition, steps: readonly SolutionStep[], requireSolved = true) {
  const grid = puzzle.rows.map((row) => [...row]);
  const result = buildCanonicalSolutionTrace(grid, steps, { requireSolved, puzzleId: puzzle.id });
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  return { trace: result.trace, story: analyzePassiveSolutionStory(grid, result.trace) };
}

/** Find keeper walks between an explicitly authored sequence of box pushes. */
function routeForPushes(
  puzzle: PuzzleDefinition,
  pushes: readonly (readonly [number, Direction, number])[],
): SolverSolution {
  let session = createSession(puzzle);
  const steps: SolutionStep[] = [];
  const apply = (direction: Direction, kind: "walk" | "push") => {
    const next = move(session, direction);
    assert.notEqual(next, session, `blocked ${direction} at step ${steps.length}`);
    assert.equal(next.pushes - session.pushes, kind === "push" ? 1 : 0);
    steps.push({ direction, kind });
    session = next;
  };
  for (const [boxIndex, direction, count] of pushes) {
    for (let push = 0; push < count; push++) {
      const box = session.snapshot.boxes[boxIndex].position;
      const delta = directionDelta(direction);
      const support = { row: box.row - delta.row, column: box.column - delta.column };
      const occupied = new Set(session.snapshot.boxes.map(({ position }) =>
        `${position.row},${position.column}`));
      const queue = [{ ...session.snapshot.robot, path: [] as Direction[] }];
      const visited = new Set<string>();
      let path: Direction[] | undefined;
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const current = queue[cursor];
        if (current.row === support.row && current.column === support.column) {
          path = current.path;
          break;
        }
        for (const walkDirection of DIRECTIONS) {
          const walkDelta = directionDelta(walkDirection);
          const row = current.row + walkDelta.row;
          const column = current.column + walkDelta.column;
          const key = `${row},${column}`;
          if (visited.has(key) || occupied.has(key) ||
            puzzle.rows[row]?.[column] === undefined || puzzle.rows[row][column] === "O") continue;
          visited.add(key);
          queue.push({ row, column, path: [...current.path, walkDirection] });
        }
      }
      assert.ok(path, `unreachable support for box ${boxIndex} ${direction}`);
      for (const walkDirection of path) apply(walkDirection, "walk");
      apply(direction, "push");
    }
  }
  assert.equal(session.solved, true);
  return solution(steps);
}

const supportPuzzle: PuzzleDefinition = {
  id: "typing-shared-support", title: "Shared Support", difficulty: "beginner", boxes: 2,
  rows: ["OOOOOOOOOO", "O R X SS O", "O   X    O", "O        O", "OOOOOOOOOO"],
};

test("typing sees shared routes and support before any boxes have labels", () => {
  const witness = routeForPushes(supportPuzzle, [[0, "right", 3], [1, "up", 1], [1, "right", 2]]);
  const { trace, story } = replay(supportPuzzle, witness.steps);
  assert.equal(story.mixedBoxInteraction.sharedCellEvidence.length, 0);
  assert.equal(story.goalRoomPacking.orderedPairs, 0);
  assert.equal(story.gateTraffic.gateStoryCount, 0);
  assert.equal(story.progressReversals.reversalCount, 0);
  const construction: MechanismConstructionPlan = {
    seed: 44, tier: "beginner", boxCount: 2,
    minGenericBoxes: 1, minTypedBoxes: 1, crossTypeInteractionRequired: true,
    targets: [{
      id: "support", mechanismIndex: 0, type: "support-square-contention",
      directive: "shared-support-contention", roomIds: [0], dependsOnTargetIds: [],
      requiredEvidence: ["support-contention", "cross-type-interaction"],
      goals: trace.goals.map((goal, index) => ({
        goalIndex: index, goalId: goal.id, position: goal.position, roomId: 0,
        depthFromDoorway: 0, role: "shared-support",
      })),
    }],
  };
  const result = applyStoryAwareTyping(supportPuzzle, witness, createRng(44), 0.5, construction);
  assert.ok(result, "same-class interactions must be available to typing");
  assert.deepEqual(result, applyStoryAwareTyping(supportPuzzle, witness, createRng(44), 0.5, construction));
  const final = replay(result.puzzle, witness.steps);
  const verified = verifyStoryAwareTyping(result.plan, final.trace, final.story);
  assert.equal(verified.passed, true);
  assert.equal(verified.targets[1].supportContentionSatisfied, true);
  assert.ok(final.story.mixedBoxInteraction.crossTypeSharedSupportCells > 0);

  const stale = verifyStoryAwareTyping(result.plan, trace, story);
  assert.equal(stale.boardMatches, false);
  assert.equal(stale.passed, false);
  const unfinished = replay(result.puzzle, [], false);
  assert.equal(verifyStoryAwareTyping(result.plan, unfinished.trace, unfinished.story).passed, false);
  assert.equal(applyStoryAwareTyping(result.puzzle, witness, createRng(44), 0.5), null);
  assert.equal(applyStoryAwareTyping(supportPuzzle, witness, createRng(44), NaN), null);
});

test("final typing verification rebinds targets after generic boxes exchange goals", () => {
  const puzzle: PuzzleDefinition = {
    id: "typing-rebinding", title: "Rebinding", difficulty: "beginner", boxes: 3,
    rows: [
      "OOOOOOOOO", "O       O", "O RXXX  O", "O       O",
      "O  SSS  O", "O       O", "O       O", "OOOOOOOOO",
    ],
  };
  const witness = routeForPushes(puzzle, [[0, "down", 2], [1, "down", 2], [2, "down", 2]]);
  const result = applyStoryAwareTyping(puzzle, witness, createRng(22), 1 / 3);
  assert.ok(result);
  const [first, second] = [...result.plan.hybridPlan.genericBoxIndices].sort((a, b) => a - b);
  const [typed] = result.plan.hybridPlan.typedBoxIndices;
  const firstColumn = first + 3;
  const secondColumn = second + 3;
  const alternate = routeForPushes(result.puzzle, [
    [typed, "down", 2], [first, "down", 1], [first, "left", firstColumn - 2],
    [first, "down", 2], [first, "right", secondColumn - 2], [first, "up", 1],
    [second, "down", 1], [second, "left", secondColumn - firstColumn], [second, "down", 1],
  ]);
  const final = replay(result.puzzle, alternate.steps);
  const goalId = result.plan.boxGoalIds[first];
  assert.equal(final.trace.boxes[second].finalGoalId, goalId);
  const plan = {
    ...result.plan,
    targets: [...result.plan.targets, {
      targetId: "single-goal-rebinding", mechanismType: "global" as const,
      goalIds: [goalId], boxIds: [first], minTyped: 0, minGeneric: 1,
      requireStrongInteraction: false, genericWitnesses: [], oppositionRequirements: [],
    }],
  };
  const verified = verifyStoryAwareTyping(plan, final.trace, final.story);
  assert.equal(verified.passed, true);
  assert.deepEqual(verified.targets[1].targetBoxIds, [second]);
});

test("Master-size constrained typing is deterministic and keeps every group mixed", () => {
  const boxCount = 20;
  const width = boxCount * 3 + 3;
  const floor = `O${" ".repeat(width - 2)}O`;
  const pieces = (character: string) => [...floor].map((cell, column) =>
    column >= 2 && (column - 2) % 3 === 0 && column < width - 2 ? character : cell).join("");
  const puzzle: PuzzleDefinition = {
    id: "typing-master", title: "Master Typing", difficulty: "master", boxes: boxCount,
    rows: ["O".repeat(width), floor.replace(" ", "R"), pieces("X"), floor, pieces("S"), floor, "O".repeat(width)],
  };
  const witness = routeForPushes(puzzle, Array.from({ length: boxCount }, (_, index) => [index, "down", 2] as const));
  const groups = Array.from({ length: boxCount / 2 }, (_, index) => ({
    goalIndices: new Set([index * 2, index * 2 + 1]), minTyped: 1, minGeneric: 1,
  }));
  const plan = buildHybridTypingConstructionPlan(puzzle, witness.steps, createRng(5), 0.5, groups);
  assert.ok(plan);
  assert.equal(plan.typedCount, 10);
  assert.equal(plan.genericCount, 10);
  assert.ok(plan.constraintResults.every((result) => result.satisfied));
  assert.deepEqual(plan, buildHybridTypingConstructionPlan(puzzle, witness.steps, createRng(5), 0.5, groups));
});

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
