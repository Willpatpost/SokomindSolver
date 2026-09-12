import assert from "node:assert/strict";
import test from "node:test";
import { parsePuzzleRows } from "../../src/core/puzzle.ts";
import { runClassicSearch } from "../../src/solver/search/engine.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { KeeperReachability } from "../../src/solver/search/reachability.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";
import { SolverWorkerClient, type SolverClientMessageListener, type SolverWorkerClientTransport } from "../../src/solver/worker-client.ts";
import { SOLVER_WORKER_PROTOCOL_VERSION } from "../../src/solver/protocol.ts";
import { hydrateOptimalCacheFromIDB, loadOptimalCache, mergeOptimalCaches, normalizeOptimalCache, setOptimalRecord, isOptimal, type OptimalCache } from "../../src/shared/optimal-cache.ts";
import { STORAGE_KEYS } from "../../src/shared/storage.ts";
import { createMemoryIndexedDB, installIndexedDB } from "../support/memory-indexeddb.ts";

function requestFor(rows: string[]) {
  const board = parsePuzzleRows(rows);
  return { board, snapshot: { puzzleId: "audit-regression", robot: board.initialRobot,
    boxes: board.initialBoxes, moves: 0, pushes: 0, solved: false }, objective: { kind: "moves" as const } };
}

test("DFS and Greedy retain the solvable disconnected-region branch", async () => {
  const request = requestFor(["OOOOOOO", "O O   O", "O     O", "O  RXOO", "OSSX  O", "O O   O", "OOOOOOO"]);
  for (const strategy of ["dfs", "greedy"] as const) {
    const result = await runClassicSearch(request, { signal: new AbortController().signal,
      now: () => performance.now(), reportProgress() {} }, { strategy });
    assert.equal(result.status, "solved");
    if (result.status !== "solved") continue;
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
    assert.equal(result.solution.optimality, "unknown");
  }
});

test("canonical shortcuts agree with BFS through walls and multiple boxes", () => {
  const board = compileSearchBoard(requestFor(["OOOOOOO", "O O   O", "O     O", "O  RXOO", "OSSX  O", "O O   O", "OOOOOOO"]).board);
  const parent = new KeeperReachability(board), child = new KeeperReachability(board);
  let checked = 0;
  for (let a = 0; a < board.cellCount; a++) for (let b = a + 1; b < board.cellCount; b++) {
    const occupied = new Uint8Array(board.cellCount); occupied[a] = occupied[b] = 1;
    for (let robot = 0; robot < board.cellCount; robot++) {
      if (occupied[robot]) continue;
      const reachable = parent.flood(robot, occupied);
      for (const box of [a, b]) for (let d = 0; d < 4; d++) {
        const destination = board.neighbors[box][d], support = board.neighbors[box][d ^ 1];
        if (destination < 0 || occupied[destination] || !reachable.isReachable(support)) continue;
        occupied[box] = 0; occupied[destination] = 1;
        const incremental = parent.incrementalCanonicalCell(box, destination, occupied);
        if (incremental !== null) assert.equal(incremental, child.flood(box, occupied).canonicalCell);
        occupied[box] = 1; occupied[destination] = 0; checked++;
      }
    }
  }
  assert.ok(checked > 100);
});

test("obsolete proofs cannot load, hydrate, or merge into current records", async () => {
  const fingerprint = "puzzle-v1:9ead120a";
  const stale = { version: 6, records: { [JSON.stringify(["huge", fingerprint])]: { moves: 713, pushes: 248 } } };
  const empty = normalizeOptimalCache(null);
  const current = setOptimalRecord(empty, "other", fingerprint, { moves: 2, pushes: 1 });
  const memory = createMemoryIndexedDB();
  memory.values.set(STORAGE_KEYS.optimal, stale);
  const restore = installIndexedDB(memory.factory);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>([[STORAGE_KEYS.optimal, JSON.stringify(stale)], [STORAGE_KEYS.progress, "preserve-progress"]]);
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: (key: string) => values.get(key) ?? null },
  } });
  try {
    assert.deepEqual(loadOptimalCache(), empty);
    assert.deepEqual(await hydrateOptimalCacheFromIDB(current), current);
    assert.deepEqual(mergeOptimalCaches(current, stale as unknown as OptimalCache), current);
    assert.equal(isOptimal(stale as unknown as OptimalCache, "huge", fingerprint, 713), false);
    assert.deepEqual(normalizeOptimalCache({ ...current, proofRevision: "obsolete" }), empty);
    assert.equal(values.get(STORAGE_KEYS.progress), "preserve-progress");
  } finally {
    restore();
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("worker client rejects unsupported proofs but accepts consistent results", async () => {
  const request = requestFor(["OOOOOO", "OR XSO", "O    O", "OOOOOO"]);
  for (const kind of ["absent", "bounded", "unknown", "optimal"] as const) {
    const listeners = new Set<SolverClientMessageListener>();
    const optimal = kind === "optimal";
    const moves = optimal ? 2 : 4;
    const solution = { steps: [
      ...(!optimal ? [{ direction: "down", kind: "walk" }, { direction: "up", kind: "walk" }] : []),
      { direction: "right", kind: "walk" }, { direction: "right", kind: "push" }],
      moves, pushes: 1, objective: request.objective, objectiveScore: moves,
      optimality: kind === "unknown" ? "unknown" : "proven" };
    const result = { status: "solved", solution, metrics: { elapsedMs: 1 },
      ...((kind === "bounded" || optimal) ? { proof: { kind: optimal ? "optimal" : "bounded",
        algorithm: "move-astar", objective: request.objective, lowerBound: 2, upperBound: moves, gap: moves - 2 } } : {}) };
    const transport: SolverWorkerClientTransport = {
      addEventListener(_type, listener) { listeners.add(listener); },
      removeEventListener(_type, listener) { listeners.delete(listener); },
      postMessage(message) {
        if (message.type === "solver/run") queueMicrotask(() => {
          for (const listener of listeners) listener({ data: { protocolVersion: SOLVER_WORKER_PROTOCOL_VERSION,
            type: "solver/result", jobId: message.jobId, result } });
        });
      },
    };
    const client = new SolverWorkerClient(transport);
    try {
      const pending = client.run("classic-astar", request).result;
      if (kind === "absent" || kind === "bounded") await assert.rejects(pending, /invalid.*protocol/i);
      else assert.equal((await pending).status, "solved");
    } finally { client.dispose(); }
  }
});
