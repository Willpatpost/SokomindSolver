import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createSession } from "../src/core/index.ts";
import { PUZZLE_BY_ID } from "../src/catalog/puzzles.ts";
import { solutionFromLegacyPath, toLegacyState } from "../src/solver/implementations/sokomind-legacy.ts";
import { structuralPlan } from "../src/solver/implementations/sokomind-plans.ts";
import { resolveSokomindTuning, sokomindTuningPayload } from "../src/solver/implementations/sokomind-tuning.ts";
import { search } from "../src/solver/implementations/sokomind-engine/engine.generated.js";
import { verifySolverSolution } from "../src/solver/verification.ts";
import { createPlanTraceRuntime } from "./lib/plan-trace-runtime.ts";
import { createRouteRecoverabilityTracker } from "./lib/route-recoverability.ts";

const args = new Map(process.argv.slice(2).map(arg => {
  const match = /^--([^=]+)=(.+)$/u.exec(arg);
  assert.ok(match, `Expected --name=value: ${arg}`);
  return [match[1], match[2]];
}));
for (const key of args.keys()) assert.ok(["fixture", "route-file", "route-name", "reschedule", "branches", "output"].includes(key), `Unknown argument: ${key}`);
assert.ok(!args.has("reschedule") || ["true", "false"].includes(args.get("reschedule")!), "reschedule must be true or false");
const fixture = args.get("fixture") ?? "huge";
const puzzle = PUZZLE_BY_ID[fixture];
assert.ok(puzzle, `Unknown fixture: ${fixture}`);
const session = createSession(puzzle);
const request = { board: session.board, snapshot: session.snapshot, objective: {kind: "moves" as const} };
const branches = args.has("branches") ? Number(args.get("branches")) : resolveSokomindTuning().planBoxBranches;
assert.ok(Number.isInteger(branches) && branches >= 2 && branches <= 16, "branches must be an integer from 2 to 16");
const payload = structuralPlan(toLegacyState(request), request,
  sokomindTuningPayload(resolveSokomindTuning({planBoxBranches: branches})), "fast").payload;
const runtime = createPlanTraceRuntime();
const baseline = runtime.run(payload);
assert.ok(baseline.path || args.has("route-file"), "An unsolved control requires an explicit reference route");
const controlSolution = baseline.path ? solutionFromLegacyPath(request, baseline.path) : null;
if (baseline.path) assert.ok(controlSolution && verifySolverSolution(request, controlSolution).valid);
let referencePath = [...(baseline.path ?? [])];
let referenceSource = "unobserved planner result (positive control)";
if (args.has("route-file")) {
  const filename = args.get("route-file")!;
  const text = readFileSync(filename, "utf8").trim();
  let actionLog = text;
  if (filename.endsWith(".json")) {
    const evidence = JSON.parse(text) as {routes?: Array<{name: string; actionLog: string}>};
    const route = evidence.routes?.find(route => route.name === args.get("route-name"));
    assert.ok(route && typeof route.actionLog === "string", "JSON route-file requires a matching --route-name");
    actionLog = route.actionLog;
  }
  assert.match(actionLog, /^[UDLR]+$/u, "Reference must be a U/D/L/R action log");
  const names: Record<string, string> = {U: "Up", D: "Down", L: "Left", R: "Right"};
  referencePath = [...actionLog].map(code => names[code]);
  referenceSource = `${filename}${args.has("route-name") ? `:${args.get("route-name")}` : ""}`;
}
assert.ok(solutionFromLegacyPath(request, referencePath), "Reference does not replay to a solution");
const repairLimits = {maxVisited: 300000, maxGenerated: 2000000, rescheduleMaxMs: 25000};
if (args.get("reschedule") === "true") {
  const repaired = search({algorithm: "solution-box-reschedule", state: toLegacyState(request),
    solutionPath: referencePath, ...repairLimits});
  assert.ok(repaired.path);
  referencePath = [...repaired.path];
  referenceSource += " -> isolated rescheduling";
}
const referenceSolution = solutionFromLegacyPath(request, referencePath);
assert.ok(referenceSolution && verifySolverSolution(request, referenceSolution).valid);
const canonical = runtime.reference(toLegacyState(request), referencePath);
const tracker = createRouteRecoverabilityTracker({...puzzle, rows: canonical.state.rows}, canonical.path);
const observed = runtime.run(payload, tracker.observe);
const deterministic = (value: typeof baseline) => ({path: value.path, visited: value.visited,
  generated: value.generated, retained: value.retained, peakFrontier: value.peakFrontier});
assert.deepEqual(deterministic(observed), deterministic(baseline), "Observation changed the route or deterministic work");
const observedSolution = observed.path ? solutionFromLegacyPath(request, observed.path) : null;
if (observed.path) assert.ok(observedSolution && verifySolverSolution(request, observedSolution).valid);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const git = (...command: string[]) => execFileSync("git", command, {windowsHide: true});
const report = {schemaVersion: 1, capturedAt: new Date().toISOString(), fixture,
  sourceCommit: git("rev-parse", "HEAD").toString().trim(),
  trackedDiffSha256: sha256(git("diff", "HEAD", "--", "src/solver", "scripts", "tests/unit")),
  engineSha256: sha256(readFileSync(new URL("../src/solver/implementations/sokomind-engine/engine.generated.js", import.meta.url))),
  harnessSha256: sha256(readFileSync(new URL(import.meta.url))),
  runtimeSha256: sha256(readFileSync(new URL("./lib/plan-trace-runtime.ts", import.meta.url))),
  trackerSha256: sha256(readFileSync(new URL("./lib/route-recoverability.ts", import.meta.url))),
  node: process.version, platform: process.platform, orientation: canonical.orientation,
  methodology: "Offline synchronous structural lane; reference absent from both search payloads; no observation-based steering",
  reference: {source: referenceSource, moves: referenceSolution.moves, pushes: referenceSolution.pushes,
    actionLog: referenceSolution.steps.map(step => step.direction[0].toUpperCase()).join(""),
    ...(args.get("reschedule") === "true" ? {repairLimits} : {})},
  payload, control: deterministic(baseline), observed: deterministic(observed),
  replayVerified: true, observerEquivalent: true, trace: tracker.report(observed.terminationReason),
};
if (args.has("output")) writeFileSync(args.get("output")!, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({fixture, orientation: report.orientation, referenceMoves: referenceSolution.moves,
  referencePushes: referenceSolution.pushes, controlMoves: controlSolution?.moves ?? null,
  observerEquivalent: report.observerEquivalent, frontierLoss: report.trace.frontierLoss,
  furthestRetainedPush: report.trace.furthestRetainedPush, events: report.trace.eventCount, truncated: report.trace.truncated}));
