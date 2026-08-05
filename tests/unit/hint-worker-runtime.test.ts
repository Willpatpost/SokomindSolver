import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createHintWorkerConnection,
  HintWorkerTimeoutError,
} from "../../src/features/game/hint-worker-runtime.ts";
import type { SolverWorkerCommand } from "../../src/solver/protocol.ts";
import { createSession, stepSnapshot } from "../../src/core/game-session.ts";
import { DIRECTIONS, type Direction, type PuzzleDefinition } from "../../src/core/model.ts";
import type { SolverResult, SolverSolution } from "../../src/solver/contracts.ts";

type WorkerEventType = "message" | "error" | "messageerror";
type WorkerListener = (event: { data?: unknown; message?: string }) => void;

class FakeWorker {
  readonly messages: SolverWorkerCommand[] = [];
  readonly listeners = new Map<WorkerEventType, Set<WorkerListener>>([
    ["message", new Set()],
    ["error", new Set()],
    ["messageerror", new Set()],
  ]);
  terminateCount = 0;

  postMessage(message: SolverWorkerCommand): void {
    this.messages.push(message);
  }

  addEventListener(type: WorkerEventType, listener: WorkerListener): void {
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: WorkerEventType, listener: WorkerListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }

  emitError(message: string): void {
    for (const listener of this.listeners.get("error") ?? []) listener({ message });
  }

  emitMessageError(): void {
    for (const listener of this.listeners.get("messageerror") ?? []) listener({});
  }
}

function controlledTimer() {
  let callback: (() => void) | undefined;
  let clearCount = 0;
  return {
    setTimer(next: () => void) {
      callback = next;
      return "timer";
    },
    clearTimer() {
      clearCount += 1;
    },
    fire() {
      assert.ok(callback, "expected a pending watchdog");
      callback();
    },
    get clearCount() {
      return clearCount;
    },
  };
}

const metadata = Object.freeze({
  id: "classic-astar",
  displayName: "Classic A*",
  description: "Hint runtime test solver",
  version: "1.0.0",
  capabilities: {
    executionTargets: ["web-worker"] as const,
    runtime: "javascript",
    objectives: ["moves"] as const,
    quality: "first-found",
    labeledBoxes: true,
    genericBoxes: true,
    partialState: true,
    reportsProgress: false,
    cooperativeCancellation: true,
    deterministic: true,
  },
});

