import { DIRECTIONS, type PuzzleDefinition, type Position } from "../../../core/model.ts";
import { createSession, stepSnapshot } from "../../../core/game-session.ts";
import { directionDelta } from "../../../core/position.ts";
import type { SolutionStep, SolverAdapter, SolverLimits, SolverResult } from "../../../solver/contracts.ts";
import type { PullRecord } from "./reverse-beam-search.ts";

export type SolvedResult = Extract<SolverResult, { status: "solved" }>;

export interface GenerationSearchBudget {
  readonly maxExpandedStates: number;
  readonly maxElapsedMs: number;
  readonly maxCalls: number;
  readonly probeExpandedStates: number;
  readonly probeElapsedMs: number;
}
export const DEFAULT_GENERATION_SEARCH_BUDGET: GenerationSearchBudget = {
  maxExpandedStates: 12000, maxElapsedMs: 5000, maxCalls: 8,
  probeExpandedStates: 2000, probeElapsedMs: 500,
};
export interface GenerationWork {
  readonly solverCalls: number;
  readonly expandedStates: number;
  readonly witnessVerifications: number;
  readonly witnessFallbacks: number;
  readonly budgetExhaustions: number;
  readonly phaseMs: Readonly<Record<string, number>>;
}

/** Bounded, candidate-local evidence. Exact rows and solver settings form the key. */
export class GenerationEvidence {
  readonly enabled: boolean;
  readonly witnessFirst: boolean;
  readonly budget?: GenerationSearchBudget;
  readonly startedAt = performance.now();
  constructor(enabled = true, witnessFirst = false, budget?: GenerationSearchBudget) {
    this.enabled = enabled;
    this.witnessFirst = witnessFirst;
    this.budget = budget ?? (witnessFirst ? DEFAULT_GENERATION_SEARCH_BUDGET : undefined);
    if (this.budget && Object.values(this.budget).some(n => !Number.isSafeInteger(n) || n < 1)) {
      throw new Error("Generation search budgets must be positive integers");
    }
  }
  readonly solved = new Map<string, SolvedResult>();
  solverCalls = 0;
  cacheHits = 0;
  witnessFallbacks = 0;
  witnessVerifications = 0;
  expandedStates = 0;
  budgetExhaustions = 0;
  private phase = "initial";
  private phaseStart = this.startedAt;
  private readonly phaseMs: Record<string, number> = {};
  mark(phase: string): void {
    const now = performance.now();
    this.phaseMs[this.phase] = (this.phaseMs[this.phase] ?? 0) + now - this.phaseStart;
    this.phase = phase; this.phaseStart = now;
  }
  work(): GenerationWork {
    this.mark("done");
    return { solverCalls: this.solverCalls, expandedStates: this.expandedStates,
      witnessVerifications: this.witnessVerifications, witnessFallbacks: this.witnessFallbacks,
      budgetExhaustions: this.budgetExhaustions, phaseMs: { ...this.phaseMs } };
  }
}

/** Route evidence has no invented solver work or optimality claim. */
export function verifiedWitnessResult(puzzle: PuzzleDefinition, steps: readonly SolutionStep[] | undefined,
  evidence?: GenerationEvidence): SolvedResult | undefined {
  if (!steps || !replayWitness(puzzle, steps)) return undefined;
  if (evidence) evidence.witnessVerifications++;
  return { status: "solved", metrics: { elapsedMs: 0 }, solution: {
    steps, moves: steps.length, pushes: steps.filter(s => s.kind === "push").length,
    objective: { kind: "moves" }, objectiveScore: steps.length, optimality: "unknown",
  } };
}

export function replayWitness(puzzle: PuzzleDefinition, steps: readonly SolutionStep[]): boolean {
  const session = createSession(puzzle);
  let snapshot = session.snapshot;
  for (const step of steps) {
    const transition = stepSnapshot(session.board, snapshot, step.direction);
    if (!transition.moved || transition.pushed !== (step.kind === "push")) return false;
    snapshot = transition.snapshot;
  }
  return snapshot.solved;
}

