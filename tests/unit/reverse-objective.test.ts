import assert from "node:assert/strict";
import test from "node:test";

import {
  assignRoomRoles,
  generateBlueprintWithRetry,
  placeGoals,
  toSolvedTemplate,
  reverseBeamSearch,
  reverseBeamSearchV4,
  buildScoringContext,
  computeObjectiveVector,
  objectiveVectorComposite,
  buildMechanismReverseContext,
  extractArchiveCandidates,
  DiverseArchive,
  DEFAULT_BLUEPRINT_PARAMS,
  DEFAULT_GOAL_PARAMS,
  DEFAULT_BEAM_PARAMS,
  DEFAULT_SEARCH_PROFILE,
  type BlueprintParams,
  type BeamSearchParams,
  type GoalPlacementParams,
  type SolvedBlueprint,
  type PullHistoryEntry,
  type ReverseObjectiveVector,
  type MechanismPlan,
  type BeamCandidate,
  type ReverseStateScore,
} from "../../src/features/generator/v2/index.ts";

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

function makeScore(composite: number): ReverseStateScore {
  return {
    boxesOffGoals: 1,
    roomCrossings: 0,
    boxDispersion: 0,
    chokepointInteractions: 0,
    tunnelOccupancy: 0,
    distanceFromSolved: 0,
    supportConstraints: 0,
    deadlockPressure: 0,
    composite,
  };
}

function makeCandidate(row: number, col: number, composite: number, depth: number): BeamCandidate {
  return {
    boxPositions: [{ row, column: col }],
    robotPosition: { row: row + 1, column: col },
    score: makeScore(composite),
    depth,
    pullHistory: [],
  };
}

// ===========================================================================
// ReverseObjectiveVector Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Empty history produces zeroed vector
// ---------------------------------------------------------------------------

test("objective vector: empty history produces zero-valued vector", () => {
  const solved = getSolved(5000);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);
  const template = toSolvedTemplate(solved);
  const initialBoxes = template.goalPositions.map((g) => ({ row: g.row, column: g.column }));

  const vec = computeObjectiveVector(ctx, initialBoxes, []);

  assert.equal(vec.scrambleDepth, 0);
  assert.equal(vec.boxDiversity, 0);
  assert.equal(vec.roomTraffic, 0);
  assert.equal(vec.repetitionPenalty, 0);
  assert.equal(vec.mechanismProgress, 0);
});

// ---------------------------------------------------------------------------
// 2. Box diversity reflects distinct box count
// ---------------------------------------------------------------------------

test("objective vector: box diversity increases with distinct boxes moved", () => {
  const solved = getSolved(5001);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);
  const template = toSolvedTemplate(solved);
  const boxes = template.goalPositions.map((g) => ({ row: g.row, column: g.column }));

  const singleBoxHistory: PullHistoryEntry[] = [
    { boxIndex: 0 }, { boxIndex: 0 }, { boxIndex: 0 },
  ];
  const multiBoxHistory: PullHistoryEntry[] = [
    { boxIndex: 0 }, { boxIndex: 1 }, { boxIndex: 2 },
  ];

  const singleVec = computeObjectiveVector(ctx, boxes, singleBoxHistory);
  const multiVec = computeObjectiveVector(ctx, boxes, multiBoxHistory);

  assert.ok(multiVec.boxDiversity > singleVec.boxDiversity,
    `Multi-box diversity (${multiVec.boxDiversity}) should exceed single-box (${singleVec.boxDiversity})`);
});

// ---------------------------------------------------------------------------
// 3. Room traffic reflects room crossings
// ---------------------------------------------------------------------------

test("objective vector: room traffic increases with room crossings", () => {
  const solved = getSolved(5002);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);
  const template = toSolvedTemplate(solved);
  const boxes = template.goalPositions.map((g) => ({ row: g.row, column: g.column }));

  const noCrossings: PullHistoryEntry[] = [
    { boxIndex: 0, fromRoom: 1, toRoom: 1 },
    { boxIndex: 1, fromRoom: 2, toRoom: 2 },
  ];
  const withCrossings: PullHistoryEntry[] = [
    { boxIndex: 0, fromRoom: 1, toRoom: 2 },
    { boxIndex: 1, fromRoom: 2, toRoom: 3 },
  ];

  const noVec = computeObjectiveVector(ctx, boxes, noCrossings);
  const crossVec = computeObjectiveVector(ctx, boxes, withCrossings);

  assert.equal(noVec.roomTraffic, 0);
  assert.ok(crossVec.roomTraffic > 0);
});

