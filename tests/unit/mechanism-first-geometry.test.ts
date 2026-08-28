import assert from "node:assert/strict";
import test from "node:test";

import {
  selectTargetMechanisms,
  deriveGeometryRequirements,
  constrainBlueprintParams,
  createMechanismPlan,
  generateBlueprintWithRetry,
  assignRoomRoles,
  MECHANISM_CATALOG,
  MECHANISM_TYPES,
  DEFAULT_BLUEPRINT_PARAMS,
  type MechanismType,
  type MechanismGeometryRequirement,
} from "../../src/features/generator/v2/index.ts";

// ---------------------------------------------------------------------------
// A. selectTargetMechanisms
// ---------------------------------------------------------------------------

test("mechanism-first: selectTargetMechanisms returns empty for non-hard tiers", () => {
  for (const tier of ["tutorial", "beginner", "intermediate"]) {
    const result = selectTargetMechanisms(tier, 3, 42);
    assert.equal(result.length, 0, `${tier} should return no mechanisms`);
  }
});

test("mechanism-first: selectTargetMechanisms returns mechanisms for hard tiers", () => {
  for (const tier of ["advanced", "expert", "master"]) {
    const result = selectTargetMechanisms(tier, 3, 42);
    assert.ok(result.length > 0, `${tier} should return at least 1 mechanism`);
    for (const m of result) {
      assert.ok(
        MECHANISM_TYPES.includes(m),
        `${m} should be a valid mechanism type`,
      );
    }
  }
});

test("mechanism-first: selectTargetMechanisms respects box count constraints", () => {
  const result = selectTargetMechanisms("expert", 3, 100);
  for (const m of result) {
    const entry = MECHANISM_CATALOG[m];
    assert.ok(
      3 >= entry.minBoxes,
      `${m} requires ${entry.minBoxes} boxes but only 3 available`,
    );
  }
});

test("mechanism-first: selectTargetMechanisms count scales with tier", () => {
  const counts: number[] = [];
  for (const tier of ["advanced", "expert", "master"]) {
    let total = 0;
    for (let seed = 0; seed < 20; seed++) {
      total += selectTargetMechanisms(tier, 4, seed).length;
    }
    counts.push(total / 20);
  }
  assert.ok(
    counts[1] >= counts[0],
    `expert avg (${counts[1]}) should be >= advanced avg (${counts[0]})`,
  );
});

// ---------------------------------------------------------------------------
// B. deriveGeometryRequirements
// ---------------------------------------------------------------------------

test("mechanism-first: deriveGeometryRequirements for gatekeeper needs narrow passage and 2+ rooms", () => {
  const reqs = deriveGeometryRequirements(["gatekeeper"]);
  assert.ok(reqs.requiredNarrowPassages >= 1, "gatekeeper needs narrow passage");
  assert.ok(reqs.requiredRooms >= 2, "gatekeeper needs at least 2 rooms");
});

test("mechanism-first: deriveGeometryRequirements for packing-chain needs terminal room", () => {
  const reqs = deriveGeometryRequirements(["packing-chain"]);
  assert.ok(reqs.terminalRoomRequired, "packing-chain needs terminal room");
});

test("mechanism-first: deriveGeometryRequirements merges requirements from multiple mechanisms", () => {
  const single = deriveGeometryRequirements(["packing-chain"]);
  const combined = deriveGeometryRequirements(["packing-chain", "gatekeeper"]);
  assert.ok(
    combined.requiredRooms >= single.requiredRooms,
    "combined should need at least as many rooms",
  );
  assert.ok(
    combined.requiredNarrowPassages >= single.requiredNarrowPassages,
    "combined should need at least as many narrow passages",
  );
});

test("mechanism-first: deriveGeometryRequirements preferredFamilies is non-empty", () => {
  for (const mType of MECHANISM_TYPES) {
    const reqs = deriveGeometryRequirements([mType]);
    assert.ok(
      reqs.preferredFamilies.length > 0,
      `${mType}: preferredFamilies should not be empty`,
    );
  }
});

// ---------------------------------------------------------------------------
// C. constrainBlueprintParams
// ---------------------------------------------------------------------------

test("mechanism-first: constrainBlueprintParams respects minRooms", () => {
  const reqs: MechanismGeometryRequirement = {
    requiredRooms: 4,
    requiredNarrowPassages: 0,
    terminalRoomRequired: false,
    largeRoomRequired: false,
    minRoomArea: 6,
    preferredFamilies: ["hub"],
  };
  const constrained = constrainBlueprintParams(DEFAULT_BLUEPRINT_PARAMS, reqs, 42);
  assert.ok(constrained.minRooms >= 4, `minRooms (${constrained.minRooms}) should be >= 4`);
  assert.ok(constrained.maxRooms >= constrained.minRooms, "maxRooms should be >= minRooms");
});

