import { DIRECTIONS, type PuzzleDefinition, type Position } from "../../../core/model.ts";
import { createSession, stepSnapshot } from "../../../core/game-session.ts";
import { directionDelta } from "../../../core/position.ts";
import type { SolutionStep, SolverAdapter, SolverLimits, SolverResult } from "../../../solver/contracts.ts";
import type { PullRecord } from "./reverse-beam-search.ts";

export type SolvedResult = Extract<SolverResult, { status: "solved" }>;

/** Bounded, candidate-local evidence. Exact rows and solver settings form the key. */
export class GenerationEvidence {
  readonly enabled: boolean;
  constructor(enabled = true) { this.enabled = enabled; }
  readonly solved = new Map<string, SolvedResult>();
  solverCalls = 0;
  cacheHits = 0;
  witnessFallbacks = 0;
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