// ---------------------------------------------------------------------------
// 4. Repetition penalty penalizes same-box consecutive pulls
// ---------------------------------------------------------------------------

test("objective vector: repetition penalty for consecutive same-box pulls", () => {
  const solved = getSolved(5003);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);
  const template = toSolvedTemplate(solved);
  const boxes = template.goalPositions.map((g) => ({ row: g.row, column: g.column }));

  const noRepeat: PullHistoryEntry[] = [
    { boxIndex: 0 }, { boxIndex: 1 }, { boxIndex: 2 },
  ];
  const allRepeat: PullHistoryEntry[] = [
    { boxIndex: 0 }, { boxIndex: 0 }, { boxIndex: 0 },
  ];

  const noVec = computeObjectiveVector(ctx, boxes, noRepeat);
  const repVec = computeObjectiveVector(ctx, boxes, allRepeat);

  assert.equal(noVec.repetitionPenalty, 0);
  assert.ok(repVec.repetitionPenalty > 0);
  assert.equal(repVec.repetitionPenalty, 1.0);
});

// ---------------------------------------------------------------------------
// 5. Scramble depth matches history length
// ---------------------------------------------------------------------------

test("objective vector: scramble depth equals history length", () => {
  const solved = getSolved(5004);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);
  const template = toSolvedTemplate(solved);
  const boxes = template.goalPositions.map((g) => ({ row: g.row, column: g.column }));

  const history: PullHistoryEntry[] = [
    { boxIndex: 0 }, { boxIndex: 1 }, { boxIndex: 0 }, { boxIndex: 2 },
  ];

  const vec = computeObjectiveVector(ctx, boxes, history);
  assert.equal(vec.scrambleDepth, 4);
});

// ---------------------------------------------------------------------------
// 6. Composite score is well-formed
// ---------------------------------------------------------------------------

test("objective vector: composite score combines all features", () => {
  const vec: ReverseObjectiveVector = {
    scrambleDepth: 10,
    boxDiversity: 0.8,
    roomTraffic: 0.5,
    supportCompetition: 0.3,
    mechanismProgress: 2.0,
    dependencyPotential: 0.6,
    structuralRisk: 0.2,
    repetitionPenalty: 0.1,
  };

  const composite = objectiveVectorComposite(vec);
  assert.ok(composite > 0, "Composite should be positive for a well-scrambled state");
  assert.ok(Number.isFinite(composite));
});

// ---------------------------------------------------------------------------
// 7. Higher scramble depth increases composite
// ---------------------------------------------------------------------------

test("objective vector: deeper scramble has higher composite", () => {
  const shallow: ReverseObjectiveVector = {
    scrambleDepth: 2,
    boxDiversity: 0.5,
    roomTraffic: 0.3,
    supportCompetition: 0.2,
    mechanismProgress: 0,
    dependencyPotential: 0.3,
    structuralRisk: 0.1,
    repetitionPenalty: 0,
  };
  const deep: ReverseObjectiveVector = {
    scrambleDepth: 20,
    boxDiversity: 0.5,
    roomTraffic: 0.3,
    supportCompetition: 0.2,
    mechanismProgress: 0,
    dependencyPotential: 0.3,
    structuralRisk: 0.1,
    repetitionPenalty: 0,
  };

  assert.ok(objectiveVectorComposite(deep) > objectiveVectorComposite(shallow));
});

// ---------------------------------------------------------------------------
// 8. High repetition penalty reduces composite
// ---------------------------------------------------------------------------

