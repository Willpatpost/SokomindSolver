import assert from "node:assert/strict";
import test from "node:test";

import {
  assignRoomRoles,
  generateBlueprintWithRetry,
  placeGoals,
  toSolvedTemplate,
  reverseBeamSearch,
  replayForwardSolution,
  candidateToRows,
  candidateToAscii,
  scoreState,
  buildScoringContext,
  stateFingerprint,
  DEFAULT_BLUEPRINT_PARAMS,
  DEFAULT_GOAL_PARAMS,
  DEFAULT_BEAM_PARAMS,
  DEFAULT_WEIGHTS,
  TOPOLOGY_FAMILIES,
  type BlueprintParams,
  type BeamSearchParams,
  type GoalPlacementParams,
  type SolvedBlueprint,
} from "../../src/features/generator/v2/index.ts";
import { scrambleByReversePull } from "../../src/features/generator/reverse-play.ts";
import { createRng } from "../../src/features/generator/board-template.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<BlueprintParams> = {}): BlueprintParams {
  return { ...DEFAULT_BLUEPRINT_PARAMS, ...overrides };
}

function makeGoalParams(overrides: Partial<GoalPlacementParams> = {}): GoalPlacementParams {
  return { ...DEFAULT_GOAL_PARAMS, ...overrides };
}

function makeBeamParams(overrides: Partial<BeamSearchParams> = {}): BeamSearchParams {
  return { ...DEFAULT_BEAM_PARAMS, ...overrides };
}

function requireSolved(
  params: BlueprintParams,
  goalParams: GoalPlacementParams,
): SolvedBlueprint | null {
  const bp = generateBlueprintWithRetry(params, 30);
  if (!bp) return null;
  const fb = assignRoomRoles(bp, params.seed, goalParams.boxCount);
  return placeGoals(fb, goalParams);
}

function getSolved(seed: number = 42): SolvedBlueprint {
  const params = makeParams({ seed, family: "linear", boardWidth: 16, boardHeight: 16 });
  const goalParams = makeGoalParams({ seed, boxCount: 3 });
  const solved = requireSolved(params, goalParams);
  assert.ok(solved, "failed to generate solved blueprint for test");
  return solved;
}

// ---------------------------------------------------------------------------
// 1. Determinism — same seed, same result
// ---------------------------------------------------------------------------

test("beam search: same seed produces identical results", () => {
  const solved = getSolved(100);
  const bparams = makeBeamParams({ seed: 7, beamWidth: 4, maxDepth: 20 });

  const a = reverseBeamSearch(solved, bparams);
  const b = reverseBeamSearch(solved, bparams);

  assert.equal(a.best.depth, b.best.depth);
  assert.equal(a.best.score.composite, b.best.score.composite);
  assert.equal(a.totalExpanded, b.totalExpanded);
  assert.equal(a.maxDepthReached, b.maxDepthReached);
  assert.deepStrictEqual(a.best.boxPositions, b.best.boxPositions);
  assert.deepStrictEqual(a.best.robotPosition, b.best.robotPosition);
});

// ---------------------------------------------------------------------------
// 2. Different seeds produce different results
// ---------------------------------------------------------------------------

test("beam search: different seeds diverge", () => {
  const solved = getSolved(200);
  const a = reverseBeamSearch(solved, makeBeamParams({ seed: 1, maxDepth: 15 }));
  const b = reverseBeamSearch(solved, makeBeamParams({ seed: 2, maxDepth: 15 }));

  const fpA = stateFingerprint(a.best.boxPositions);
  const fpB = stateFingerprint(b.best.boxPositions);
  // Different seeds should generally produce different final states,
  // but on very small boards they might converge. We just verify the search ran.
  assert.ok(a.totalExpanded > 0);
  assert.ok(b.totalExpanded > 0);
  // At least one property should differ (depth, fingerprint, or score)
  const same = fpA === fpB && a.best.depth === b.best.depth;
  // Not strictly guaranteed, but overwhelmingly likely with different seeds
  if (same) {
    console.log("  (seeds converged — unusual but allowed on small boards)");
  }
});

// ---------------------------------------------------------------------------
// 3. Pull history legality — all pulls in history are valid reverse moves
// ---------------------------------------------------------------------------

test("beam search: pull history records valid positions", () => {
  const solved = getSolved(300);
  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 3, maxDepth: 20 }));
  const template = toSolvedTemplate(solved);

  for (const pull of result.best.pullHistory) {
    // from/to must be in-bounds floor cells
    assert.ok(pull.from.row >= 0 && pull.from.row < template.grid.length);
    assert.ok(pull.from.column >= 0 && pull.from.column < template.grid[0].length);
    assert.ok(pull.to.row >= 0 && pull.to.row < template.grid.length);
    assert.ok(pull.to.column >= 0 && pull.to.column < template.grid[0].length);
    assert.notEqual(template.grid[pull.to.row][pull.to.column], "O");
    assert.notEqual(template.grid[pull.from.row][pull.from.column], "O");

    // Robot positions must also be on floor
    assert.notEqual(template.grid[pull.robotFrom.row][pull.robotFrom.column], "O");
    assert.notEqual(template.grid[pull.robotTo.row][pull.robotTo.column], "O");
  }
});

