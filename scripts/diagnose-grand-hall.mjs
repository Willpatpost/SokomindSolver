// Offline diagnosis only: the reference never enters solver configuration.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {PUZZLE_BY_ID} from "../src/catalog/puzzles.ts";
import {createSession, stepSnapshot} from "../src/core/index.ts";
import {search} from "../src/solver/implementations/sokomind-engine/engine.generated.js";
import {solutionFromLegacyPath, toLegacyState} from "../src/solver/implementations/sokomind-solver.ts";
import {verifySolverSolution} from "../src/solver/verification.ts";

const session = createSession(PUZZLE_BY_ID.huge);
const request = {board: session.board, snapshot: session.snapshot, objective: {kind: "moves"}};
const state = toLegacyState(request);
const reference = JSON.parse(readFileSync("tests/fixtures/solver-v2/grand-hall-reference.json", "utf8"));
const directions = {U: "Up", D: "Down", L: "Left", R: "Right"};
const key = p => `${p.row},${p.column}`;
const goals = new Map(session.board.goals.map(g => [key(g.position), g.label]));
const floor = new Set(session.board.floor.map(key));
const adjacent = cell => {
  const [y,x] = cell.split(",").map(Number);
  return [[y-1,x],[y+1,x],[y,x-1],[y,x+1]].map(p => p.join(",")).filter(p => floor.has(p));
};
function distances(start, blocked) {
  const found = new Map([[start, 0]]), queue = [start];
  for (let i = 0; i < queue.length; i++) for (const next of adjacent(queue[i])) {
    if (blocked.has(next) || found.has(next)) continue;
    found.set(next, found.get(queue[i]) + 1); queue.push(next);
  }
  return found;
}
const gates = [...floor].flatMap(gate => {
  const components = new Map(); let component = 0;
  for (const cell of floor) {
    if (cell === gate || components.has(cell)) continue;
    for (const member of distances(cell, new Set([gate])).keys()) components.set(member, component);
    component++;
  }
  return component > 1 ? [{gate, components}] : [];
});
function crossings(cells) {
  return gates.flatMap(({gate, components}) => {
    const events = [];
    for (let i = 1; i < cells.length - 1; i++) if (cells[i] === gate &&
        components.get(cells[i-1]) !== components.get(cells[i+1])) {
      events.push({gate, step: i, fromComponent: components.get(cells[i-1]),
        toComponent: components.get(cells[i+1])});
    }
    return events;
  });
}
const discoveryOptions = {algorithm: "plan-macro-beam", maxDepth: 460, maxVisited: 6000,
  transpositionLimit: 60000, planBeamWidth: 32, planBoxBranches: 6, maxPlanSegments: 160,
  planSlack: 240, sequenceMacroLimit: 24, sequenceMacroExplored: 48, sequenceMacroResults: 4,
  targetedMacroExplored: 64, planSolutionComparisonBudget: 0, progressIntervalMs: 5000};
const rewriteOptions = {algorithm: "solution-window-rewrite", maxVisited: 50000,
  permutationVisited: 10000, permutationWindowPushes: [8,16,32], perPermutationWindowVisited: 1500,
  windowPushes: [8,16,32], windowVisited: 12000, windowTotalVisited: 15000, frontierLimit: 12000,
  moveWindowVisited: 25000, moveWindowPushes: [1,2,4], moveWindowAttempts: 12,
  perMoveWindowVisited: 4000, moveWindowExtraPushes: 4, moveWindowMinimumOverhead: 6,
  adaptiveMoveWindows: true, adaptiveMoveMinimumPriorImprovements: 8, moveWindowMissLimit: 1};
globalThis.postMessage = () => {};
function run(options) {
  const start = performance.now();
  const result = search({...options, state});
  assert.ok(result.path);
  return {path: result.path, elapsedMs: performance.now() - start, visited: result.visited,
    generated: result.generated};
}
const discovery = run(discoveryOptions);
const rewritten = run({...rewriteOptions, solutionPath: discovery.path});

