import assert from "node:assert/strict";
import test from "node:test";

import {
  generateBlueprintWithRetry,
  assignRoomRoles,
  createMechanismPlan,
  placeGoalsFromPlan,
  MECHANISM_CATALOG,
  DEFAULT_BLUEPRINT_PARAMS,
  type BlueprintParams,
  type MechanismPlan,
  type MechanismSpec,
} from "../../src/features/generator/v2/index.ts";
import { validateForAcceptance } from "../../src/features/generator/v2/review-catalog.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFunctionalBlueprint(seed: number, boxCount: number) {
  const params: BlueprintParams = {
    ...DEFAULT_BLUEPRINT_PARAMS,
    seed,
    family: "linear",
    boardWidth: 16,
    boardHeight: 16,
    minRooms: 3,
    maxRooms: 5,
  };
  const bp = generateBlueprintWithRetry(params, 30);
  assert.ok(bp, "failed to generate blueprint");
  return assignRoomRoles(bp, seed, boxCount);
}

function getPlanForBoxCount(seed: number, boxCount: number): MechanismPlan | null {
  const fb = makeFunctionalBlueprint(seed, boxCount);
  return createMechanismPlan(fb, "intermediate", boxCount, seed);
}

// ---------------------------------------------------------------------------
// Test A: allocatedGoals sum equals requested boxCount
// ---------------------------------------------------------------------------

test("box budget: allocatedGoals sum equals requested boxCount", () => {
  const boxCounts = [2, 3, 4, 5, 6];
  let tested = 0;

  for (const boxCount of boxCounts) {
    for (let seed = 7000; seed < 7020; seed++) {
      const plan = getPlanForBoxCount(seed, boxCount);
      if (!plan) continue;

      const totalAllocated = plan.mechanisms.reduce(
        (sum, m) => sum + m.allocatedGoals,
        0,
      );
      assert.equal(
        totalAllocated,
        boxCount,
        `seed=${seed} boxCount=${boxCount}: allocatedGoals sum=${totalAllocated} !== ${boxCount}`,
      );
      tested++;
    }
  }

  assert.ok(tested >= 5, `expected at least 5 successful plans, got ${tested}`);
});

// ---------------------------------------------------------------------------
// Test B: every allocatedGoals >= minGoals from catalog
// ---------------------------------------------------------------------------

test("box budget: allocatedGoals >= minGoals for every mechanism", () => {
  let tested = 0;

  for (let seed = 7100; seed < 7130; seed++) {
    const plan = getPlanForBoxCount(seed, 4);
    if (!plan) continue;

    for (const spec of plan.mechanisms) {
      const entry = MECHANISM_CATALOG[spec.type];
      assert.ok(
        spec.allocatedGoals >= entry.minBoxes,
        `${spec.type}: allocatedGoals=${spec.allocatedGoals} < minBoxes=${entry.minBoxes}`,
      );
      assert.ok(
        spec.allocatedGoals >= spec.minGoals,
        `${spec.type}: allocatedGoals=${spec.allocatedGoals} < minGoals=${spec.minGoals}`,
      );
    }
    tested++;
  }

  assert.ok(tested >= 3, `expected at least 3 successful plans, got ${tested}`);
});

// ---------------------------------------------------------------------------
// Test C: allocatedGoals never exceeds maxUsefulBoxes
// ---------------------------------------------------------------------------

test("box budget: allocatedGoals <= maxUsefulBoxes", () => {
  let tested = 0;

  for (let seed = 7200; seed < 7230; seed++) {
    const plan = getPlanForBoxCount(seed, 6);
    if (!plan) continue;

    for (const spec of plan.mechanisms) {
      const entry = MECHANISM_CATALOG[spec.type];
      assert.ok(
        spec.allocatedGoals <= entry.maxUsefulBoxes,
        `${spec.type}: allocatedGoals=${spec.allocatedGoals} > maxUsefulBoxes=${entry.maxUsefulBoxes}`,
      );
    }
    tested++;
  }

  assert.ok(tested >= 3, `expected at least 3 successful plans, got ${tested}`);
});

// ---------------------------------------------------------------------------
// Test D: budget allocation is deterministic
// ---------------------------------------------------------------------------

test("box budget: deterministic with same seed", () => {
  const seed = 7300;
  const boxCount = 4;

  const planA = getPlanForBoxCount(seed, boxCount);
  const planB = getPlanForBoxCount(seed, boxCount);

  if (!planA || !planB) {
    assert.ok(planA === planB, "both should be null or both non-null");
    return;
  }

  assert.equal(planA.mechanisms.length, planB.mechanisms.length);
  for (let i = 0; i < planA.mechanisms.length; i++) {
    assert.equal(planA.mechanisms[i].type, planB.mechanisms[i].type);
    assert.equal(planA.mechanisms[i].allocatedGoals, planB.mechanisms[i].allocatedGoals);
    assert.equal(planA.mechanisms[i].minGoals, planB.mechanisms[i].minGoals);
  }
});

