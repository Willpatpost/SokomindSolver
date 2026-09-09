import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createSession } from "../../src/core/index.ts";
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { solutionFromLegacyPath } from "../../src/solver/implementations/sokomind-legacy.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { toDenseBoxes } from "../../src/solver/search/model.ts";
import { KeeperReachability } from "../../src/solver/search/reachability.ts";
import { PiCorralDetector } from "../../src/solver/search/pi-corral.ts";
import { ALL_OFF_EXACT_SEARCH_FEATURES } from "../../src/solver/search/exact-search-features.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";

test("a PI-corral false positive cannot certify a known nonoptimal Grand Hall route", async () => {
  const session = createSession(PUZZLE_BY_ID.huge);
  const request = {board: session.board, snapshot: session.snapshot, objective: {kind: "moves" as const},
    limits: {maxExpandedStates: 2, maxGeneratedStates: 1000, maxElapsedMs: 30000, maxMemoryBytes: 384 * 1024 ** 2}};
  const loadSolution = (filename: string) => {
    const evidence = JSON.parse(readFileSync(new URL(`../../docs/benchmarks/${filename}`, import.meta.url), "utf8"));
    const path = evidence.result.solution.steps.map((step: {direction: string}) =>
      step.direction[0].toUpperCase() + step.direction.slice(1));
    const solution = solutionFromLegacyPath(request, path);
    assert.ok(solution && verifySolverSolution(request, solution).valid);
    return solution;
  };
  const incumbent = loadSolution("quality-memory-384-after.json");
  const shorter = loadSolution("quality-memory-1536-after.json");
  await assert.rejects(runIdaStarSearch(request, {signal: new AbortController().signal,
    now: () => performance.now(), reportProgress() {}}, {
    checkpoint: {schemaVersion: 2} as never,
  }), /checkpoint schema is obsolete/);
  assert.ok(shorter.moves < incumbent.moves);
  const board = compileSearchBoard(request.board);
  const boxes = toDenseBoxes(board, request.snapshot.boxes);
  const occupancy = new Uint8Array(board.cellCount);
  for (const box of boxes) occupancy[box.cell] = 1;
  const reachable = new KeeperReachability(board).flood(
    board.cellAt(request.snapshot.robot.row, request.snapshot.robot.column), occupancy);
  // Preserve the counterexample for any future replacement of this detector.
  assert.equal(new PiCorralDetector(board.cellCount).check(board, boxes, occupancy, reachable), true);
  for (const search of [runExactMoveAStar, runIdaStarSearch]) {
    const result = await search(request, {signal: new AbortController().signal,
      now: () => performance.now(), reportProgress() {}}, {
      incumbent: {solution: incumbent, cost: incumbent.moves},
      features: {...ALL_OFF_EXACT_SEARCH_FEATURES, piCorralPruning: true},
    });
    assert.equal(result.status, "solved");
    if (result.status !== "solved") continue;
    assert.equal(result.solution.optimality, "unknown");
    assert.notEqual(result.proof?.kind, "optimal");
    assert.ok((result.proof?.lowerBound ?? 0) <= shorter.moves);
    assert.equal(result.metrics.counters?.piCorralPrunes, 0);
    assert.ok(verifySolverSolution(request, result.solution).valid);
  }
});
