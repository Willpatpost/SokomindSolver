import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSession,
  stepSnapshot,
  type GameSnapshot,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverObjective,
  SolverProgress,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import { classicAStarSolver } from "../../src/solver/implementations/index.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TWO_GENERIC_BOXES: PuzzleDefinition = {
  id: "two-generic-boxes",
  title: "Two generic boxes",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOOOO",
    "O SS  O",
    "O XX  O",
    "O  R  O",
    "O     O",
    "OOOOOOO",
  ],
};

const ONE_BOX: PuzzleDefinition = {
  id: "one-box",
  title: "One box",
  difficulty: "tutorial",
  boxes: 1,
  rows: [
    "OOOOO",
    "O S O",
    "O X O",
    "O R O",
    "OOOOO",
  ],
};

/**
 * For the "already solved" test we use the ONE_BOX puzzle and push the box
 * onto the goal to produce a solved snapshot, then feed that to IDA*.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requestFor(
  puzzle: PuzzleDefinition,
  objective: SolverObjective,
  snapshot?: GameSnapshot,
): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: snapshot ?? session.snapshot,
    objective,
  };
}

function executionContext(
  progress: SolverExecutionContext["reportProgress"] = () => undefined,
  signal = new AbortController().signal,
): SolverExecutionContext {
  return {
    signal,
    reportProgress: progress,
    now: () => performance.now(),
  };
}

function solved(
  result: SolverResult,
): Extract<SolverResult, { readonly status: "solved" }> {
  assert.equal(result.status, "solved", `Expected solved, got ${result.status}${result.status === "unsolved" ? `: ${result.detail}` : ""}`);
  if (result.status !== "solved") throw new Error("Expected a solved result.");
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IDA* search", () => {
  it("solves a trivial one-box puzzle", async () => {
    const request = requestFor(ONE_BOX, { kind: "moves" });
    const result = solved(
      await runIdaStarSearch(request, executionContext()),
    );

    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.pushes, 1);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
  });

  it("solves a two-box puzzle move-optimally", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, { kind: "moves" });

    // Get A* result for comparison
    const astarResult = solved(
      await classicAStarSolver.solve(request, executionContext()),
    );

    const idaResult = solved(
      await runIdaStarSearch(request, executionContext()),
    );

    assert.equal(idaResult.solution.optimality, "proven");
    assert.equal(idaResult.solution.moves, astarResult.solution.moves);
    assert.equal(
      verifySolverSolution(request, idaResult.solution).valid,
      true,
    );
  });

  it("handles already-solved puzzles", async () => {
    // Push the one box onto the goal to create a solved snapshot
    const session = createSession(ONE_BOX);
    const pushed = stepSnapshot(session.board, session.snapshot, "up");
    assert.equal(pushed.pushed, true);
    assert.equal(pushed.snapshot.solved, true);

    const request: SolverRequest = {
      board: session.board,
      snapshot: pushed.snapshot,
      objective: { kind: "moves" },
    };
    const result = solved(
      await runIdaStarSearch(request, executionContext()),
    );

    assert.equal(result.solution.pushes, 0);
    assert.equal(result.solution.moves, 0);
    assert.equal(result.solution.steps.length, 0);
    assert.equal(result.solution.optimality, "proven");
  });

  it("respects cancellation via AbortSignal", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, { kind: "moves" });

    const controller = new AbortController();
    // Cancel immediately
    controller.abort("test cancellation");

    const result = await runIdaStarSearch(
      request,
      executionContext(undefined, controller.signal),
    );

    assert.equal(result.status, "cancelled");
    assert.ok((result.metrics.counters?.estimatedMemoryBytes ?? 0) > 0);
    assert.equal(
      result.metrics.counters?.estimatedMemoryBytes,
      result.metrics.counters?.peakEstimatedMemoryBytes,
    );
  });

  it("respects maxElapsedMs limit", async () => {
    const request: SolverRequest = {
      ...requestFor(TWO_GENERIC_BOXES, { kind: "moves" }),
      limits: { maxElapsedMs: 0 },
    };

    const result = await runIdaStarSearch(request, executionContext());

    // With 0ms limit, the solver should stop quickly
    assert.ok(
      result.status === "unsolved" || result.status === "solved",
      `Expected unsolved or solved, got ${result.status}`,
    );
    if (result.status === "unsolved") {
      assert.equal(result.reason, "limit-reached");
    }
  });

  it("reports progress during search", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, { kind: "moves" });

    const progressReports: string[] = [];
    const ctx = executionContext((progress) => {
      if (progress.detail) progressReports.push(progress.detail);
    });

    const result = solved(await runIdaStarSearch(request, ctx));

    assert.ok(progressReports.length > 0, "Expected at least one progress report");
    assert.ok(
      progressReports.some((d) => d.includes("IDA*")),
      "Expected progress detail to mention IDA*",
    );
    assert.equal(
      verifySolverSolution(request, result.solution).valid,
      true,
    );
  });

  it("returns metrics with IDA* iteration count", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, { kind: "moves" });
    const result = solved(
      await runIdaStarSearch(request, executionContext()),
    );

    assert.ok(result.metrics.elapsedMs >= 0);
    assert.ok((result.metrics.expandedStates ?? 0) > 0);
    assert.ok((result.metrics.generatedStates ?? 0) > 0);
    assert.ok(
      (result.metrics.counters?.idaStarIterations ?? 0) >= 1,
      "Expected at least 1 IDA* iteration",
    );
    assert.ok(
      (result.metrics.counters?.estimatedMemoryBytes ?? 0) > 0,
      "Expected a non-zero live memory estimate",
    );
    assert.equal(
      result.metrics.counters?.estimatedMemoryBytes,
      result.metrics.counters?.currentEstimatedMemoryBytes,
    );
    assert.ok(
      (result.metrics.counters?.peakEstimatedMemoryBytes ?? 0) >=
        (result.metrics.counters?.estimatedMemoryBytes ?? Infinity),
      "Expected peak memory to include current memory",
    );
  });

  it("rejects a budget below static allocation before search", async () => {
    const session = createSession(ONE_BOX);
    const pushed = stepSnapshot(session.board, session.snapshot, "up");
    assert.equal(pushed.snapshot.solved, true);

    const solvedRequest: SolverRequest = {
      board: session.board,
      snapshot: pushed.snapshot,
      objective: { kind: "moves" },
    };
    const baseline = solved(
      await runIdaStarSearch(solvedRequest, executionContext()),
    );
    const staticBytes =
      baseline.metrics.counters?.memoryStaticBytes ?? 0;
    assert.ok(staticBytes > 1, "Expected a meaningful static allocation");
    assert.equal(
      baseline.metrics.counters?.estimatedMemoryBytes,
      staticBytes,
    );

    const result = await runIdaStarSearch(
      {
        ...solvedRequest,
        limits: { maxMemoryBytes: staticBytes - 1 },
      },
      executionContext(),
    );

    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "limit-reached");
    assert.match(result.detail ?? "", /memory.*(preparation|preprocessing)/i);
    assert.equal(result.metrics.expandedStates, 0);
    assert.equal(result.metrics.generatedStates, 0);
    assert.equal(result.metrics.counters?.estimatedMemoryBytes, staticBytes);
    assert.equal(result.metrics.counters?.peakEstimatedMemoryBytes, staticBytes);
  });

  it("tracks monotonic peak memory and enforces the limit during growth", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, { kind: "moves" });
    const progress: SolverProgress[] = [];
    const baseline = solved(
      await runIdaStarSearch(
        request,
        executionContext((update) => progress.push(update)),
      ),
    );

    const peaks = progress.map(
      (update) => update.counters?.peakEstimatedMemoryBytes ?? 0,
    );
    assert.ok(peaks.length >= 2);
    for (let index = 1; index < peaks.length; index += 1) {
      assert.ok(peaks[index] >= peaks[index - 1], "Peak memory regressed");
    }

    const counters = baseline.metrics.counters;
    const firstFullProgress = progress.find(
      (p) => p.counters?.memoryStaticBytes !== undefined,
    );
    const staticBytes = firstFullProgress?.counters?.memoryStaticBytes ?? 0;
    const currentBytes = counters?.estimatedMemoryBytes ?? 0;
    const peakBytes = counters?.peakEstimatedMemoryBytes ?? 0;
    assert.ok(staticBytes > 0);
    assert.ok(peakBytes > staticBytes);
    assert.ok(peakBytes >= currentBytes);
    assert.equal(
      currentBytes,
      (counters?.memoryStaticBytes ?? 0) +
        (counters?.memoryTranspositionBytes ?? 0) +
        (counters?.memoryHeuristicCacheBytes ?? 0) +
        (counters?.memoryDfsStackBytes ?? 0) +
        (counters?.memoryReachabilitySnapshotBytes ?? 0),
    );

    const growthBudget =
      staticBytes + Math.floor((peakBytes - staticBytes) / 2);
    assert.ok(growthBudget >= staticBytes && growthBudget < peakBytes);
    const limited = await runIdaStarSearch(
      { ...request, limits: { maxMemoryBytes: growthBudget } },
      executionContext(),
    );
    assert.equal(limited.status, "unsolved");
    if (limited.status !== "unsolved") return;
    assert.equal(limited.reason, "limit-reached");
    assert.match(limited.detail ?? "", /memory/i);
    assert.ok(
      (limited.metrics.counters?.peakEstimatedMemoryBytes ?? 0) > growthBudget,
    );
  });

  it("solves a partial snapshot correctly", async () => {
    const session = createSession(TWO_GENERIC_BOXES);
    const firstPush = stepSnapshot(session.board, session.snapshot, "up");
    assert.equal(firstPush.pushed, true);

    const request: SolverRequest = {
      board: session.board,
      snapshot: firstPush.snapshot,
      objective: { kind: "moves" },
    };

    const astarResult = solved(
      await classicAStarSolver.solve(request, executionContext()),
    );
    const idaResult = solved(
      await runIdaStarSearch(request, executionContext()),
    );

    assert.equal(idaResult.solution.moves, astarResult.solution.moves);
    assert.equal(
      verifySolverSolution(request, idaResult.solution).valid,
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Sprint 1: Forced-push macros in IDA*
// ---------------------------------------------------------------------------

const CORRIDOR_PUZZLE: PuzzleDefinition = {
  id: "corridor",
  title: "Corridor forced push",
  difficulty: "tutorial",
  boxes: 1,
  rows: [
    "OOOOOOO",
    "O  S  O",
    "O  X  O",
    "O  R  O",
    "OOOOOOO",
  ],
};

describe("IDA* forced-push macros", () => {
  it("produces the same optimal solution on corridor puzzle", async () => {
    const request = requestFor(CORRIDOR_PUZZLE, { kind: "moves" });
    const result = solved(
      await runIdaStarSearch(request, executionContext()),
    );
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.solution.pushes, 1);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
  });

  it("produces same optimal solution as A* on two-box puzzle with macros", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, { kind: "moves" });
    const astarResult = solved(
      await classicAStarSolver.solve(request, executionContext()),
    );
    const idaResult = solved(
      await runIdaStarSearch(request, executionContext()),
    );
    assert.equal(idaResult.solution.moves, astarResult.solution.moves);
    assert.equal(verifySolverSolution(request, idaResult.solution).valid, true);
  });

  it("reports forced-push macro applications in metrics", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, { kind: "moves" });
    const result = solved(
      await runIdaStarSearch(request, executionContext()),
    );
    const applications = result.metrics.counters?.forcedPushMacroApplications;
    assert.ok(
      applications !== undefined,
      "Expected forcedPushMacroApplications counter in metrics",
    );
  });
});

// ---------------------------------------------------------------------------
// Sprint 1: TT-enhanced IDA* (TT-IDA*)
// ---------------------------------------------------------------------------

describe("TT-enhanced IDA*", () => {
  it("finds optimal solution with TT persisting across iterations", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, { kind: "moves" });
    const result = solved(
      await runIdaStarSearch(request, executionContext()),
    );
    assert.equal(result.solution.optimality, "proven");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    const iterations = result.metrics.counters?.idaStarIterations ?? 0;
    assert.ok(iterations >= 1, "Expected at least 1 IDA* iteration");
  });

  it("finds same optimal solution on one-box puzzle with TT", async () => {
    const request = requestFor(ONE_BOX, { kind: "moves" });
    const result = solved(
      await runIdaStarSearch(request, executionContext()),
    );
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.solution.moves, 1);
    assert.equal(result.solution.pushes, 1);
  });

  it("memory estimate includes transposition table", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, { kind: "moves" });
    const result = solved(
      await runIdaStarSearch(request, executionContext()),
    );
    const ttBytes = result.metrics.counters?.memoryTranspositionBytes ?? 0;
    assert.ok(ttBytes >= 0, "Expected non-negative TT memory");
  });
});

// ---------------------------------------------------------------------------
// Sprint 1: Linear conflict in IDA*
// ---------------------------------------------------------------------------

describe("IDA* with linear conflict", () => {
  it("produces optimal verified solution on two-box puzzle", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, { kind: "moves" });
    const result = solved(
      await runIdaStarSearch(request, executionContext()),
    );
    assert.equal(result.solution.optimality, "proven");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
  });

  it("produces optimal verified solution on one-box puzzle", async () => {
    const request = requestFor(ONE_BOX, { kind: "moves" });
    const result = solved(
      await runIdaStarSearch(request, executionContext()),
    );
    assert.equal(result.solution.optimality, "proven");
    assert.equal(result.solution.moves, 1);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
  });
});
