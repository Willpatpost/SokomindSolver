import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import {
  createSession,
  parsePuzzleRows,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import {
  solutionFromLegacyPath,
  toLegacyState,
} from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { runClassicSearch } from "../../src/solver/search/engine.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import { exactRemainingMoves } from "../support/exact-solver-oracle.ts";
import {
  TUNNEL_SOUNDNESS_BY_ID,
  type TunnelSoundnessFixture,
} from "../fixtures/solver-v2/tunnel-soundness.ts";

const MIXED_TYPED_PUZZLE: PuzzleDefinition = {
  id: "mixed-typed-engine",
  title: "Mixed typed engine",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOOOO",
    "O  R  O",
    "O A X O",
    "O a S O",
    "O     O",
    "OOOOOOO",
  ],
};

// es01 tunnel boards: move optima 16, 19, 22.
const ES01_TUNNEL_FIXTURES: readonly TunnelSoundnessFixture[] = [
  TUNNEL_SOUNDNESS_BY_ID.es01a,
  TUNNEL_SOUNDNESS_BY_ID.es01c,
  TUNNEL_SOUNDNESS_BY_ID.es01d,
];

function requestFromFixture(fixture: TunnelSoundnessFixture): SolverRequest {
  const board = parsePuzzleRows(fixture.rows);
  return {
    board,
    snapshot: {
      puzzleId: `engine-${fixture.id}`,
      robot: board.initialRobot,
      boxes: board.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
  };
}

function oracleMoves(fixture: TunnelSoundnessFixture): number | null {
  const parsed = parsePuzzleRows(fixture.rows);
  const board = compileSearchBoard(parsed);
  return exactRemainingMoves(
    board,
    board.cellAt(parsed.initialRobot.row, parsed.initialRobot.column),
    toDenseBoxes(board, parsed.initialBoxes),
  ).exactMoves;
}

function exactContext(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress() {},
    now: performance.now.bind(performance),
  };
}

function requestFor(puzzle: PuzzleDefinition): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
  };
}

