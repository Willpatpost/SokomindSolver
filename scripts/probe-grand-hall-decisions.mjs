// Offline same-state decision probes. No reference suffix is supplied to search.
import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {PUZZLE_BY_ID} from "../src/catalog/puzzles.ts";
import {createSession, stepSnapshot} from "../src/core/index.ts";
import {search} from "../src/solver/implementations/sokomind-engine/engine.generated.js";
import {toLegacyState, solutionFromLegacyPath} from "../src/solver/implementations/sokomind-solver.ts";
import {verifySolverSolution} from "../src/solver/verification.ts";

const diagnosis = JSON.parse(readFileSync("docs/benchmarks/grand-hall-route-diagnosis.json", "utf8"));
const session = createSession(PUZZLE_BY_ID.huge);
const request = {board: session.board, snapshot: session.snapshot, objective: {kind: "moves"}};
const route = diagnosis.routes.find(r => r.name === "discovery");
const names = {U: "Up", D: "Down", L: "Left", R: "Right"};
const key = p => `${p.row},${p.column}`;
const deltas = {Up: [-1,0], Down: [1,0], Left: [0,-1], Right: [0,1]};
function replay(snapshot, path) {
  for (const direction of path) {
    const transition = stepSnapshot(request.board, snapshot, direction.toLowerCase());
    assert.ok(transition.moved); snapshot = transition.snapshot;
  }
  return snapshot;
}
function legalBoxChoices(snapshot, label) {
  const box = snapshot.boxes.find(b => b.label === label), reachable = new Map([[key(snapshot.robot), []]]);
  const queue = [snapshot];
  for (let i = 0; i < queue.length; i++) for (const direction of Object.keys(deltas)) {
    const transition = stepSnapshot(request.board, queue[i], direction.toLowerCase());
    if (!transition.moved || transition.pushed || reachable.has(key(transition.snapshot.robot))) continue;
    reachable.set(key(transition.snapshot.robot), [...reachable.get(key(queue[i].robot)), direction]);
    queue.push(transition.snapshot);
  }
  return Object.entries(deltas).flatMap(([direction,[dy,dx]]) => {
    const support = `${box.position.row-dy},${box.position.column-dx}`;
    const walk = reachable.get(support);
    if (!walk) return [];
    const before = replay(snapshot, walk);
    const transition = stepSnapshot(request.board, before, direction.toLowerCase());
    return transition.pushedBoxId === box.id ? [{decision: `${label}-${direction}`, path: [...walk,direction]}] : [];
  });
}
globalThis.postMessage = () => {};
const options = {...diagnosis.discoveryOptions, planSearchMs: 30000};
const results = [];
// Event-derived checkpoints: before H's first manipulation and before its first goal fill.
const firstH = route.pushTrace.find(e => e.label === "H");
const firstHFill = route.goalEvents.find(e => e.label === "H" && e.kind === "fill");
for (const event of [firstH, firstHFill]) {
  const previousPush = route.pushTrace[event.push - 2];
  const prefix = [...route.actionLog.slice(0, previousPush?.move ?? 0)].map(code => names[code]);
  const checkpoint = replay(request.snapshot, prefix);
  const choices = [{decision: "unconstrained-restart", path: []}, ...legalBoxChoices(checkpoint, "H")];
  for (const choice of choices) {
    const branched = replay(checkpoint, choice.path);
    const start = performance.now();
    const result = search({...options, state: toLegacyState({...request, snapshot: branched})});
    const elapsedMs = performance.now() - start;
    const fullPath = result.path ? [...prefix, ...choice.path, ...result.path] : null;
    const solution = fullPath && solutionFromLegacyPath(request, fullPath);
    if (solution) assert.ok(verifySolverSolution(request, solution).valid);
    const sample = {beforeProductionPush: event.push, checkpoint: toLegacyState({...request, snapshot: checkpoint}),
      prefixMoves: prefix.length, prefixActionLog: prefix.map(move => move[0]).join(""),
      decision: choice.decision, decisionMoves: choice.path.length,
      decisionActionLog: choice.path.map(move => move[0]).join(""), status: result.status,
      terminationReason: result.terminationReason, elapsedMs, visited: result.visited, generated: result.generated,
      verified: Boolean(solution), totalMoves: solution?.moves, totalPushes: solution?.pushes,
      fullActionLog: fullPath?.map(move => move[0]).join("")};
    results.push(sample);
    console.log(JSON.stringify({...sample, checkpoint: undefined, fullActionLog: undefined, prefixActionLog: undefined}));
    writeFileSync("docs/benchmarks/grand-hall-decision-probes.json", JSON.stringify({schemaVersion: 1,
      capturedAt: new Date().toISOString(), node: process.version, platform: process.platform,
      engineSha256: createHash("sha256").update(readFileSync("src/solver/implementations/sokomind-engine/engine.generated.js")).digest("hex"),
      scriptSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
      methodology: "single-run same-state forced-next-push trials; independent continuation; no rewrite; cutoff is inconclusive",
      options, results}, null, 2) + "\n");
  }
}
