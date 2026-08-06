import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseSokomindOptions,
  extractSokomindOptions,
  DEFAULT_SOKOMIND_REQUEST_OPTIONS,
} from "../../src/solver/implementations/sokomind-options.ts";

import { runSequentialProof } from "../../src/solver/implementations/sokomind-proof.ts";
import { parsePuzzleRows } from "../../src/core/index.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import { runClassicSearch } from "../../src/solver/search/engine.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function oracleContext(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    now: () => performance.now(),
  };
}

function requestFromRows(rows: string[]): SolverRequest {
  const parsed = parsePuzzleRows(rows);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "modes-test",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
  };
}

/** 1-box puzzle solvable in ~2 moves: push X right onto S. */
const ONE_BOX = ["OOOOO", "ORXSO", "OOOOO"];

// ===========================================================================
// 1. Options parser
// ===========================================================================

describe("parseSokomindOptions", () => {
  it("null returns defaults", () => {
    assert.deepStrictEqual(parseSokomindOptions(null), DEFAULT_SOKOMIND_REQUEST_OPTIONS);
  });

  it("undefined returns defaults", () => {
    assert.deepStrictEqual(parseSokomindOptions(undefined), DEFAULT_SOKOMIND_REQUEST_OPTIONS);
  });

  it("empty object returns defaults", () => {
    assert.deepStrictEqual(parseSokomindOptions({}), DEFAULT_SOKOMIND_REQUEST_OPTIONS);
  });

  it("mode override replaces only mode", () => {
    const result = parseSokomindOptions({ mode: "quality" });
    assert.equal(result.mode, "quality");
    assert.equal(result.proofAlgorithm, DEFAULT_SOKOMIND_REQUEST_OPTIONS.proofAlgorithm);
    assert.equal(result.deterministic, DEFAULT_SOKOMIND_REQUEST_OPTIONS.deterministic);
    assert.equal(result.maximumIncumbents, DEFAULT_SOKOMIND_REQUEST_OPTIONS.maximumIncumbents);
    assert.equal(result.harvestElapsedMs, DEFAULT_SOKOMIND_REQUEST_OPTIONS.harvestElapsedMs);
    assert.equal(result.proofParallelism, DEFAULT_SOKOMIND_REQUEST_OPTIONS.proofParallelism);
  });

  it("invalid mode throws", () => {
    assert.throws(() => parseSokomindOptions({ mode: "invalid" }), /mode/);
  });

  it("string input throws", () => {
    assert.throws(() => parseSokomindOptions("string"), /plain object/);
  });

  it("array input throws", () => {
    assert.throws(() => parseSokomindOptions([]), /plain object/);
  });

  it("unknown keys throw", () => {
    assert.throws(() => parseSokomindOptions({ unknownKey: true }), /unknown/i);
  });

  it("maximumIncumbents = 0 throws (min is 1)", () => {
    assert.throws(() => parseSokomindOptions({ maximumIncumbents: 0 }), /maximumIncumbents/);
  });

  it("maximumIncumbents = 9 throws (max is 8)", () => {
    assert.throws(() => parseSokomindOptions({ maximumIncumbents: 9 }), /maximumIncumbents/);
  });

  it("harvestElapsedMs = -1 throws", () => {
    assert.throws(() => parseSokomindOptions({ harvestElapsedMs: -1 }), /harvestElapsedMs/);
  });

  it("harvestElapsedMs = 31000 throws (max is 30000)", () => {
    assert.throws(() => parseSokomindOptions({ harvestElapsedMs: 31000 }), /harvestElapsedMs/);
  });

  it("proofParallelism = 0 throws (min is 1)", () => {
    assert.throws(() => parseSokomindOptions({ proofParallelism: 0 }), /proofParallelism/);
  });

  it("proofParallelism = 33 throws (max is 32)", () => {
    assert.throws(() => parseSokomindOptions({ proofParallelism: 33 }), /proofParallelism/);
  });

  it("invalid proofAlgorithm throws", () => {
    assert.throws(() => parseSokomindOptions({ proofAlgorithm: "dijkstra" }), /proofAlgorithm/);
  });

  it("invalid idaReachabilitySnapshots throws", () => {
    assert.throws(() => parseSokomindOptions({ idaReachabilitySnapshots: "always" }), /idaReachabilitySnapshots/);
  });

  it("idaSnapshotPeriod = 0 throws (min is 1)", () => {
    assert.throws(() => parseSokomindOptions({ idaSnapshotPeriod: 0 }), /idaSnapshotPeriod/);
  });

  it("idaSnapshotPeriod = 65 throws (max is 64)", () => {
    assert.throws(() => parseSokomindOptions({ idaSnapshotPeriod: 65 }), /idaSnapshotPeriod/);
  });

  it("deterministic as string throws (not boolean)", () => {
    assert.throws(() => parseSokomindOptions({ deterministic: "yes" }), /deterministic/);
  });

  it("all-valid partial override", () => {
    const result = parseSokomindOptions({
      mode: "optimal",
      proofAlgorithm: "ida-star",
      deterministic: true,
      maximumIncumbents: 2,
    });
    assert.equal(result.mode, "optimal");
    assert.equal(result.proofAlgorithm, "ida-star");
    assert.equal(result.deterministic, true);
    assert.equal(result.maximumIncumbents, 2);
    // Non-overridden fields keep defaults.
    assert.equal(result.harvestElapsedMs, DEFAULT_SOKOMIND_REQUEST_OPTIONS.harvestElapsedMs);
    assert.equal(result.proofParallelism, DEFAULT_SOKOMIND_REQUEST_OPTIONS.proofParallelism);
    assert.equal(result.idaReachabilitySnapshots, DEFAULT_SOKOMIND_REQUEST_OPTIONS.idaReachabilitySnapshots);
    assert.equal(result.idaSnapshotPeriod, DEFAULT_SOKOMIND_REQUEST_OPTIONS.idaSnapshotPeriod);
  });
});

