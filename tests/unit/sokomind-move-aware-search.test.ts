import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

interface SearchCandidate {
  exactIdentity: string;
  cost: number;
  moves: number;
  score: number;
  selectionIdentity?: string;
}

interface MoveAwareApi {
  search(payload: Record<string, unknown>): {
    path: string[] | null;
    status?: string;
    bestMoves?: number;
    bestPushes?: number;
    generated?: number;
  };
  BoundedParetoMap: new (
    limit: number,
    perKeyLimit?: number,
  ) => {
    isDominated(key: string, pushes: number, moves: number): boolean;
    hasPair(key: string, pushes: number, moves: number): boolean;
    set(key: string, pushes: number, moves: number): boolean;
    readonly size: number;
  };
  addParetoCandidate(
    candidates: Map<string, SearchCandidate[]>,
    candidate: SearchCandidate,
    perKeyLimit?: number,
  ): boolean;
  betterMoveSolution(
    candidate: { cost: number; moves: number },
    incumbent: { cost: number; moves: number } | null,
  ): boolean;
  selectDynamicTaskTarget(
    task: { target: string; allowedTargets?: string[] },
    state: { boxes: Array<[number, number, string]> },
    boxIndex: number,
    board: unknown,
  ): string;
  macroParetoAccept(
    seen: Map<string, Array<{ pushes: number; moves: number }>>,
    signature: string,
    pushes: number,
    moves: number,
    limit?: number,
  ): boolean;
  macroParetoActive(
    seen: Map<string, Array<{ pushes: number; moves: number }>>,
    signature: string,
    pushes: number,
    moves: number,
  ): boolean;
  selectMacroEndpoints<T>(
    endpoints: T[],
    maximum: number,
    viable?: (endpoint: T) => boolean,
    reserveAlternateApproach?: boolean,
  ): T[];
  compareTargetedMacroEndpoints(
    left: {
      targetDistance: number;
      pushes: number;
      macroPath: { length: number };
      macroOrder: number;
    },
    right: {
      targetDistance: number;
      pushes: number;
      macroPath: { length: number };
      macroOrder: number;
    },
  ): number;
  parse(state: { rows: string[] }): unknown;
  reachablePaths(state: unknown, board: unknown): unknown;
  pushNeighbors(state: unknown, board: unknown, reachable: unknown): Array<{
    pushedTo: string;
  }>;
  expandTargetedPushSequence(
    first: unknown,
    board: unknown,
    objective: { target: string },
    maxPushes: number,
    maxExplored: number,
    maxReturned: number,
  ): Array<{ targetDeadEnd?: boolean; path: string[] }>;
}

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
];

function loadMoveAwareApi(): MoveAwareApi {
  const directory = fileURLToPath(new URL(
    "../../src/solver/implementations/sokomind-engine/source/",
    import.meta.url,
  ));
  const source = SOURCE_FILES.map(filename =>
    readFileSync(`${directory}/${filename}`, "utf8")).join("\n") + `
      globalThis.__moveAwareApi = {
        BoundedParetoMap,
        addParetoCandidate,
        betterMoveSolution,
        selectDynamicTaskTarget,
        macroParetoAccept,
        macroParetoActive,
        selectMacroEndpoints,
        compareTargetedMacroEndpoints,
        parse,
        reachablePaths,
        pushNeighbors,
        expandTargetedPushSequence,
        search,
      };
    `;
  const sandbox: Record<string, unknown> = {
    console,
    performance,
    postMessage: () => {},
    structuredClone,
  };
  runInContext(source, createContext(sandbox));
  return sandbox.__moveAwareApi as MoveAwareApi;
}

