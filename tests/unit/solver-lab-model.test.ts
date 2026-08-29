import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SolverMetadata, SolverProgress, SolverResult } from "../../src/solver/contracts.ts";
import {
  algorithmLesson,
  buildSearchPopulation,
  compareSolverLabRuns,
  solutionActionLog,
  type SolverLabRunRecord,
} from "../../src/features/solver-lab/solver-lab-model.ts";

const solved: SolverResult = Object.freeze({
  status: "solved",
  solution: Object.freeze({
    steps: Object.freeze([
      Object.freeze({ direction: "right" as const, kind: "walk" as const }),
      Object.freeze({ direction: "down" as const, kind: "push" as const }),
    ]),
    moves: 2,
    pushes: 1,
    objective: Object.freeze({ kind: "moves" as const }),
    objectiveScore: 2,
    optimality: "proven" as const,
  }),
  metrics: Object.freeze({
    elapsedMs: 20,
    expandedStates: 8,
    generatedStates: 13,
    peakFrontierSize: 5,
    counters: Object.freeze({
      uniqueStates: 11,
      deadlockPrunes: 2,
      infeasiblePrunes: 1,
      estimatedMemoryBytes: 1_024,
    }),
  }),
});

function record(
  id: string,
  result: SolverResult,
  overrides: Partial<SolverLabRunRecord["configuration"]> = {},
): SolverLabRunRecord {
  return Object.freeze({
    id,
    puzzleId: "first",
    actionLog: "",
    capturedAt: "2026-08-29T12:00:00.000Z",
    configuration: Object.freeze({
      solverId: "classic-astar",
      solverName: "A* Search",
      mode: "fast" as const,
      timeLimitMs: 60_000,
      memoryLimitMiB: 0,
      ...overrides,
    }),
    result,
    verifiedActionLog: "RD",
  });
}

describe("Solver Lab search populations", () => {
  test("uses documented generated, expanded, queued, and pruned counters", () => {
    const progress: SolverProgress = {
      phase: "searching",
      elapsedMs: 10,
      expandedStates: 5,
      generatedStates: 9,
      frontierSize: 4,
      counters: { deadlockPrunes: 1, infeasiblePrunes: 2 },
    };
    assert.deepEqual(
      buildSearchPopulation(progress, null).map(({ id, value }) => [id, value]),
      [["generated", 9], ["visited", 5], ["frontier", 4], ["pruned", 3]],
    );
  });

  test("terminal metrics replace live values without inventing a frontier", () => {
    assert.deepEqual(
      buildSearchPopulation(null, solved).map(({ id, value }) => [id, value]),
      [["generated", 13], ["visited", 8], ["frontier", 0], ["pruned", 3]],
    );
  });
});

test("solutionActionLog preserves verified solution directions", () => {
  assert.equal(solutionActionLog(solved), "RD");
  assert.equal(solutionActionLog({ status: "cancelled", metrics: { elapsedMs: 4 } }), undefined);
});

test("run comparison reports input, limit, and signed metric differences", () => {
  const slower: SolverResult = {
    ...solved,
    solution: { ...solved.solution, moves: 3, objectiveScore: 3 },
    metrics: { ...solved.metrics, elapsedMs: 30, expandedStates: 12, generatedStates: 20 },
  };
  assert.deepEqual(compareSolverLabRuns(record("left", slower), record("right", solved)), {
    sameInput: true,
    sameLimits: true,
    elapsedDeltaMs: 10,
    expandedDelta: 4,
    generatedDelta: 7,
    moveDelta: 1,
    pushDelta: 0,
  });
  assert.equal(
    compareSolverLabRuns(record("left", slower, { timeLimitMs: 5_000 }), record("right", solved)).sameLimits,
    false,
  );
});

test("run comparison ignores inactive modes for classic algorithms", () => {
  const primary = record("left", solved, { solverId: "classic-astar", mode: "fast" });
  const reference = record("right", solved, { solverId: "classic-dfs", mode: "optimal" });

  assert.equal(compareSolverLabRuns(primary, reference).sameLimits, true);
});

test("algorithm lessons disclose strategy, heuristic, and guarantee", () => {
  const metadata = {
    id: "classic-astar",
    displayName: "A* Search",
    description: "Exact search",
    version: "1",
    capabilities: {
      executionTargets: ["web-worker"],
      runtime: "javascript",
      objectives: ["moves"],
      quality: "optimal",
      labeledBoxes: true,
      genericBoxes: true,
      partialState: true,
      reportsProgress: true,
      cooperativeCancellation: true,
      deterministic: true,
    },
  } satisfies SolverMetadata;
  const lesson = algorithmLesson(metadata);
  assert.match(lesson.strategy, /exact moves already spent/i);
  assert.match(lesson.heuristic, /reverse-push assignment/i);
  assert.match(lesson.guarantee, /minimum total-move route/i);
});