function trace(name, path, metadata = {}) {
  const solution = solutionFromLegacyPath(request, path);
  assert.ok(solution && verifySolverSolution(request, solution).valid);
  let snapshot = request.snapshot, walking = 0, lastBox = null, walkStart = key(snapshot.robot);
  const keeperCells = [walkStart];
  const normalizedPath = [];
  const pushes = [], runs = [], goalEvents = [], byLabel = {}, boxTrajectories = {};
  for (const box of snapshot.boxes) boxTrajectories[box.id] = {label: box.label, cells: [key(box.position)]};
  for (let i = 0; i < path.length; i++) {
    const before = snapshot;
    const transition = stepSnapshot(request.board, before, path[i].toLowerCase());
    snapshot = transition.snapshot;
    keeperCells.push(key(snapshot.robot));
    assert.equal(snapshot.moves, before.moves + 1, `${name}: illegal move ${i + 1}`);
    if (!transition.pushed) {walking++; continue;}
    const index = snapshot.boxes.findIndex((box, j) => key(box.position) !== key(before.boxes[j].position));
    const box = snapshot.boxes[index], from = key(before.boxes[index].position), to = key(box.position);
    const walkingDistances = distances(walkStart, new Set(before.boxes.map(box => key(box.position))));
    const walkCells = [key(before.robot)];
    while (walkCells.at(-1) !== walkStart) {
      const cell = walkCells.at(-1);
      const previous = adjacent(cell).find(next => walkingDistances.get(next) === walkingDistances.get(cell) - 1);
      assert.ok(previous); walkCells.push(previous);
    }
    walkCells.reverse();
    for (let j = 1; j < walkCells.length; j++) {
      const [y,x] = walkCells[j-1].split(",").map(Number), [ny,nx] = walkCells[j].split(",").map(Number);
      normalizedPath.push(ny < y ? "Up" : ny > y ? "Down" : nx < x ? "Left" : "Right");
    }
    normalizedPath.push(path[i]);
    const event = {push: pushes.length + 1, move: i + 1, boxId: box.id, label: box.label,
      from, to, keeperBefore: key(before.robot), walkingBefore: walking,
      shortestWalkingBefore: walkingDistances.get(key(before.robot)),
      leavesGoal: goals.get(from) === box.label, fillsGoal: goals.get(to) === box.label};
    assert.ok(Number.isInteger(event.shortestWalkingBefore) && event.shortestWalkingBefore <= walking);
    pushes.push(event);
    if (event.leavesGoal) goalEvents.push({...event, kind: "unfill"});
    if (event.fillsGoal) goalEvents.push({...event, kind: "fill"});
    const totals = byLabel[box.label] ??= {pushes: 0, walkingBefore: 0, runs: 0, unfilled: 0};
    totals.pushes++; totals.walkingBefore += walking; totals.unfilled += Number(event.leavesGoal);
    boxTrajectories[box.id].cells.push(to);
    if (lastBox !== box.id) {
      runs.push({boxId: box.id, label: box.label, startPush: event.push, startMove: event.move,
        from, to, pushes: 0, walking: 0, endsOnGoal: false});
      totals.runs++;
    }
    Object.assign(runs.at(-1), {to, pushes: runs.at(-1).pushes + 1,
      walking: runs.at(-1).walking + walking, endsOnGoal: event.fillsGoal});
    lastBox = box.id; walking = 0; walkStart = key(snapshot.robot);
  }
  assert.equal(solution.moves, pushes.length + pushes.reduce((n, p) => n + p.walkingBefore, 0) + walking);
  const normalizedSolution = solutionFromLegacyPath(request, normalizedPath);
  assert.ok(normalizedSolution && verifySolverSolution(request, normalizedSolution).valid);
  assert.equal(normalizedSolution.pushes, solution.pushes);
  return {name, ...metadata, actionLog: path.map(move => move[0]).join(""), verified: true,
    shortestWalkRealization: {moves: normalizedSolution.moves, pushes: normalizedSolution.pushes,
      verified: true, actionLog: normalizedPath.map(move => move[0]).join("")},
    moves: solution.moves, pushes: solution.pushes, walking: solution.moves - solution.pushes,
    trailingWalking: walking, keeperGateCrossings: crossings(keeperCells),
    runs, goalEvents, byLabel, boxTrajectories, pushTrace: pushes};
}
const routes = [trace("discovery", discovery.path, discovery), trace("rewrite", rewritten.path, rewritten),
  trace("reference", [...reference.actionLog].map(code => directions[code]))];
