import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createSession } from "../src/core/index.ts";
import { PUZZLE_BY_ID } from "../src/catalog/puzzles.ts";
import { solutionFromLegacyPath, toLegacyState } from "../src/solver/implementations/sokomind-legacy.ts";
import { structuralPlan } from "../src/solver/implementations/sokomind-plans.ts";
import { resolveSokomindTuning, sokomindTuningPayload } from "../src/solver/implementations/sokomind-tuning.ts";
import { verifySolverSolution } from "../src/solver/verification.ts";
import { createPlanTraceRuntime } from "./lib/plan-trace-runtime.ts";

const output = process.argv[2];
assert.ok(output && process.argv.length === 3, "Usage: benchmark-planner-branches.ts output.json");
const results = [];
for (const fixture of ["beginner-three", "classic-1", "adv-gallery", "expert-maze", "huge"]) {
  const session = createSession(PUZZLE_BY_ID[fixture]);
  const request = {board: session.board, snapshot: session.snapshot, objective: {kind: "moves" as const}};
  for (const branches of [6, 8, 10, 12, 16]) {
    // A fresh VM prevents cache carryover between configurations. No reference route is loaded.
    const runtime = createPlanTraceRuntime();
    const payload = structuralPlan(toLegacyState(request), request,
      sokomindTuningPayload(resolveSokomindTuning({planBoxBranches: branches})), "fast").payload;
    const started = performance.now();
    const result = runtime.run(payload);
    const elapsedMs = performance.now() - started;
    const solution = result.path ? solutionFromLegacyPath(request, result.path) : null;
    if (result.path) assert.ok(solution && verifySolverSolution(request, solution).valid, "Invalid returned route");
    const row = {fixture, branches, payload, solved: Boolean(solution), moves: solution?.moves ?? null,
      pushes: solution?.pushes ?? null, visited: result.visited, generated: result.generated,
      retained: result.retained, peakFrontier: result.peakFrontier, performance: result.performance,
      terminationReason: result.terminationReason, elapsedMs,
      actionLog: solution?.steps.map(step => step.direction[0].toUpperCase()).join("") ?? null};
    results.push(row);
    console.log(JSON.stringify({...row, payload: undefined, actionLog: undefined, performance: undefined}));
  }
}
const hash = (path: string) => createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex");
writeFileSync(output, JSON.stringify({schemaVersion: 1, capturedAt: new Date().toISOString(),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {windowsHide: true}).toString().trim(),
  engineSha256: hash("../src/solver/implementations/sokomind-engine/engine.generated.js"),
  harnessSha256: hash("./benchmark-planner-branches.ts"), runtimeSha256: hash("./lib/plan-trace-runtime.ts"),
  node: process.version, platform: process.platform,
  methodology: "Single sequential sample per configuration; fresh VM; fixed structural state/generated budgets; all returned routes independently replayed. Elapsed time is descriptive, not a performance acceptance test. Engine memory estimates, when present, are not process RSS.",
  results}, null, 2) + "\n");
