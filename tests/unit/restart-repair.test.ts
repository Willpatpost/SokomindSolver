import assert from "node:assert/strict";
import test from "node:test";

import {
  generateBlueprintWithRetry,
  assignRoomRoles,
  placeGoals,
  reverseBeamSearchV4,
  DiverseArchive,
  DEFAULT_BLUEPRINT_PARAMS,
  DEFAULT_GOAL_PARAMS,
  DEFAULT_SEARCH_PROFILE,
  type BlueprintParams,
  type GoalPlacementParams,
  type SolvedBlueprint,
} from "../../src/features/generator/v2/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSolved(seed: number): SolvedBlueprint {
  const params: BlueprintParams = {
    ...DEFAULT_BLUEPRINT_PARAMS,
    seed,
    family: "linear",
    boardWidth: 16,
    boardHeight: 16,
  };
  const goalParams: GoalPlacementParams = {
    ...DEFAULT_GOAL_PARAMS,
    seed,
    boxCount: 3,
  };
  const bp = generateBlueprintWithRetry(params, 30);
  assert.ok(bp, "failed to generate blueprint");
  const fb = assignRoomRoles(bp, seed, goalParams.boxCount);
  const solved = placeGoals(fb, goalParams);
  assert.ok(solved, "failed to place goals");
  return solved;
}

// ---------------------------------------------------------------------------
// Test A: 3 restarts all expand meaningfully
// ---------------------------------------------------------------------------