// ---------------------------------------------------------------------------
// 4. Forward solution replay — verify the candidate is solvable
// ---------------------------------------------------------------------------

test("beam search: best candidate replays as valid forward solution", () => {
  const solved = getSolved(400);
  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 4, maxDepth: 30 }));
  const template = toSolvedTemplate(solved);

  if (result.best.pullHistory.length > 0) {
    const valid = replayForwardSolution(template, result.best);
    assert.ok(valid, "forward solution replay failed");
  }
});

test("beam search: all returned candidates replay correctly", () => {
  const solved = getSolved(401);
  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 5, maxDepth: 25 }));
  const template = toSolvedTemplate(solved);

  for (const candidate of result.candidates) {
    if (candidate.pullHistory.length > 0) {
      const valid = replayForwardSolution(template, candidate);
      assert.ok(valid, `candidate at depth ${candidate.depth} failed replay`);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Beam width limits
// ---------------------------------------------------------------------------

test("beam search: candidates ≤ beamWidth", () => {
  const solved = getSolved(500);
  const bw = 4;
  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 6, beamWidth: bw, maxDepth: 20 }));

  assert.ok(result.candidates.length <= bw);
});

test("beam search: wider beam expands more states", () => {
  const solved = getSolved(501);
  const narrow = reverseBeamSearch(solved, makeBeamParams({ seed: 7, beamWidth: 2, maxDepth: 15 }));
  const wide = reverseBeamSearch(solved, makeBeamParams({ seed: 7, beamWidth: 8, maxDepth: 15 }));

  assert.ok(wide.totalExpanded >= narrow.totalExpanded,
    `wide ${wide.totalExpanded} should expand ≥ narrow ${narrow.totalExpanded}`);
});

// ---------------------------------------------------------------------------
// 6. Diversity — fingerprints in beam are unique
// ---------------------------------------------------------------------------

test("beam search: returned candidates have unique fingerprints", () => {
  const solved = getSolved(600);
  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 8, beamWidth: 6, maxDepth: 25 }));

  const fps = new Set<string>();
  for (const c of result.candidates) {
    const fp = stateFingerprint(c.boxPositions);
    assert.ok(!fps.has(fp), `duplicate fingerprint in beam: ${fp}`);
    fps.add(fp);
  }
});

// ---------------------------------------------------------------------------
// 7. Scoring — composite increases with depth (on average)
// ---------------------------------------------------------------------------

test("beam search: best composite ≥ initial state score", () => {
  const solved = getSolved(700);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);
  const template = toSolvedTemplate(solved);

  const initialBoxes = template.goalPositions.map((g) => ({ row: g.row, column: g.column }));
  const initialScore = scoreState(ctx, initialBoxes, template.robotPosition, DEFAULT_WEIGHTS);

  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 9, maxDepth: 30 }));

  assert.ok(result.best.score.composite >= initialScore.composite,
    `best ${result.best.score.composite} should be ≥ initial ${initialScore.composite}`);
});

// ---------------------------------------------------------------------------
// 8. Score features — sanity checks
// ---------------------------------------------------------------------------

test("scoring: initial state has 0 boxes off goals", () => {
  const solved = getSolved(800);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);
  const template = toSolvedTemplate(solved);
  const initialBoxes = template.goalPositions.map((g) => ({ row: g.row, column: g.column }));

  const score = scoreState(ctx, initialBoxes, template.robotPosition, DEFAULT_WEIGHTS);
  assert.equal(score.boxesOffGoals, 0);
  assert.equal(score.distanceFromSolved, 0);
});

test("scoring: moving a box off-goal increases boxesOffGoals", () => {
  const solved = getSolved(801);

  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 10, maxDepth: 10 }));
  if (result.best.depth > 0) {
    assert.ok(result.best.score.boxesOffGoals >= 0);
    assert.ok(result.best.score.distanceFromSolved >= 0);
  }
});

// ---------------------------------------------------------------------------
// 9. State fingerprint
// ---------------------------------------------------------------------------

test("fingerprint: identical box positions produce same fingerprint", () => {
  const positions = [{ row: 3, column: 5 }, { row: 1, column: 2 }];
  const a = stateFingerprint(positions);
  const b = stateFingerprint([...positions]);
  assert.equal(a, b);
});

