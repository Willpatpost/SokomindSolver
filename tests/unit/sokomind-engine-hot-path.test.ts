import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, it } from "node:test";
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession, decodeActionCode, move } from "../../src/core/index.ts";
import reference from "../fixtures/solver-v2/grand-hall-reference.json" with { type: "json" };

const SOURCE_FILES = [
  "state.js",
  "memo.js",
  "metrics.js",
  "topology.js",
  "board.js",
  "heuristic.js",
  "deadlock.js",
  "analysis.js",
  "push-generation.js",
  "solver-search.js",
] as const;

interface DistanceTable {
  readonly size: number;
  get(key: string): number | undefined;
  has(key: string): boolean;
}

interface PreparedSeed {
  readonly estimatedBytes: number;
}

interface TestEngine {
  doorwayCrossingReachable(board: EngineBoard, geometry: RoomGeometry, occupied: Int32Array): Set<string>;
  parse(data: { rows: string[]; preparedBoard?: unknown }): EngineBoard;
  createPerformanceMetrics(): Record<string, unknown>;
  createPreparedBoardSeed(board: EngineBoard): PreparedSeed;
  hydratePreparedBoard(
    data: { rows: string[] },
    seed: unknown,
    metrics: Record<string, unknown>,
  ): EngineBoard;
  playerAwarePushDistances(board: EngineBoard, start: string): DistanceTable;
  playerAwarePushDistancesReference(floor: Set<string>, start: string): Map<string, number>;
  staticDead(y: number, x: number, board: EngineBoard, label: string): boolean;
  reachablePaths(state: EngineState, board: EngineBoard): Reachability;
  pushNeighbors(
    state: EngineState,
    board: EngineBoard,
    reachable: Reachability,
    options?: { deferPath?: boolean },
  ): Array<Record<string, unknown>>;
  materializePushNeighborPath(
    neighbor: Record<string, unknown>,
    reachable: Reachability,
  ): Record<string, unknown>;
  goalAccessAnalysis(
    boxes: EngineState["boxes"],
    board: EngineBoard,
  ): { packingRisk: unknown; safeGoals: unknown };
  ensureGoalAccessPackingRisk(
    result: { packingRisk: unknown; safeGoals: unknown },
    boxes: EngineState["boxes"],
    board: EngineBoard,
  ): { get(key: string): number | undefined };
  evaluateGoalAccess(
    goalAccess: GoalAccessEntry[],
    occupied: Map<string, string>,
  ): GoalAccessResult;
  evaluateGoalAccessSummary(
    goalAccess: GoalAccessEntry[],
    occupied: Map<string, string>,
  ): GoalAccessResult;
  boardCacheMemorySnapshot(board: EngineBoard): {
    boardBytes: number;
    cacheBytes: number;
    cacheBreakdownBytes: Record<string, number>;
  };
  configureBoardCaches(board: EngineBoard, maxMemoryBytes: number): {
    cacheBudgetBytes: number;
    capacities: Record<string, number>;
  } | null;
  search(payload: Record<string, unknown>): {
    status: string;
    path?: string[];
    visited?: number;
    generated?: number;
    performance?: Record<string, unknown>;
  };
}

interface RoomGeometry {
  readonly gateId: number;
  readonly cellIds: Int32Array;
  readonly inside: Uint8Array;
}

interface EngineBoard {
  readonly dense: { readonly keys: string[]; readonly idByKey: Map<string, number> };
  readonly topology: {
    readonly rooms: Array<{ gate: string; cells: Set<string> }>;
    readonly transportGeometry: RoomGeometry[];
  };
  readonly floor: Set<string>;
  readonly goalsByLabel: Map<string, string[]>;
  readonly playerPushDistances: Map<string, DistanceTable>;
  readonly goalPushTables: {
    readonly byGoal: Map<string, DistanceTable>;
  };
  readonly patternEligibility: Uint8Array;
  readonly heuristicMemo: {
    readonly capacity: number;
    readonly size: number;
    set(key: unknown, value: unknown): void;
  };
  readonly deadlockMemo: { readonly capacity: number };
  readonly patternDeadlockMemo: { readonly capacity: number };
  readonly pushTransitionMemo: { readonly capacity: number };
  reachabilityMemoLimit: number;
}

interface EngineState {
  readonly robot: [number, number];
  readonly boxes: Array<[number, number, string]>;
}

interface Reachability {
  readonly board: EngineBoard;
}

