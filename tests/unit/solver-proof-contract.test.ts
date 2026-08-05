import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isSolverProgress,
  isSolverResult,
  assertValidSolverResult,
} from "../../src/solver/validation.ts";
import {
  collectProofIssues,
  assertValidProof,
  isProofCompatibleOptimality,
} from "../../src/solver/proof.ts";
import type { SolverProof } from "../../src/solver/contracts.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalSolution(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    steps: [{ direction: "right", kind: "push" }],
    moves: 1,
    pushes: 1,
    objective: { kind: "moves" },
    objectiveScore: 1,
    optimality: "unknown",
    ...overrides,
  };
}

function minimalMetrics(): Record<string, unknown> {
  return { elapsedMs: 42 };
}

function solvedResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "solved",
    solution: minimalSolution(),
    metrics: minimalMetrics(),
    ...overrides,
  };
}

function unsolvedResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "unsolved",
    reason: "exhausted",
    metrics: minimalMetrics(),
    ...overrides,
  };
}

function cancelledResult(): Record<string, unknown> {
  return { status: "cancelled", metrics: minimalMetrics() };
}

function boundedProof(
  overrides: Partial<SolverProof> = {},
): Record<string, unknown> {
  const lb = (overrides.lowerBound ?? 0) as number;
  const ub = (overrides.upperBound ?? 1) as number;
  return {
    objective: { kind: "moves" },
    kind: "bounded",
    algorithm: "move-astar",
    lowerBound: lb,
    upperBound: ub,
    gap: ub - lb,
    ...overrides,
  };
}

function optimalProof(
  overrides: Partial<SolverProof> = {},
): Record<string, unknown> {
  return {
    objective: { kind: "moves" },
    kind: "optimal",
    algorithm: "move-astar",
    lowerBound: 1,
    upperBound: 1,
    gap: 0,
    ...overrides,
  };
}

