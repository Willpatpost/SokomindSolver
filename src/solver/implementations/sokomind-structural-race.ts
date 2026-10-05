import type { SolverRequest, SolverSolution } from "../contracts.ts";
import type { EngineWorkerSource } from "./sokomind-engine-pool.ts";
import { isSolutionBetter } from "./sokomind-incumbents.ts";
import type { LegacyState, SokomindAnalysisPlan } from "./sokomind-legacy.ts";
import { runPhase, type PhaseOutcome } from "./sokomind-phase-runner.ts";
import type { EnginePlan } from "./sokomind-plans.ts";
import {
  bidirectionalPlans,
  checkpointContinuationPlans,
  discoveryPlans,
  reverseLaneCount,
  structuralPlan,
} from "./sokomind-plans.ts";
import type { PhaseStopReason, SearchRunState } from "./sokomind-run-state.ts";

export interface StructuralRaceInput {
  readonly state: LegacyState;
  /** The remaining request with the structural lane's state share. */
  readonly structuralRequest: SolverRequest;
  /**
   * The remaining request. Discovery and checkpoint lanes plan against it;
   * plans read only its memory and state limits, and the race runs only
   * when no state limit is finite.
   */
  readonly discoveryRequest: SolverRequest;
  readonly tuning: Readonly<Record<string, number>>;
  readonly analysisPlan?: SokomindAnalysisPlan;
  /** At least 2: structural takes one worker, discovery the rest. */
  readonly maxWorkers: number;
  readonly headStartMs: number;
}

export interface StructuralRaceOutcome {
  readonly solution?: SolverSolution;
  readonly stopReason?: PhaseStopReason;
  readonly errors: readonly string[];
}

interface Lane {
  readonly controller: AbortController;
  readonly promise: Promise<PhaseOutcome>;
}

/**
 * Fast on a structural board. Structural search keeps its head start on one
 * worker while discovery runs on the others: the forward and reverse
 * frontiers when at least three workers are free for them, the guided push
 * portfolio otherwise or once the frontiers end without a route. The first
 * replayed route wins: the other lanes stop, and the better of any routes they
 * already hold is kept. When the head start ends without a route, its
 * checkpoint continuations take its place beside discovery.
 */
export async function raceStructuralDiscovery(
  run: SearchRunState,
  engineWorkers: EngineWorkerSource,
  input: StructuralRaceInput,
): Promise<StructuralRaceOutcome> {
  const { state, tuning, analysisPlan, maxWorkers } = input;
  const portfolio = discoveryPlans(
    state, input.discoveryRequest, 1, tuning, 1, analysisPlan, true,
  );
  // Beside the frontiers, the portfolio's lane added memory and found no
  // route sooner, so it runs only if the frontiers end without one.
  const frontiers = maxWorkers - 1 >= 3 && reverseLaneCount(analysisPlan) > 0
    ? bidirectionalPlans(state, input.discoveryRequest, 2, analysisPlan)
    : [];
  const rootPlans = frontiers.length > 0 ? frontiers : portfolio;
  const rootPlanCount = rootPlans.length;
  // One memory share per lane that can run at once: discovery's root plans
  // plus structural, or plus the checkpoint continuations that replace it.
  const memoryConcurrency =
    rootPlanCount + Math.min(2, maxWorkers - rootPlanCount);
  const errors: string[] = [];
  const best: { solution?: SolverSolution; stopReason?: PhaseStopReason } = {};
  const lanes: Lane[] = [];

  const start = (
    plans: readonly EnginePlan[],
    maxConcurrent: number,
    maxPhaseElapsedMs?: number,
    beside = true,
  ): Lane => {
    const controller = new AbortController();
    const lane = {
      controller,
      promise: runPhase(
        run, plans, engineWorkers, maxConcurrent, maxPhaseElapsedMs,
        { signal: controller.signal, ...(beside ? { memoryConcurrency } : {}) },
      ),
    };
    lanes.push(lane);
    return lane;
  };
  const keep = (outcome: PhaseOutcome): void => {
    errors.push(...outcome.errors);
    if (outcome.solution && (!best.solution || isSolutionBetter(outcome.solution, best.solution))) {
      best.solution = outcome.solution;
    }
    best.stopReason ??= outcome.stopReason;
  };

  try {
    const structural = start(
      [structuralPlan(state, input.structuralRequest, tuning, "fast", 1, analysisPlan)],
      1,
      input.headStartMs,
    );
    let discovery = start(rootPlans, rootPlanCount);
    let portfolioPending = rootPlans !== portfolio;
    const pending = new Set<Lane>([structural, discovery]);
    while (pending.size > 0) {
      const { lane, outcome } = await Promise.race(
        [...pending].map((candidate) =>
          candidate.promise.then((settled) => ({ lane: candidate, outcome: settled }))),
      );
      pending.delete(lane);
      keep(outcome);
      if (best.solution || best.stopReason) break;
      if (lane === discovery && portfolioPending) {
        portfolioPending = false;
        discovery = start(portfolio, 1);
        pending.add(discovery);
        continue;
      }
      if (lane !== structural) continue;
      const continuations = checkpointContinuationPlans(
        outcome.checkpoints ?? [], state, input.discoveryRequest, tuning,
        memoryConcurrency, analysisPlan, true,
      );
      if (continuations.length === 0) continue;
      pending.add(pending.has(discovery)
        ? start(continuations, maxWorkers - rootPlanCount)
        : start(continuations, maxWorkers, undefined, false));
    }
    for (const lane of pending) lane.controller.abort();
    for (const lane of pending) keep(await lane.promise);
  } catch (error) {
    for (const lane of lanes) lane.controller.abort();
    await Promise.allSettled(lanes.map((lane) => lane.promise));
    throw error;
  }
  return Object.freeze({
    ...(best.solution ? { solution: best.solution } : {}),
    ...(best.stopReason ? { stopReason: best.stopReason } : {}),
    errors: Object.freeze(errors),
  });
}