describe("extractSokomindOptions", () => {
  it("request with no options field returns defaults", () => {
    const req = requestFromRows(ONE_BOX);
    const result = extractSokomindOptions(req);
    assert.deepStrictEqual(result, DEFAULT_SOKOMIND_REQUEST_OPTIONS);
  });

  it("request with sokomind-solver options returns quality mode", () => {
    const req: SolverRequest = {
      ...requestFromRows(ONE_BOX),
      options: { "sokomind-solver": { mode: "quality" } },
    };
    const result = extractSokomindOptions(req);
    assert.equal(result.mode, "quality");
  });
});

// ===========================================================================
// 2. Sequential proof integration
// ===========================================================================

describe("runSequentialProof", () => {
  it("quality mode proof improves or matches DFS solution", async () => {
    const req = requestFromRows(ONE_BOX);
    const ctx = oracleContext();

    const dfsResult = await runClassicSearch(req, ctx, { strategy: "dfs" });
    assert.equal(dfsResult.status, "solved", "DFS must solve the tiny puzzle");
    if (dfsResult.status !== "solved") return;

    const proofResult = await runSequentialProof(
      req,
      ctx,
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality" },
      dfsResult,
    );

    assert.equal(proofResult.status, "solved");
    if (proofResult.status !== "solved") return;
    assert.ok(
      proofResult.solution.moves <= dfsResult.solution.moves,
      `proof moves (${proofResult.solution.moves}) should be <= DFS moves (${dfsResult.solution.moves})`,
    );

    const verification = verifySolverSolution(req, proofResult.solution);
    assert.ok(verification.valid, "proof solution must replay correctly");
  });

  it("optimal mode proves small puzzle", async () => {
    const req = requestFromRows(ONE_BOX);
    const ctx = oracleContext();

    const greedyResult = await runClassicSearch(req, ctx, { strategy: "greedy" });
    assert.equal(greedyResult.status, "solved", "greedy must solve the tiny puzzle");
    if (greedyResult.status !== "solved") return;

    const proofResult = await runSequentialProof(
      req,
      ctx,
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "optimal" },
      greedyResult,
    );

    assert.equal(proofResult.status, "solved");
    if (proofResult.status !== "solved") return;
    assert.equal(proofResult.solution.optimality, "proven");
    assert.ok(proofResult.proof !== undefined, "proof metadata must be present");
    assert.equal(proofResult.proof!.kind, "optimal");
    assert.equal(proofResult.proof!.gap, 0);

    const verification = verifySolverSolution(req, proofResult.solution);
    assert.ok(verification.valid, "optimal solution must replay correctly");
  });

  it("optimal with tight state limit preserves incumbent", async () => {
    const req = requestFromRows(ONE_BOX);
    const ctx = oracleContext();

    const greedyResult = await runClassicSearch(req, ctx, { strategy: "greedy" });
    assert.equal(greedyResult.status, "solved");
    if (greedyResult.status !== "solved") return;

    const tightReq: SolverRequest = {
      ...req,
      limits: { maxExpandedStates: 1 },
    };

    const proofResult = await runSequentialProof(
      tightReq,
      ctx,
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "optimal" },
      greedyResult,
    );

    // The incumbent should be preserved even when the proof is cut short.
    assert.equal(proofResult.status, "solved");
    if (proofResult.status !== "solved") return;

    const verification = verifySolverSolution(req, proofResult.solution);
    assert.ok(verification.valid, "incumbent solution must replay correctly");

    // If proof was cut short, it may be bounded with gap > 0, or it may have
    // completed anyway for a trivial puzzle. Either way, result stays solved.
    if (proofResult.proof?.kind === "bounded") {
      assert.ok(
        (proofResult.proof.gap ?? 0) >= 0,
        "bounded proof gap must be non-negative",
      );
    }
  });

  it("non-solved discovery passes through unchanged", async () => {
    const req = requestFromRows(ONE_BOX);
    const ctx = oracleContext();

    const fakeUnsolved: SolverResult = {
      status: "unsolved",
      reason: "limit-reached",
      metrics: { elapsedMs: 10 },
    };

    const result = await runSequentialProof(
      req,
      ctx,
      DEFAULT_SOKOMIND_REQUEST_OPTIONS,
      fakeUnsolved,
    );

    assert.equal(result.status, "unsolved");
    assert.equal(result, fakeUnsolved, "should return the exact same object");
  });

  it("no remaining time budget skips proof", async () => {
    const req: SolverRequest = {
      ...requestFromRows(ONE_BOX),
      limits: { maxElapsedMs: 100 },
    };
    const ctx = oracleContext();

    // Get a real solution to use as discovery result.
    const greedyResult = await runClassicSearch(
      requestFromRows(ONE_BOX),
      ctx,
      { strategy: "greedy" },
    );
    assert.equal(greedyResult.status, "solved");
    if (greedyResult.status !== "solved") return;

    // Forge discovery with elapsed > budget.
    const expiredDiscovery: SolverResult = {
      status: "solved",
      solution: greedyResult.solution,
      metrics: { elapsedMs: 200 },
    };

    const result = await runSequentialProof(
      req,
      ctx,
      DEFAULT_SOKOMIND_REQUEST_OPTIONS,
      expiredDiscovery,
    );

    assert.equal(result.status, "solved");
    assert.equal(
      result,
      expiredDiscovery,
      "should return discovery unchanged when time budget exhausted",
    );

    if (result.status === "solved") {
      const verification = verifySolverSolution(req, result.solution);
      assert.ok(verification.valid, "returned solution must replay even when proof skipped");
    }
  });

  it("greedy solution replays after proof", async () => {
    const req = requestFromRows(ONE_BOX);
    const ctx = oracleContext();

    const greedyResult = await runClassicSearch(req, ctx, { strategy: "greedy" });
    assert.equal(greedyResult.status, "solved");
    if (greedyResult.status !== "solved") return;

    const proofResult = await runSequentialProof(
      req,
      ctx,
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "quality" },
      greedyResult,
    );

    assert.equal(proofResult.status, "solved");
    if (proofResult.status !== "solved") return;

    const verification = verifySolverSolution(req, proofResult.solution);
    assert.ok(verification.valid, "post-proof solution must replay");
  });

  it("proofAlgorithm astar produces move-astar algorithm", async () => {
    const req = requestFromRows(ONE_BOX);
    const ctx = oracleContext();

    const greedyResult = await runClassicSearch(req, ctx, { strategy: "greedy" });
    assert.equal(greedyResult.status, "solved");
    if (greedyResult.status !== "solved") return;

    const proofResult = await runSequentialProof(
      req,
      ctx,
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "optimal", proofAlgorithm: "astar" },
      greedyResult,
    );

    assert.equal(proofResult.status, "solved");
    if (proofResult.status !== "solved") return;
    assert.ok(proofResult.proof !== undefined, "proof metadata must be present");
    assert.equal(proofResult.proof!.algorithm, "move-astar");

    const verification = verifySolverSolution(req, proofResult.solution);
    assert.ok(verification.valid);
  });

  it("proofAlgorithm ida-star produces move-ida-star algorithm", async () => {
    const req = requestFromRows(ONE_BOX);
    const ctx = oracleContext();

    const greedyResult = await runClassicSearch(req, ctx, { strategy: "greedy" });
    assert.equal(greedyResult.status, "solved");
    if (greedyResult.status !== "solved") return;

    const proofResult = await runSequentialProof(
      req,
      ctx,
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "optimal", proofAlgorithm: "ida-star" },
      greedyResult,
    );

    assert.equal(proofResult.status, "solved");
    if (proofResult.status !== "solved") return;
    assert.ok(proofResult.proof !== undefined, "proof metadata must be present");
    assert.equal(proofResult.proof!.algorithm, "move-ida-star");

    const verification = verifySolverSolution(req, proofResult.solution);
    assert.ok(verification.valid);
  });

  it("proofAlgorithm auto selects an algorithm", async () => {
    const req = requestFromRows(ONE_BOX);
    const ctx = oracleContext();

    const greedyResult = await runClassicSearch(req, ctx, { strategy: "greedy" });
    assert.equal(greedyResult.status, "solved");
    if (greedyResult.status !== "solved") return;

    const proofResult = await runSequentialProof(
      req,
      ctx,
      { ...DEFAULT_SOKOMIND_REQUEST_OPTIONS, mode: "optimal", proofAlgorithm: "auto" },
      greedyResult,
    );

    assert.equal(proofResult.status, "solved");
    if (proofResult.status !== "solved") return;
    assert.ok(proofResult.proof !== undefined, "proof metadata must be present");
    assert.ok(
      proofResult.proof!.algorithm === "move-astar" ||
        proofResult.proof!.algorithm === "move-ida-star",
      `auto should select astar or ida-star, got ${proofResult.proof!.algorithm}`,
    );

    const verification = verifySolverSolution(req, proofResult.solution);
    assert.ok(verification.valid);
  });
});

// ===========================================================================
// 3. Deterministic mode (parser-level)
// ===========================================================================

describe("deterministic mode", () => {
  it("parseSokomindOptions accepts deterministic: true", () => {
    const result = parseSokomindOptions({ deterministic: true });
    assert.equal(result.deterministic, true);
  });

  it("parseSokomindOptions accepts deterministic: false", () => {
    const result = parseSokomindOptions({ deterministic: false });
    assert.equal(result.deterministic, false);
  });

  it("extractSokomindOptions passes through deterministic", () => {
    const req: SolverRequest = {
      ...requestFromRows(ONE_BOX),
      options: { "sokomind-solver": { deterministic: true } },
    };
    const result = extractSokomindOptions(req);
    assert.equal(result.deterministic, true);
  });
});