describe("vendored Sokomind engine", () => {
  // globalThis.postMessage does not exist in Node.js, so t.mock.method()
  // cannot be used (it requires the property to already be a function).
  // Instead we use t.after() — the Node test runner's built-in cleanup hook —
  // which is resilient to mid-test crashes and avoids manual try/finally.
  beforeEach((t) => {
    const original = globalThis.postMessage;
    globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;
    if ("after" in t) {
      t.after(() => {
        if (original === undefined) {
          Reflect.deleteProperty(globalThis, "postMessage");
        } else {
          globalThis.postMessage = original;
        }
      });
    }
  });

  it("solves and replay-verifies a mixed generic/dedicated puzzle", () => {
    const request = requestFor(MIXED_TYPED_PUZZLE);
    const result = search({
      algorithm: "ultimate",
      state: toLegacyState(request),
      maxVisited: 20_000,
      beamWidth: 160,
      maxDepth: 80,
    });
    assert.equal(result.status, "solved");
    assert.ok(Array.isArray(result.path));
    const solution = solutionFromLegacyPath(request, result.path);
    assert.ok(solution);
    assert.equal(verifySolverSolution(request, solution).valid, true);
    assert.equal(solution.pushes, 2);
  });

  it("emits bounded structural-plan diagnostics only when requested", () => {
    const request = requestFor(MIXED_TYPED_PUZZLE);
    const payload = {
      algorithm: "plan-macro-beam",
      state: toLegacyState(request),
      maxVisited: 1_000,
      planBeamWidth: 16,
      planBoxBranches: 4,
      maxPlanSegments: 40,
      maxDepth: 80,
      planSolutionComparisonBudget: 0,
    } as const;
    const regular = search(payload);
    const traced = search({...payload, planDiagnostics: true});

    assert.deepEqual(traced.path, regular.path);
    assert.equal("planDiagnostics" in regular, false);
    const diagnostics = traced.planDiagnostics as {
      readonly schemaVersion: number;
      readonly branching: {
        readonly distinctBoxReserve: number;
        readonly firstPushLimit: number;
      };
      readonly pruning: Readonly<Record<string, number>>;
      readonly layers: ReadonlyArray<{
        readonly frontier: number;
        readonly firstPushesGenerated: number;
        readonly firstPushesSelected: number;
        readonly candidateStates: number;
        readonly retainedStates: number;
      }>;
    };
    assert.equal(diagnostics.schemaVersion, 1);
    assert.equal(diagnostics.branching.distinctBoxReserve, 0);
    assert.equal(diagnostics.branching.firstPushLimit, 6);
    assert.ok(diagnostics.layers.length > 0);
    assert.ok(diagnostics.layers[0].frontier > 0);
    assert.ok(diagnostics.layers[0].firstPushesGenerated > 0);
    assert.ok(
      diagnostics.layers[0].firstPushesSelected <=
        diagnostics.branching.firstPushLimit,
    );
    assert.ok(
      diagnostics.layers.every(layer =>
        layer.retainedStates <= layer.candidateStates),
    );
    assert.ok(
      Object.values(diagnostics.pruning).every(value =>
        Number.isSafeInteger(value) && value >= 0),
    );
  });

  it("derives the fixed-work box-agenda reserve from topology and pressure", () => {
    const roomPuzzle = PUZZLE_BY_ID["huge"];
    const openPuzzle = PUZZLE_BY_ID["open-field"];
    assert.ok(roomPuzzle);
    assert.ok(openPuzzle);
    const branchingFor = (puzzle: PuzzleDefinition) => {
      const result = search({
        algorithm: "plan-macro-beam",
        state: toLegacyState(requestFor(puzzle)),
        maxVisited: 1,
        maxGenerated: 1,
        planBeamWidth: 16,
        planBoxBranches: 6,
        maxPlanSegments: 1,
        maxDepth: 80,
        planDiagnostics: true,
      });
      return (result.planDiagnostics as {
        readonly branching: {
          readonly distinctBoxReserve: number;
          readonly firstPushLimit: number;
        };
      }).branching;
    };

    assert.deepEqual(branchingFor(roomPuzzle), {
      distinctBoxReserve: 1,
      boxBranchLimit: 6,
      firstPushLimit: 8,
    });
    assert.deepEqual(branchingFor(openPuzzle), {
      distinctBoxReserve: 0,
      boxBranchLimit: 6,
      firstPushLimit: 8,
    });
  });

  it("rehydrates a structured-cloned prepared board without changing the route", () => {
    const request = requestFor(MIXED_TYPED_PUZZLE);
    const state = toLegacyState(request);
    const analysisResult = search({
      algorithm: "analyze-puzzle",
      state,
    });
    const analysis = analysisResult.analysis as
      | { readonly preparedBoard?: unknown }
      | undefined;
    assert.ok(analysis?.preparedBoard);
    const preparedBoard = structuredClone(analysis.preparedBoard);

    const result = search({
      algorithm: "ultimate",
      state: { ...state, preparedBoard },
      maxVisited: 20_000,
      beamWidth: 160,
      maxDepth: 80,
    });

    assert.equal(result.status, "solved");
    assert.ok(Array.isArray(result.path));
    assert.equal(
      (result.performance?.preparedBoardReuses as number | undefined) ?? 0,
      1,
    );
    const solution = solutionFromLegacyPath(request, result.path);
    assert.ok(solution);
    assert.equal(verifySolverSolution(request, solution).valid, true);
  });

  it("certifies Grand Hall's Hall-tight lower-room traffic", () => {
    const request = requestFor(PUZZLE_BY_ID.huge);
    const result = search({
      algorithm: "analyze-puzzle",
      state: toLegacyState(request),
    });
    const analysis = result.analysis as {
      readonly mandatoryDoorwayExports: number;
      readonly mandatoryDoorwayImports: number;
      readonly rooms: ReadonlyArray<{
        readonly gate: string;
        readonly forcedExports: number;
        readonly forcedImports: number;
        readonly interfacePhase: string;
        readonly interfaceMinimumCrossings: number;
        readonly interfaceMinimumExportsBeforeImport: number;
        readonly interfaceClearanceMethod: string;
      }>;
      readonly doorwayAssignment: {
        readonly complete: boolean;
        readonly eliminatedEdges: number;
        readonly mandatoryCrossings: number;
        readonly boxDomains: ReadonlyArray<{
          readonly box: string;
          readonly allowedTargets: readonly string[];
        }>;
      };
      readonly roomInterfaces: ReadonlyArray<{
        readonly gate: string;
        readonly keeperSide: string;
        readonly pendingExports: number;
        readonly remainingImports: number;
        readonly minimumExportsBeforeFirstImport: number;
        readonly preferredAction: string;
        readonly availableActions: readonly string[];
        readonly hardPruning: boolean;
      }>;
    };

    assert.equal(analysis.doorwayAssignment.complete, true);
    assert.equal(analysis.doorwayAssignment.eliminatedEdges, 28);
    assert.equal(analysis.doorwayAssignment.mandatoryCrossings, 10);
    assert.equal(analysis.mandatoryDoorwayExports, 6);
    assert.equal(analysis.mandatoryDoorwayImports, 4);
    const lowerInterface = analysis.roomInterfaces.find(
      room => room.gate === "10,7",
    );
    assert.ok(lowerInterface);
    assert.equal(lowerInterface.keeperSide, "inside");
    assert.equal(lowerInterface.pendingExports, 6);
    assert.equal(lowerInterface.remainingImports, 4);
    assert.equal(lowerInterface.minimumExportsBeforeFirstImport, 4);
    assert.equal(lowerInterface.preferredAction, "export");
    assert.deepEqual(lowerInterface.availableActions, ["export"]);
    assert.equal(lowerInterface.hardPruning, false);
    assert.deepEqual(
      new Set(
        analysis.doorwayAssignment.boxDomains.find(
          domain => domain.box === "10,6",
        )?.allowedTargets,
      ),
      new Set(["13,2", "13,12"]),
    );
    assert.equal(
      analysis.doorwayAssignment.boxDomains.find(
        domain => domain.box === "12,4",
      )?.allowedTargets.some(target => target === "13,2" || target === "13,12"),
      false,
    );
    assert.deepEqual(
      analysis.rooms.find(room => room.gate === "10,7"),
      {
        gate: "10,7",
        cells: 27,
        goals: 4,
        boxes: 6,
        surplus: 4,
        forcedExports: 6,
        forcedImports: 4,
        dependencies: 2,
        maxDepth: 9,
        interfacePhase: "export",
        interfaceMinimumCrossings: 10,
        interfaceMinimumExportsBeforeImport: 4,
        interfaceClearanceMethod: "shallow-two-sided-barrier",
      },
    );
  });

  it("builds an advisory per-box transport agenda without fixing goal assignments", () => {
    const request = requestFor(PUZZLE_BY_ID.huge);
    const result = search({algorithm: "analyze-puzzle", state: toLegacyState(request)});
    const plan = (result.analysis as { transportPlan: {
      scope: string;
      hardPruning: boolean;
      batches: Array<{ gate: string; exports: number[]; imports: number[]; stagingCandidates: string[] }>;
      boxes: Array<{
        position: string;
        label: string;
        allowedTargets: string[];
        goalDomainComplete: boolean;
        initialPushOptions: Array<{ destination: string; moves: number }>;
        parkingCandidates: Array<{ position: string; relaxedPushesToPark: number; relaxedPushesToGoal: number }>;
      }>;
    } }).transportPlan;
    assert.equal(plan.scope, "initial-position-advisory");
    assert.equal(plan.hardPruning, false);
    assert.equal(plan.boxes.length, 17);
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
    const lower = plan.batches.find(batch => batch.gate === "10,7");
    assert.ok(lower);
    assert.equal(lower.exports.length, 6);
    assert.equal(lower.imports.length, 4);
    assert.ok(!lower.stagingCandidates.includes(lower.gate));
    const generic = plan.boxes.find(box => box.position === "10,6");
    assert.ok(generic?.goalDomainComplete);
    assert.deepEqual(new Set(generic.allowedTargets), new Set(["13,2", "13,12"]));
    const goals = new Map(request.board.goals.map(goal => [
      `${goal.position.row},${goal.position.column}`, goal.label,
    ]));
    for (const box of plan.boxes) {
      assert.ok(box.parkingCandidates.length <= 4);
      for (const target of box.allowedTargets) assert.equal(goals.get(target), box.label);
      for (const option of box.initialPushOptions) assert.ok(option.moves >= 1);
      for (const parking of box.parkingCandidates) {
        assert.ok(Number.isFinite(parking.relaxedPushesToPark));
        assert.ok(Number.isFinite(parking.relaxedPushesToGoal));
      }
    }
  });

  it("shares one state budget across the ultimate portfolio", () => {
    const request = requestFor(MIXED_TYPED_PUZZLE);
    const result = search({
      algorithm: "ultimate",
      state: toLegacyState(request),
      maxVisited: 1,
      maxGenerated: 1,
      beamWidth: 32,
      maxDepth: 80,
    });

    assert.equal(result.status, "cutoff");
    assert.ok(Number(result.visited) <= 1);
    assert.ok(Number(result.generated) <= 1);
    assert.ok(
      Number(result.performance?.denseLayoutBuilds ?? 0) <= 1,
      "the budget must not restart four full portfolio lanes",
    );
  });

  it("reports an exhausted frontier as an unverified cutoff, not a proof", () => {
    // The box starts in a corner away from its goal. The engine's prunes are
    // unverified, so emptying the frontier must not claim unsolvability.
    const request = requestFor({
      id: "corner-dead-engine",
      title: "Corner dead engine",
      difficulty: "tutorial",
      boxes: 1,
      rows: [
        "OOOOOO",
        "OX   O",
        "O  RSO",
        "OOOOOO",
      ],
    });
    const cases = [
      ...(["astar", "bfs", "dfs", "push-astar"] as const).map((algorithm) => ({
        payload: { algorithm },
        reason: "frontier-exhausted-unverified",
      })),
      { payload: { algorithm: "push-ida-star", upperBound: Infinity }, reason: "frontier-exhausted-unverified" },
      { payload: { algorithm: "push-ida-star" }, reason: "bound-exhausted" },
    ];
    for (const { payload, reason } of cases) {
      const result = search({ ...payload, state: toLegacyState(request), maxVisited: 10_000 });
      const label = JSON.stringify(payload);
      assert.equal(result.path, null, label);
      assert.equal(result.status, "cutoff", label);
      assert.equal(result.cutoff, false, label);
      assert.equal(result.terminationReason, reason, label);
    }
  });

  it("reserves rewrite states for move-specific windows", () => {
    const request = requestFor(MIXED_TYPED_PUZZLE);
    const state = toLegacyState(request);
    const analysis = search({algorithm: "analyze-puzzle", state}).analysis as {
      readonly preparedBoardStats: { readonly graphNodes: number };
    };
    const incumbent = search({
      algorithm: "ultimate",
      state,
      maxVisited: 20_000,
      beamWidth: 160,
      maxDepth: 80,
    });
    assert.ok(Array.isArray(incumbent.path));

    const rewritten = search({
      algorithm: "solution-window-rewrite",
      state,
      solutionPath: incumbent.path,
      maxVisited: 200,
      permutationVisited: 0,
      windowTotalVisited: 0,
      moveWindowVisited: 200,
      moveWindowAttempts: 2,
      perMoveWindowVisited: 100,
      moveWindowMinimumOverhead: 1,
    });

    assert.ok(Array.isArray(rewritten.path));
    assert.ok(Number(rewritten.moveVisited) > 0);
    assert.equal(
      Number(rewritten.performance?.graphNodes),
      analysis.preparedBoardStats.graphNodes,
      "rewrite windows must reuse the outer compiled board",
    );
    const solution = solutionFromLegacyPath(request, rewritten.path);
    assert.ok(solution);
    assert.equal(verifySolverSolution(request, solution).valid, true);
  });

  it("enforces and reports the rewrite generated-state budget", () => {
    const request = requestFor(MIXED_TYPED_PUZZLE);
    const state = toLegacyState(request);
    const incumbent = search({
      algorithm: "ultimate",
      state,
      maxVisited: 20_000,
      beamWidth: 160,
      maxDepth: 80,
    });
    assert.ok(Array.isArray(incumbent.path));

    const rewritten = search({
      algorithm: "solution-window-rewrite",
      state,
      solutionPath: incumbent.path,
      maxVisited: 1_000,
      maxGenerated: 1,
      permutationVisited: 500,
      permutationWindowPushes: [1],
      perPermutationWindowVisited: 500,
      windowTotalVisited: 500,
      windowPushes: [1],
      moveWindowVisited: 500,
      moveWindowMinimumOverhead: 1,
    });

    assert.ok(Array.isArray(rewritten.path));
    assert.ok(Number(rewritten.generated) <= 1);
  });

  it("reports injectable isolate memory separately from live engine storage", (t) => {
    const memoryRuntime = globalThis as typeof globalThis & {
      __sokomindMemoryUsage?: () => number;
    };
    const originalMemoryUsage = memoryRuntime.__sokomindMemoryUsage;
    memoryRuntime.__sokomindMemoryUsage = () => 42 * 1024 * 1024;
    t.after(() => {
      if (originalMemoryUsage === undefined) {
        Reflect.deleteProperty(memoryRuntime, "__sokomindMemoryUsage");
      } else {
        memoryRuntime.__sokomindMemoryUsage = originalMemoryUsage;
      }
    });

    const request = requestFor(MIXED_TYPED_PUZZLE);
    const result = search({
      algorithm: "analyze-puzzle",
      state: toLegacyState(request),
    });
    const performance = result.performance;
    const memory = performance?.memory as
      | Readonly<Record<string, unknown>>
      | undefined;
    const engineMemory = performance?.engineMemory as
      | Readonly<Record<string, unknown>>
      | undefined;

    assert.equal(performance?.schemaVersion, 4);
    assert.equal(memory?.source, "injected-runtime");
    assert.equal(memory?.usedBytes, 42 * 1024 * 1024);
    assert.ok(
      ((engineMemory?.boardBytes as number | undefined) ?? 0) > 0,
    );
    assert.ok(
      ((engineMemory?.currentBytes as number | undefined) ?? 0) > 0,
    );
  });

  it("pins the es01 tunnel boards: step astar/bfs give the move optimum, push-astar the push optimum", () => {
    // collapseForcedPushes (source/push-generation.js) runs only
    // inside the push-* algorithms, so push-astar is what exercises the
    // engine's own tunnel collapse. Its answer is a push optimum, which is not
    // a move optimum.
    for (const fixture of ES01_TUNNEL_FIXTURES) {
      const request = requestFromFixture(fixture);
      for (const algorithm of ["astar", "bfs"] as const) {
        const result = search({
          algorithm,
          state: toLegacyState(request),
          maxVisited: 200_000,
        });
        assert.equal(result.status, "solved", `${algorithm} ${fixture.id}`);
        assert.ok(Array.isArray(result.path));
        const solution = solutionFromLegacyPath(request, result.path);
        assert.ok(solution, `${algorithm} ${fixture.id} replayable path`);
        assert.equal(verifySolverSolution(request, solution).valid, true);
        assert.equal(solution.moves, fixture.moves, `${algorithm} ${fixture.id} moves`);
      }

      const push = search({
        algorithm: "push-astar",
        state: toLegacyState(request),
        maxVisited: 200_000,
      });
      assert.equal(push.status, "solved", `push-astar ${fixture.id}`);
      assert.ok(Array.isArray(push.path));
      const pushSolution = solutionFromLegacyPath(request, push.path);
      assert.ok(pushSolution, `push-astar ${fixture.id} replayable path`);
      assert.equal(verifySolverSolution(request, pushSolution).valid, true);
      assert.equal(pushSolution.pushes, fixture.pushOptimum, `push-astar ${fixture.id} pushes`);
      assert.ok(pushSolution.moves >= fixture.moves, `push-astar ${fixture.id} moves`);
    }
  });
});

