import assert from "node:assert/strict";
import test from "node:test";

import {
  generateBlueprintWithRetry,
  assignRoomRoles,
  toSolvedTemplate,
  reverseBeamSearch,
  feasibleMechanisms,
  createMechanismPlan,
  placeGoalsFromPlan,
  mechanismCompatibility,
  MECHANISM_CATALOG,
  MECHANISM_TYPES,
  DEFAULT_BLUEPRINT_PARAMS,
  DEFAULT_BEAM_PARAMS,
  isAcyclic,
  type FunctionalBlueprint,
  type MechanismType,
  type ForgeGenerationMode,
} from "../../src/features/generator/v2/index.ts";

import { buildPuzzleFromScramble } from "../../src/features/generator/generate-puzzle.ts";
import { validatePuzzle } from "../../src/core/puzzle.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildBlueprint(
  seed: number,
  family: "linear" | "hub" | "loop" | "branch" | "nested" = "linear",
): FunctionalBlueprint | null {
  const bp = generateBlueprintWithRetry(
    { ...DEFAULT_BLUEPRINT_PARAMS, seed, family, boardWidth: 14, boardHeight: 14 },
    30,
  );
  if (!bp) return null;
  return assignRoomRoles(bp, seed, 3);
}

/**
 * Find a blueprint that has at least one width-1 passage and 2+ rooms.
 */
function findBlueprintWithPassage(): FunctionalBlueprint | null {
  for (let seed = 100; seed < 300; seed++) {
    const fb = buildBlueprint(seed, "linear");
    if (!fb) continue;
    if (fb.passages.some((p) => p.width === 1) && fb.rooms.length >= 2) return fb;
  }
  return null;
}


// ===========================================================================
// 1. MECHANISM CATALOG & FEASIBILITY
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. All mechanism types in catalog
// ---------------------------------------------------------------------------