interface GoalAccessEntry {
  readonly goal: string;
  readonly label: string;
  readonly lanes: Array<{ source: string; support: string }>;
}

interface GoalAccessResult {
  readonly penalty: number;
  readonly blockedGoals: Array<{ goal: string }>;
}

async function loadSourceEngine(): Promise<TestEngine> {
  const sourceDirectory = new URL(
    "../../src/solver/implementations/sokomind-engine/source/",
    import.meta.url,
  );
  const sources = [];
  for (const filename of SOURCE_FILES) {
    sources.push(await readFile(new URL(filename, sourceDirectory), "utf8"));
  }
  const context = vm.createContext({
    console,
    performance: globalThis.performance,
    structuredClone,
    postMessage: () => {},
  });
  vm.runInContext(`${sources.join("\n")}
    globalThis.__engineTest = {
      parse, createPerformanceMetrics, createPreparedBoardSeed, hydratePreparedBoard,
      playerAwarePushDistances, playerAwarePushDistancesReference, staticDead,
      reachablePaths, pushNeighbors, materializePushNeighborPath,
      goalAccessAnalysis, ensureGoalAccessPackingRisk,
      evaluateGoalAccess, evaluateGoalAccessSummary,
      boardCacheMemorySnapshot, configureBoardCaches,
      search,
      doorwayCrossingReachable,
    };`, context);
  return (context as unknown as { __engineTest: TestEngine }).__engineTest;
}

const ROWS = [
  "OOOOOOO",
  "O  R  O",
  "O X S O",
  "O     O",
  "OOOOOOO",
];