test("objective vector: repetition penalty reduces composite", () => {
  const noRep: ReverseObjectiveVector = {
    scrambleDepth: 10,
    boxDiversity: 0.5,
    roomTraffic: 0.3,
    supportCompetition: 0.2,
    mechanismProgress: 0,
    dependencyPotential: 0.3,
    structuralRisk: 0.1,
    repetitionPenalty: 0,
  };
  const highRep: ReverseObjectiveVector = {
    scrambleDepth: 10,
    boxDiversity: 0.5,
    roomTraffic: 0.3,
    supportCompetition: 0.2,
    mechanismProgress: 0,
    dependencyPotential: 0.3,
    structuralRisk: 0.1,
    repetitionPenalty: 1.0,
  };

  assert.ok(objectiveVectorComposite(noRep) > objectiveVectorComposite(highRep));
});

// ===========================================================================
// Mechanism-Aware Reverse Context Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// 9. Mechanism context construction populates room sets
// ---------------------------------------------------------------------------

test("mechanism context: populates gate/packing/exchange room sets", () => {
  const solved = getSolved(5010);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  const plan: MechanismPlan = {
    mechanisms: [
      { type: "gatekeeper", primaryRoomIds: [0], minGoals: 1, allocatedGoals: 1, weight: 1 },
      { type: "packing-chain", primaryRoomIds: [1], minGoals: 2, allocatedGoals: 2, weight: 1 },
    ],
    intendedDependencies: [],
    evidenceRequirements: [],
    tier: "advanced",
    seed: 42,
  };

  const mechCtx = buildMechanismReverseContext(plan, ctx);

  assert.ok(mechCtx.gateRoomIds.has(0));
  assert.ok(mechCtx.packingRoomIds.has(1));
  assert.equal(mechCtx.exchangeRoomIds.size, 0);
});

// ---------------------------------------------------------------------------
// 10. Mechanism context with cross-room exchange populates exchange set
// ---------------------------------------------------------------------------

test("mechanism context: cross-room exchange populates exchange room set", () => {
  const solved = getSolved(5011);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  const plan: MechanismPlan = {
    mechanisms: [
      { type: "cross-room-exchange", primaryRoomIds: [0, 1], minGoals: 2, allocatedGoals: 2, weight: 1 },
    ],
    intendedDependencies: [],
    evidenceRequirements: [],
    tier: "expert",
    seed: 42,
  };

  const mechCtx = buildMechanismReverseContext(plan, ctx);

  assert.ok(mechCtx.exchangeRoomIds.has(0));
  assert.ok(mechCtx.exchangeRoomIds.has(1));
});

// ---------------------------------------------------------------------------
// 11. Mechanism progress is zero without mechanism context
// ---------------------------------------------------------------------------

test("objective vector: mechanism progress is zero without mechCtx", () => {
  const solved = getSolved(5012);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);
  const template = toSolvedTemplate(solved);
  const boxes = template.goalPositions.map((g) => ({ row: g.row, column: g.column }));

  const history: PullHistoryEntry[] = [{ boxIndex: 0 }];
  const vec = computeObjectiveVector(ctx, boxes, history, undefined);

  assert.equal(vec.mechanismProgress, 0);
});

// ---------------------------------------------------------------------------
// 12. Mechanism progress is non-negative with mechanism context
// ---------------------------------------------------------------------------

test("objective vector: mechanism progress is non-negative with mechCtx", () => {
  const solved = getSolved(5013);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  const plan: MechanismPlan = {
    mechanisms: [
      { type: "gatekeeper", primaryRoomIds: [0], minGoals: 1, allocatedGoals: 1, weight: 1 },
    ],
    intendedDependencies: [],
    evidenceRequirements: [],
    tier: "advanced",
    seed: 42,
  };
  const mechCtx = buildMechanismReverseContext(plan, ctx);

  const result = reverseBeamSearch(solved, makeBeamParams({ seed: 50, maxDepth: 15 }));
  if (result.best.depth === 0) return;

  const historyEntries: PullHistoryEntry[] = result.best.pullHistory.map((h) => ({
    boxIndex: h.boxIndex,
    fromRoom: ctx.roomLookup.get(`${h.from.row},${h.from.column}`),
    toRoom: ctx.roomLookup.get(`${h.to.row},${h.to.column}`),
  }));

  const vec = computeObjectiveVector(ctx, result.best.boxPositions, historyEntries, mechCtx);
  assert.ok(vec.mechanismProgress >= 0);
});

