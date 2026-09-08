// Real adapter/worker integration: no saved solution or human route is supplied.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {PUZZLE_BY_ID} from "../src/catalog/puzzles.ts";
import {createSession} from "../src/core/index.ts";
import {createNodeSolverAdapter} from "../src/solver/node-runner.ts";
import {verifySolverSolution} from "../src/solver/verification.ts";

const root = new URL("../", import.meta.url);
const cases = [
  {id: "huge", orientation: "identity", budget: 50000},
  {id: "huge", orientation: "identity", budget: 300000},
  {id: "huge", orientation: "mirror", budget: 300000},
  {id: "huge", orientation: "rotate", budget: 300000},
  ...["beginner-typed-line", "beginner-detour", "workshop-1", "classic-1", "large", "adv-gallery", "expert-maze"]
    .map(id => ({id, orientation: "identity", budget: 100000})),
];
const only = process.argv.find(arg => arg.startsWith("--only="))?.slice(7);
const results: unknown[] = [];
const hash = async (path: string) => createHash("sha256").update(await readFile(new URL(path, root))).digest("hex");
const evidence = {node: process.version, engineSha256: await hash("src/solver/implementations/sokomind-engine/engine.generated.js"),
  adapterSha256: await hash("src/solver/implementations/sokomind-solver.ts"), results};
for (const entry of cases.filter(entry => !only || (only === "corpus" ? entry.id !== "huge" : entry.id === only))) {
  const puzzle = PUZZLE_BY_ID[entry.id];
  const rows = entry.orientation === "identity" ? puzzle.rows :
    (entry.orientation === "rotate" ? [...puzzle.rows].reverse() : puzzle.rows).map(row => [...row].reverse().join(""));
  const session = createSession({...puzzle, rows});
  const request = {board: session.board, snapshot: session.snapshot, objective: {kind: "moves" as const},
    options: {"sokomind-solver": {mode: "quality", maximumIncumbents: 1, harvestElapsedMs: 0}},
    limits: {maxElapsedMs: 30000, maxExpandedStates: entry.budget + 10000, maxGeneratedStates: 2000000,
      maxMemoryBytes: 2 * 1024 ** 3}};
  const phases: Array<{detail: string; elapsedMs: number; expanded?: number; bestMoves?: number}> = [];
  const adapter = createNodeSolverAdapter({hardwareConcurrency: 2, improvementMaxVisited: entry.budget,
    improvementMaxElapsedMs: 20000, improvementMinimumMoves: 0, structuralHeadStartMs: 15000});
  const result = await adapter.solve(request, {signal: new AbortController().signal, now: () => performance.now(),
    reportProgress(progress) {
      if (progress.detail && /started\.|finished|Verifying candidate/.test(progress.detail)) {
        phases.push({detail: progress.detail, elapsedMs: progress.elapsedMs, expanded: progress.expandedStates,
          bestMoves: progress.counters?.bestSolutionMoves});
      }
    }});
  const verified = result.status === "solved" && verifySolverSolution(request, result.solution).valid;
  assert.ok(verified, `${entry.id}/${entry.orientation}: ${result.status}`);
  assert.ok((result.metrics.expandedStates ?? 0) <= request.limits.maxExpandedStates);
  assert.ok((result.metrics.generatedStates ?? 0) <= request.limits.maxGeneratedStates);
  if (result.status === "solved") {
    assert.ok(result.solution.moves <= (result.metrics.counters?.initialSolutionMoves ?? Infinity));
    if (entry.id === "huge") assert.ok(result.solution.moves <= (entry.budget === 50000 ? 709 : 650));
  }
  const record = {...entry, requestLimits: request.limits, verified, phases, status: result.status,
    ...(result.status === "solved" ? {moves: result.solution.moves, pushes: result.solution.pushes,
      actionLog: result.solution.steps.map(step => step.direction[0].toUpperCase()).join("")} : {}), metrics: result.metrics};
  results.push(record);
  console.log(JSON.stringify({id: entry.id, orientation: entry.orientation, budget: entry.budget,
    moves: record.moves, pushes: record.pushes, ms: result.metrics.elapsedMs,
    initial: result.metrics.counters?.initialSolutionMoves, beforeProof: result.metrics.counters?.bestSolutionMoves,
    rescheduled: phases.some(phase => phase.detail.includes("transport rescheduling"))}));
  await writeFile(new URL(`docs/benchmarks/quality-rescheduling${only ? `-${only}` : ""}.json`, root), JSON.stringify(evidence, null, 2) + "\n");
}
