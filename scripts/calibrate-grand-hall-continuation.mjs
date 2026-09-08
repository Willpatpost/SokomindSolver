// Offline causal ablations. The in-memory doorway override is never shipped.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import vm from "node:vm";
import {PUZZLE_BY_ID} from "../src/catalog/puzzles.ts";
import {createSession, stepSnapshot} from "../src/core/index.ts";
import {toLegacyState, solutionFromLegacyPath} from "../src/solver/implementations/sokomind-solver.ts";
import {verifySolverSolution} from "../src/solver/verification.ts";

const evidence = JSON.parse(readFileSync("docs/benchmarks/grand-hall-route-diagnosis.json", "utf8"));
const originalSource = readFileSync("src/solver/implementations/sokomind-engine/engine.generated.js", "utf8");
const root = createSession(PUZZLE_BY_ID.huge);
const request = {board: root.board, snapshot: root.snapshot, objective: {kind: "moves"}};
assert.deepEqual(toLegacyState(request), evidence.board);
const production = evidence.routes.find(route => route.name === "discovery");
const moves = {U: "Up", D: "Down", L: "Left", R: "Right"};
const needle = 'const rootDoorwayTasks = payload.planDoorwaySchedule === false\n    ? [] : assignmentDoorwayPlan(initial.boxes, board, true).tasks;';
let source = originalSource.replace(/\r\n/g, "\n").replace(/export \{[^}]+\};\s*$/, "");
assert.equal(source.split(needle).length, 2);
source = source.replace(needle, 'const rootDoorwayTasks = payload.calibrationDoorwayTasks ?? (payload.planDoorwaySchedule === false\n    ? [] : assignmentDoorwayPlan(initial.boxes, board, true).tasks);');
globalThis.postMessage = () => {};
const options = {...evidence.discoveryOptions, planSearchMs: 120000, planDiagnostics: true};
assert.ok(process.argv.slice(2).every(argument => argument === "--guards"), "Unknown argument");
const guards = process.argv.includes("--guards");
const output = {schemaVersion: 1, capturedAt: new Date().toISOString(), node: process.version,
  platform: process.platform, engineSha256: createHash("sha256").update(originalSource).digest("hex"),
  scriptSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  methodology: "isolated compiled closure per sample; single runs; matched work limits; root order/doorway ablations; no suffix seeded",
  options, samples: []};
const outputPath = guards ? "docs/benchmarks/grand-hall-continuation-guards.json" : "docs/benchmarks/grand-hall-continuation-calibration.json";
const emit = () => writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
for (const push of [7,44]) {
  const prefixMoves = production.pushTrace[push - 2].move;
  const prefix = [...production.actionLog.slice(0, prefixMoves)].map(code => moves[code]);
  let snapshot = request.snapshot;
  for (const move of prefix) {
    const next = stepSnapshot(request.board, snapshot, move.toLowerCase()); assert.ok(next.moved); snapshot = next.snapshot;
  }
  const checkpoint = toLegacyState({...request, snapshot});
  for (const variant of guards ? ["fresh-no-goal-access", "fresh-no-egress"] : ["fresh", "root-order", "root-order-and-doorway"]) {
    const calibrate = vm.compileFunction(source + `
      return (root, checkpoint, prefix, options, variant) => {
        const canonical = canonicalPlanTransform(root), board = parse(canonical);
        let state = {robot: canonical.robot, boxes: canonical.boxes.map(([cell,label]) => [...cell.split(",").map(Number),label])};
        for (const move of prefix) {
          const transformed = transformPlanMove(move, canonical.transform, canonical.height, canonical.width);
          state = neighbors(state, board, false).find(next => next.move === transformed);
          if (!state) throw new Error("Invalid canonical prefix");
        }
        const rooted = {rows: canonical.rows, robot: state.robot,
          boxes: state.boxes.map(([y,x,label]) => [pkey(y,x),label])};
        const initial = canonical.boxes.map(([cell,label]) => [...cell.split(",").map(Number),label]);
        const rootTasks = assignmentDoorwayPlan(initial, board, true).tasks;
        const freshTasks = assignmentDoorwayPlan(state.boxes, board, true).tasks;
        let result;
        if (variant.startsWith("fresh")) result = search({...options, state: checkpoint,
          ...(variant === "fresh-no-goal-access" ? {planGoalAccessGuard: false} : {}),
          ...(variant === "fresh-no-egress" ? {planEgressGuard: false} : {})});
        else {
          result = search({...options, state: rooted, planCanonicalOrientation: false,
            ...(variant === "root-order-and-doorway" ? {calibrationDoorwayTasks: rootTasks} : {})});
          if (result.path) result.path = result.path.map(move => transformPlanMove(move, canonical.transform, canonical.height, canonical.width, true));
        }
        return {result, rootOrientation: canonical.transform.id, checkpointOrientation: canonicalPlanTransform(checkpoint).transform.id,
          rootedBoxes: rooted.boxes, rootTasks, freshTasks};
      };
    `, [])();
    const start = performance.now();
    const {result, ...details} = calibrate(evidence.board, checkpoint, prefix, options, variant);
    const elapsedMs = performance.now() - start;
    const full = result.path && [...prefix,...result.path];
    const solution = full && solutionFromLegacyPath(request, full);
    if (solution) assert.ok(verifySolverSolution(request, solution).valid);
    const sample = {beforePush: push, variant, prefixMoves, ...details, elapsedMs,
      status: result.status, terminationReason: result.terminationReason, visited: result.visited,
      generated: result.generated, totalMoves: solution?.moves, totalPushes: solution?.pushes,
      verified: Boolean(solution), fullActionLog: full?.map(move => move[0]).join(""), diagnostics: result.planDiagnostics};
    output.samples.push(sample); emit();
    console.log(JSON.stringify({push,variant,moves:sample.totalMoves,status:sample.status,elapsedMs}));
  }
}