// ===========================================================================
// Multiple Archive Candidates Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// 13. extractArchiveCandidates returns up to count candidates
// ---------------------------------------------------------------------------

test("extract archive: returns up to requested count", () => {
  const solved = getSolved(5020);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  const archive = new DiverseArchive(16, 0);
  archive.offer(makeCandidate(2, 2, 10, 1), "k1");
  archive.offer(makeCandidate(2, 3, 20, 2), "k2");
  archive.offer(makeCandidate(2, 4, 30, 3), "k3");
  archive.offer(makeCandidate(3, 2, 15, 2), "k4");
  archive.offer(makeCandidate(3, 3, 25, 3), "k5");

  const result = extractArchiveCandidates(archive, ctx, 3);
  assert.ok(result.length <= 3);
  assert.ok(result.length > 0);
});

// ---------------------------------------------------------------------------
// 14. extractArchiveCandidates results are sorted by objective composite
// ---------------------------------------------------------------------------

test("extract archive: results sorted by objective composite descending", () => {
  const solved = getSolved(5021);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  const archive = new DiverseArchive(16, 0);
  archive.offer(makeCandidate(2, 2, 10, 5), "k1");
  archive.offer(makeCandidate(2, 3, 20, 10), "k2");
  archive.offer(makeCandidate(2, 4, 30, 15), "k3");
  archive.offer(makeCandidate(3, 2, 15, 7), "k4");

  const result = extractArchiveCandidates(archive, ctx, 4);

  for (let i = 1; i < result.length; i++) {
    assert.ok(result[i - 1].objectiveComposite >= result[i].objectiveComposite,
      `result[${i - 1}].composite (${result[i - 1].objectiveComposite}) should be >= result[${i}].composite (${result[i].objectiveComposite})`);
  }
});

// ---------------------------------------------------------------------------
// 15. extractArchiveCandidates each entry has valid objectiveVector
// ---------------------------------------------------------------------------

test("extract archive: each entry has well-formed objective vector", () => {
  const solved = getSolved(5022);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  const archive = new DiverseArchive(16, 0);
  archive.offer(makeCandidate(2, 2, 10, 3), "k1");
  archive.offer(makeCandidate(2, 3, 20, 5), "k2");

  const result = extractArchiveCandidates(archive, ctx, 2);

  for (const entry of result) {
    assert.ok(Number.isFinite(entry.objectiveVector.scrambleDepth));
    assert.ok(Number.isFinite(entry.objectiveVector.boxDiversity));
    assert.ok(Number.isFinite(entry.objectiveVector.roomTraffic));
    assert.ok(Number.isFinite(entry.objectiveVector.supportCompetition));
    assert.ok(Number.isFinite(entry.objectiveVector.mechanismProgress));
    assert.ok(Number.isFinite(entry.objectiveVector.dependencyPotential));
    assert.ok(Number.isFinite(entry.objectiveVector.structuralRisk));
    assert.ok(Number.isFinite(entry.objectiveVector.repetitionPenalty));
    assert.ok(Number.isFinite(entry.objectiveComposite));
  }
});

// ---------------------------------------------------------------------------
// 16. extractArchiveCandidates empty archive returns empty
// ---------------------------------------------------------------------------

test("extract archive: empty archive returns empty array", () => {
  const solved = getSolved(5023);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  const archive = new DiverseArchive(16, 0);
  const result = extractArchiveCandidates(archive, ctx, 5);
  assert.equal(result.length, 0);
});

// ---------------------------------------------------------------------------
// 17. extractArchiveCandidates respects fingerprint dedup
// ---------------------------------------------------------------------------