describe("Sokomind move-aware structural search", () => {
  it("retains bounded push/move tradeoffs and safely rejects dominated arrivals", () => {
    const { BoundedParetoMap } = loadMoveAwareApi();
    const seen = new BoundedParetoMap(8, 3);

    assert.equal(seen.set("state", 2, 12), true);
    assert.equal(seen.set("state", 3, 7), true);
    assert.equal(seen.isDominated("state", 3, 12), true);
    assert.equal(seen.set("state", 3, 12), false);
    assert.equal(seen.set("state", 2, 9), true);
    assert.equal(seen.hasPair("state", 2, 12), false);
    assert.equal(seen.hasPair("state", 2, 9), true);
    assert.equal(seen.hasPair("state", 3, 7), true);
  });

  it("preserves candidate object identity while bounding a same-state Pareto set", () => {
    const { addParetoCandidate } = loadMoveAwareApi();
    const candidates = new Map<string, SearchCandidate[]>();
    const fewerPushes = { exactIdentity: "same", cost: 2, moves: 12, score: 2 };
    const fewerMoves = { exactIdentity: "same", cost: 3, moves: 7, score: 3 };
    const dominated = { exactIdentity: "same", cost: 3, moves: 14, score: 4 };

    assert.equal(addParetoCandidate(candidates, fewerPushes, 3), true);
    assert.equal(addParetoCandidate(candidates, fewerMoves, 3), true);
    assert.equal(addParetoCandidate(candidates, dominated, 3), false);
    assert.equal(candidates.get("same")?.includes(fewerPushes), true);
    assert.equal(candidates.get("same")?.includes(fewerMoves), true);
    assert.equal(candidates.get("same")?.includes(dominated), false);
  });

  it("compares first-found beam solutions by moves before pushes", () => {
    const { betterMoveSolution } = loadMoveAwareApi();
    assert.equal(betterMoveSolution(
      { cost: 5, moves: 20 },
      { cost: 4, moves: 21 },
    ), true);
    assert.equal(betterMoveSolution(
      { cost: 5, moves: 21 },
      { cost: 4, moves: 20 },
    ), false);
    assert.equal(betterMoveSolution(
      { cost: 4, moves: 20 },
      { cost: 5, moves: 20 },
    ), true);
  });

  it("selects a finite unoccupied target from a doorway task domain", () => {
    const { selectDynamicTaskTarget } = loadMoveAwareApi();
    const board = {
      goalPushTables: {
        byGoal: new Map([
          ["1,1", new Map([["0,0", 0]])],
          ["2,2", new Map([["0,0", 2]])],
        ]),
      },
      metrics: { goalTableHits: 0 },
    };
    const state = {
      boxes: [
        [0, 0, "X"],
        [1, 1, "X"],
      ] as Array<[number, number, string]>,
    };

    assert.equal(selectDynamicTaskTarget({
      target: "1,1",
      allowedTargets: ["1,1", "2,2"],
    }, state, 0, board), "2,2");
  });

  it("keeps macro-local push/move tradeoffs and reserves an alternate approach", () => {
    const {
      macroParetoAccept,
      macroParetoActive,
      selectMacroEndpoints,
    } = loadMoveAwareApi();
    const seen = new Map<string, Array<{ pushes: number; moves: number }>>();
    assert.equal(macroParetoAccept(seen, "state", 2, 12, 2), true);
    assert.equal(macroParetoAccept(seen, "state", 3, 7, 2), true);
    assert.equal(macroParetoAccept(seen, "state", 3, 14, 2), false);
    assert.equal(macroParetoActive(seen, "state", 2, 12), true);
    assert.equal(macroParetoActive(seen, "state", 3, 7), true);

    const primary = { pushedTo: "2,2", robot: [2, 1], id: "primary" };
    const endpoints = [
      primary,
      { pushedTo: "2,3", robot: [2, 2], id: "second" },
      { pushedTo: "2,4", robot: [2, 3], id: "third" },
      { pushedTo: "2,2", robot: [1, 2], id: "alternate" },
      { pushedTo: "2,5", robot: [2, 4], id: "fourth-destination" },
    ];
    const selected = selectMacroEndpoints(endpoints, 4, () => true, true);
    assert.equal(selected.includes(primary), true);
    assert.equal(selected.some(endpoint => endpoint.id === "alternate"), true);
  });

  it("prefers the shorter walk for equivalent targeted macro endpoints", () => {
    const { compareTargetedMacroEndpoints } = loadMoveAwareApi();
    const longer = {
      targetDistance: 0,
      pushes: 4,
      macroPath: { length: 12 },
      macroOrder: 0,
    };
    const shorter = {
      targetDistance: 0,
      pushes: 4,
      macroPath: { length: 9 },
      macroOrder: 1,
    };

    assert.ok(compareTargetedMacroEndpoints(shorter, longer) < 0);
  });

  it("stops an unreachable targeted macro at a replayable decision endpoint", () => {
    const engine = loadMoveAwareApi();
    const board = engine.parse({
      rows: [
        "OOOOOOO",
        "O   S O",
        "O     O",
        "O     O",
        "OOOOOOO",
      ],
    });
    const state = {
      robot: [2, 1],
      boxes: [[2, 2, "X"]],
    };
    const reachable = engine.reachablePaths(state, board);
    const first = engine.pushNeighbors(state, board, reachable)
      .find(candidate => candidate.pushedTo === "2,3");
    assert.ok(first);

    const expanded = engine.expandTargetedPushSequence(
      first,
      board,
      { target: "missing-goal" },
      8,
      32,
      4,
    );
    assert.equal(expanded[0]?.targetDeadEnd, true);
    assert.ok(Array.isArray(expanded[0]?.path));
  });

  it("runs the move-aware flagship and fallback beams within strict budgets", () => {
    const { search } = loadMoveAwareApi();
    const state = {
      rows: [
        "OOOOOOO",
        "O  R  O",
        "O A X O",
        "O a S O",
        "O     O",
        "OOOOOOO",
      ],
      robot: [1, 3],
      boxes: [["2,2", "A"], ["2,4", "X"]],
    };
    for (const payload of [
      {
        algorithm: "plan-macro-beam",
        planCanonicalOrientation: false,
        planMoveAwareTranspositions: true,
        moveAwareMacroDedupe: true,
        macroApproachDiversity: true,
        planBeamWidth: 32,
        maxVisited: 1_000,
        maxGenerated: 2_000,
        maxDepth: 20,
      },
      {
        algorithm: "push-beam",
        beamMoveAwareTranspositions: true,
        beamWidth: 32,
        maxVisited: 1_000,
        maxGenerated: 2_000,
        maxDepth: 20,
        sequenceMacros: true,
      },
    ]) {
      const result = search({ ...payload, state });
      assert.equal(result.status, "solved");
      assert.ok(Array.isArray(result.path));
      assert.ok(Number(result.bestMoves) > 0);
      assert.ok(Number(result.bestPushes) > 0);
      assert.ok(Number(result.generated) <= Number(payload.maxGenerated));
    }
  });

  it("reports lexicographic push-bridge quality", () => {
    const { search } = loadMoveAwareApi();
    const result = search({
      algorithm: "bridge-astar",
      weight: 1,
      maxVisited: 100,
      maxGenerated: 100,
      upperBound: 1,
      state: {
        rows: [
          "OOOOOOO",
          "O    SO",
          "O RX  O",
          "O     O",
          "OOOOOOO",
        ],
        robot: [2, 2],
        boxes: [["2,3", "X"]],
      },
      targetState: {
        robot: [2, 3],
        boxes: [["2,4", "X"]],
      },
    });

    assert.deepEqual(Array.from(result.path || []), ["Right"]);
    assert.equal(result.bestPushes, 1);
    assert.equal(result.bestMoves, 1);
  });
});
