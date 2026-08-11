import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DIRECTIONS,
  createSession,
  stepSnapshot,
  type GameSnapshot,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import type {
  SolverAdapter,
  SolverExecutionContext,
  SolverObjective,
  SolverRequest,
  SolverResult,
} from "../../src/solver/contracts.ts";
import { createDefaultSolverRegistry } from "../../src/solver/default-registry.ts";
import {
  BUILT_IN_SOLVERS,
  CLASSIC_SOLVERS,
  classicAStarSolver,
  classicDfsSolver,
  classicGreedySolver,
} from "../../src/solver/implementations/index.ts";
import { QueueFrontier } from "../../src/solver/search/engine.ts";
import {
  compareNumberTuples,
  StablePriorityQueue,
} from "../../src/solver/search/priority-queue.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

const TWO_GENERIC_BOXES: PuzzleDefinition = {
  id: "two-generic-boxes",
  title: "Two generic boxes",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOOOO",
    "O SS  O",
    "O XX  O",
    "O  R  O",
    "O     O",
    "OOOOOOO",
  ],
};

const EXACT_KEEPER_IDENTITY_REGRESSION: PuzzleDefinition = {
  id: "exact-keeper-identity-regression",
  title: "Exact keeper identity regression",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOOOO",
    "O X SSO",
    "O   O O",
    "OO XR O",
    "O     O",
    "OOOOOOO",
  ],
};

function requestFor(
  puzzle: PuzzleDefinition,
  objective: SolverObjective,
  snapshot?: GameSnapshot,
): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: snapshot ?? session.snapshot,
    objective,
  };
}

function executionContext(
  progress: SolverExecutionContext["reportProgress"] = () => undefined,
  signal = new AbortController().signal,
): SolverExecutionContext {
  return {
    signal,
    reportProgress: progress,
    now: () => performance.now(),
  };
}

async function solve(
  adapter: SolverAdapter,
  request: SolverRequest,
): Promise<SolverResult> {
  return adapter.solve(request, executionContext());
}

function solved(
  result: SolverResult,
): Extract<SolverResult, { readonly status: "solved" }> {
  assert.equal(result.status, "solved");
  if (result.status !== "solved") throw new Error("Expected a solved result.");
  return result;
}

const VOLATILE_TIMING_COUNTERS = new Set([
  "pdbBuildTimeMs",
  "deadlockTableBuildTimeMs",
]);

function deterministicCounters(
  counters: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(counters ?? {}).filter(
      ([name]) => !VOLATILE_TIMING_COUNTERS.has(name),
    ),
  );
}

function stateKey(snapshot: GameSnapshot): string {
  const boxes = snapshot.boxes
    .map(
      (box) =>
        `${box.label}:${String(box.position.row)},${String(box.position.column)}`,
    )
    .sort()
    .join("|");
  return `${String(snapshot.robot.row)},${String(snapshot.robot.column)}|${boxes}`;
}

function oracleVector(
  _objective: SolverObjective,
  moves: number,
): readonly number[] {
  return [moves];
}

/**
 * Independent step-state Dijkstra oracle. It knows nothing about push macros,
 * assignment bounds, reachability floods, or solver state identity.
 */
