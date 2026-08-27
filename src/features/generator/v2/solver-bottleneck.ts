/**
 * Phase 9 — Solver bottleneck analysis and multi-role evaluator policy.
 *
 * Provides infrastructure to measure whether the forward solver limits
 * generator quality, following a measurement-first approach.
 */

import type { PuzzleDefinition } from "../../../core/model.ts";
import type { SolutionStep } from "../../../solver/contracts.ts";
import { createSession, stepSnapshot } from "../../../core/game-session.ts";
import {
  classicGreedySolver,
  classicAStarSolver,
  classicIdaStarSolver,
} from "../../../solver/implementations/classic-solvers.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SolverRole =
  | "witness"
  | "fast-probe"
  | "exact-evidence"
  | "optional-proof";

export interface SolverRoleAssignment {
  readonly solverId: string;
  readonly role: SolverRole;
  readonly limits: { maxElapsedMs: number; maxExpandedStates: number };
}

export interface V4EvaluatorPolicy {
  readonly witnessTimeoutMs: number;
  readonly fastProbeMaxElapsedMs: number;
  readonly fastProbeMaxStates: number;
  readonly exactEvidenceMaxElapsedMs: number;
  readonly exactEvidenceMaxStates: number;
  readonly proofMaxElapsedMs: number;
  readonly proofMaxStates: number;
  readonly proofMaxBoxes: number;
  readonly proofMaxFloor: number;
  readonly requireOptimalProof: boolean;
}

export const DEFAULT_V4_POLICY: V4EvaluatorPolicy = {
  witnessTimeoutMs: 1_000,
  fastProbeMaxElapsedMs: 5_000,
  fastProbeMaxStates: 500_000,
  exactEvidenceMaxElapsedMs: 15_000,
  exactEvidenceMaxStates: 2_000_000,
  proofMaxElapsedMs: 30_000,
  proofMaxStates: 5_000_000,
  proofMaxBoxes: 6,
  proofMaxFloor: 200,
  requireOptimalProof: false,
};

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

export function assignSolverRoles(
  boxCount: number,
  totalFloor: number,
  policy: V4EvaluatorPolicy = DEFAULT_V4_POLICY,
): SolverRoleAssignment[] {
  const roles: SolverRoleAssignment[] = [
    {
      solverId: "witness",
      role: "witness",
      limits: {
        maxElapsedMs: policy.witnessTimeoutMs,
        maxExpandedStates: policy.fastProbeMaxStates,
      },
    },
    {
      solverId: "classic-greedy",
      role: "fast-probe",
      limits: {
        maxElapsedMs: policy.fastProbeMaxElapsedMs,
        maxExpandedStates: policy.fastProbeMaxStates,
      },
    },
    {
      solverId: "classic-astar",
      role: "exact-evidence",
      limits: {
        maxElapsedMs: policy.exactEvidenceMaxElapsedMs,
        maxExpandedStates: policy.exactEvidenceMaxStates,
      },
    },
  ];

  if (
    boxCount <= policy.proofMaxBoxes &&
    totalFloor <= policy.proofMaxFloor
  ) {
    roles.push({
      solverId: "classic-ida-star",
      role: "optional-proof",
      limits: {
        maxElapsedMs: policy.proofMaxElapsedMs,
        maxExpandedStates: policy.proofMaxStates,
      },
    });
  }

  return roles;
}

// ---------------------------------------------------------------------------
// Bottleneck report
// ---------------------------------------------------------------------------

export interface SolverBottleneckEntry {
  readonly solverId: string;
  readonly role: SolverRole;
  readonly status: string;
  readonly elapsedMs: number;
  readonly expandedStates: number;
  readonly moves?: number;
  readonly pushes?: number;
  readonly timedOut: boolean;
  readonly stateExhausted: boolean;
  readonly optimalityProven: boolean;
}