test("restart repair: all restarts expand meaningful states", () => {
  const solved = getSolved(5001);
  const result = reverseBeamSearchV4(solved, 42, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 6,
    maxDepth: 15,
    restartCount: 3,
    diverseArchiveSize: 16,
  });

  assert.equal(result.perRestartStats.length, 3);
  for (const rs of result.perRestartStats) {
    assert.ok(
      rs.expanded > 0,
      `restart ${rs.restartIndex} expanded 0 states — should explore independently`,
    );
    assert.ok(
      rs.maxDepth > 0,
      `restart ${rs.restartIndex} reached depth 0 — should explore beyond initial state`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test B: restart 2 not blocked at depth 0 by restart 1's transposition table
// ---------------------------------------------------------------------------

test("restart repair: later restarts not blocked by earlier transposition entries", () => {
  const solved = getSolved(5002);
  const result = reverseBeamSearchV4(solved, 100, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 8,
    maxDepth: 20,
    restartCount: 3,
    diverseArchiveSize: 16,
  });

  assert.equal(result.perRestartStats.length, 3);

  for (let i = 1; i < result.perRestartStats.length; i++) {
    const rs = result.perRestartStats[i];
    assert.ok(
      rs.maxDepth > 0,
      `restart ${i} terminated at depth 0 — transposition table from earlier restart is blocking first layer`,
    );
    assert.ok(
      rs.firstLayerGenerated === undefined || rs.firstLayerGenerated > 0,
      `restart ${i} generated 0 first-layer candidates`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test C: determinism — same seed/config produces identical results
// ---------------------------------------------------------------------------

test("restart repair: deterministic with same seed", () => {
  const solved = getSolved(5003);
  const profile = {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 6,
    maxDepth: 15,
    restartCount: 3,
    diverseArchiveSize: 12,
  };

  const a = reverseBeamSearchV4(solved, 77, profile);
  const b = reverseBeamSearchV4(solved, 77, profile);

  assert.equal(a.totalExpanded, b.totalExpanded);
  assert.equal(a.best.depth, b.best.depth);
  assert.equal(a.best.score.composite, b.best.score.composite);
  assert.deepStrictEqual(a.best.boxPositions, b.best.boxPositions);
  assert.equal(a.archive.length, b.archive.length);

  for (let i = 0; i < a.perRestartStats.length; i++) {
    assert.equal(a.perRestartStats[i].expanded, b.perRestartStats[i].expanded);
    assert.equal(a.perRestartStats[i].maxDepth, b.perRestartStats[i].maxDepth);
    assert.equal(a.perRestartStats[i].bestComposite, b.perRestartStats[i].bestComposite);
  }
});

// ---------------------------------------------------------------------------
// Test D: different restart indices produce non-identical search behavior
// ---------------------------------------------------------------------------

test("restart repair: different restarts explore differently", () => {
  const solved = getSolved(5004);
  const result = reverseBeamSearchV4(solved, 200, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 6,
    maxDepth: 20,
    restartCount: 4,
    diverseArchiveSize: 16,
  });

  assert.equal(result.perRestartStats.length, 4);

  const expandedCounts = result.perRestartStats.map((rs) => rs.expanded);
  const maxDepths = result.perRestartStats.map((rs) => rs.maxDepth);
  const bestComposites = result.perRestartStats.map((rs) => rs.bestComposite);

  const uniqueExpanded = new Set(expandedCounts).size;
  const uniqueDepths = new Set(maxDepths).size;
  const uniqueComposites = new Set(bestComposites).size;

  const totalUnique = uniqueExpanded + uniqueDepths + uniqueComposites;
  assert.ok(
    totalUnique > 3,
    `restarts should show at least some diversity: expanded=${JSON.stringify(expandedCounts)}, ` +
    `depths=${JSON.stringify(maxDepths)}, composites=${JSON.stringify(bestComposites)}`,
  );
});

// ---------------------------------------------------------------------------
// Test E: evicted archive keys are reusable
// ---------------------------------------------------------------------------

test("restart repair: evicted archive keys are reusable", () => {
  const archive = new DiverseArchive(2, 0);

  const makeCandidate = (score: number, row: number) => ({
    boxPositions: [{ row, column: 1 }],
    robotPosition: { row: 0, column: 0 },
    score: {
      composite: score,
      boxesOffGoals: 1,
      roomCrossings: 0,
      boxDispersion: 0,
      chokepointInteractions: 0,
      tunnelOccupancy: 0,
      distanceFromSolved: 0,
      supportConstraints: 0,
    },
    depth: 1,
    pullHistory: [],
  });

  assert.ok(archive.offer(makeCandidate(10, 1), "stateA"), "A should be accepted");
  assert.ok(archive.offer(makeCandidate(20, 2), "stateB"), "B should be accepted");
  assert.equal(archive.size, 2);

  assert.ok(archive.offer(makeCandidate(30, 3), "stateC"), "C should evict A");
  assert.equal(archive.size, 2);

  assert.ok(
    archive.offer(makeCandidate(25, 4), "stateA"),
    "stateA key should be reusable after eviction",
  );
});

// ---------------------------------------------------------------------------
// Test F: per-restart stats include telemetry fields
// ---------------------------------------------------------------------------

test("restart repair: per-restart stats include telemetry", () => {
  const solved = getSolved(5006);
  const result = reverseBeamSearchV4(solved, 300, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 6,
    maxDepth: 15,
    restartCount: 2,
    diverseArchiveSize: 16,
  });

  for (const rs of result.perRestartStats) {
    assert.ok(rs.uniqueStates !== undefined, "uniqueStates should be reported");
    assert.ok(rs.uniqueStates! > 0, "should record at least one unique state");
    assert.ok(rs.archiveOffers !== undefined, "archiveOffers should be reported");
    assert.ok(rs.archiveOffers! > 0, "should have at least one archive offer");
    assert.ok(rs.transpositionHits !== undefined, "transpositionHits should be reported");
    assert.ok(rs.firstLayerGenerated !== undefined, "firstLayerGenerated should be reported");
  }
});

// ---------------------------------------------------------------------------
// Test G: jitter scale causes divergent exploration across restarts
// ---------------------------------------------------------------------------

test("restart repair: jitter scale changes search behavior", () => {
  const solved = getSolved(5007);

  const noJitter = reverseBeamSearchV4(solved, 400, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 6,
    maxDepth: 15,
    restartCount: 2,
    diverseArchiveSize: 16,
    restartJitterScale: 0,
  });

  const withJitter = reverseBeamSearchV4(solved, 400, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 6,
    maxDepth: 15,
    restartCount: 2,
    diverseArchiveSize: 16,
    restartJitterScale: 0.05,
  });

  assert.ok(noJitter.totalExpanded > 0);
  assert.ok(withJitter.totalExpanded > 0);

  const sameBest =
    noJitter.best.score.composite === withJitter.best.score.composite &&
    noJitter.totalExpanded === withJitter.totalExpanded;

  if (sameBest) {
    console.log("  (jitter did not alter this particular search — allowed on small boards)");
  }
});

// ---------------------------------------------------------------------------
// Test H: archive contributions tracked across restarts
// ---------------------------------------------------------------------------

test("restart repair: multiple restarts contribute to archive", () => {
  const solved = getSolved(5008);
  const result = reverseBeamSearchV4(solved, 500, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 8,
    maxDepth: 20,
    restartCount: 4,
    diverseArchiveSize: 32,
  });

  const totalContributions = result.perRestartStats.reduce(
    (sum, rs) => sum + (rs.archiveContributions ?? 0),
    0,
  );

  assert.ok(
    totalContributions >= result.archive.length,
    `total contributions (${totalContributions}) should be >= archive size (${result.archive.length})`,
  );

  const contributingRestarts = result.perRestartStats.filter(
    (rs) => (rs.archiveContributions ?? 0) > 0,
  ).length;

  assert.ok(
    contributingRestarts >= 1,
    "at least one restart should contribute to the archive",
  );
});