test("mechanism-first: constrainBlueprintParams picks preferred family", () => {
  const reqs: MechanismGeometryRequirement = {
    requiredRooms: 2,
    requiredNarrowPassages: 0,
    terminalRoomRequired: false,
    largeRoomRequired: false,
    minRoomArea: 6,
    preferredFamilies: ["linear"],
  };
  const constrained = constrainBlueprintParams(DEFAULT_BLUEPRINT_PARAMS, reqs, 42);
  assert.equal(constrained.family, "linear");
});

test("mechanism-first: constrainBlueprintParams forces narrow passages when required", () => {
  const reqs: MechanismGeometryRequirement = {
    requiredRooms: 2,
    requiredNarrowPassages: 1,
    terminalRoomRequired: false,
    largeRoomRequired: false,
    minRoomArea: 6,
    preferredFamilies: ["linear", "branch"],
  };
  const constrained = constrainBlueprintParams(DEFAULT_BLUEPRINT_PARAMS, reqs, 42);
  assert.deepEqual(constrained.passageWidths, [1]);
});

test("mechanism-first: constrainBlueprintParams increases room size for large room requirement", () => {
  const reqs: MechanismGeometryRequirement = {
    requiredRooms: 2,
    requiredNarrowPassages: 0,
    terminalRoomRequired: false,
    largeRoomRequired: true,
    minRoomArea: 9,
    preferredFamilies: ["hub"],
  };
  const constrained = constrainBlueprintParams(DEFAULT_BLUEPRINT_PARAMS, reqs, 42);
  assert.ok(constrained.minRoomSize >= 3, `minRoomSize (${constrained.minRoomSize}) should be >= 3`);
});

// ---------------------------------------------------------------------------
// D. createMechanismPlan with pre-selected mechanisms
// ---------------------------------------------------------------------------

test("mechanism-first: createMechanismPlan uses pre-selected mechanisms when provided", () => {
  const bp = generateBlueprintWithRetry(
    { ...DEFAULT_BLUEPRINT_PARAMS, seed: 99, family: "linear", minRooms: 3, maxRooms: 5 },
    5,
  );
  if (!bp) return;

  const fb = assignRoomRoles(bp, 99, 3);
  const plan = createMechanismPlan(fb, "expert", 3, 99, ["packing-chain"]);
  if (!plan) return;

  const types = plan.mechanisms.map((m) => m.type);
  assert.ok(
    types.includes("packing-chain"),
    `plan should include packing-chain but got [${types}]`,
  );
});

test("mechanism-first: createMechanismPlan filters infeasible pre-selected mechanisms", () => {
  const bp = generateBlueprintWithRetry(
    { ...DEFAULT_BLUEPRINT_PARAMS, seed: 42, family: "linear", minRooms: 2, maxRooms: 2 },
    5,
  );
  if (!bp) return;

  const fb = assignRoomRoles(bp, 42, 2);
  const plan = createMechanismPlan(fb, "expert", 2, 42, ["cross-room-exchange"]);
  if (plan) {
    const types = plan.mechanisms.map((m) => m.type);
    assert.ok(
      types.every((t) => {
        const entry = MECHANISM_CATALOG[t];
        return 2 >= entry.minBoxes;
      }),
      "all mechanisms should be feasible with 2 boxes",
    );
  }
});

// ---------------------------------------------------------------------------
// E. End-to-end: mechanism-first → blueprint → plan
// ---------------------------------------------------------------------------

test("mechanism-first: end-to-end flow produces constrained blueprint", () => {
  const selected = selectTargetMechanisms("expert", 3, 55);
  if (selected.length === 0) return;

  const reqs = deriveGeometryRequirements(selected);
  const constrained = constrainBlueprintParams(DEFAULT_BLUEPRINT_PARAMS, reqs, 55);

  assert.ok(
    constrained.minRooms >= reqs.requiredRooms,
    `constrained minRooms (${constrained.minRooms}) should satisfy requirement (${reqs.requiredRooms})`,
  );

  const bp = generateBlueprintWithRetry(constrained, 5);
  if (!bp) return;

  assert.ok(
    bp.rooms.length >= reqs.requiredRooms,
    `blueprint rooms (${bp.rooms.length}) should satisfy requirement (${reqs.requiredRooms})`,
  );
});

test("mechanism-first: constrained blueprint can host pre-selected mechanisms", () => {
  let planCreated = false;

  for (let seed = 0; seed < 30; seed++) {
    const selected = selectTargetMechanisms("advanced", 3, seed);
    if (selected.length === 0) continue;

    const reqs = deriveGeometryRequirements(selected);
    const constrained = constrainBlueprintParams(
      { ...DEFAULT_BLUEPRINT_PARAMS, boardWidth: 14, boardHeight: 14 },
      reqs,
      seed,
    );

    const bp = generateBlueprintWithRetry(constrained, 5);
    if (!bp) continue;

    const fb = assignRoomRoles(bp, seed, 3);
    const plan = createMechanismPlan(fb, "advanced", 3, seed, selected);
    if (plan) {
      planCreated = true;
      break;
    }
  }

  assert.ok(planCreated, "at least one seed should produce a valid mechanism plan from constrained blueprint");
});