export interface SolverBottleneckReport {
  readonly puzzleId: string;
  readonly boxCount: number;
  readonly totalFloor: number;
  readonly entries: readonly SolverBottleneckEntry[];
  readonly witnessValid: boolean;
  readonly fastProbeFound: boolean;
  readonly exactEvidenceFound: boolean;
  readonly proofAttempted: boolean;
  readonly proofSucceeded: boolean;
  readonly solvableButTimedOut: boolean;
  readonly rejectedByProofOnly: boolean;
}

// ---------------------------------------------------------------------------
// Witness replay
// ---------------------------------------------------------------------------

function replayWitness(
  puzzle: PuzzleDefinition,
  steps: readonly SolutionStep[],
): boolean {
  const session = createSession(puzzle);
  let snapshot = session.snapshot;
  for (const step of steps) {
    const transition = stepSnapshot(session.board, snapshot, step.direction);
    if (!transition.moved) return false;
    snapshot = transition.snapshot;
  }
  return snapshot.solved;
}

// ---------------------------------------------------------------------------
// Run a solver with limits and produce a bottleneck entry
// ---------------------------------------------------------------------------

async function runSolverForBottleneck(
  puzzle: PuzzleDefinition,
  solverId: string,
  role: SolverRole,
  limits: { maxElapsedMs: number; maxExpandedStates: number },
): Promise<SolverBottleneckEntry> {
  const solver =
    solverId === "classic-greedy"
      ? classicGreedySolver
      : solverId === "classic-astar"
        ? classicAStarSolver
        : classicIdaStarSolver;

  const session = createSession(puzzle);
  const request = {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" as const },
    limits,
  };
  const context = {
    signal: new AbortController().signal,
    reportProgress: () => {},
    now: () => performance.now(),
  };

  try {
    const result = await solver.solve(request, context);

    if (result.status === "solved") {
      return {
        solverId,
        role,
        status: "solved",
        elapsedMs: result.metrics.elapsedMs,
        expandedStates: result.metrics.expandedStates ?? 0,
        moves: result.solution.moves,
        pushes: result.solution.pushes,
        timedOut: false,
        stateExhausted: false,
        optimalityProven: result.solution.optimality === "proven",
      };
    }

    const timedOut =
      result.status === "unsolved" && result.reason === "limit-reached";
    const stateExhausted =
      result.status === "unsolved" && result.reason === "exhausted";

    return {
      solverId,
      role,
      status:
        result.status === "unsolved"
          ? `unsolved:${result.reason}`
          : result.status,
      elapsedMs: result.metrics.elapsedMs,
      expandedStates: result.metrics.expandedStates ?? 0,
      timedOut,
      stateExhausted,
      optimalityProven: false,
    };
  } catch {
    return {
      solverId,
      role,
      status: "error",
      elapsedMs: 0,
      expandedStates: 0,
      timedOut: false,
      stateExhausted: false,
      optimalityProven: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Count floor cells in a puzzle
// ---------------------------------------------------------------------------

function countFloor(puzzle: PuzzleDefinition): number {
  let count = 0;
  for (const row of puzzle.rows) {
    for (const ch of row) {
      if (ch !== "O") count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main analysis entry point
// ---------------------------------------------------------------------------

export async function analyzeSolverBottleneck(
  puzzle: PuzzleDefinition,
  witnessSteps: readonly SolutionStep[] | undefined,
  policy: V4EvaluatorPolicy = DEFAULT_V4_POLICY,
): Promise<SolverBottleneckReport> {
  const totalFloor = countFloor(puzzle);
  const roles = assignSolverRoles(puzzle.boxes, totalFloor, policy);

  // Witness validation — replay if steps provided
  let witnessValid = false;
  if (witnessSteps && witnessSteps.length > 0) {
    witnessValid = replayWitness(puzzle, witnessSteps);
  }

  // Run each non-witness role
  const solverRoles = roles.filter((r) => r.role !== "witness");
  const entries: SolverBottleneckEntry[] = [];

  // Add witness entry
  entries.push({
    solverId: "witness",
    role: "witness",
    status: witnessValid ? "valid" : "invalid",
    elapsedMs: 0,
    expandedStates: 0,
    timedOut: false,
    stateExhausted: false,
    optimalityProven: false,
  });

  // Run solver roles sequentially to avoid resource contention
  for (const assignment of solverRoles) {
    const entry = await runSolverForBottleneck(
      puzzle,
      assignment.solverId,
      assignment.role,
      assignment.limits,
    );
    entries.push(entry);
  }

  // Analyze results
  const fastProbeEntry = entries.find((e) => e.role === "fast-probe");
  const exactEntry = entries.find((e) => e.role === "exact-evidence");
  const proofEntry = entries.find((e) => e.role === "optional-proof");

  const fastProbeFound = fastProbeEntry !== undefined && fastProbeEntry.status === "solved";
  const exactEvidenceFound = exactEntry !== undefined && exactEntry.status === "solved";
  const proofAttempted = proofEntry !== undefined;
  const proofSucceeded = proofEntry !== undefined && proofEntry.status === "solved";

  // Any solver found a solution?
  const anySolved = entries.some((e) => e.status === "solved" || e.status === "valid");
  // Any solver timed out?
  const anyTimedOut = entries.some((e) => e.timedOut);

  const solvableButTimedOut = anySolved && anyTimedOut;

  // Rejected only because proof is expensive: witness or fast-probe succeed,
  // but proof was attempted and failed.
  const rejectedByProofOnly =
    (witnessValid || fastProbeFound) &&
    proofAttempted &&
    !proofSucceeded;

  return {
    puzzleId: puzzle.id,
    boxCount: puzzle.boxes,
    totalFloor,
    entries,
    witnessValid,
    fastProbeFound,
    exactEvidenceFound,
    proofAttempted,
    proofSucceeded,
    solvableButTimedOut,
    rejectedByProofOnly,
  };
}

// ---------------------------------------------------------------------------
// Correlation data extraction
// ---------------------------------------------------------------------------

export interface SolverCorrelationData {
  readonly expandedStates: number;
  readonly elapsedMs: number;
  readonly solverAgreement: boolean;
  readonly optimalityProven: boolean;
  // puzzle quality signals
  readonly estimatedDependencyDepth: number;
  readonly nonMonotonicBoxMoves: number;
  readonly stagingOperations: number;
  readonly goalOrderConstraints: number;
  readonly boxCount: number;
  readonly solutionPushes: number;
  readonly avgReachablePushes: number;
}

/**
 * Input shape for extractCorrelationData — uses structural typing to avoid
 * circular imports from finalist-evaluator.ts and puzzle-evaluator.ts.
 */
export interface CorrelationEvaluationInput {
  readonly solverElapsedMs: number;
  readonly estimatedDependencyDepth: number;
  readonly nonMonotonicBoxMoves: number;
  readonly stagingOperations: number;
  readonly goalOrderConstraints: number;
  readonly boxCount: number;
  readonly solutionPushes: number;
  readonly avgReachablePushes: number;
}

export interface CorrelationFinalistInput {
  readonly solverEvidence: readonly { readonly optimalityProven?: boolean }[];
  readonly solverAgreement: boolean;
  readonly avgExpandedStates: number;
}

export function extractCorrelationData(
  ev: CorrelationEvaluationInput,
  finalistEval: CorrelationFinalistInput,
): SolverCorrelationData {
  const optimalityProven = finalistEval.solverEvidence.some(
    (e) => e.optimalityProven === true,
  );

  return {
    expandedStates: finalistEval.avgExpandedStates,
    elapsedMs: ev.solverElapsedMs,
    solverAgreement: finalistEval.solverAgreement,
    optimalityProven,
    estimatedDependencyDepth: ev.estimatedDependencyDepth,
    nonMonotonicBoxMoves: ev.nonMonotonicBoxMoves,
    stagingOperations: ev.stagingOperations,
    goalOrderConstraints: ev.goalOrderConstraints,
    boxCount: ev.boxCount,
    solutionPushes: ev.solutionPushes,
    avgReachablePushes: ev.avgReachablePushes,
  };
}
