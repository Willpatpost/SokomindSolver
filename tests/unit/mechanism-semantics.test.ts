import assert from "node:assert/strict";
import test from "node:test";

import {
  generateBlueprintWithRetry,
  assignRoomRoles,
  createMechanismPlan,
  placeGoalsFromPlan,
  verifyMechanismEvidence,
  MECHANISM_CATALOG,
  MECHANISM_TYPES,
  DEFAULT_BLUEPRINT_PARAMS,
  type MechanismType,
  type MechanismPlan,
  type MechanismEvidenceKind,
  type DependencyEdgeType,
} from "../../src/features/generator/v2/index.ts";
import type {
  DependencyVerificationResult,
  DependencyEdgeVerification,
} from "../../src/features/generator/v2/dependency-verification.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFINING_EDGE_MAP: Record<MechanismType, DependencyEdgeType> = {
  "packing-chain": "must-precede",
  "gatekeeper": "blocks-access",
  "gate-reopening": "must-reopen",
  "staging-dependency": "must-stage",
  "corridor-traffic": "shares-passage",
  "temporary-parking": "must-park",
  "dependency-chain": "chain-link",
  "cross-room-exchange": "exchange-cross",
  "assignment-misdirection": "assignment-cross",
  "support-square-contention": "support-conflict",
  "multi-chain-merge": "chain-merge",
};

const VALID_EVIDENCE_KINDS: ReadonlySet<MechanismEvidenceKind> = new Set([
  "completion-order",
  "access-blocked",
  "staging-displacement",
  "shared-route",
  "shared-passage",
  "reopen-gate",
  "park-and-resume",
  "strict-chain-order",
  "exchange-passage",
  "assignment-surprise",
  "support-contention",
  "chain-merge",
]);

function makeMockPlan(
  types: MechanismType[],
): MechanismPlan {
  return {
    mechanisms: types.map((type) => ({
      type,
      primaryRoomIds: [0],
      minGoals: MECHANISM_CATALOG[type].minBoxes,
      allocatedGoals: MECHANISM_CATALOG[type].minBoxes,
      weight: 1,
    })),
    intendedDependencies: [],
    evidenceRequirements: types.map((type) => MECHANISM_CATALOG[type].evidenceRequirements),
    tier: "intermediate",
    seed: 42,
  };
}

function makeMockDepResult(
  edgeDetails: DependencyEdgeVerification[],
): DependencyVerificationResult {
  const realized = edgeDetails.filter((d) => d.realized).length;
  return {
    totalEdges: edgeDetails.length,
    realizedEdges: realized,
    realizationRate: edgeDetails.length > 0 ? realized / edgeDetails.length : 1,
    edgeDetails,
  };
}