function exactStepOracle(request: SolverRequest): {
  readonly moves: number;
  readonly pushes: number;
  readonly score: number;
} {
  const startMoves = request.snapshot.moves;
  const startPushes = request.snapshot.pushes;
  let nextOrder = 0;
  const frontier: Array<{
    readonly snapshot: GameSnapshot;
    readonly cost: readonly number[];
    readonly order: number;
  }> = [
    {
      snapshot: request.snapshot,
      cost: oracleVector(request.objective, 0),
      order: nextOrder++,
    },
  ];
  const best = new Map<string, readonly number[]>([
    [stateKey(request.snapshot), frontier[0]?.cost ?? []],
  ]);
  let expanded = 0;

  while (frontier.length > 0) {
    frontier.sort(
      (left, right) =>
        compareNumberTuples(left.cost, right.cost) ||
        left.order - right.order,
    );
    const entry = frontier.shift();
    if (!entry) break;
    const key = stateKey(entry.snapshot);
    if (compareNumberTuples(entry.cost, best.get(key) ?? []) !== 0) continue;

    const moves = entry.snapshot.moves - startMoves;
    const pushes = entry.snapshot.pushes - startPushes;
    if (entry.snapshot.solved) {
      return {
        moves,
        pushes,
        score: oracleVector(request.objective, moves)[0] ?? 0,
      };
    }
    expanded += 1;
    if (expanded > 20_000) {
      throw new Error("Tiny exact-search fixture exceeded its safety bound.");
    }

    for (const direction of DIRECTIONS) {
      const transition = stepSnapshot(
        request.board,
        entry.snapshot,
        direction,
      );
      if (!transition.moved) continue;
      const nextMoves = transition.snapshot.moves - startMoves;
      const nextCost = oracleVector(
        request.objective,
        nextMoves,
      );
      const nextKey = stateKey(transition.snapshot);
      const previous = best.get(nextKey);
      if (previous && compareNumberTuples(nextCost, previous) >= 0) continue;
      best.set(nextKey, nextCost);
      frontier.push({
        snapshot: transition.snapshot,
        cost: nextCost,
        order: nextOrder++,
      });
    }
  }
  throw new Error("Exact-search fixture is unsolvable.");
}

describe("classic search strategies", () => {
  it("registers Sokomind Solver before all deterministic classic adapters", () => {
    const registry = createDefaultSolverRegistry();
    assert.deepEqual(
      CLASSIC_SOLVERS.map(({ metadata }) => metadata.id),
      [
        "classic-dfs",
        "classic-greedy",
        "classic-astar",
        "classic-ida-star",
      ],
    );
    assert.deepEqual(
      registry.listMetadata().map(({ id }) => id),
      BUILT_IN_SOLVERS.map(({ metadata }) => metadata.id),
    );
    assert.equal(registry.listMetadata()[0]?.id, "sokomind-solver");
    assert.equal(
      registry.listMetadata()[0]?.capabilities.deterministic,
      false,
    );
    for (const metadata of registry.listMetadata().slice(1)) {
      assert.equal(metadata.capabilities.deterministic, true);
      assert.equal(metadata.capabilities.partialState, true);
      assert.equal(
        metadata.capabilities.executionTargets.includes("web-worker"),
        true,
      );
    }
  });

  it("uses a stable heap and handles infinite tuple values deterministically", () => {
    const queue = new StablePriorityQueue<{
      readonly id: string;
      readonly priority: readonly number[];
    }>((left, right) =>
      compareNumberTuples(left.priority, right.priority),
    );
    queue.enqueue({ id: "later", priority: [2] });
    queue.enqueue({ id: "first-equal", priority: [1, Number.POSITIVE_INFINITY] });
    queue.enqueue({ id: "second-equal", priority: [1, Number.POSITIVE_INFINITY] });

    assert.equal(queue.dequeue()?.id, "first-equal");
    assert.equal(queue.dequeue()?.id, "second-equal");
    assert.equal(queue.dequeue()?.id, "later");
    assert.equal(queue.dequeue(), undefined);
  });

  it("returns replayable first-found solutions from DFS and Greedy", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, {
      kind: "moves",
    });
    for (const adapter of [classicDfsSolver, classicGreedySolver]) {
      const result = solved(await solve(adapter, request));
      assert.equal(result.solution.optimality, "unknown");
      assert.deepEqual(verifySolverSolution(request, result.solution).valid, true);
      assert.ok(result.solution.moves >= result.solution.pushes);
      assert.ok((result.metrics.expandedStates ?? 0) > 0);
    }
  });

  it("makes A* move-optimal against an independent step-state oracle", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, { kind: "moves" });
    const expected = exactStepOracle(request);
    const result = solved(await solve(classicAStarSolver, request));

    assert.equal(result.solution.objectiveScore, expected.score);
    assert.equal(result.solution.moves, expected.moves);
    assert.equal(result.solution.optimality, "proven");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
  });

  it("keeps exact keeper positions distinct when A* compares move costs", async () => {
    const request = requestFor(EXACT_KEEPER_IDENTITY_REGRESSION, {
      kind: "moves",
    });
    const expected = exactStepOracle(request);
    const result = solved(await solve(classicAStarSolver, request));

    assert.equal(expected.moves, 18);
    assert.equal(result.solution.moves, expected.moves);
    assert.equal(result.solution.optimality, "proven");
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
  });

  it("solves an exact partial snapshot and reports only remaining steps", async () => {
    const session = createSession(TWO_GENERIC_BOXES);
    const firstPush = stepSnapshot(
      session.board,
      session.snapshot,
      "up",
    );
    assert.equal(firstPush.pushed, true);
    assert.equal(firstPush.snapshot.moves, 1);
    assert.equal(firstPush.snapshot.pushes, 1);

    const request: SolverRequest = {
      board: session.board,
      snapshot: firstPush.snapshot,
      objective: { kind: "moves" },
    };
    const expected = exactStepOracle(request);
    const result = solved(await solve(classicAStarSolver, request));

    assert.equal(result.solution.moves, expected.moves);
    assert.equal(result.solution.pushes, expected.pushes);
    assert.equal(result.solution.moves, result.solution.steps.length);
    assert.equal(verifySolverSolution(request, result.solution).valid, true);
  });

  it("produces identical paths and deterministic counters across runs", async () => {
    const request = requestFor(TWO_GENERIC_BOXES, {
      kind: "moves",
    });
    const first = solved(await solve(classicAStarSolver, request));
    const second = solved(await solve(classicAStarSolver, request));

    assert.deepEqual(first.solution.steps, second.solution.steps);
    assert.deepEqual(first.solution.moves, second.solution.moves);
    assert.deepEqual(first.solution.pushes, second.solution.pushes);
    assert.deepEqual(first.metrics.expandedStates, second.metrics.expandedStates);
    assert.deepEqual(first.metrics.generatedStates, second.metrics.generatedStates);
    assert.deepEqual(
      deterministicCounters(first.metrics.counters),
      deterministicCounters(second.metrics.counters),
    );
  });
});

