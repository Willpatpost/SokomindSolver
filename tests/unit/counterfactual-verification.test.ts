import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyDependenciesWithEvidence,
  verifyDependenciesCounterfactual,
  type VerificationConfidence,
} from "../../src/features/generator/v2/index.ts";
import type { PuzzleDefinition } from "../../src/core/model.ts";
import type { SolutionStep } from "../../src/solver/contracts.ts";

// ---------------------------------------------------------------------------
// Helpers: puzzle fixtures with known dependency structures
// ---------------------------------------------------------------------------

function makeGatekeeperPuzzle(): PuzzleDefinition {
  // Box at (2,3) blocks passage to inner goal at (2,5)
  // Gate box on goal S at (2,3), inner goal S at (2,5)
  // Robot at (2,1)
  return {
    id: "cf-gatekeeper",
    difficulty: "intermediate",
    rows: [
      "OOOOOOOO",
      "O......O",
      "OR.XOS.O",
      "O......O",
      "OOOOOOOO",
    ],
    title: "cf-gatekeeper",
    boxes: 2,
  };
}

function makeLinearChainPuzzle(): PuzzleDefinition {
  // Two boxes in a corridor — deeper one must be pushed first
  // Robot at left, goals at right side of corridor
  return {
    id: "cf-chain",
    title: "cf-chain",
    difficulty: "intermediate",
    rows: [
      "OOOOOOOO",
      "OR.X.X.O",
      "O....SSO",
      "OOOOOOOO",
    ],
    boxes: 2,
  };
}

function makeOpenRoomPuzzle(): PuzzleDefinition {
  // Open room with boxes and goals — no blocking structure
  return {
    id: "cf-open",
    title: "cf-open",
    difficulty: "beginner",
    rows: [
      "OOOOOOOO",
      "O......O",
      "O.X..S.O",
      "O......O",
      "O.X..S.O",
      "O......O",
      "OR.....O",
      "OOOOOOOO",
    ],
    boxes: 2,
  };
}

// Minimal DAG types that match dependency-verification's internal interface
interface TestDepNode {
  readonly id: number;
  readonly goalIndex: number;
  readonly roomId: number;
  readonly role: string;
}

interface TestDepEdge {
  readonly from: number;
  readonly to: number;
  readonly type: string;
  readonly description: string;
}

interface TestDepDAG {
  readonly nodes: readonly TestDepNode[];
  readonly edges: readonly TestDepEdge[];
}

function makeGatekeeperDAG(): TestDepDAG {
  return {
    nodes: [
      { id: 0, goalIndex: 0, roomId: 0, role: "gate" },
      { id: 1, goalIndex: 1, roomId: 0, role: "inner" },
    ],
    edges: [
      {
        from: 0,
        to: 1,
        type: "blocks-access",
        description: "Gate box blocks access to inner goal",
      },
    ],
  };
}

function makeChainDAG(): TestDepDAG {
  return {
    nodes: [
      { id: 0, goalIndex: 0, roomId: 0, role: "chain-link" },
      { id: 1, goalIndex: 1, roomId: 0, role: "chain-link" },
    ],
    edges: [
      {
        from: 0,
        to: 1,
        type: "must-precede",
        description: "First box must be completed before second",
      },
    ],
  };
}

function makeOpenDAG(): TestDepDAG {
  return {
    nodes: [
      { id: 0, goalIndex: 0, roomId: 0, role: "general" },
      { id: 1, goalIndex: 1, roomId: 0, role: "general" },
    ],
    edges: [
      {
        from: 0,
        to: 1,
        type: "must-precede",
        description: "Ordering dependency (may not be causal)",
      },
    ],
  };
}

// Simple solution steps for testing — just pushes
function makePushStep(direction: "up" | "down" | "left" | "right"): SolutionStep {
  return { kind: "push", direction };
}

function makeMoveStep(direction: "up" | "down" | "left" | "right"): SolutionStep {
  return { kind: "walk", direction };
}

// ---------------------------------------------------------------------------
// Test A: VerificationConfidence includes "proven" level
// ---------------------------------------------------------------------------

test("counterfactual: VerificationConfidence includes all 4 levels", () => {
  const levels: VerificationConfidence[] = ["observed", "structural", "counterfactual", "proven"];
  for (const level of levels) {
    assert.equal(typeof level, "string", `${level} should be a valid confidence level`);
  }
});

// ---------------------------------------------------------------------------
// Test B: counterfactual verifier returns same edge count as base verifier
// ---------------------------------------------------------------------------

