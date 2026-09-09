// Offline public-adapter diagnostic. No reference route enters discovery.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { createSession } from "../src/core/index.ts";
import { PUZZLE_BY_ID } from "../src/catalog/puzzles.ts";
import { createNodeSolverAdapter } from "../src/solver/node-runner.ts";
import { verifySolverSolution } from "../src/solver/verification.ts";

const args = new Map(process.argv.slice(2).map(arg => {
  const match = /^--([^=]+)=(.+)$/.exec(arg);
  assert.ok(match, `Expected --name=value: ${arg}`);
  return [match[1], match[2]];
}));
for (const key of args.keys()) assert.ok(["fixture", "window-cap", "memory-mib", "output"].includes(key), `Unknown argument: ${key}`);
const memoryMiB = args.has("memory-mib") ? Number(args.get("memory-mib")) : 2048;
assert.ok(Number.isSafeInteger(memoryMiB) && memoryMiB > 0, "memory-mib must be a positive integer");
const fixture = args.get("fixture") ?? "huge";
assert.ok(PUZZLE_BY_ID[fixture], `Unknown fixture: ${fixture}`);
const windowCap = args.has("window-cap") ? Number(args.get("window-cap")) : undefined;
assert.ok(windowCap === undefined || (Number.isSafeInteger(windowCap) && windowCap > 0), "window-cap must be a positive integer");
const phases = [];
const workers = new Set();
const session = createSession(PUZZLE_BY_ID[fixture]);
const request = {
  board: session.board, snapshot: session.snapshot, objective: { kind: "moves" },
  options: { "sokomind-solver": { mode: "quality", deterministic: true, maximumIncumbents: 1, harvestElapsedMs: 0 } },
  limits: { maxElapsedMs: 45000, maxExpandedStates: 200000, maxGeneratedStates: 2000000, maxMemoryBytes: memoryMiB * 1024 ** 2 },
};
const adapter = createNodeSolverAdapter({
  hardwareConcurrency: 2,
  createWorker() {
    const worker = new Worker(new URL("../src/solver/implementations/sokomind-engine.node-worker.ts", import.meta.url), {
      execArgv: ["--experimental-strip-types"],
    });
    workers.add(worker);
    const listeners = new Map();
    let phase;
    worker.on("message", data => {
      if (phase && data.type === "progress") phase.lastProgress = data;
      if (phase && data.type === "progress" && data.path) {
        phase.publications.push({moves: data.path.length, visited: data.visited, generated: data.generated});
      }
      if (data.type === "done" && phase) {
        const { status, path, visited, generated, boxRescheduling, terminationReason } = data;
        phase.result = { status, path, visited, generated, boxRescheduling, terminationReason };
        phase.elapsedMs = performance.now() - phase.startedAt;
      }
    });
    return {
      postMessage(command) {
        // Controlled offline ablation: reduce all aggregate local-window shares
        // proportionally, retaining the outer request's accounting and limits.
        const payload = { ...command.payload };
        if (payload.algorithm === "solution-window-rewrite" && windowCap !== undefined) {
          const cap = Math.min(windowCap, payload.maxVisited);
          const scale = cap / payload.maxVisited;
          for (const key of ["permutationVisited", "windowTotalVisited", "moveWindowVisited"]) {
            payload[key] = Math.floor(payload[key] * scale);
          }
          payload.maxVisited = cap;
        }
        phase = { algorithm: payload.algorithm, startedAt: performance.now(), publications: [],
          limits: Object.fromEntries(Object.entries(payload).filter(([key]) => /Visited|Generated|MaxMs|MemoryBytes/.test(key))),
          inputMoves: payload.solutionPath?.length };
        phases.push(phase);
        worker.postMessage({ ...command, payload });
      },
      addEventListener(type, listener) {
        const wrapped = type === "message" ? data => listener({ data }) : error => listener({ message: error.message });
        listeners.set(listener, wrapped);
        worker.on(type, wrapped);
      },
      removeEventListener(type, listener) {
        const wrapped = listeners.get(listener);
        if (wrapped) worker.off(type, wrapped);
        listeners.delete(listener);
      },
      terminate() { workers.delete(worker); void worker.terminate(); },
    };
  },
});
const controller = new AbortController();
const watchdog = setTimeout(() => {
  controller.abort();
  for (const worker of workers) void worker.terminate();
  console.error("Quality diagnostic exceeded its 60-second external deadline");
  process.exitCode = 1;
}, 60000);
try {
  const result = await adapter.solve(request, {
    signal: controller.signal, now: () => performance.now(), reportProgress() {},
  });
  assert.equal(result.status, "solved");
  assert.ok(verifySolverSolution(request, result.solution).valid);
  assert.ok(result.metrics.expandedStates <= request.limits.maxExpandedStates);
  assert.ok(result.metrics.generatedStates <= request.limits.maxGeneratedStates);
  assert.ok(result.metrics.counters?.peakEstimatedMemoryBytes <= request.limits.maxMemoryBytes);
  assert.ok(result.metrics.elapsedMs <= request.limits.maxElapsedMs);
  const evidence = { capturedAt: new Date().toISOString(), node: process.version,
    engineSha256: createHash("sha256").update(readFileSync(new URL("../src/solver/implementations/sokomind-engine/engine.generated.js", import.meta.url))).digest("hex"),
    adapterSha256: createHash("sha256").update(readFileSync(new URL("../src/solver/implementations/sokomind-solver.ts", import.meta.url))).digest("hex"),
    fixture, windowCap: windowCap ?? null, requestLimits: request.limits, options: request.options,
    replayVerified: true, phases, result };
  if (args.has("output")) writeFileSync(args.get("output"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ fixture, windowCap, moves: result.solution.moves, pushes: result.solution.pushes,
    metrics: result.metrics, phases: phases.map(({ algorithm, inputMoves, result: phaseResult, elapsedMs }) => ({
      algorithm, inputMoves, outputMoves: phaseResult?.path?.length, elapsedMs,
      visited: phaseResult?.visited, generated: phaseResult?.generated, repair: phaseResult?.boxRescheduling,
    })) }));
} finally {
  clearTimeout(watchdog);
  for (const worker of workers) await worker.terminate();
}