describe("classic search on the es01 tunnel boards", () => {
  it("pins the es01a, es01c and es01d move optima at 16, 19 and 22", () => {
    assert.deepEqual(
      ES01_TUNNEL_FIXTURES.map((fixture) => fixture.moves),
      [16, 19, 22],
    );
    for (const fixture of ES01_TUNNEL_FIXTURES) {
      assert.equal(oracleMoves(fixture), fixture.moves, `${fixture.id} oracle`);
    }
  });

  for (const fixture of ES01_TUNNEL_FIXTURES) {
    it(`engine classic A* proves ${fixture.moves} on ${fixture.id} and the exact kernels agree`, async () => {
      const request = requestFromFixture(fixture);
      const classic = await runClassicSearch(request, exactContext(), {
        strategy: "astar",
      });
      assert.equal(classic.status, "solved", `${fixture.id} engine classic`);
      if (classic.status !== "solved") return;
      assert.equal(classic.solution.moves, fixture.moves, `${fixture.id} engine classic moves`);
      assert.equal(classic.solution.optimality, "proven", `${fixture.id} engine classic proof`);
      assert.equal(verifySolverSolution(request, classic.solution).valid, true);

      // Cross-check against the TS exact kernels. The tunnelMacros:true run is
      // the one that fails if the macro prunes the single push again, since
      // the default is now off.
      const kernels = [
        ["runExactMoveAStar", () => runExactMoveAStar(request, exactContext())],
        [
          "runExactMoveAStar tunnelMacros:true",
          () =>
            runExactMoveAStar(request, exactContext(), {
              features: { tunnelMacros: true },
            }),
        ],
        ["runIdaStarSearch", () => runIdaStarSearch(request, exactContext())],
      ] as const;
      for (const [label, run] of kernels) {
        const result = await run();
        assert.equal(result.status, "solved", `${fixture.id} ${label}`);
        if (result.status !== "solved") continue;
        assert.equal(
          result.solution.moves,
          classic.solution.moves,
          `${fixture.id} ${label} agrees with engine classic`,
        );
        assert.equal(result.solution.optimality, "proven", `${fixture.id} ${label} proof`);
      }
    });
  }
});