function unsolvableProof(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    objective: { kind: "moves" },
    kind: "unsolvable",
    algorithm: "move-astar",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1: Old result payloads remain valid
// ---------------------------------------------------------------------------

describe("AC1: backward compatibility — results without proof", () => {
  it("solved result without proof passes validation", () => {
    assert.ok(isSolverResult(solvedResult()));
  });

  it("unsolved result without proof passes validation", () => {
    assert.ok(isSolverResult(unsolvedResult()));
  });

  it("cancelled result without proof passes validation", () => {
    assert.ok(isSolverResult(cancelledResult()));
  });

  it("unsolved with detail and no proof passes validation", () => {
    assert.ok(isSolverResult(unsolvedResult({ detail: "timed out" })));
  });
});

// ---------------------------------------------------------------------------
// AC2: Invalid proof combinations are rejected
// ---------------------------------------------------------------------------

describe("AC2: invalid proof combinations rejected", () => {
  it("rejects optimal proof with non-zero gap", () => {
    const issues = collectProofIssues(
      optimalProof({ gap: 5 }),
      minimalSolution({ optimality: "proven" }),
    );
    assert.ok(issues.length > 0, "expected issues for gap !== 0");
  });

  it("rejects optimal proof with mismatched bounds", () => {
    const issues = collectProofIssues(
      optimalProof({ lowerBound: 1, upperBound: 3 }),
      minimalSolution({ optimality: "proven" }),
    );
    assert.ok(issues.length > 0, "expected issues for lowerBound !== upperBound");
  });

  it("rejects bounded proof with lowerBound > upperBound", () => {
    const issues = collectProofIssues(
      { ...boundedProof(), lowerBound: 10, upperBound: 5, gap: -5 },
      minimalSolution(),
    );
    assert.ok(issues.length > 0, "expected issues for inverted bounds");
  });

  it("rejects bounded proof with wrong gap computation", () => {
    const issues = collectProofIssues(
      { ...boundedProof({ lowerBound: 0, upperBound: 5 }), gap: 999 },
      minimalSolution({ moves: 5 }),
    );
    assert.ok(issues.length > 0, "expected issues for wrong gap");
  });

  it("rejects unsolvable proof with a solution present", () => {
    const issues = collectProofIssues(unsolvableProof(), minimalSolution());
    assert.ok(issues.length > 0, "expected issues for unsolvable with solution");
  });

  it("rejects unsolvable proof with upperBound present", () => {
    const issues = collectProofIssues(
      unsolvableProof({ upperBound: 10 }),
      null,
    );
    assert.ok(issues.length > 0, "expected issues for unsolvable with upperBound");
  });

  it("rejects proof with missing algorithm", () => {
    const noAlgo = optimalProof();
    delete noAlgo.algorithm;
    const issues = collectProofIssues(
      noAlgo,
      minimalSolution({ optimality: "proven" }),
    );
    assert.ok(issues.length > 0, "expected issues for missing algorithm");
  });

  it("rejects proof with invalid algorithm value", () => {
    const issues = collectProofIssues(
      optimalProof({ algorithm: "magic" as never }),
      minimalSolution({ optimality: "proven" }),
    );
    assert.ok(issues.length > 0, "expected issues for invalid algorithm");
  });

  it("rejects bounded proof where upperBound !== solution.moves", () => {
    const issues = collectProofIssues(
      boundedProof({ lowerBound: 0, upperBound: 99 }),
      minimalSolution({ moves: 1 }),
    );
    assert.ok(issues.length > 0, "expected issues for upperBound mismatch");
  });

  it("rejects proof with missing objective", () => {
    const noObj = optimalProof();
    delete noObj.objective;
    const issues = collectProofIssues(
      noObj,
      minimalSolution({ optimality: "proven" }),
    );
    assert.ok(issues.length > 0, "expected issues for missing objective");
  });
});

// ---------------------------------------------------------------------------
// AC3: Optimal result requires equal bounds
// ---------------------------------------------------------------------------

describe("AC3: optimal proof requires equal bounds", () => {
  it("accepts valid optimal proof", () => {
    const issues = collectProofIssues(
      optimalProof(),
      minimalSolution({ optimality: "proven" }),
    );
    assert.deepStrictEqual(issues, []);
  });

  it("rejects optimal proof with solution.optimality = unknown", () => {
    const issues = collectProofIssues(
      optimalProof(),
      minimalSolution({ optimality: "unknown" }),
    );
    assert.ok(
      issues.some((i) => i.includes("optimality")),
      "expected optimality mismatch issue",
    );
  });

  it("rejects optimal proof with gap !== 0", () => {
    const issues = collectProofIssues(
      optimalProof({ gap: 1 }),
      minimalSolution({ optimality: "proven" }),
    );
    assert.ok(issues.some((i) => i.includes("gap")), "expected gap issue");
  });

  it("full result validation accepts solved + optimal proof", () => {
    const result = solvedResult({
      solution: minimalSolution({ optimality: "proven" }),
      proof: optimalProof(),
    });
    assert.ok(isSolverResult(result));
  });
});

// ---------------------------------------------------------------------------
// AC4: Bounded result requires valid gap
// ---------------------------------------------------------------------------

describe("AC4: bounded proof requires valid gap", () => {
  it("accepts valid bounded proof", () => {
    const proof = boundedProof({ lowerBound: 0, upperBound: 1 });
    const issues = collectProofIssues(proof, minimalSolution({ moves: 1 }));
    assert.deepStrictEqual(issues, []);
  });

  it("rejects bounded proof with gap !== upperBound - lowerBound", () => {
    const proof = {
      ...boundedProof({ lowerBound: 0, upperBound: 1 }),
      gap: 42,
    };
    const issues = collectProofIssues(proof, minimalSolution({ moves: 1 }));
    assert.ok(issues.some((i) => i.includes("gap")), "expected gap issue");
  });

  it("full result validation accepts solved + bounded proof", () => {
    const result = solvedResult({
      proof: boundedProof({ lowerBound: 0, upperBound: 1 }),
    });
    assert.ok(isSolverResult(result));
  });
});

// ---------------------------------------------------------------------------
// AC5: Worker host and client both validate proof metadata
// ---------------------------------------------------------------------------

describe("AC5: assertValidSolverResult rejects malformed proof", () => {
  it("rejects solved result with invalid proof", () => {
    const result = solvedResult({
      proof: { kind: "optimal", algorithm: "move-astar", gap: 999 },
    });
    assert.throws(() => assertValidSolverResult(result), /proof/i);
  });

  it("rejects unsolved result with invalid proof", () => {
    const result = unsolvedResult({
      proof: unsolvableProof({ upperBound: 10 }),
    });
    assert.throws(() => assertValidSolverResult(result), /proof/i);
  });

  it("accepts solved result with valid proof through assertion", () => {
    const result = solvedResult({
      solution: minimalSolution({ optimality: "proven" }),
      proof: optimalProof(),
    });
    assert.doesNotThrow(() => assertValidSolverResult(result));
  });
});

// ---------------------------------------------------------------------------
// Progress: "proving" phase and bound/gap fields
// ---------------------------------------------------------------------------

describe("progress extensions", () => {
  it("accepts 'proving' as a valid phase", () => {
    assert.ok(
      isSolverProgress({
        phase: "proving",
        elapsedMs: 100,
      }),
    );
  });

  it("accepts progress with lowerBound, upperBound, gap", () => {
    assert.ok(
      isSolverProgress({
        phase: "proving",
        elapsedMs: 100,
        lowerBound: 5,
        upperBound: 10,
        gap: 5,
      }),
    );
  });

  it("rejects progress with lowerBound > upperBound", () => {
    assert.ok(
      !isSolverProgress({
        phase: "proving",
        elapsedMs: 100,
        lowerBound: 20,
        upperBound: 10,
      }),
    );
  });

  it("rejects progress with negative lowerBound", () => {
    assert.ok(
      !isSolverProgress({
        phase: "proving",
        elapsedMs: 100,
        lowerBound: -1,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// isProofCompatibleOptimality
// ---------------------------------------------------------------------------

describe("isProofCompatibleOptimality", () => {
  it("maps optimal to proven", () => {
    assert.equal(
      isProofCompatibleOptimality(optimalProof() as unknown as SolverProof),
      "proven",
    );
  });

  it("maps bounded to unknown", () => {
    assert.equal(
      isProofCompatibleOptimality(boundedProof() as unknown as SolverProof),
      "unknown",
    );
  });

  it("maps unsolvable to unknown", () => {
    assert.equal(
      isProofCompatibleOptimality(unsolvableProof() as unknown as SolverProof),
      "unknown",
    );
  });
});

// ---------------------------------------------------------------------------
// assertValidProof
// ---------------------------------------------------------------------------

describe("assertValidProof", () => {
  it("throws on invalid proof", () => {
    assert.throws(
      () => assertValidProof({ kind: "optimal", gap: 99 }, null),
      /Invalid solver proof/,
    );
  });

  it("does not throw on valid proof", () => {
    assert.doesNotThrow(() =>
      assertValidProof(
        optimalProof(),
        minimalSolution({ optimality: "proven" }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Unsolvable proof
// ---------------------------------------------------------------------------

describe("unsolvable proof", () => {
  it("accepts valid unsolvable proof with no solution", () => {
    const issues = collectProofIssues(unsolvableProof(), null);
    assert.deepStrictEqual(issues, []);
  });

  it("accepts unsolvable proof with optional lowerBound", () => {
    const issues = collectProofIssues(
      unsolvableProof({ lowerBound: 0 }),
      null,
    );
    assert.deepStrictEqual(issues, []);
  });

  it("rejects unsolvable proof with gap", () => {
    const issues = collectProofIssues(unsolvableProof({ gap: 0 }), null);
    assert.ok(issues.length > 0, "expected issue for unsolvable with gap");
  });

  it("full result validation accepts unsolved + unsolvable proof", () => {
    assert.ok(
      isSolverResult(unsolvedResult({ proof: unsolvableProof() })),
    );
  });
});

// ---------------------------------------------------------------------------
// Cancelled variant with proof
// ---------------------------------------------------------------------------

describe("cancelled result with proof", () => {
  it("accepts cancelled result with bounded proof", () => {
    assert.ok(
      isSolverResult({
        status: "cancelled",
        metrics: minimalMetrics(),
        proof: unsolvableProof(),
      }),
    );
  });

  it("rejects cancelled result with invalid proof", () => {
    assert.ok(
      !isSolverResult({
        status: "cancelled",
        metrics: minimalMetrics(),
        proof: { kind: "optimal", gap: 999 },
      }),
    );
  });
});
