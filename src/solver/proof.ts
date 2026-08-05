import type { SolverProof, SolverProofKind, SolverProofAlgorithm } from "./contracts.ts";

const PROOF_KINDS: ReadonlySet<string> = new Set<SolverProofKind>([
  "bounded",
  "optimal",
  "unsolvable",
]);

const PROOF_ALGORITHMS: ReadonlySet<string> = new Set<SolverProofAlgorithm>([
  "move-astar",
  "move-ida-star",
  "parallel-move-astar",
  "parallel-move-ida-star",
]);

interface SolutionLike {
  readonly moves: number;
  readonly optimality: string;
}

function isSolutionLike(v: unknown): v is SolutionLike {
  if (v == null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.moves === "number" && typeof s.optimality === "string";
}

function isNonNegativeFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export function collectProofIssues(
  proof: unknown,
  solution: unknown | null,
): string[] {
  const issues: string[] = [];
  if (proof == null || typeof proof !== "object") {
    issues.push("proof must be a non-null object");
    return issues;
  }
  const p = proof as Record<string, unknown>;

  if (typeof p.kind !== "string" || !PROOF_KINDS.has(p.kind)) {
    issues.push(`proof.kind must be one of ${[...PROOF_KINDS].join(", ")}; got ${String(p.kind)}`);
    return issues;
  }

  if (typeof p.algorithm !== "string" || !PROOF_ALGORITHMS.has(p.algorithm)) {
    issues.push(
      `proof.algorithm must be one of ${[...PROOF_ALGORITHMS].join(", ")}; got ${String(p.algorithm)}`,
    );
  }

  if (
    p.objective == null ||
    typeof p.objective !== "object" ||
    (p.objective as Record<string, unknown>).kind !== "moves"
  ) {
    issues.push("proof.objective.kind must be \"moves\"");
  }

  const kind = p.kind as SolverProofKind;
  const sol = isSolutionLike(solution) ? solution : null;

  if (kind === "bounded") {
    if (!isNonNegativeFinite(p.lowerBound)) {
      issues.push("bounded proof requires non-negative finite lowerBound");
    }
    if (!isNonNegativeFinite(p.upperBound)) {
      issues.push("bounded proof requires non-negative finite upperBound");
    }
    if (
      isNonNegativeFinite(p.lowerBound) &&
      isNonNegativeFinite(p.upperBound)
    ) {
      if (p.lowerBound > p.upperBound) {
        issues.push(
          `bounded proof lowerBound (${p.lowerBound}) must be <= upperBound (${p.upperBound})`,
        );
      }
      const expectedGap = (p.upperBound as number) - (p.lowerBound as number);
      if (p.gap !== expectedGap) {
        issues.push(
          `bounded proof gap must be upperBound - lowerBound (${expectedGap}); got ${String(p.gap)}`,
        );
      }
    }
    if (sol == null) {
      issues.push("bounded proof requires a solution");
    } else if (isNonNegativeFinite(p.upperBound) && p.upperBound !== sol.moves) {
      issues.push(
        `bounded proof upperBound (${p.upperBound}) must equal solution.moves (${sol.moves})`,
      );
    }
  } else if (kind === "optimal") {
    if (!isNonNegativeFinite(p.lowerBound)) {
      issues.push("optimal proof requires non-negative finite lowerBound");
    }
    if (!isNonNegativeFinite(p.upperBound)) {
      issues.push("optimal proof requires non-negative finite upperBound");
    }
    if (
      isNonNegativeFinite(p.lowerBound) &&
      isNonNegativeFinite(p.upperBound) &&
      p.lowerBound !== p.upperBound
    ) {
      issues.push(
        `optimal proof requires lowerBound === upperBound; got ${p.lowerBound} !== ${p.upperBound}`,
      );
    }
    if (p.gap !== 0) {
      issues.push(`optimal proof requires gap === 0; got ${String(p.gap)}`);
    }
    if (sol == null) {
      issues.push("optimal proof requires a solution");
    } else {
      if (
        isNonNegativeFinite(p.upperBound) &&
        p.upperBound !== sol.moves
      ) {
        issues.push(
          `optimal proof upperBound (${p.upperBound}) must equal solution.moves (${sol.moves})`,
        );
      }
      if (sol.optimality !== "proven") {
        issues.push(
          `optimal proof requires solution.optimality === "proven"; got "${sol.optimality}"`,
        );
      }
    }
  } else if (kind === "unsolvable") {
    if (p.upperBound !== undefined) {
      issues.push("unsolvable proof must not have upperBound");
    }
    if (p.gap !== undefined) {
      issues.push("unsolvable proof must not have gap");
    }
    if (solution != null) {
      issues.push("unsolvable proof must not have a solution");
    }
  }

  return issues;
}

export function assertValidProof(
  proof: unknown,
  solution: unknown | null,
): void {
  const issues = collectProofIssues(proof, solution);
  if (issues.length > 0) {
    throw new Error(`Invalid solver proof: ${issues.join("; ")}`);
  }
}

export function isProofCompatibleOptimality(
  proof: SolverProof,
): "unknown" | "proven" {
  return proof.kind === "optimal" ? "proven" : "unknown";
}