for (const route of routes) {
  route.fixedPushOrderWalkingExcess = route.pushTrace.reduce((sum, event) => sum + event.walkingBefore - event.shortestWalkingBefore, 0);
  route.boxGateCrossings = Object.fromEntries(Object.entries(route.boxTrajectories).map(([id, trajectory]) => [id, crossings(trajectory.cells)]));
}
assert.deepEqual(routes.map(r => [r.moves, r.pushes]), [[893,278],[789,270],[626,248]]);
// Same-label box identities are diagnostic within a route, not fixed roles across routes.
const labels = [...new Set(session.snapshot.boxes.map(box => box.label))].sort();
const table = labels.map(label => {
  const values = routes.map(route => route.byLabel[label] || {pushes: 0, walkingBefore: 0, runs: 0, unfilled: 0});
  return `| ${label} | ${values.map(v => `${v.pushes} / ${v.walkingBefore} / ${v.runs}`).join(" | ")} |`;
}).join("\n");
const firstPushDivergence = routes[0].pushTrace.findIndex((event, index) => {
  const other = routes[2].pushTrace[index];
  return !other || event.from !== other.from || event.to !== other.to;
});
const output = {schemaVersion: 1, methodology: "offline production-kernel replay diagnosis; not browser timing",
  capturedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  engineSha256: createHash("sha256").update(readFileSync("src/solver/implementations/sokomind-engine/engine.generated.js")).digest("hex"),
  scriptSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  board: state, discoveryOptions, rewriteOptions, referenceSource: reference.source,
  firstPushDivergence: firstPushDivergence + 1, routes};
writeFileSync("docs/benchmarks/grand-hall-route-diagnosis.json", JSON.stringify(output, null, 2) + "\n");
const report = `# Grand Hall route accounting\n\nGenerated by scripts/diagnose-grand-hall.mjs. All routes replay verified.
This captures the production regression kernel configuration, not a browser/UI portfolio run.

| Route | Moves | Pushes | Walking | Box runs | Goal unfill events |
| --- | ---: | ---: | ---: | ---: | ---: |
${routes.map(r => `| ${r.name} | ${r.moves} | ${r.pushes} | ${r.walking} | ${r.runs.length} | ${r.goalEvents.filter(e => e.kind === "unfill").length} |`).join("\n")}

The 267-move discovery gap is exactly 30 pushes plus 237 walking moves.
Rewrite removes 104 moves: 8 pushes and 96 walking moves. Its remaining 163-move
gap is 22 pushes plus 141 walking moves. These are accounting differences, not
proof that any particular action can be removed independently.

For each unchanged push sequence, independently computed shortest keeper paths
give excess walking of ${routes.map(r => `${r.name}: ${r.fixedPushOrderWalkingExcess}`).join(", ")} moves.
This isolates walking detours from the distances imposed by box positions and
push order. Gate-crossing events in the JSON use static articulation cells;
they overlap across gates and are annotations, not additive wasted-move totals.
Rebuilding and replaying the reference with shortest keeper walks yields
${routes[2].shortestWalkRealization.moves} moves / ${routes[2].shortestWalkRealization.pushes} pushes.
This is an offline improvement of the supplied witness, not an independently
discovered solver improvement. The original reference fixture is preserved.

## Per-label accounting

Cells contain pushes / walking before those pushes / contiguous box runs.
Walking is charged to the NEXT pushed box for accounting, not causal blame.
X boxes are pooled because they are interchangeable. A run ending off-goal is
a temporary placement observation, not proof of unnecessary staging.

| Label | Discovery | Rewrite | Reference |
| --- | --- | --- | --- |
${table}

## Largest keeper walks before a push

${routes.map(r => `### ${r.name}\n\n` + [...r.pushTrace].sort((a,b) => b.walkingBefore-a.walkingBefore).slice(0,8).map(e =>
  `- Push ${e.push}, move ${e.move}: ${e.walkingBefore} walks before ${e.label} from ${e.from} to ${e.to}.`).join("\n")).join("\n\n")}

The first differing push is ${firstPushDivergence + 1}. Push-index correspondence
after this point is not assumed. Raw evidence includes every push, physical box
trajectory, run boundary, and goal fill/unfill event. The reference is a witness,
not an optimality proof or a source of runtime instructions.
`;
writeFileSync("docs/benchmarks/grand-hall-route-accounting.md", report);
console.log(JSON.stringify(routes.map(({name,moves,pushes,walking,byLabel}) => ({name,moves,pushes,walking,byLabel})), null, 2));