export async function solveWithEvidence(
  puzzle: PuzzleDefinition, solver: SolverAdapter, limits: SolverLimits,
  signal?: AbortSignal, evidence?: GenerationEvidence,
): Promise<SolverResult> {
  signal?.throwIfAborted();
  if (evidence?.budget) {
    const b = evidence.budget;
    const remainingMs = b.maxElapsedMs - (performance.now() - evidence.startedAt);
    const remainingStates = b.maxExpandedStates - evidence.expandedStates;
    if (remainingMs <= 0 || remainingStates <= 0 || evidence.solverCalls >= b.maxCalls) {
      evidence.budgetExhaustions++;
      return { status: "unsolved", reason: "limit-reached", metrics: { elapsedMs: 0 } };
    }
    limits = { ...limits, maxElapsedMs: Math.min(limits.maxElapsedMs ?? Infinity, b.probeElapsedMs, remainingMs),
      maxExpandedStates: Math.min(limits.maxExpandedStates ?? Infinity, b.probeExpandedStates, remainingStates) };
  }
  const key = JSON.stringify([puzzle.rows, solver.metadata.id, solver.metadata.version]);
  const cached = evidence?.enabled ? evidence.solved.get(key) : undefined;
  if (cached && cached.metrics.elapsedMs <= (limits.maxElapsedMs ?? Infinity) &&
    (cached.metrics.expandedStates ?? 0) <= (limits.maxExpandedStates ?? Infinity) &&
    (cached.metrics.generatedStates ?? 0) <= (limits.maxGeneratedStates ?? Infinity) &&
    limits.maxMemoryBytes === undefined) { evidence!.cacheHits++; return cached; }
  const session = createSession(puzzle);
  if (evidence) evidence.solverCalls++;
  const result = await solver.solve({ board: session.board, snapshot: session.snapshot,
    objective: { kind: "moves" }, limits }, {
    signal: signal ?? new AbortController().signal, reportProgress: () => {}, now: () => performance.now(),
  });
  if (evidence) evidence.expandedStates += result.metrics.expandedStates ?? 0;
  if (result.status === "solved" && evidence?.enabled && replayWitness(puzzle, result.solution.steps)) {
    if (evidence.solved.size >= 8) evidence.solved.delete(evidence.solved.keys().next().value!);
    evidence.solved.set(key, result);
  }
  return result;
}

/** A bounded solver failure does not invalidate a construction witness. Never claims optimality. */
export function witnessedResult(puzzle: PuzzleDefinition, steps: readonly SolutionStep[] | undefined,
  attempted: SolverResult, evidence?: GenerationEvidence): SolverResult {
  if (attempted.status !== "unsolved" || !steps || !replayWitness(puzzle, steps)) return attempted;
  if (evidence) evidence.witnessFallbacks++;
  const pushes = steps.filter((step) => step.kind === "push").length;
  return { status: "solved", metrics: attempted.metrics,
    solution: { steps, moves: steps.length, pushes, objective: { kind: "moves" },
      objectiveScore: steps.length, optimality: "unknown" } };
}

/** Recover walking as well as pushes; every action is checked by the immutable core. */
export function witnessFromPullHistory(puzzle: PuzzleDefinition, history: readonly PullRecord[]): readonly SolutionStep[] | undefined {
  const session = createSession(puzzle);
  let snapshot = session.snapshot;
  const steps: SolutionStep[] = [];
  const key = (p: Position) => p.row * session.board.width + p.column;
  const floor = new Set(session.board.floor.map(key));
  for (let i = history.length - 1; i >= 0; i--) {
    const pull = history[i];
    const dr = pull.from.row - pull.to.row;
    const dc = pull.from.column - pull.to.column;
    const direction = DIRECTIONS.find((d) => { const delta = directionDelta(d); return delta.row === dr && delta.column === dc; });
    if (!direction) return undefined;
    const target = { row: pull.to.row - dr, column: pull.to.column - dc };
    const blocked = new Set(snapshot.boxes.map((box) => key(box.position)));
    const queue: Position[] = [snapshot.robot];
    const parents = new Map<number, { previous: number; step: SolutionStep }>();
    const start = key(snapshot.robot);
    const seen = new Set([start]);
    for (let q = 0; q < queue.length && !seen.has(key(target)); q++) {
      for (const d of DIRECTIONS) {
        const delta = directionDelta(d);
        const next = { row: queue[q].row + delta.row, column: queue[q].column + delta.column };
        const nk = key(next);
        if (next.row < 0 || next.column < 0 || next.row >= session.board.height || next.column >= session.board.width ||
          !floor.has(nk) || blocked.has(nk) || seen.has(nk)) continue;
        seen.add(nk); parents.set(nk, { previous: key(queue[q]), step: { kind: "walk", direction: d } }); queue.push(next);
      }
    }
    if (!seen.has(key(target))) return undefined;
    const walk: SolutionStep[] = [];
    for (let cell = key(target); cell !== start;) {
      const parent = parents.get(cell)!; walk.push(parent.step); cell = parent.previous;
    }
    for (const step of [...walk.reverse(), { kind: "push" as const, direction }]) {
      const transition = stepSnapshot(session.board, snapshot, step.direction);
      if (!transition.moved || transition.pushed !== (step.kind === "push")) return undefined;
      snapshot = transition.snapshot; steps.push(step);
    }
  }
  return snapshot.solved ? steps : undefined;
}
