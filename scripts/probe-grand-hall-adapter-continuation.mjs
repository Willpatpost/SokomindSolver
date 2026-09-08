// Use the production continuation-plan builder, without reference route seeding.
import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createSession, stepSnapshot} from "../src/core/index.ts";
import {PUZZLE_BY_ID} from "../src/catalog/puzzles.ts";
import {search} from "../src/solver/implementations/sokomind-engine/engine.generated.js";
import {checkpointContinuationPlans} from "../src/solver/implementations/sokomind-plans.ts";
import {analysisPlanFromAnalysis} from "../src/solver/implementations/sokomind-legacy.ts";
import {solutionFromLegacyPath, toLegacyState} from "../src/solver/implementations/sokomind-solver.ts";
import {verifySolverSolution} from "../src/solver/verification.ts";
const evidence = JSON.parse(readFileSync("docs/benchmarks/grand-hall-route-diagnosis.json", "utf8"));
const session = createSession(PUZZLE_BY_ID.huge);
const request = {board: session.board, snapshot: session.snapshot, objective: {kind: "moves"}};
const state = toLegacyState(request);
assert.deepEqual(state, evidence.board);
const production = evidence.routes.find(route => route.name === "discovery");
const moves = {U: "Up", D: "Down", L: "Left", R: "Right"};
globalThis.postMessage = () => {};
const prepared = search({algorithm: "analyze-puzzle", state});
const analysis = analysisPlanFromAnalysis(prepared.analysis);
const output = {schemaVersion: 1, capturedAt: new Date().toISOString(), node: process.version,
  engineSha256: createHash("sha256").update(readFileSync("src/solver/implementations/sokomind-engine/engine.generated.js")).digest("hex"),
  scriptSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  methodology: "production checkpointContinuationPlans with root analysis, independent search, no suffix seeded; one run per setting",
  samples: []};
const child = process.argv.find(argument => argument.startsWith("--child="))?.slice(8);
if (!child) {
  for (const budget of [6000,60000]) for (const push of [7,44]) {
    const started = performance.now();
    const execution = spawnSync(process.execPath,["--experimental-strip-types",fileURLToPath(import.meta.url),`--child=${push},${budget}`],
      {encoding:"utf8",timeout:30000,maxBuffer:4000000,windowsHide:true});
    const sample = execution.status === 0 ? JSON.parse(execution.stdout) : {
      beforePush:push,maxExpandedStates:budget,status:"inconclusive",terminationReason:execution.error?.code === "ETIMEDOUT"
        ? "external-30s-process-budget" : "worker-error",elapsedMs:performance.now()-started,
      error:execution.error?.message ?? execution.stderr,verified:false};
    output.samples.push(sample);
    writeFileSync("docs/benchmarks/grand-hall-adapter-continuation.json",JSON.stringify(output,null,2)+"\n");
    console.log(JSON.stringify({...sample,payload:undefined,fullActionLog:undefined}));
  }
  process.exit(0);
}
for (const maxExpandedStates of [6000,60000]) for (const push of [7,44]) {
  if (child !== `${push},${maxExpandedStates}`) continue;
  const prefixMoves = production.pushTrace[push-2].move;
  const prefix = [...production.actionLog.slice(0,prefixMoves)].map(code => moves[code]);
  let snapshot = request.snapshot;
  for (const move of prefix) {
    const transition = stepSnapshot(request.board, snapshot, move.toLowerCase()); assert.ok(transition.moved); snapshot = transition.snapshot;
  }
  const [plan] = checkpointContinuationPlans([{state: toLegacyState({...request,snapshot}),path: prefix,cost: push-1}],
    state, {...request,limits: {maxExpandedStates,maxGeneratedStates: 500000}}, {},1,analysis);
  assert.ok(plan);
  const started = performance.now(), result = search(plan.payload), elapsedMs = performance.now()-started;
  const full = result.path && [...prefix,...result.path];
  const solution = full && solutionFromLegacyPath(request, full);
  if (solution) assert.ok(verifySolverSolution(request, solution).valid);
  const sample = {beforePush: push,maxExpandedStates,payload: plan.payload,prefixMoves,
    status: result.status,terminationReason: result.terminationReason,elapsedMs,visited: result.visited,
    generated: result.generated,verified: Boolean(solution),totalMoves: solution?.moves,totalPushes: solution?.pushes,
    fullActionLog: full?.map(move => move[0]).join("")};
  console.log(JSON.stringify(sample));
}