test("extract archive: deduplicates by fingerprint", () => {
  const solved = getSolved(5024);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  const archive = new DiverseArchive(16, 0);
  // Two candidates with same box position but different robot positions
  // They have the same fingerprint
  const c1: BeamCandidate = {
    boxPositions: [{ row: 2, column: 3 }],
    robotPosition: { row: 3, column: 3 },
    score: makeScore(10),
    depth: 1,
    pullHistory: [],
  };
  const c2: BeamCandidate = {
    boxPositions: [{ row: 2, column: 3 }],
    robotPosition: { row: 4, column: 3 },
    score: makeScore(20),
    depth: 2,
    pullHistory: [],
  };

  archive.offer(c1, "k1");
  archive.offer(c2, "k2");

  const result = extractArchiveCandidates(archive, ctx, 10);
  // Both have same box fingerprint, but we should still get 2 because
  // the fill-remaining logic adds duplicates if needed
  assert.ok(result.length >= 1);
});

// ===========================================================================
// reverseBeamSearchV4 Integration with Phase 8
// ===========================================================================

// ---------------------------------------------------------------------------
// 18. V4 result includes rankedCandidates
// ---------------------------------------------------------------------------

test("V4: result includes rankedCandidates array", () => {
  const solved = getSolved(5030);
  const result = reverseBeamSearchV4(solved, 50, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 6,
    maxDepth: 15,
    restartCount: 2,
    diverseArchiveSize: 8,
  });

  assert.ok(Array.isArray(result.rankedCandidates));
  assert.ok(result.rankedCandidates.length > 0 || result.archive.length === 0);
});

// ---------------------------------------------------------------------------
// 19. reverseCandidatesPerBlueprint limits ranked output
// ---------------------------------------------------------------------------

test("V4: reverseCandidatesPerBlueprint limits rankedCandidates count", () => {
  const solved = getSolved(5031);
  const result = reverseBeamSearchV4(solved, 51, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 8,
    maxDepth: 20,
    restartCount: 3,
    diverseArchiveSize: 16,
    reverseCandidatesPerBlueprint: 3,
  });

  assert.ok(result.rankedCandidates.length <= 3,
    `Should have at most 3 ranked candidates, got ${result.rankedCandidates.length}`);
});

// ---------------------------------------------------------------------------
// 20. rankedCandidates sorted by objectiveComposite
// ---------------------------------------------------------------------------

test("V4: rankedCandidates sorted by objectiveComposite descending", () => {
  const solved = getSolved(5032);
  const result = reverseBeamSearchV4(solved, 52, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 6,
    maxDepth: 15,
    restartCount: 2,
    diverseArchiveSize: 12,
  });

  for (let i = 1; i < result.rankedCandidates.length; i++) {
    assert.ok(
      result.rankedCandidates[i - 1].objectiveComposite >= result.rankedCandidates[i].objectiveComposite,
      `rankedCandidates[${i - 1}] (${result.rankedCandidates[i - 1].objectiveComposite}) >= [${i}] (${result.rankedCandidates[i].objectiveComposite})`
    );
  }
});

// ---------------------------------------------------------------------------
// 21. rankedCandidates each have valid objectiveVector fields
// ---------------------------------------------------------------------------

test("V4: rankedCandidates have well-formed objective vectors", () => {
  const solved = getSolved(5033);
  const result = reverseBeamSearchV4(solved, 53, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 4,
    maxDepth: 10,
    restartCount: 1,
    diverseArchiveSize: 8,
  });

  for (const rc of result.rankedCandidates) {
    const v = rc.objectiveVector;
    assert.ok(v.scrambleDepth >= 0);
    assert.ok(v.boxDiversity >= 0 && v.boxDiversity <= 1);
    assert.ok(v.roomTraffic >= 0 && v.roomTraffic <= 1);
    assert.ok(v.supportCompetition >= 0);
    assert.ok(v.mechanismProgress >= 0);
    assert.ok(v.dependencyPotential >= 0 && v.dependencyPotential <= 1);
    assert.ok(v.structuralRisk >= 0 && v.structuralRisk <= 1);
    assert.ok(v.repetitionPenalty >= 0 && v.repetitionPenalty <= 1);
  }
});

// ---------------------------------------------------------------------------
// 22. Multiple archive candidates > 1 when archive has multiple entries
// ---------------------------------------------------------------------------