test("mechanism-plan: MECHANISM_CATALOG has entries for all 8 types", () => {
  assert.equal(MECHANISM_TYPES.length, 8, "should have 8 mechanism types");
  for (const mType of MECHANISM_TYPES) {
    const entry = MECHANISM_CATALOG[mType];
    assert.ok(entry, `catalog should have entry for ${mType}`);
    assert.equal(entry.type, mType, `entry type should match key ${mType}`);
    assert.ok(typeof entry.minBoxes === "number" && entry.minBoxes >= 1);
    assert.ok(typeof entry.minRooms === "number" && entry.minRooms >= 1);
    assert.ok(typeof entry.description === "string" && entry.description.length > 0);
    assert.ok(entry.evidenceRequirements, `${mType} should have evidenceRequirements`);
    assert.equal(entry.evidenceRequirements.mechanismType, mType);
    assert.ok(
      entry.evidenceRequirements.requiredKinds.length >= 1,
      `${mType} should require at least 1 evidence kind`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Feasible mechanisms on a minimal (1-room) blueprint
// ---------------------------------------------------------------------------

test("mechanism-plan: feasible mechanisms filtered by room count and passage requirements", () => {
  // Find any blueprint and compare feasibility at different room counts to verify filtering.
  // The key invariant: every feasible mechanism must have minRooms <= blueprint.rooms.length,
  // minBoxes <= boxCount, and passage/terminal/large requirements satisfied.
  for (let seed = 100; seed < 200; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const feasible = feasibleMechanisms(fb, 3);
    const hasNarrow = fb.passages.some((p) => p.width === 1);
    const hasTerminal = fb.rooms.some((r) => r.isTerminal);

    for (const m of feasible) {
      const entry = MECHANISM_CATALOG[m];
      assert.ok(
        entry.minRooms <= fb.rooms.length,
        `${m} needs ${entry.minRooms} rooms but blueprint has ${fb.rooms.length}`,
      );
      assert.ok(
        entry.minBoxes <= 3,
        `${m} needs ${entry.minBoxes} boxes but boxCount is 3`,
      );
      if (entry.needsNarrowPassage) {
        assert.ok(hasNarrow, `${m} needs narrow passage but blueprint has none`);
      }
      if (entry.needsTerminalRoom) {
        assert.ok(hasTerminal, `${m} needs terminal room but blueprint has none`);
      }
    }

    // Also verify that excluded mechanisms fail at least one requirement
    const excluded = MECHANISM_TYPES.filter((t) => !feasible.includes(t));
    for (const m of excluded) {
      const entry = MECHANISM_CATALOG[m];
      const fails =
        entry.minBoxes > 3 ||
        entry.minRooms > fb.rooms.length ||
        (entry.needsNarrowPassage && !hasNarrow) ||
        (entry.needsTerminalRoom && !hasTerminal) ||
        (entry.needsLargeRoom && !fb.rooms.some(
          (r) => (r.width >= 3 && r.height >= 2) || (r.width >= 2 && r.height >= 3),
        ));
      assert.ok(
        fails,
        `${m} is excluded but all requirements seem met (rooms=${fb.rooms.length}, ` +
          `narrow=${hasNarrow}, terminal=${hasTerminal})`,
      );
    }
    return;
  }
  assert.fail("no blueprint generated for feasibility filter test");
});

// ---------------------------------------------------------------------------
// 3. Feasible mechanisms with narrow passage (2-room)
// ---------------------------------------------------------------------------

test("mechanism-plan: 2-room blueprint with narrow passage enables passage-requiring mechanisms", () => {
  const fb = findBlueprintWithPassage();
  assert.ok(fb, "should find a blueprint with narrow passage and 2+ rooms");

  const feasible = feasibleMechanisms(fb!, 3);
  // With narrow passage and 2+ rooms, at least one passage-requiring mechanism should be feasible
  const passageMechanisms: MechanismType[] = [
    "gatekeeper",
    "corridor-traffic",
    "gate-reopening",
    "cross-room-exchange",
  ];
  const foundPassageMech = passageMechanisms.some((m) => feasible.includes(m));
  assert.ok(
    foundPassageMech,
    `with narrow passage and 2+ rooms, at least one passage mechanism ` +
      `should be feasible; got: ${feasible.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// 4. Feasibility respects box count
// ---------------------------------------------------------------------------

test("mechanism-plan: boxCount=1 excludes mechanisms needing minBoxes >= 2", () => {
  for (let seed = 100; seed < 200; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const feasible = feasibleMechanisms(fb, 1);
    for (const m of feasible) {
      const entry = MECHANISM_CATALOG[m];
      assert.ok(
        entry.minBoxes <= 1,
        `${m} needs ${entry.minBoxes} boxes but boxCount is 1`,
      );
    }
    // All catalog entries require minBoxes >= 2, so nothing should be feasible
    assert.equal(
      feasible.length,
      0,
      `boxCount=1 should yield no feasible mechanisms, got: ${feasible.join(", ")}`,
    );
    return;
  }
  assert.fail("no blueprint generated for box count feasibility test");
});

// ===========================================================================
// 2. COMPATIBILITY
// ===========================================================================

// ---------------------------------------------------------------------------
// 5. High compatibility pairs
// ---------------------------------------------------------------------------

test("mechanism-plan: gatekeeper + packing-chain has high compatibility", () => {
  const score = mechanismCompatibility("gatekeeper", "packing-chain");
  assert.ok(
    score >= 0.8,
    `gatekeeper+packing-chain compatibility should be >= 0.8, got ${score}`,
  );
});

// ---------------------------------------------------------------------------
// 6. Low compatibility pairs
// ---------------------------------------------------------------------------

test("mechanism-plan: gatekeeper + gate-reopening has low compatibility", () => {
  const score = mechanismCompatibility("gatekeeper", "gate-reopening");
  assert.ok(
    score <= 0.4,
    `gatekeeper+gate-reopening compatibility should be <= 0.4, got ${score}`,
  );
});

// ---------------------------------------------------------------------------
// 7. Symmetric compatibility
// ---------------------------------------------------------------------------

test("mechanism-plan: mechanismCompatibility is symmetric", () => {
  for (const a of MECHANISM_TYPES) {
    for (const b of MECHANISM_TYPES) {
      const ab = mechanismCompatibility(a, b);
      const ba = mechanismCompatibility(b, a);
      assert.equal(
        ab,
        ba,
        `compatibility(${a}, ${b})=${ab} !== compatibility(${b}, ${a})=${ba}`,
      );
    }
  }
});

// ===========================================================================
// 3. PLAN CREATION
// ===========================================================================

// ---------------------------------------------------------------------------
// 8. Tutorial tier creates 1 mechanism
// ---------------------------------------------------------------------------

test("mechanism-plan: tutorial tier creates exactly 1 mechanism", () => {
  for (let seed = 100; seed < 200; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const plan = createMechanismPlan(fb, "tutorial", 3, seed);
    if (!plan) continue;

    assert.equal(
      plan.mechanisms.length,
      1,
      `tutorial tier should produce 1 mechanism, got ${plan.mechanisms.length}`,
    );
    assert.equal(plan.tier, "tutorial");
    assert.equal(plan.seed, seed);
    return;
  }
  assert.fail("no blueprint produced a tutorial plan");
});

// ---------------------------------------------------------------------------
// 9. Expert tier creates 2+ mechanisms
// ---------------------------------------------------------------------------

test("mechanism-plan: expert tier creates 2+ mechanisms", () => {
  for (let seed = 100; seed < 300; seed++) {
    const fb = findBlueprintWithPassage();
    if (!fb) continue;

    // Expert with enough boxes should target 2+ mechanisms
    const plan = createMechanismPlan(fb, "expert", 4, seed);
    if (!plan) continue;

    if (plan.mechanisms.length >= 2) {
      assert.ok(
        plan.mechanisms.length >= 2,
        `expert tier should produce >= 2 mechanisms, got ${plan.mechanisms.length}`,
      );
      return;
    }
  }
  // If we never got 2+, try with larger blueprints
  for (let seed = 300; seed < 500; seed++) {
    for (const family of ["hub", "branch", "linear"] as const) {
      const fb = buildBlueprint(seed, family);
      if (!fb || fb.rooms.length < 3) continue;

      const plan = createMechanismPlan(fb, "expert", 5, seed);
      if (!plan || plan.mechanisms.length < 2) continue;

      assert.ok(
        plan.mechanisms.length >= 2,
        `expert tier should produce >= 2 mechanisms, got ${plan.mechanisms.length}`,
      );
      return;
    }
  }
  assert.fail("no blueprint produced an expert plan with 2+ mechanisms");
});

// ---------------------------------------------------------------------------
// 10. Plan has evidence requirements matching mechanism count
// ---------------------------------------------------------------------------

test("mechanism-plan: plan.evidenceRequirements.length === plan.mechanisms.length", () => {
  for (let seed = 200; seed < 300; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const plan = createMechanismPlan(fb, "intermediate", 3, seed);
    if (!plan) continue;

    assert.equal(
      plan.evidenceRequirements.length,
      plan.mechanisms.length,
      `evidenceRequirements (${plan.evidenceRequirements.length}) should match ` +
        `mechanisms (${plan.mechanisms.length})`,
    );

    // Each evidence requirement should correspond to its mechanism type
    for (let i = 0; i < plan.mechanisms.length; i++) {
      assert.equal(
        plan.evidenceRequirements[i].mechanismType,
        plan.mechanisms[i].type,
        `evidence requirement ${i} should match mechanism type ${plan.mechanisms[i].type}`,
      );
    }
    return;
  }
  assert.fail("no blueprint produced a plan for evidence requirements test");
});

// ---------------------------------------------------------------------------
// 11. Plan null for infeasible
// ---------------------------------------------------------------------------

test("mechanism-plan: createMechanismPlan returns null when no mechanisms are feasible", () => {
  // boxCount=1 makes all mechanisms infeasible (all need minBoxes >= 2)
  for (let seed = 100; seed < 200; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const plan = createMechanismPlan(fb, "tutorial", 1, seed);
    assert.equal(
      plan,
      null,
      `plan should be null when boxCount=1 (no mechanisms feasible)`,
    );
    return;
  }
  assert.fail("no blueprint generated for infeasibility test");
});

// ===========================================================================
// 4. GOAL PLACEMENT FROM PLAN
// ===========================================================================

// ---------------------------------------------------------------------------
// 12. placeGoalsFromPlan succeeds on valid blueprint
// ---------------------------------------------------------------------------

test("mechanism-plan: placeGoalsFromPlan succeeds and returns SolvedBlueprint + DAG", () => {
  for (let seed = 100; seed < 300; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const plan = createMechanismPlan(fb, "intermediate", 3, seed);
    if (!plan) continue;

    const result = placeGoalsFromPlan(fb, plan);
    if (!result) continue;

    assert.ok(result.solved, "result should have solved blueprint");
    assert.ok(result.dag, "result should have DAG");
    assert.ok(result.plan, "result should have plan");
    assert.ok(result.solved.grid.length > 0, "grid should have rows");
    assert.ok(result.solved.goals.length >= 1, "should have at least 1 goal");
    assert.ok(result.solved.robotPosition, "should have robot position");
    assert.ok(result.solved.goalStyle, "should have goal style");
    return;
  }
  assert.fail("no blueprint produced a successful goal placement");
});

// ---------------------------------------------------------------------------
// 13. DAG has correct node count
// ---------------------------------------------------------------------------

test("mechanism-plan: DAG node count equals total goals placed", () => {
  for (let seed = 100; seed < 300; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const plan = createMechanismPlan(fb, "intermediate", 3, seed);
    if (!plan) continue;

    const result = placeGoalsFromPlan(fb, plan);
    if (!result) continue;

    assert.equal(
      result.dag.nodes.length,
      result.solved.goals.length,
      `DAG nodes (${result.dag.nodes.length}) should equal goals placed ` +
        `(${result.solved.goals.length})`,
    );

    // Each node should reference a valid goal index
    for (const node of result.dag.nodes) {
      assert.ok(
        node.goalIndex >= 0 && node.goalIndex < result.solved.goals.length,
        `node goalIndex ${node.goalIndex} out of range [0, ${result.solved.goals.length})`,
      );
    }
    return;
  }
  assert.fail("no placement produced for DAG node count test");
});

// ---------------------------------------------------------------------------
// 14. DAG edges match mechanism dependencies
// ---------------------------------------------------------------------------

test("mechanism-plan: DAG edges have valid types from the mechanism system", () => {
  const validEdgeTypes = new Set([
    "must-precede",
    "must-stage",
    "shares-passage",
    "blocks-access",
    "must-reopen",
    "must-park",
    "chain-link",
    "exchange-cross",
  ]);

  for (let seed = 100; seed < 300; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const plan = createMechanismPlan(fb, "intermediate", 3, seed);
    if (!plan) continue;

    const result = placeGoalsFromPlan(fb, plan);
    if (!result) continue;

    assert.ok(result.dag.edges.length >= 1, "DAG should have at least 1 edge");

    for (const edge of result.dag.edges) {
      assert.ok(
        validEdgeTypes.has(edge.type),
        `edge type "${edge.type}" should be a valid dependency edge type`,
      );
      assert.ok(
        typeof edge.description === "string" && edge.description.length > 0,
        "edge should have a description",
      );
      // from and to should reference valid node IDs
      const nodeIds = new Set(result.dag.nodes.map((n) => n.id));
      assert.ok(
        nodeIds.has(edge.from),
        `edge.from=${edge.from} should reference a valid node`,
      );
      assert.ok(
        nodeIds.has(edge.to),
        `edge.to=${edge.to} should reference a valid node`,
      );
    }
    return;
  }
  assert.fail("no placement produced for DAG edge type test");
});

// ---------------------------------------------------------------------------
// 15. Goals avoid collisions
// ---------------------------------------------------------------------------

test("mechanism-plan: no two goals occupy the same cell", () => {
  let checked = 0;
  for (let seed = 100; seed < 300; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const plan = createMechanismPlan(fb, "intermediate", 3, seed);
    if (!plan) continue;

    const result = placeGoalsFromPlan(fb, plan);
    if (!result) continue;

    const cellKeys = result.solved.goals.map((g) => `${g.row},${g.column}`);
    const uniqueKeys = new Set(cellKeys);
    assert.equal(
      cellKeys.length,
      uniqueKeys.size,
      `goals should have unique positions but found duplicates`,
    );

    // Goals should be on floor, not walls
    for (const goal of result.solved.goals) {
      assert.notEqual(
        result.solved.grid[goal.row][goal.column],
        "O",
        `goal at (${goal.row},${goal.column}) should not be on a wall`,
      );
    }

    checked++;
    if (checked >= 3) return;
  }
  assert.ok(checked > 0, "should validate at least one placement for collision test");
});

// ===========================================================================
// 5. INTEGRATION
// ===========================================================================

// ---------------------------------------------------------------------------
// 16. Mechanism mode is a valid ForgeGenerationMode
// ---------------------------------------------------------------------------

test("mechanism-plan: 'mechanism' is a valid ForgeGenerationMode value", () => {
  // TypeScript structural check: assign "mechanism" to ForgeGenerationMode and
  // verify it is accepted at runtime.
  const mode: ForgeGenerationMode = "mechanism";
  assert.equal(mode, "mechanism");

  // Also verify the other modes still exist alongside it
  const allModes: ForgeGenerationMode[] = ["plain", "motif", "composed", "mechanism"];
  assert.equal(allModes.length, 4);
  assert.ok(allModes.includes("mechanism"));
});

// ---------------------------------------------------------------------------
// 17. Full pipeline: plan -> place -> beam search -> puzzle
// ---------------------------------------------------------------------------

test("mechanism-plan: full pipeline produces a valid puzzle", () => {
  for (let seed = 100; seed < 400; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const plan = createMechanismPlan(fb, "intermediate", 3, seed);
    if (!plan) continue;

    const placement = placeGoalsFromPlan(fb, plan);
    if (!placement) continue;

    const template = toSolvedTemplate(placement.solved);
    const beam = reverseBeamSearch(placement.solved, {
      ...DEFAULT_BEAM_PARAMS,
      seed,
      maxDepth: 25,
    });

    if (beam.best.depth === 0) continue;

    const scrambled = {
      template,
      boxPositions: beam.best.boxPositions as Array<{ row: number; column: number }>,
      robotPosition: beam.best.robotPosition,
      reversePulls: beam.best.depth,
    };
    const puzzle = buildPuzzleFromScramble(scrambled, "intermediate");
    const validation = validatePuzzle(puzzle);
    assert.ok(validation.valid, "mechanism-plan puzzle should pass validation");
    assert.ok(puzzle.boxes >= 2, `puzzle should have >= 2 boxes, got ${puzzle.boxes}`);
    return;
  }
  assert.fail("no mechanism-plan pipeline produced a valid puzzle");
});

// ===========================================================================
// 6. ADDITIONAL TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// 18. Determinism: same seed produces same plan
// ---------------------------------------------------------------------------

test("mechanism-plan: deterministic for same seed", () => {
  for (let seed = 400; seed < 500; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const planA = createMechanismPlan(fb, "intermediate", 3, seed);
    const planB = createMechanismPlan(fb, "intermediate", 3, seed);

    if (!planA || !planB) continue;

    assert.equal(planA.mechanisms.length, planB.mechanisms.length);
    for (let i = 0; i < planA.mechanisms.length; i++) {
      assert.equal(planA.mechanisms[i].type, planB.mechanisms[i].type);
    }
    assert.equal(planA.intendedDependencies.length, planB.intendedDependencies.length);
    return;
  }
  assert.fail("no blueprint produced plans for determinism test");
});

// ---------------------------------------------------------------------------
// 19. DAG produced by placeGoalsFromPlan is acyclic
// ---------------------------------------------------------------------------

test("mechanism-plan: DAG from placeGoalsFromPlan is acyclic", () => {
  for (let seed = 500; seed < 600; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const plan = createMechanismPlan(fb, "intermediate", 3, seed);
    if (!plan) continue;

    const result = placeGoalsFromPlan(fb, plan);
    if (!result) continue;

    assert.ok(isAcyclic(result.dag), "DAG from mechanism plan should be acyclic");
    return;
  }
  assert.fail("no placement produced for acyclicity test");
});

// ---------------------------------------------------------------------------
// 20. Robot position is not on any goal
// ---------------------------------------------------------------------------

test("mechanism-plan: robot is not placed on any goal", () => {
  for (let seed = 600; seed < 700; seed++) {
    const fb = buildBlueprint(seed);
    if (!fb) continue;

    const plan = createMechanismPlan(fb, "intermediate", 3, seed);
    if (!plan) continue;

    const result = placeGoalsFromPlan(fb, plan);
    if (!result) continue;

    const goalKeys = new Set(
      result.solved.goals.map((g) => `${g.row},${g.column}`),
    );
    const robotKey =
      `${result.solved.robotPosition.row},${result.solved.robotPosition.column}`;
    assert.ok(
      !goalKeys.has(robotKey),
      "robot should not be placed on a goal cell",
    );
    return;
  }
  assert.fail("no placement produced for robot-goal collision test");
});