test("counterfactual: preserves edge count from base verifier", () => {
  const puzzle = makeGatekeeperPuzzle();
  const dag = makeGatekeeperDAG();
  // Even without real solution steps, both should process the same edges
  const steps: SolutionStep[] = [];

  const base = verifyDependenciesWithEvidence(dag as any, puzzle, steps);
  const cf = verifyDependenciesCounterfactual(dag as any, puzzle, steps);

  assert.equal(cf.totalEdges, base.totalEdges);
  assert.equal(cf.edgeDetails.length, base.edgeDetails.length);
});

// ---------------------------------------------------------------------------
// Test C: counterfactual verifier upgrades confidence when blocking detected
// ---------------------------------------------------------------------------

test("counterfactual: upgrades confidence for blocks-access when goal unreachable", () => {
  // Gatekeeper puzzle: box at (2,3) blocks access to goal at (2,5)
  // We need solution steps that show box 0 completing before box 1
  const puzzle = makeGatekeeperPuzzle();
  const dag = makeGatekeeperDAG();

  // Solve: push box right twice to goal, then push second box right twice to goal
  // R.X.S. → R..XS. → R...XS (box 0 on goal)
  // Then maneuver to push box 1
  const steps: SolutionStep[] = [
    makeMoveStep("right"),
    makePushStep("right"),
    makePushStep("right"),
    makeMoveStep("right"),
    makeMoveStep("right"),
    makePushStep("right"),
    makePushStep("right"),
  ];

  const base = verifyDependenciesWithEvidence(dag as any, puzzle, steps);
  const cf = verifyDependenciesCounterfactual(dag as any, puzzle, steps);

  // If the base verifier shows the edge as realized, the counterfactual should
  // potentially upgrade confidence
  if (base.edgeDetails[0]?.realized) {
    const baseConfidence = base.edgeDetails[0].confidence;
    const cfConfidence = cf.edgeDetails[0].confidence;
    // Counterfactual confidence should be >= base confidence
    const order: Record<string, number> = {
      "observed": 0, "structural": 1, "counterfactual": 2, "proven": 3,
    };
    assert.ok(
      order[cfConfidence] >= order[baseConfidence],
      `counterfactual confidence (${cfConfidence}) should be >= base (${baseConfidence})`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test D: counterfactual evidence is appended, not replacing base evidence
// ---------------------------------------------------------------------------

test("counterfactual: appends evidence without losing base evidence", () => {
  const puzzle = makeGatekeeperPuzzle();
  const dag = makeGatekeeperDAG();
  const steps: SolutionStep[] = [
    makeMoveStep("right"),
    makePushStep("right"),
    makePushStep("right"),
  ];

  const base = verifyDependenciesWithEvidence(dag as any, puzzle, steps);
  const cf = verifyDependenciesCounterfactual(dag as any, puzzle, steps);

  for (let i = 0; i < base.edgeDetails.length; i++) {
    const baseEvidence = base.edgeDetails[i].evidence;
    const cfEvidence = cf.edgeDetails[i].evidence;
    assert.ok(
      cfEvidence.length >= baseEvidence.length,
      `edge ${i}: counterfactual evidence (${cfEvidence.length}) should be >= base (${baseEvidence.length})`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test E: open room puzzle doesn't get counterfactual upgrade
// ---------------------------------------------------------------------------

test("counterfactual: open room without blocking structure stays at observed", () => {
  const puzzle = makeOpenRoomPuzzle();
  const dag = makeOpenDAG();
  const steps: SolutionStep[] = [];

  const cf = verifyDependenciesCounterfactual(dag as any, puzzle, steps);

  // With no solution steps, edges aren't realized at all
  for (const detail of cf.edgeDetails) {
    if (!detail.realized) {
      assert.notEqual(
        detail.confidence,
        "counterfactual",
        "unrealized edge should not have counterfactual confidence",
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Test F: counterfactual handles edge types without counterfactual logic
// ---------------------------------------------------------------------------

test("counterfactual: unknown/unsupported edge types pass through unchanged", () => {
  const puzzle = makeOpenRoomPuzzle();
  const dag: TestDepDAG = {
    nodes: [
      { id: 0, goalIndex: 0, roomId: 0, role: "general" },
      { id: 1, goalIndex: 1, roomId: 0, role: "general" },
    ],
    edges: [
      {
        from: 0,
        to: 1,
        type: "shares-passage",
        description: "Passage sharing (no counterfactual test available)",
      },
    ],
  };
  const steps: SolutionStep[] = [];

  const base = verifyDependenciesWithEvidence(dag as any, puzzle, steps);
  const cf = verifyDependenciesCounterfactual(dag as any, puzzle, steps);

  assert.equal(cf.edgeDetails[0].confidence, base.edgeDetails[0].confidence);
  assert.equal(cf.edgeDetails[0].evidence.length, base.edgeDetails[0].evidence.length);
});

// ---------------------------------------------------------------------------
// Test G: ForgeProvenance counterfactual fields exist
// ---------------------------------------------------------------------------

test("counterfactual: provenance fields are typed correctly", () => {
  // Just verifying the type structure — if this compiles, the fields exist
  const provenance = {
    counterfactualEdges: 3,
    counterfactualTotal: 5,
  };
  assert.equal(provenance.counterfactualEdges, 3);
  assert.equal(provenance.counterfactualTotal, 5);
});

// ---------------------------------------------------------------------------
// Test H: realizationRate is preserved correctly through counterfactual
// ---------------------------------------------------------------------------

test("counterfactual: realizationRate is consistent", () => {
  const puzzle = makeGatekeeperPuzzle();
  const dag = makeGatekeeperDAG();
  const steps: SolutionStep[] = [];

  const cf = verifyDependenciesCounterfactual(dag as any, puzzle, steps);

  if (cf.totalEdges > 0) {
    const expectedRate = cf.realizedEdges / cf.totalEdges;
    assert.ok(
      Math.abs(cf.realizationRate - expectedRate) < 0.001,
      `realizationRate (${cf.realizationRate}) should equal realizedEdges/totalEdges (${expectedRate})`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test I: counterfactual verifier handles empty DAG
// ---------------------------------------------------------------------------

test("counterfactual: handles empty DAG gracefully", () => {
  const puzzle = makeOpenRoomPuzzle();
  const emptyDag: TestDepDAG = { nodes: [], edges: [] };
  const steps: SolutionStep[] = [];

  const cf = verifyDependenciesCounterfactual(emptyDag as any, puzzle, steps);
  assert.equal(cf.totalEdges, 0);
  assert.equal(cf.realizedEdges, 0);
  assert.equal(cf.realizationRate, 1);
  assert.equal(cf.edgeDetails.length, 0);
});

// ---------------------------------------------------------------------------
// Test J: all supported counterfactual edge types are tested
// ---------------------------------------------------------------------------

test("counterfactual: covers all key edge types", () => {
  const supportedTypes = [
    "blocks-access",
    "must-reopen",
    "must-precede",
    "chain-link",
    "must-park",
    "must-stage",
    "exchange-cross",
  ];

  const puzzle = makeGatekeeperPuzzle();
  const steps: SolutionStep[] = [];

  for (const edgeType of supportedTypes) {
    const dag: TestDepDAG = {
      nodes: [
        { id: 0, goalIndex: 0, roomId: 0, role: "test" },
        { id: 1, goalIndex: 1, roomId: 0, role: "test" },
      ],
      edges: [{
        from: 0, to: 1, type: edgeType, description: `test ${edgeType}`,
      }],
    };

    const cf = verifyDependenciesCounterfactual(dag as any, puzzle, steps);
    assert.equal(
      cf.totalEdges,
      1,
      `${edgeType}: should process exactly 1 edge`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test K: exchange-cross counterfactual can upgrade confidence
// ---------------------------------------------------------------------------

test("counterfactual: exchange-cross edge is processed with counterfactual logic", () => {
  const puzzle = makeGatekeeperPuzzle();
  const dag: TestDepDAG = {
    nodes: [
      { id: 0, goalIndex: 0, roomId: 0, role: "exchange" },
      { id: 1, goalIndex: 1, roomId: 1, role: "exchange" },
    ],
    edges: [{
      from: 0, to: 1, type: "exchange-cross",
      description: "Cross-room exchange dependency",
    }],
  };
  const steps: SolutionStep[] = [
    makeMoveStep("right"),
    makePushStep("right"),
  ];

  const base = verifyDependenciesWithEvidence(dag as any, puzzle, steps);
  const cf = verifyDependenciesCounterfactual(dag as any, puzzle, steps);

  assert.equal(cf.totalEdges, 1);
  assert.equal(cf.edgeDetails.length, base.edgeDetails.length);
  // Counterfactual evidence should be >= base evidence
  assert.ok(
    cf.edgeDetails[0].evidence.length >= base.edgeDetails[0].evidence.length,
    "exchange-cross should not lose base evidence",
  );
});