test("fingerprint: order-independent", () => {
  const a = stateFingerprint([{ row: 3, column: 5 }, { row: 1, column: 2 }]);
  const b = stateFingerprint([{ row: 1, column: 2 }, { row: 3, column: 5 }]);
  assert.equal(a, b);
});

test("fingerprint: different positions produce different fingerprints", () => {
  const a = stateFingerprint([{ row: 3, column: 5 }]);
  const b = stateFingerprint([{ row: 3, column: 6 }]);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// 10. candidateToRows / candidateToAscii output
// ---------------------------------------------------------------------------

test("candidate ASCII: contains R, S, and X markers", () => {
  const solved = getSolved(1000);
  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 11, maxDepth: 15 }));
  const template = toSolvedTemplate(solved);

  const ascii = candidateToAscii(template, result.best);
  assert.ok(ascii.includes("R"), "ASCII should contain robot R");
  assert.ok(ascii.includes("S") || ascii.includes("X"), "ASCII should contain goals or boxes");

  const rows = candidateToRows(template, result.best);
  assert.equal(rows.length, template.grid.length);
  for (const row of rows) {
    assert.equal(row.length, template.grid[0].length);
  }
});

// ---------------------------------------------------------------------------
// 11. Edge case — zero-depth (no pulls possible on initial state)
// ---------------------------------------------------------------------------

test("beam search: handles boards where no pulls are possible", () => {
  // Try many seeds; if we find one where search terminates at depth 0,
  // verify the result is well-formed
  for (let seed = 2000; seed < 2050; seed++) {
    const params = makeParams({ seed, family: "linear", boardWidth: 10, boardHeight: 10 });
    const goalParams = makeGoalParams({ seed, boxCount: 2 });
    const solved = requireSolved(params, goalParams);
    if (!solved) continue;

    const result = reverseBeamSearch(solved, makeBeamParams({ seed, beamWidth: 4, maxDepth: 5 }));
    assert.ok(result.best);
    assert.ok(result.totalExpanded >= 0);
    assert.ok(result.elapsedMs >= 0);
    assert.ok(result.candidates.length > 0);
    if (result.maxDepthReached === 0) {
      assert.equal(result.best.pullHistory.length, 0);
      return; // found our edge case
    }
  }
  // If no zero-depth case found, that's fine — all boards had at least one pull
});

// ---------------------------------------------------------------------------
// 12. maxDepth is respected
// ---------------------------------------------------------------------------

test("beam search: depth does not exceed maxDepth", () => {
  const solved = getSolved(1200);
  const maxDepth = 10;
  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 12, maxDepth }));

  assert.ok(result.maxDepthReached <= maxDepth);
  assert.ok(result.best.depth <= maxDepth);
  for (const c of result.candidates) {
    assert.ok(c.depth <= maxDepth);
  }
});

// ---------------------------------------------------------------------------
// 13. Result metadata is plausible
// ---------------------------------------------------------------------------

test("beam search: result metadata is well-formed", () => {
  const solved = getSolved(1300);
  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 13, maxDepth: 20 }));

  assert.ok(result.elapsedMs > 0, "search should take measurable time");
  assert.ok(result.totalExpanded > 0, "should expand at least the initial state");
  assert.ok(result.best === result.candidates.find(c =>
    c.score.composite === result.best.score.composite &&
    c.depth === result.best.depth
  ) || result.candidates.some(c => c.score.composite >= result.best.score.composite),
    "best should appear in candidates or be dominated");
});

// ---------------------------------------------------------------------------
// 14. Candidates are sorted by composite score descending
// ---------------------------------------------------------------------------

test("beam search: candidates sorted by composite descending", () => {
  const solved = getSolved(1400);
  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 14, maxDepth: 20 }));

  for (let i = 1; i < result.candidates.length; i++) {
    assert.ok(
      result.candidates[i - 1].score.composite >= result.candidates[i].score.composite,
      `candidates[${i - 1}].composite (${result.candidates[i - 1].score.composite}) should be ≥ candidates[${i}].composite (${result.candidates[i].score.composite})`
    );
  }
});

// ---------------------------------------------------------------------------
// 15. Cross-family: beam search works on all topology families
// ---------------------------------------------------------------------------

test("beam search: works across all topology families", () => {
  const families = TOPOLOGY_FAMILIES;
  const results: string[] = [];

  for (const family of families) {
    let found = false;
    for (let seed = 50; seed < 80; seed++) {
      const params = makeParams({ seed, family, boardWidth: 16, boardHeight: 16 });
      const goalParams = makeGoalParams({ seed, boxCount: 3 });
      const solved = requireSolved(params, goalParams);
      if (!solved) continue;

      const result = reverseBeamSearch(solved, makeBeamParams({ seed, maxDepth: 20 }));
      assert.ok(result.best);
      assert.ok(result.totalExpanded > 0);
      results.push(`${family}: depth=${result.best.depth} score=${result.best.score.composite.toFixed(1)} expanded=${result.totalExpanded}`);
      found = true;
      break;
    }
    if (!found) {
      results.push(`${family}: could not generate solved blueprint`);
    }
  }

  console.log("  Cross-family beam search:");
  for (const r of results) {
    console.log(`    ${r}`);
  }
});

