import { parentPort, workerData } from "node:worker_threads";

import { evaluateFinalistV4, computeCurationObjectives } from "./finalist-evaluator.ts";
import type { FinalistEvaluationV4, CurationObjectives } from "./finalist-evaluator.ts";
import type { V4EvaluatorPolicy } from "./solver-bottleneck.ts";
import type { PuzzleDefinition } from "../../../core/model.ts";
import type { SolutionStep } from "../../../solver/contracts.ts";
import type { PuzzleEvaluationVector } from "./puzzle-evaluator.ts";

const policy = workerData as V4EvaluatorPolicy;

export interface FinalistTaskPayload {
  readonly puzzle: PuzzleDefinition;
  readonly witnessSteps?: readonly SolutionStep[];
  readonly evaluation: PuzzleEvaluationVector;
  readonly dependencyRealizationRate?: number;
}

interface FinalistTaskResult {
  readonly finalist: FinalistEvaluationV4;
  readonly objectives: CurationObjectives;
  readonly deepScore: number;
}

parentPort!.on("message", async (msg: { type: string; index: number; payload: unknown }) => {
  if (msg.type === "shutdown") {
    process.exit(0);
  }
  if (msg.type === "task") {
    const p = msg.payload as FinalistTaskPayload;
    const finalist = await evaluateFinalistV4(p.puzzle, policy, p.witnessSteps);
    const objectives = computeCurationObjectives(
      p.evaluation,
      finalist,
      p.dependencyRealizationRate,
    );
    const deepScore = objectives.interaction + objectives.dependency +
      objectives.decisionQuality + objectives.structuralRichness +
      objectives.solverChallenge - objectives.tedium * 3;
    parentPort!.postMessage({
      type: "result",
      index: msg.index,
      result: { finalist, objectives, deepScore } satisfies FinalistTaskResult,
    });
  }
});