describe("hint worker connection", () => {
  it("terminates and reports a silent discovery timeout", async () => {
    const worker = new FakeWorker();
    const timer = controlledTimer();
    const failures: Error[] = [];
    const connection = createHintWorkerConnection(worker as unknown as Worker, {
      startupTimeoutMs: 5_000,
      onFailure: (error) => failures.push(error),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    const discovery = connection.discover();
    timer.fire();

    await assert.rejects(discovery, HintWorkerTimeoutError);
    assert.equal(failures.length, 1);
    assert.match(failures[0]?.message ?? "", /did not respond during startup/);
    assert.equal(worker.terminateCount, 1);
    assert.equal(worker.listeners.get("error")?.size, 0);
    assert.equal(worker.listeners.get("messageerror")?.size, 0);
  });

  it("clears the watchdog after successful discovery", async () => {
    const worker = new FakeWorker();
    const timer = controlledTimer();
    const failures: Error[] = [];
    const connection = createHintWorkerConnection(worker as unknown as Worker, {
      startupTimeoutMs: 5_000,
      onFailure: (error) => failures.push(error),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    const discovery = connection.discover();
    worker.emitMessage({
      protocolVersion: 1,
      type: "solver/ready",
      solvers: [metadata],
    });

    assert.deepEqual(await discovery, [metadata]);
    assert.equal(timer.clearCount, 1);
    assert.deepEqual(failures, []);
    assert.equal(worker.terminateCount, 0);
    connection.dispose();
    assert.equal(worker.terminateCount, 1);
  });

  for (const eventType of ["error", "messageerror"] as const) {
    it(`disposes pending discovery after ${eventType}`, async () => {
      const worker = new FakeWorker();
      const failures: Error[] = [];
      const connection = createHintWorkerConnection(worker as unknown as Worker, {
        startupTimeoutMs: 5_000,
        onFailure: (error) => failures.push(error),
      });
      const discovery = connection.discover();

      if (eventType === "error") worker.emitError("worker exploded");
      else worker.emitMessageError();

      await assert.rejects(discovery, /disposed/);
      assert.equal(failures.length, 1);
      assert.match(
        failures[0]?.message ?? "",
        eventType === "error" ? /worker exploded/ : /unreadable message/,
      );
      assert.equal(worker.terminateCount, 1);
    });
  }

  it("disposes silently when the owner cancels startup", async () => {
    const worker = new FakeWorker();
    const failures: Error[] = [];
    const connection = createHintWorkerConnection(worker as unknown as Worker, {
      startupTimeoutMs: 5_000,
      onFailure: (error) => failures.push(error),
    });
    const discovery = connection.discover();

    connection.dispose();

    await assert.rejects(discovery, /disposed/);
    assert.deepEqual(failures, []);
    assert.equal(worker.terminateCount, 1);
  });
});

// ---------------------------------------------------------------------------
// Hint correctness
// ---------------------------------------------------------------------------

/**
 * A small 5x5 solvable puzzle used to verify that hints produce legal moves.
 *
 * Layout (O = wall, R = robot, X = box, S = goal):
 *   OOOOO
 *   O  SO
 *   O X O
 *   OR  O
 *   OOOOO
 *
 * Robot starts at (3,1). Box at (2,2). Goal at (1,3).
 * Optimal solution: up(walk), right(push), down(walk), right(walk), up(push)
 * = 5 moves, 2 pushes.
 */
const HINT_TEST_PUZZLE: PuzzleDefinition = Object.freeze({
  id: "hint-test-5x5",
  title: "Hint Test",
  difficulty: "tutorial" as const,
  boxes: 1,
  rows: Object.freeze([
    "OOOOO",
    "O  SO",
    "O X O",
    "OR  O",
    "OOOOO",
  ]),
});

/** Full correct solution for HINT_TEST_PUZZLE from the initial state. */
const HINT_TEST_SOLUTION: SolverSolution = Object.freeze({
  steps: Object.freeze([
    { direction: "up" as Direction, kind: "walk" as const },
    { direction: "right" as Direction, kind: "push" as const },
    { direction: "down" as Direction, kind: "walk" as const },
    { direction: "right" as Direction, kind: "walk" as const },
    { direction: "up" as Direction, kind: "push" as const },
  ]),
  moves: 5,
  pushes: 2,
  objective: Object.freeze({ kind: "moves" as const }),
  objectiveScore: 5,
  optimality: "unknown" as const,
});

/** Builds the solver/result event the FakeWorker should emit. */
function solvedResultEvent(jobId: string, solution: SolverSolution): unknown {
  const result: SolverResult = {
    status: "solved",
    solution,
    metrics: { elapsedMs: 1 },
  };
  return {
    protocolVersion: 1,
    type: "solver/result",
    jobId,
    result,
  };
}

describe("hint correctness", () => {
  /**
   * Helper: completes the discovery handshake so the connection is ready for
   * solver runs, then returns the connection and the underlying FakeWorker.
   */
  async function readyConnection() {
    const worker = new FakeWorker();
    const timer = controlledTimer();
    const failures: Error[] = [];
    const connection = createHintWorkerConnection(worker as unknown as Worker, {
      startupTimeoutMs: 5_000,
      onFailure: (error) => failures.push(error),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    const discovery = connection.discover();
    worker.emitMessage({
      protocolVersion: 1,
      type: "solver/ready",
      solvers: [metadata],
    });
    await discovery;
    return { worker, connection, failures };
  }

  it("returns a valid direction as first hint for a solvable puzzle", async () => {
    const { worker, connection } = await readyConnection();
    const session = createSession(HINT_TEST_PUZZLE);

    const handle = connection.client.run(
      metadata.id,
      {
        board: session.board,
        snapshot: session.snapshot,
        objective: { kind: "moves" },
      },
    );

    // Simulate the solver responding with a correct solution.
    worker.emitMessage(solvedResultEvent(handle.jobId, HINT_TEST_SOLUTION));

    const result = await handle.result;
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return; // type guard

    const firstDirection = result.solution.steps[0]?.direction;
    assert.ok(firstDirection, "solution must have at least one step");
    assert.ok(
      (DIRECTIONS as readonly string[]).includes(firstDirection),
      `hint direction "${firstDirection}" must be one of ${DIRECTIONS.join(", ")}`,
    );

    connection.dispose();
  });

  it("first hint move produces a valid (moved=true) transition", async () => {
    const { worker, connection } = await readyConnection();
    const session = createSession(HINT_TEST_PUZZLE);

    const handle = connection.client.run(
      metadata.id,
      {
        board: session.board,
        snapshot: session.snapshot,
        objective: { kind: "moves" },
      },
    );

    worker.emitMessage(solvedResultEvent(handle.jobId, HINT_TEST_SOLUTION));

    const result = await handle.result;
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;

    const firstDirection = result.solution.steps[0]!.direction;
    const transition = stepSnapshot(session.board, session.snapshot, firstDirection);

    assert.equal(transition.moved, true, "applying the hint direction must produce a legal move");

    connection.dispose();
  });

  it("every step of the hint solution produces legal transitions to a solved state", async () => {
    const { worker, connection } = await readyConnection();
    const session = createSession(HINT_TEST_PUZZLE);

    const handle = connection.client.run(
      metadata.id,
      {
        board: session.board,
        snapshot: session.snapshot,
        objective: { kind: "moves" },
      },
    );

    worker.emitMessage(solvedResultEvent(handle.jobId, HINT_TEST_SOLUTION));

    const result = await handle.result;
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;

    // Replay every step and verify each is legal.
    let snapshot = session.snapshot;
    for (const [i, step] of result.solution.steps.entries()) {
      const transition = stepSnapshot(session.board, snapshot, step.direction);
      assert.equal(
        transition.moved,
        true,
        `step ${i} (${step.direction}) must be a legal move`,
      );
      snapshot = transition.snapshot;
    }

    assert.equal(snapshot.solved, true, "all steps must lead to a solved state");

    connection.dispose();
  });
});
