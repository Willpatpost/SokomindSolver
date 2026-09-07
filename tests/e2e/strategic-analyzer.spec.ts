import { readdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createSession, type PuzzleDefinition } from "../../src/core/index.ts";
import { toLegacyState, solutionFromLegacyPath } from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

const puzzle: PuzzleDefinition = {
  id: "browser-strategic", title: "Browser strategic", difficulty: "tutorial", boxes: 2,
  rows: ["OOOOOOO", "O  R  O", "O A X O", "O a S O", "O     O", "OOOOOOO"],
};

test("a fresh search worker consumes a serialized analyzer plan", async ({page}) => {
  const assets = await readdir(new URL("../../dist/assets/", import.meta.url));
  const asset = assets.find(name => /^sokomind-engine\.worker-.*\.js$/.test(name));
  expect(asset).toBeTruthy();
  await page.goto("./#/play/ultra-tiny");
  const session = createSession(puzzle);
  const request = {board: session.board, snapshot: session.snapshot, objective: {kind: "moves" as const}};
  const state = toLegacyState(request);
  const result = await page.evaluate(async ({asset, state}) => {
    const url = new URL(`assets/${asset}`, document.baseURI).href;
    const run = (payload: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const worker = new Worker(url, {type: "module"});
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Strategic worker timed out"));
      }, 10000);
      worker.onerror = event => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message));
      };
      worker.onmessage = event => {
        if (event.data.type !== "done") return;
        clearTimeout(timer);
        worker.terminate();
        resolve(event.data);
      };
      worker.postMessage({mode: "search", payload});
    });
    const preparation = await run({algorithm: "analyze-puzzle", state, strategicAnalysis: {maxMs: 1000}});
    const plan = (preparation.analysis as {strategicPlan: Record<string, unknown>}).strategicPlan;
    // Crossing both JSON and Worker boundaries must retain a usable package.
    const solved = await run({algorithm: "plan-macro-beam", state,
      strategicPlan: JSON.parse(JSON.stringify(plan)), maxVisited: 1});
    const executed = await run({algorithm: "plan-macro-beam", state,
      strategicPlan: {...JSON.parse(JSON.stringify(plan)), candidates: []}, planDiagnostics: true});
    const cutoff = await run({algorithm: "plan-macro-beam", state, planSearchMs: 0});
    return {solved, executed, cutoff};
  }, {asset, state});
  expect(result.solved.status).toBe("solved");
  expect(result.solved.visited).toBe(0);
  const solution = solutionFromLegacyPath(request, result.solved.path as string[]);
  expect(solution).toBeTruthy();
  expect(verifySolverSolution(request, solution!).valid).toBe(true);
  expect(result.executed.status).toBe("solved");
  const execution = (result.executed.planDiagnostics as {strategicExecution: {evaluations: number}}).strategicExecution;
  expect(execution.evaluations).toBeGreaterThan(0);
  const executedSolution = solutionFromLegacyPath(request, result.executed.path as string[]);
  expect(executedSolution).toBeTruthy();
  expect(verifySolverSolution(request, executedSolution!).valid).toBe(true);
  expect(result.cutoff.status).toBe("cutoff");
  expect(result.cutoff.terminationReason).toBe("search-time-budget");
});
