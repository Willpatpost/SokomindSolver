import { readdir, readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createSession, type PuzzleDefinition } from "../../src/core/index.ts";
import { toLegacyState, solutionFromLegacyPath } from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import type { SolverResult } from "../../src/solver/contracts.ts";

const puzzle: PuzzleDefinition = {
  id: "browser-strategic", title: "Browser strategic", difficulty: "tutorial", boxes: 2,
  rows: ["OOOOOOO", "O  R  O", "O A X O", "O a S O", "O     O", "OOOOOOO"],
};

test("the public quality worker solves Grand Hall through automatic rescheduling", async ({page}) => {
  test.setTimeout(90000);
  const assets = await readdir(new URL("../../dist/assets/", import.meta.url));
  const asset = assets.find(name => /^solver\.worker-.*\.js$/.test(name));
  expect(asset).toBeTruthy();
  const session = createSession(PUZZLE_BY_ID.huge);
  const request = {board: session.board, snapshot: session.snapshot, objective: {kind: "moves" as const},
    options: {"sokomind-solver": {mode: "quality", maximumIncumbents: 1, harvestElapsedMs: 0, deterministic: true}},
    limits: {maxElapsedMs: 45000, maxExpandedStates: 200000, maxGeneratedStates: 2000000,
      maxMemoryBytes: 2 * 1024 ** 3}};
  await page.goto("./#/play/ultra-tiny");
  const {result, rescheduled} = await page.evaluate(async ({asset, request}) =>
    new Promise<{result: SolverResult; rescheduled: boolean}>((resolve, reject) => {
      const worker = new Worker(new URL(`assets/${asset}`, document.baseURI), {type: "module"});
      let rescheduled = false;
      const finish = () => {clearTimeout(timer); worker.terminate();};
      const timer = setTimeout(() => {finish(); reject(new Error("Quality worker timed out"));}, 60000);
      worker.onerror = event => {finish(); reject(new Error(event.message));};
      worker.onmessage = event => {
        const data = event.data;
        if (data.type === "solver/progress" && data.progress.detail?.includes("transport rescheduling")) rescheduled = true;
        if (data.type === "solver/failure") {finish(); reject(new Error(data.error.message));}
        if (data.type === "solver/result") {finish(); resolve({result: data.result, rescheduled});}
      };
      worker.postMessage({type: "solver/run", protocolVersion: 1, jobId: "quality-rescheduling",
        solverId: "sokomind-solver", request});
    }), {asset, request});
  expect(rescheduled).toBe(true);
  expect(result.status).toBe("solved");
  if (result.status !== "solved") return;
  expect(result.solution.moves).toBeLessThanOrEqual(900);
  expect(result.solution.pushes).toBeLessThanOrEqual(280);
  expect(verifySolverSolution(request, result.solution).valid).toBe(true);
  expect(result.metrics.expandedStates).toBeLessThanOrEqual(request.limits.maxExpandedStates);
  expect(result.metrics.generatedStates).toBeLessThanOrEqual(request.limits.maxGeneratedStates);
});

test("a fresh worker reschedules a production Grand Hall incumbent", async ({page}) => {
  const assets = await readdir(new URL("../../dist/assets/", import.meta.url));
  const asset = assets.find(name => /^sokomind-engine\.worker-.*\.js$/.test(name));
  expect(asset).toBeTruthy();
  const evidence = JSON.parse(await readFile(new URL("../../docs/benchmarks/grand-hall-route-diagnosis.json", import.meta.url), "utf8")) as
    {routes: Array<{name:string;actionLog:string}>};
  const route = evidence.routes.find(route => route.name === "rewrite")!;
  const names:Record<string,string> = {U:"Up",D:"Down",L:"Left",R:"Right"};
  const session = createSession(PUZZLE_BY_ID.huge);
  const request = {board:session.board,snapshot:session.snapshot,objective:{kind:"moves" as const}};
  await page.goto("./#/play/ultra-tiny");
  const result = await page.evaluate(async ({asset,state,path}) => new Promise<{path:string[];status:string;visited:number}>((resolve,reject) => {
    const worker = new Worker(new URL(`assets/${asset}`,document.baseURI),{type:"module"});
    const timer = setTimeout(() => {worker.terminate();reject(new Error("Rescheduling worker timed out"));},30000);
    worker.onerror = event => {clearTimeout(timer);worker.terminate();reject(new Error(event.message));};
    worker.onmessage = event => {
      if(event.data.type!=="done")return;
      clearTimeout(timer);worker.terminate();resolve(event.data);
    };
    worker.postMessage({mode:"search",payload:{algorithm:"solution-box-reschedule",state,solutionPath:path,
      maxVisited:300000,maxGenerated:2000000,rescheduleMaxMs:25000}});
  }),{asset,state:toLegacyState(request),path:[...route.actionLog].map(code=>names[code])});
  expect(result.status).toBe("solved");
  const solution=solutionFromLegacyPath(request,result.path);
  expect(solution?.moves).toBe(503);expect(solution?.pushes).toBe(236);
  expect(verifySolverSolution(request,solution!).valid).toBe(true);
  expect(result.visited).toBeLessThanOrEqual(300000);
});

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