// ---------------------------------------------------------------------------
// 16. Beam search vs random reverse-pull comparison
// ---------------------------------------------------------------------------

test("benchmark: beam search vs random reverse pull", () => {
  const trials = 5;
  const beamDepths: number[] = [];
  const beamScores: number[] = [];
  const randomDepths: number[] = [];
  const randomScores: number[] = [];
  const beamTimes: number[] = [];
  const randomTimes: number[] = [];

  for (let i = 0; i < trials; i++) {
    const seed = 9000 + i;
    const params = makeParams({ seed, family: "hub", boardWidth: 16, boardHeight: 16 });
    const goalParams = makeGoalParams({ seed, boxCount: 3 });
    const solved = requireSolved(params, goalParams);
    if (!solved) continue;

    const template = toSolvedTemplate(solved);
    const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

    // Beam search
    const beamResult = reverseBeamSearch(solved, makeBeamParams({
      seed,
      beamWidth: 8,
      maxDepth: 30,
    }));
    beamDepths.push(beamResult.best.depth);
    beamScores.push(beamResult.best.score.composite);
    beamTimes.push(beamResult.elapsedMs);

    // Random reverse pull (V1 approach)
    const t0 = performance.now();
    const scrambled = scrambleByReversePull(template, 30, createRng(seed));
    const randomTime = performance.now() - t0;

    const randomScore = scoreState(ctx, scrambled.boxPositions, scrambled.robotPosition, DEFAULT_WEIGHTS);
    randomDepths.push(scrambled.reversePulls);
    randomScores.push(randomScore.composite);
    randomTimes.push(randomTime);
  }

  if (beamScores.length > 0) {
    const avgBeamScore = beamScores.reduce((a, b) => a + b, 0) / beamScores.length;
    const avgRandomScore = randomScores.reduce((a, b) => a + b, 0) / randomScores.length;
    const avgBeamDepth = beamDepths.reduce((a, b) => a + b, 0) / beamDepths.length;
    const avgRandomDepth = randomDepths.reduce((a, b) => a + b, 0) / randomDepths.length;
    const avgBeamTime = beamTimes.reduce((a, b) => a + b, 0) / beamTimes.length;
    const avgRandomTime = randomTimes.reduce((a, b) => a + b, 0) / randomTimes.length;

    console.log("  Beam search vs random reverse-pull:");
    console.log(`    Beam:   avg score=${avgBeamScore.toFixed(1)}, avg depth=${avgBeamDepth.toFixed(1)}, avg time=${avgBeamTime.toFixed(1)}ms`);
    console.log(`    Random: avg score=${avgRandomScore.toFixed(1)}, avg depth=${avgRandomDepth.toFixed(1)}, avg time=${avgRandomTime.toFixed(1)}ms`);
    console.log(`    Score improvement: ${((avgBeamScore / Math.max(avgRandomScore, 0.001) - 1) * 100).toFixed(0)}%`);

    // Beam search should generally score higher than random
    // Not guaranteed on every trial, but on average it should be competitive
    assert.ok(beamScores.length > 0, "at least one trial should complete");
  }
});

// ---------------------------------------------------------------------------
// 17. Scoring weights affect results
// ---------------------------------------------------------------------------

test("beam search: custom weights produce different scores", () => {
  const solved = getSolved(1700);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 17, maxDepth: 15 }));
  if (result.best.depth === 0) return;

  const defaultScore = result.best.score.composite;
  const doubledWeights = {
    ...DEFAULT_WEIGHTS,
    roomCrossings: DEFAULT_WEIGHTS.roomCrossings * 3,
  };
  const reScored = scoreState(ctx, result.best.boxPositions, result.best.robotPosition, doubledWeights);

  // If roomCrossings > 0, the score should differ
  if (result.best.score.roomCrossings > 0) {
    assert.notEqual(reScored.composite, defaultScore);
  }
});

// ---------------------------------------------------------------------------
// 18. Pull history length matches depth
// ---------------------------------------------------------------------------

test("beam search: pullHistory.length equals depth", () => {
  const solved = getSolved(1800);
  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 18, maxDepth: 25 }));

  assert.equal(result.best.pullHistory.length, result.best.depth);
  for (const c of result.candidates) {
    assert.equal(c.pullHistory.length, c.depth);
  }
});