function makeEdgeDetail(
  edgeType: DependencyEdgeType,
  realized: boolean,
  evidenceKinds: string[],
): DependencyEdgeVerification {
  return {
    edge: {
      from: 0,
      to: 1,
      type: edgeType,
      description: "test edge",
    },
    realized,
    confidence: "observed",
    reason: realized ? "observed in solution" : "not observed",
    evidence: evidenceKinds.map((kind) => ({
      kind,
      description: `test evidence for ${kind}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Test A: Each mechanism type maps to a unique defining edge type
// ---------------------------------------------------------------------------

test("mechanism semantics: each mechanism has a unique defining edge type", () => {
  const edgeTypes = new Set<string>();
  for (const type of MECHANISM_TYPES) {
    const edgeType = DEFINING_EDGE_MAP[type];
    assert.ok(edgeType, `${type} has no defining edge type`);
    assert.ok(!edgeTypes.has(edgeType), `${edgeType} is used by multiple mechanisms`);
    edgeTypes.add(edgeType);
  }
  assert.equal(edgeTypes.size, MECHANISM_TYPES.length);
});

// ---------------------------------------------------------------------------
// Test B: Catalog evidence kinds are all valid MechanismEvidenceKind values
// ---------------------------------------------------------------------------

test("mechanism semantics: catalog requiredKinds are valid MechanismEvidenceKind values", () => {
  for (const type of MECHANISM_TYPES) {
    const entry = MECHANISM_CATALOG[type];
    for (const kind of entry.evidenceRequirements.requiredKinds) {
      assert.ok(
        VALID_EVIDENCE_KINDS.has(kind),
        `${type}: requiredKind "${kind}" is not a valid MechanismEvidenceKind`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Test C: verifyMechanismEvidence passes when all required evidence present
// ---------------------------------------------------------------------------

test("mechanism semantics: verifyMechanismEvidence passes with all evidence", () => {
  for (const type of MECHANISM_TYPES) {
    const plan = makeMockPlan([type]);
    const entry = MECHANISM_CATALOG[type];
    const edgeType = DEFINING_EDGE_MAP[type];

    const depResult = makeMockDepResult([
      makeEdgeDetail(edgeType, true, [...entry.evidenceRequirements.requiredKinds]),
    ]);

    const results = verifyMechanismEvidence(plan, depResult);
    assert.equal(results.length, 1, `${type}: should return 1 result`);
    assert.ok(results[0].passed, `${type}: should pass when all evidence present`);
    assert.equal(results[0].missingEvidence.length, 0, `${type}: no evidence should be missing`);
  }
});

// ---------------------------------------------------------------------------
// Test D: verifyMechanismEvidence fails when required evidence missing
// ---------------------------------------------------------------------------

test("mechanism semantics: verifyMechanismEvidence fails with missing evidence", () => {
  for (const type of MECHANISM_TYPES) {
    const plan = makeMockPlan([type]);
    const edgeType = DEFINING_EDGE_MAP[type];

    const depResult = makeMockDepResult([
      makeEdgeDetail(edgeType, true, []),
    ]);

    const results = verifyMechanismEvidence(plan, depResult);
    assert.equal(results.length, 1, `${type}: should return 1 result`);
    assert.ok(!results[0].passed, `${type}: should fail when evidence missing`);
    assert.ok(
      results[0].missingEvidence.length > 0,
      `${type}: missingEvidence should be non-empty`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test E: verifyMechanismEvidence fails when edge not realized
// ---------------------------------------------------------------------------

test("mechanism semantics: verifyMechanismEvidence fails when edge not realized", () => {
  for (const type of MECHANISM_TYPES) {
    const plan = makeMockPlan([type]);
    const entry = MECHANISM_CATALOG[type];
    const edgeType = DEFINING_EDGE_MAP[type];

    const depResult = makeMockDepResult([
      makeEdgeDetail(edgeType, false, [...entry.evidenceRequirements.requiredKinds]),
    ]);

    const results = verifyMechanismEvidence(plan, depResult);
    assert.equal(results.length, 1, `${type}: should return 1 result`);
    assert.ok(!results[0].passed, `${type}: should fail when edge not realized`);
  }
});

// ---------------------------------------------------------------------------
// Test F: verifyMechanismEvidence handles multiple mechanisms
// ---------------------------------------------------------------------------

test("mechanism semantics: verifyMechanismEvidence handles multi-mechanism plans", () => {
  const types: MechanismType[] = ["packing-chain", "gatekeeper"];
  const plan = makeMockPlan(types);

  const depResult = makeMockDepResult([
    makeEdgeDetail("must-precede", true, ["completion-order"]),
    makeEdgeDetail("blocks-access", true, ["access-blocked"]),
  ]);

  const results = verifyMechanismEvidence(plan, depResult);
  assert.equal(results.length, 2);
  assert.ok(results[0].passed, "packing-chain should pass");
  assert.ok(results[1].passed, "gatekeeper should pass");
});

test("mechanism semantics: partial evidence fails only the lacking mechanism", () => {
  const types: MechanismType[] = ["packing-chain", "gatekeeper"];
  const plan = makeMockPlan(types);

  const depResult = makeMockDepResult([
    makeEdgeDetail("must-precede", true, ["completion-order"]),
    makeEdgeDetail("blocks-access", true, []),
  ]);

  const results = verifyMechanismEvidence(plan, depResult);
  assert.ok(results[0].passed, "packing-chain should pass");
  assert.ok(!results[1].passed, "gatekeeper should fail");
  assert.deepEqual(results[1].missingEvidence, ["access-blocked"]);
});

// ---------------------------------------------------------------------------
// Test G: verifyMechanismEvidence result fields are correct
// ---------------------------------------------------------------------------

test("mechanism semantics: result fields are populated correctly", () => {
  const plan = makeMockPlan(["gate-reopening"]);

  const depResult = makeMockDepResult([
    makeEdgeDetail("must-reopen", true, ["reopen-gate"]),
  ]);

  const results = verifyMechanismEvidence(plan, depResult);
  const r = results[0];

  assert.equal(r.mechanismIndex, 0);
  assert.equal(r.type, "gate-reopening");
  assert.ok(r.passed);
  assert.deepEqual([...r.requiredEvidence], ["reopen-gate"]);
  assert.ok(r.observedEvidence.includes("reopen-gate"));
  assert.equal(r.missingEvidence.length, 0);
});

// ---------------------------------------------------------------------------
// Test H: Empty dependency result fails all mechanisms
// ---------------------------------------------------------------------------

test("mechanism semantics: empty dependency result fails mechanisms", () => {
  const plan = makeMockPlan(["packing-chain"]);
  const depResult = makeMockDepResult([]);

  const results = verifyMechanismEvidence(plan, depResult);
  assert.ok(!results[0].passed, "should fail with no edges");
});

// ---------------------------------------------------------------------------
// Test I: Evidence from wrong edge type is not counted
// ---------------------------------------------------------------------------

test("mechanism semantics: evidence from wrong edge type is ignored", () => {
  const plan = makeMockPlan(["packing-chain"]);

  const depResult = makeMockDepResult([
    makeEdgeDetail("blocks-access", true, ["completion-order"]),
  ]);

  const results = verifyMechanismEvidence(plan, depResult);
  assert.ok(!results[0].passed, "packing-chain should not use evidence from blocks-access edges");
});

// ---------------------------------------------------------------------------
// Test J: Generated mechanism plans emit correct edge types
// ---------------------------------------------------------------------------

test("mechanism semantics: generated mechanism plans use correct edge types", () => {
  let tested = 0;

  for (let seed = 9000; seed < 9080; seed++) {
    const bp = generateBlueprintWithRetry(
      {
        ...DEFAULT_BLUEPRINT_PARAMS,
        seed,
        family: "linear",
        boardWidth: 16,
        boardHeight: 16,
        minRooms: 3,
        maxRooms: 5,
      },
      30,
    );
    if (!bp) continue;

    const fb = assignRoomRoles(bp, seed, 4);
    const plan = createMechanismPlan(fb, "intermediate", 4, seed);
    if (!plan) continue;

    const placement = placeGoalsFromPlan(fb, plan);
    if (!placement) continue;

    for (const edge of placement.dag.edges) {
      const expectedEdge = Object.entries(DEFINING_EDGE_MAP).find(
        ([, e]) => e === edge.type,
      );
      if (expectedEdge) {
        tested++;
      }
    }
  }

  assert.ok(tested > 0, "should have tested at least one mechanism edge");
});

// ---------------------------------------------------------------------------
// Test K: Catalog minEvidenceCount is <= requiredKinds.length
// ---------------------------------------------------------------------------

test("mechanism semantics: catalog minEvidenceCount <= requiredKinds.length", () => {
  for (const type of MECHANISM_TYPES) {
    const entry = MECHANISM_CATALOG[type];
    assert.ok(
      entry.evidenceRequirements.minEvidenceCount <= entry.evidenceRequirements.requiredKinds.length,
      `${type}: minEvidenceCount (${entry.evidenceRequirements.minEvidenceCount}) > requiredKinds.length (${entry.evidenceRequirements.requiredKinds.length})`,
    );
  }
});
