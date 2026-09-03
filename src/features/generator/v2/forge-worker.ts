import { parentPort, workerData } from "node:worker_threads";
import { setImmediate } from "node:timers/promises";
import { completeCandidateFromBlueprint, generateBlueprintCandidate, generateRawCandidate } from "./puzzle-forge.ts";
import type { ForgeConfig, BlueprintCandidate, ReverseStart } from "./puzzle-forge.ts";
import type { ForgeTask } from "./forge-protocol.ts";
import { classifyDifficultyByBoxCount } from "./difficulty-model.ts";
import { evaluateFinalistV4, computeCurationObjectives } from "./finalist-evaluator.ts";
import { configureSearchScheduler } from "../../../solver/search/scheduling.ts";
import { evaluatePuzzle } from "./puzzle-evaluator.ts";

// This isolate runs one CPU job at a time. Yield often enough for host messages,
// without imposing the browser timer's minimum sleep every 256 search states.
let lastYield = performance.now();
configureSearchScheduler(async () => {
  if (performance.now() - lastYield >= 25) {
    await setImmediate();
    lastYield = performance.now();
  }
});

async function execute(task: ForgeTask): Promise<unknown> {
  switch (task.kind) {
    case "evaluate": return evaluatePuzzle(task.puzzle);
    case "blueprint": {
      const { seed, combination: c } = task.entry;
      return generateBlueprintCandidate(task.config, seed, c.family, c.boxCount, c.mode, classifyDifficultyByBoxCount(c.boxCount));
    }
    case "reverse": return generateRawCandidate(task.blueprint, task.config);
    case "complete": return completeCandidateFromBlueprint(task.blueprint, task.config, task.forcedReverseState, task.prepared);
    case "finalist": {
      const p = task.payload;
      const finalist = await evaluateFinalistV4(p.puzzle, task.policy, p.witnessSteps);
      const objectives = computeCurationObjectives(p.evaluation, finalist, p.dependencyRealizationRate);
      const deepScore = objectives.interaction + objectives.dependency + objectives.decisionQuality +
        objectives.structuralRichness + objectives.solverChallenge - objectives.tedium * 3;
      return { finalist, objectives, deepScore };
    }
  }
  throw new Error("Unknown forge task kind");
}

parentPort!.on("message", async (msg: { type: string; index: number; payload: unknown }) => {
  if (msg.type === "shutdown") { parentPort!.close(); return; }
  if (msg.type !== "task") return;
  try {
    const p = msg.payload as { kind?: string; candidate?: BlueprintCandidate; blueprint?: BlueprintCandidate; forcedReverseState?: ReverseStart };
    // Legacy callers are accepted at the boundary, but internal dispatch is a typed union.
    const result = p.kind ? await execute(msg.payload as ForgeTask) : await completeCandidateFromBlueprint(
      p.blueprint ?? p.candidate ?? msg.payload as BlueprintCandidate, workerData as ForgeConfig, p.forcedReverseState);
    parentPort!.postMessage({ type: "result", index: msg.index, result });
  } catch (error) {
    parentPort!.postMessage({ type: "error", index: msg.index, error: error instanceof Error ? error.stack : String(error) });
  }
});