describe("QueueFrontier segment-based deque", () => {
  it("maintains FIFO order across segment boundaries with 5000+ items", () => {
    const queue = new QueueFrontier();
    const count = 6000;
    for (let i = 0; i < count; i += 1) {
      queue.push(i);
    }
    assert.equal(queue.size, count);
    for (let i = 0; i < count; i += 1) {
      assert.equal(queue.pop(), i);
    }
    assert.equal(queue.size, 0);
    assert.equal(queue.pop(), undefined);
  });

  it("handles interleaved push/pop operations in correct FIFO order", () => {
    const queue = new QueueFrontier();
    const received: number[] = [];
    let nextPush = 0;

    // Push 100, pop 50, push 100, pop 50, ...
    for (let round = 0; round < 20; round += 1) {
      for (let i = 0; i < 100; i += 1) {
        queue.push(nextPush);
        nextPush += 1;
      }
      for (let i = 0; i < 50; i += 1) {
        const value = queue.pop();
        assert.notEqual(value, undefined);
        received.push(value!);
      }
    }
    // Drain remaining
    while (queue.size > 0) {
      const value = queue.pop();
      assert.notEqual(value, undefined);
      received.push(value!);
    }
    // Verify full FIFO sequence 0..nextPush-1
    assert.equal(received.length, nextPush);
    for (let i = 0; i < received.length; i += 1) {
      assert.equal(received[i], i);
    }
  });

  it("tracks size accurately throughout push and pop operations", () => {
    const queue = new QueueFrontier();
    assert.equal(queue.size, 0);

    queue.push(10);
    assert.equal(queue.size, 1);

    queue.push(20);
    queue.push(30);
    assert.equal(queue.size, 3);

    queue.pop();
    assert.equal(queue.size, 2);

    queue.pop();
    queue.pop();
    assert.equal(queue.size, 0);

    // Push across a segment boundary and verify size
    for (let i = 0; i < 5000; i += 1) {
      queue.push(i);
    }
    assert.equal(queue.size, 5000);

    for (let i = 0; i < 2500; i += 1) {
      queue.pop();
    }
    assert.equal(queue.size, 2500);

    for (let i = 0; i < 2500; i += 1) {
      queue.pop();
    }
    assert.equal(queue.size, 0);

    // Pop on empty returns undefined and keeps size at 0
    assert.equal(queue.pop(), undefined);
    assert.equal(queue.size, 0);
  });
});