// ---------------------------------------------------------------------------
// Test E: placeGoalsFromPlan produces exactly boxCount goals
// ---------------------------------------------------------------------------

test("box budget: placeGoalsFromPlan produces exactly boxCount goals", () => {
  const boxCounts = [2, 3, 4, 5];
  let tested = 0;

  for (const boxCount of boxCounts) {
    for (let seed = 7400; seed < 7430; seed++) {
      const fb = makeFunctionalBlueprint(seed, boxCount);
      const plan = createMechanismPlan(fb, "intermediate", boxCount, seed);
      if (!plan) continue;

      const result = placeGoalsFromPlan(fb, plan);
      if (!result) continue;

      assert.equal(
        result.solved.goals.length,
        boxCount,
        `seed=${seed}: placed ${result.solved.goals.length} goals, expected ${boxCount}`,
      );
      tested++;
    }
  }

  assert.ok(tested >= 4, `expected at least 4 successful placements, got ${tested}`);
});

// ---------------------------------------------------------------------------
// Test F: plan returns null when boxCount < minimum sum
// ---------------------------------------------------------------------------

test("box budget: returns null when boxCount too small for selected mechanisms", () => {
  let foundNull = false;

  for (let seed = 7500; seed < 7550; seed++) {
    const plan = getPlanForBoxCount(seed, 1);
    if (!plan) {
      foundNull = true;
      break;
    }
  }

  assert.ok(foundNull, "at least one plan with boxCount=1 should fail (min sum too large)");
});

// ---------------------------------------------------------------------------
// Test G: catalog entry scalability fields are well-formed
// ---------------------------------------------------------------------------

test("box budget: catalog entries have valid scalability fields", () => {
  for (const [type, entry] of Object.entries(MECHANISM_CATALOG)) {
    assert.ok(
      entry.maxUsefulBoxes >= entry.minBoxes,
      `${type}: maxUsefulBoxes=${entry.maxUsefulBoxes} < minBoxes=${entry.minBoxes}`,
    );
    assert.equal(typeof entry.scalable, "boolean", `${type}: scalable should be boolean`);
    assert.ok(entry.maxUsefulBoxes > 0, `${type}: maxUsefulBoxes should be > 0`);
    assert.ok(entry.minBoxes > 0, `${type}: minBoxes should be > 0`);
  }
});

// ---------------------------------------------------------------------------
// Test H: validateForAcceptance catches box count mismatches
// ---------------------------------------------------------------------------

test("box budget: acceptance validator catches box/manifest mismatch", () => {
  const puzzle = {
    id: "gen-v2-test-1",
    difficulty: "intermediate" as const,
    rows: [
      "OOOOO",
      "O.X.O",
      "O.S.O",
      "OR..O",
      "OOOOO",
    ],
  };

  const catalog = JSON.stringify([puzzle]);
  const manifest = JSON.stringify({
    puzzles: [{
      id: "gen-v2-test-1",
      boxCount: 5,
      genericBoxCount: 5,
      typedBoxCount: 0,
    }],
  });

  const result = validateForAcceptance(catalog, manifest);
  assert.ok(
    result.errors.some((e) => e.includes("Box count mismatch")),
    `expected box count mismatch error, got: ${JSON.stringify(result.errors)}`,
  );
});

// ---------------------------------------------------------------------------
// Test I: validateForAcceptance passes when counts match
// ---------------------------------------------------------------------------

test("box budget: acceptance validator passes when box counts match", () => {
  const puzzle = {
    id: "gen-v2-test-2",
    difficulty: "intermediate" as const,
    rows: [
      "OOOOO",
      "O.X.O",
      "O.S.O",
      "OR..O",
      "OOOOO",
    ],
  };

  const catalog = JSON.stringify([puzzle]);
  const manifest = JSON.stringify({
    puzzles: [{
      id: "gen-v2-test-2",
      boxCount: 1,
      genericBoxCount: 1,
      typedBoxCount: 0,
    }],
  });

  const result = validateForAcceptance(catalog, manifest);
  const boxErrors = result.errors.filter(
    (e) => e.includes("box count") || e.includes("Box count"),
  );
  assert.equal(boxErrors.length, 0, `unexpected box count errors: ${JSON.stringify(boxErrors)}`);
});
