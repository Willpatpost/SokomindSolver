// Read-only reproductions of current integration defects. No production writes.
// Run from the repository root:
// node --experimental-strip-types tmp/solver-audit-2026-09-13/integration-repros.ts
import assert from "node:assert/strict";
import { createSession } from "../../src/core/index.ts";
import { createNodeSolverAdapter } from "../../src/solver/node-runner.ts";
import { createSokomindSolverAdapter } from "../../src/solver/implementations/sokomind-solver.ts";
import { toLegacyState } from "../../src/solver/implementations/sokomind-legacy.ts";
import { bidirectionalSide } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import type { SolverRequest } from "../../src/solver/contracts.ts";
import type { SokomindEngineWorker } from "../../src/solver/implementations/sokomind-phase-runner.ts";

function requestFor(rows: readonly string[]): SolverRequest {
  const session = createSession({ id: "integration-audit", title: "Integration audit", difficulty: "tutorial", boxes: 1, rows });
  return { board: session.board, snapshot: session.snapshot, objective: { kind: "moves" } };
}
const small = requestFor(["OOOOO", "O R O", "O A O", "O a O", "OOOOO"]);
const openRoom = requestFor(["OOOOOOO", "O R   O", "O  A  O", "O     O", "O  a  O", "OOOOOOO"]);
const large = requestFor(["OOOOOOOOOOOO", "O R        O", "O A        O", "O a        O", ...Array.from({ length: 7 }, () => "O          O"), "OOOOOOOOOOOO"]);
const context = (signal = new AbortController().signal) => ({ signal, now: () => performance.now(), reportProgress() {} });

function silentWorker(onPost: SokomindEngineWorker["postMessage"]): SokomindEngineWorker {
  return { postMessage: onPost, addEventListener() {}, removeEventListener() {}, terminate() {} };
}

// 1. Both explicitly disabled strategic options are overridden in quality mode.
const controller = new AbortController();
const commands: Parameters<SokomindEngineWorker["postMessage"]>[0][] = [];
const explicitOptions = { mode: "quality", strategicAnalysisMs: 0, strategicPlanExecution: false };
const optionResult = await createSokomindSolverAdapter({
  createWorker: () => silentWorker((command) => { commands.push(command); queueMicrotask(() => controller.abort()); }),
}).solve({ ...large, options: { "sokomind-solver": explicitOptions } }, context(controller.signal));
const actualPreparation = commands[0]?.payload.strategicAnalysis as { maxMs: number; inferenceWork: number };
assert.equal(actualPreparation.maxMs, 500);
assert.equal(actualPreparation.inferenceWork, 2048);
console.log(JSON.stringify({ repro: "explicit-strategic-disable-overridden", requested: explicitOptions, actualPreparation, status: optionResult.status }));

// 2. The raw bidirectional kernel ignores a generated-state ceiling.
const messages: Array<Record<string, unknown>> = [];
const originalPostMessage = globalThis.postMessage;
globalThis.postMessage = ((message: Record<string, unknown>) => messages.push(message)) as typeof globalThis.postMessage;
try {
  bidirectionalSide({ mode: "bidir-forward", state: toLegacyState(openRoom), maxVisited: 20, maxGenerated: 1 });
} finally {
  globalThis.postMessage = originalPostMessage;
}
const terminal = messages.find((message) => message.type === "done")!;
assert.ok(Number(terminal.generated) > 1);
assert.equal(terminal.cutoff, false);
console.log(JSON.stringify({ repro: "bidir-ignores-generated-ceiling", requestedGenerated: 1, visited: terminal.visited, generated: terminal.generated, cutoff: terminal.cutoff, reason: terminal.terminationReason }));

// 3. Reproduce the same overspend through the real public Node adapter/workers.
const generatedResult = await createNodeSolverAdapter({ hardwareConcurrency: 4, deviceMemoryGb: 16 }).solve(
  { ...openRoom, limits: { maxGeneratedStates: 3, maxElapsedMs: 5000 } }, context(),
);
assert.ok((generatedResult.metrics.generatedStates ?? 0) > 3);
console.log(JSON.stringify({ repro: "public-adapter-generated-overspend", requestedGenerated: 3, status: generatedResult.status, generated: generatedResult.metrics.generatedStates, expanded: generatedResult.metrics.expandedStates, detail: generatedResult.status === "unsolved" ? generatedResult.detail : undefined }));

// 4. Newly registered workers are absent from the cached aggregate until telemetry arrives.
let created = 0;
let posted = 0;
const progress: unknown[] = [];
const memoryResult = await createSokomindSolverAdapter({
  createWorker: () => { created += 1; return silentWorker(() => { posted += 1; }); },
}).solve({ ...small, limits: { maxMemoryBytes: 1, maxElapsedMs: 40 } }, {
  ...context(), reportProgress(value) { progress.push({ phase: value.phase, estimatedMemoryBytes: value.counters?.estimatedMemoryBytes }); },
});
assert.equal(posted, 1);
assert.equal(memoryResult.metrics.counters?.peakEstimatedMemoryBytes, 0);
console.log(JSON.stringify({ repro: "worker-registration-stale-memory-cache", requestedMemoryBytes: 1, created, posted, status: memoryResult.status, detail: memoryResult.status === "unsolved" ? memoryResult.detail : undefined, peakEstimatedMemoryBytes: memoryResult.metrics.counters?.peakEstimatedMemoryBytes, progress }));