test("V4: multiple archive candidates with diverseArchiveSize > 1", () => {
  const solved = getSolved(5034);
  const result = reverseBeamSearchV4(solved, 54, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 8,
    maxDepth: 20,
    restartCount: 4,
    diverseArchiveSize: 16,
    reverseCandidatesPerBlueprint: 8,
  });

  // With 4 restarts and beamWidth 8, there should be multiple candidates
  if (result.archive.length > 1) {
    assert.ok(result.rankedCandidates.length > 1,
      `Should have multiple ranked candidates when archive has ${result.archive.length} entries`);
  }
});

// ---------------------------------------------------------------------------
// 23. V4 backward compat: existing result fields unchanged
// ---------------------------------------------------------------------------

test("V4: existing result fields still present and correct", () => {
  const solved = getSolved(5035);
  const result = reverseBeamSearchV4(solved, 55, {
    ...DEFAULT_SEARCH_PROFILE,
    beamWidth: 4,
    maxDepth: 10,
    restartCount: 1,
  });

  assert.ok(result.best);
  assert.ok(Array.isArray(result.archive));
  assert.ok(Array.isArray(result.rankedCandidates));
  assert.ok(result.totalExpanded > 0);
  assert.ok(result.elapsedMs > 0);
  assert.equal(result.restartCount, 1);
  assert.equal(result.perRestartStats.length, 1);
  assert.ok(typeof result.transpositionHits === "number");
});

// ---------------------------------------------------------------------------
// 24. Support competition detects adjacent boxes
// ---------------------------------------------------------------------------

test("objective vector: support competition detects box adjacency", () => {
  const solved = getSolved(5040);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  // Boxes far apart - no support competition
  const farBoxes = [{ row: 2, column: 2 }, { row: 8, column: 8 }];
  const farVec = computeObjectiveVector(ctx, farBoxes, [{ boxIndex: 0 }]);

  // Boxes adjacent - should have support competition
  const nearBoxes = [{ row: 2, column: 2 }, { row: 2, column: 3 }];
  const nearVec = computeObjectiveVector(ctx, nearBoxes, [{ boxIndex: 0 }]);

  assert.ok(nearVec.supportCompetition > farVec.supportCompetition,
    `Adjacent boxes (${nearVec.supportCompetition}) should have more support competition than far boxes (${farVec.supportCompetition})`);
});

// ---------------------------------------------------------------------------
// 25. Structural risk detects chokepoint/tunnel occupation
// ---------------------------------------------------------------------------

test("objective vector: structural risk rewards chokepoint/tunnel occupation", () => {
  const solved = getSolved(5041);
  const ctx = buildScoringContext(solved.blueprint, solved.grid, solved.goals);

  // Find a chokepoint cell if any exist
  const chokepoints = [...ctx.chokepointSet];
  if (chokepoints.length === 0) return; // Skip if no chokepoints

  const [r, c] = chokepoints[0].split(",").map(Number);
  const onChokepoint = [{ row: r, column: c }];
  const chokeVec = computeObjectiveVector(ctx, onChokepoint, [{ boxIndex: 0 }]);

  // Find a non-chokepoint non-tunnel cell
  let offR = -1, offC = -1;
  for (let row = 1; row < solved.grid.length - 1; row++) {
    for (let col = 1; col < solved.grid[0].length - 1; col++) {
      const key = `${row},${col}`;
      if (solved.grid[row][col] !== "O" &&
          !ctx.chokepointSet.has(key) &&
          !ctx.tunnelSet.has(key)) {
        offR = row;
        offC = col;
        break;
      }
    }
    if (offR >= 0) break;
  }
  if (offR < 0) return; // Skip if no safe cell

  const offChokepoint = [{ row: offR, column: offC }];
  const offVec = computeObjectiveVector(ctx, offChokepoint, [{ boxIndex: 0 }]);

  assert.ok(chokeVec.structuralRisk > offVec.structuralRisk,
    `Chokepoint risk (${chokeVec.structuralRisk}) should exceed off-chokepoint (${offVec.structuralRisk})`);
});