describe("Sokomind engine dense hot paths", () => {
  it("preserves doorway reachability through occupied gates and prepared-board cloning", async () => {
    const engine = await loadSourceEngine();
    const puzzle = PUZZLE_BY_ID.huge;
    const board = engine.parse({ rows: [...puzzle.rows] });
    const clone = engine.hydratePreparedBoard(
      { rows: [...puzzle.rows] }, structuredClone(engine.createPreparedBoardSeed(board)),
      engine.createPerformanceMetrics(),
    );
    const olderSeed = structuredClone(engine.createPreparedBoardSeed(board)) as
      PreparedSeed & { topology: { transportGeometry?: unknown } };
    delete olderSeed.topology.transportGeometry;
    const olderClone = engine.hydratePreparedBoard(
      { rows: [...puzzle.rows] }, olderSeed, engine.createPerformanceMetrics(),
    );
    const sessions = [createSession(puzzle)];
    for (const code of reference.actionLog) {
      sessions.push(move(sessions[sessions.length - 1], decodeActionCode(code)));
    }
    const occupancies = sessions.map(session => new Set(session.snapshot.boxes.map(
      box => `${box.position.row},${box.position.column}`,
    )));
    // Also exercise an empty board and a fully blocked room (no flood seed).
    occupancies.push(new Set(), new Set(board.floor));
    for (const occupied of occupancies) {
      for (let roomIndex = 0; roomIndex < board.topology.rooms.length; roomIndex++) {
        const room = board.topology.rooms[roomIndex];
        const start = !occupied.has(room.gate) ? room.gate :
          [...room.cells].find(cell => !occupied.has(cell));
        const reached = new Set(start === undefined ? [] : [start]);
        const queue = [...reached];
        for (let head = 0; head < queue.length; head++) {
          const [row, column] = queue[head].split(",").map(Number);
          for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const next = `${row + dy},${column + dx}`;
            if (!board.floor.has(next) || occupied.has(next) || reached.has(next)) continue;
            reached.add(next);
            queue.push(next);
          }
        }
        for (const candidate of [board, clone, olderClone]) {
          const geometry = candidate.topology.transportGeometry[roomIndex];
          const indices = new Int32Array(candidate.dense.keys.length).fill(-1);
          for (const cell of occupied) indices[candidate.dense.idByKey.get(cell)!] = 0;
          const actual = engine.doorwayCrossingReachable(candidate, geometry, indices);
          assert.deepEqual([...actual].sort(), [...reached].sort());
          assert.deepEqual(
            [...candidate.dense.keys].filter((_, cell) => geometry.inside[cell]).sort(),
            [...room.cells].sort(),
          );
        }
      }
    }
  });

  it("keeps dense source distances equivalent through prepared-board cloning", async () => {
    const engine = await loadSourceEngine();
    const board = engine.parse({ rows: ROWS });
    const start = "2,2";
    const coldSeed = engine.createPreparedBoardSeed(board);
    const dense = engine.playerAwarePushDistances(board, start);
    const reference = engine.playerAwarePushDistancesReference(board.floor, start);

    assert.equal(dense.size, reference.size);
    for (const position of board.floor) {
      assert.equal(dense.get(position), reference.get(position), position);
    }
    assert.ok([...board.goalPushTables.byGoal.values()]
      .every((table) => !(table instanceof Map)));

    const warmSeed = engine.createPreparedBoardSeed(board);
    assert.ok(warmSeed.estimatedBytes > coldSeed.estimatedBytes);
    const clonedSeed = structuredClone(warmSeed);
    const hydratedMetrics = engine.createPerformanceMetrics();
    const hydrated = engine.hydratePreparedBoard(
      { rows: ROWS },
      clonedSeed,
      hydratedMetrics,
    );
    assert.equal(hydratedMetrics.preparedSeedBytes, warmSeed.estimatedBytes);
    const restored = hydrated.playerPushDistances.get(start);
    assert.ok(restored);
    assert.equal(restored.size, reference.size);
    for (const position of board.floor) {
      assert.equal(restored.get(position), reference.get(position), position);
    }
    assert.ok(ArrayBuffer.isView(hydrated.patternEligibility));
    assert.equal(hydrated.patternEligibility.BYTES_PER_ELEMENT, 1);
  });

  it("uses reverse goal tables without changing static-dead results", async () => {
    const engine = await loadSourceEngine();
    const board = engine.parse({ rows: ROWS });
    const goals = board.goalsByLabel.get("X") ?? [];
    for (const position of board.floor) {
      const [y, x] = position.split(",").map(Number);
      const distances = engine.playerAwarePushDistances(board, position);
      const reference = !goals.includes(position) &&
        !goals.some((goal) => distances.has(goal));
      assert.equal(engine.staticDead(y, x, board, "X"), reference, position);
    }
  });

  it("reports structure-specific cache memory", async () => {
    const engine = await loadSourceEngine();
    const board = engine.parse({ rows: ROWS });
    engine.playerAwarePushDistances(board, "2,2");
    const memory = engine.boardCacheMemorySnapshot(board);
    assert.ok(memory.boardBytes > 0);
    assert.ok(memory.cacheBytes > 0);
    assert.ok(memory.cacheBreakdownBytes.playerPushDistances > 0);
    assert.ok(memory.cacheBreakdownBytes.heuristicMemo > 0);
  });

  it("counts reachability payloads without multiplying the shared board", async () => {
    const engine = await loadSourceEngine();
    const board = engine.parse({ rows: ROWS });
    board.reachabilityMemoLimit = 512;
    const state: EngineState = {
      robot: [1, 3],
      boxes: [[2, 2, "X"]],
    };
    const reachable = engine.reachablePaths(state, board);
    const descriptor = Object.getOwnPropertyDescriptor(reachable, "board");
    assert.equal(descriptor?.enumerable, false);
    assert.equal(reachable.board, board);

    const memory = engine.boardCacheMemorySnapshot(board);
    const reachabilityBytes = memory.cacheBreakdownBytes.reachabilityMemo;
    assert.ok(reachabilityBytes > 0);
    assert.ok(reachabilityBytes < 1024 * 1024);
  });

  it("defers unused walk paths and computes packing risk only on demand", async () => {
    const engine = await loadSourceEngine();
    const board = engine.parse({ rows: ROWS });
    const state: EngineState = {
      robot: [1, 3],
      boxes: [[2, 2, "X"]],
    };
    const reachable = engine.reachablePaths(state, board);
    const neighbor = engine.pushNeighbors(
      state,
      board,
      reachable,
      { deferPath: true },
    )[0];
    assert.ok(neighbor);
    assert.equal(neighbor.path, undefined);
    const materialized = engine.materializePushNeighborPath(neighbor, reachable);
    assert.ok(Array.isArray(materialized.path));

    const access = engine.goalAccessAnalysis(state.boxes, board);
    assert.equal(access.packingRisk, null);
    assert.equal(access.safeGoals, null);
    const risk = engine.ensureGoalAccessPackingRisk(access, state.boxes, board);
    assert.equal(typeof risk.get, "function");
    assert.equal(access.packingRisk, risk);
  });

  it("keeps compact structural goal-access scoring exact", async () => {
    const engine = await loadSourceEngine();
    const access: GoalAccessEntry[] = [
      {
        goal: "1,1",
        label: "A",
        lanes: [
          { source: "1,2", support: "1,3" },
          { source: "2,1", support: "3,1" },
        ],
      },
      {
        goal: "4,4",
        label: "X",
        lanes: [],
      },
    ];
    const layouts = [
      new Map<string, string>(),
      new Map([["1,2", "A"]]),
      new Map([["1,3", "X"], ["2,1", "B"]]),
      new Map([["1,1", "A"], ["4,4", "X"]]),
    ];

    for (const occupied of layouts) {
      const full = engine.evaluateGoalAccess(access, occupied);
      const compact = engine.evaluateGoalAccessSummary(access, occupied);
      assert.equal(compact.penalty, full.penalty);
      assert.deepEqual(
        Array.from(compact.blockedGoals, ({ goal }) => goal),
        Array.from(full.blockedGoals, ({ goal }) => goal),
      );
    }
  });

  it("right-sizes empty board caches to a declared memory budget", async () => {
    const engine = await loadSourceEngine();
    const board = engine.parse({ rows: ROWS });
    const configured = engine.configureBoardCaches(board, 1024);
    assert.ok(configured);
    assert.equal(configured.cacheBudgetBytes, 0);
    assert.deepEqual(
      Object.values(configured.capacities),
      [1, 1, 1, 1],
    );
    assert.equal(board.heuristicMemo.capacity, 1);
    assert.equal(board.deadlockMemo.capacity, 1);
    assert.equal(board.patternDeadlockMemo.capacity, 1);
    assert.equal(board.pushTransitionMemo.capacity, 1);
  });

  it("keeps same-capacity warm caches but replaces them when the limit shrinks", async () => {
    const engine = await loadSourceEngine();
    const board = engine.parse({ rows: ROWS });
    engine.configureBoardCaches(board, 64 * 1024 * 1024);
    const warm = board.heuristicMemo;
    assert.ok(warm.capacity > 1);
    warm.set("first", 1);
    warm.set("second", 2);

    engine.configureBoardCaches(board, 64 * 1024 * 1024);
    assert.equal(board.heuristicMemo, warm);

    engine.configureBoardCaches(board, 1024);
    assert.notEqual(board.heuristicMemo, warm);
    assert.equal(board.heuristicMemo.capacity, 1);
    assert.equal(board.heuristicMemo.size, 0);
    board.heuristicMemo.set("first", 1);
    board.heuristicMemo.set("second", 2);
    assert.equal(board.heuristicMemo.size, 1);
  });

  it("accounts for bounded plan-local caches without changing search", async () => {
    const engine = await loadSourceEngine();
    const payload = {
      algorithm: "plan-macro-beam",
      state: {
        rows: ROWS,
        robot: [1, 3],
        boxes: [["2,2", "X"]],
      },
      maxVisited: 1_000,
      maxDepth: 40,
      planBeamWidth: 16,
      planSolutionComparisonBudget: 0,
    };
    const first = engine.search(payload);
    const second = engine.search(payload);
    assert.equal(first.status, "solved");
    assert.deepEqual(second.path, first.path);
    assert.equal(second.visited, first.visited);
    assert.equal(second.generated, first.generated);

    for (const result of [first, second]) {
      const memory = result.performance?.engineMemory as {
        cacheEntries: number;
        cacheBytes: number;
        cacheBreakdownBytes: Record<string, number>;
      } | undefined;
      assert.ok(memory);
      const doorwayBytes = memory.cacheBreakdownBytes.planDoorwayScheduleMemo;
      const analysisBytes = memory.cacheBreakdownBytes.planAnalysisCache;
      assert.ok(doorwayBytes > 0);
      assert.ok(analysisBytes > 0);
      assert.ok(memory.cacheEntries >= 2);
      assert.ok(memory.cacheBytes >= doorwayBytes + analysisBytes);
    }
  });

  it("solves through the dense deadlock path under a bounded cache budget", async () => {
    const engine = await loadSourceEngine();
    const result = engine.search({
      algorithm: "ultimate",
      state: {
        rows: ROWS,
        robot: [1, 3],
        boxes: [["2,2", "X"]],
      },
      maxVisited: 10_000,
      maxDepth: 40,
      maxMemoryBytes: 8 * 1024 * 1024,
    });
    assert.equal(result.status, "solved");
    assert.ok(result.path?.length);
    assert.ok((result.performance?.cacheCapacityEntries as number) > 0);
    assert.ok((result.performance?.dynamicDeadlockCalls as number) >= 0);
  });
});
