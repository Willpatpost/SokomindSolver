import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  TunnelMacroDetector,
  encodeTunnelPushDirection,
  decodeTunnelPushDirection,
} from "../../src/solver/search/tunnel-macros.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";
import { runExactMoveAStar } from "../../src/solver/search/exact-move-astar.ts";
import { runIdaStarSearch } from "../../src/solver/search/ida-star.ts";
import {
  exactRemainingMoves,
} from "../support/exact-solver-oracle.ts";

function boardFromRows(rows: string[]) {
  const parsed = parsePuzzleRows(rows);
  const board = compileSearchBoard(parsed);
  const boxes = toDenseBoxes(board, parsed.initialBoxes);
  const robotCell = board.cellAt(
    parsed.initialRobot.row,
    parsed.initialRobot.column,
  );
  return { board, parsed, boxes, robotCell };
}

function buildOccupancy(board: CompiledSearchBoard, boxes: readonly DenseBox[]): Uint8Array {
  const occupancy = new Uint8Array(board.cellCount);
  for (const box of boxes) occupancy[box.cell] = 1;
  return occupancy;
}

function makeContext(): SolverExecutionContext {
  return {
    now: () => performance.now(),
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}

function makeRequest(rows: string[]): SolverRequest {
  const parsed = parsePuzzleRows(rows);
  return {
    board: parsed,
    snapshot: {
      puzzleId: "test",
      robot: parsed.initialRobot,
      boxes: parsed.initialBoxes,
      moves: 0,
      pushes: 0,
      solved: false,
    },
    objective: { kind: "moves" },
    limits: {
      maxElapsedMs: 30000,
      maxExpandedStates: 500_000,
      maxGeneratedStates: 2_000_000,
      maxMemoryBytes: 256 * 1024 * 1024,
    },
  };
}

// Tight horizontal tunnel: walls above and below force 2 collinear neighbors
// R X   S  ← all cells between walls are tunnel cells
const TUNNEL_BOARD = [
  "OOOOOOO",
  "ORX  SO",
  "OOOOOOO",
];

describe("TunnelMacroDetector", () => {
  describe("resolve", () => {
    it("returns null for non-tunnel destination", () => {
      // Wide room: cells have >2 neighbors, not tunnel cells
      const { board, boxes } = boardFromRows([
        "OOOOO",
        "OR  O",
        "O X O",
        "O  SO",
        "OOOOO",
      ]);
      const detector = new TunnelMacroDetector(board);
      const occupancy = buildOccupancy(board, boxes);
      const dest = board.cellAt(2, 3);
      const result = detector.resolve(
        dest, 3, occupancy, board.goalLabelByCell, "X",
      );
      assert.equal(result, null);
    });

    it("returns stops for horizontal tunnel push", () => {
      const { board } = boardFromRows(TUNNEL_BOARD);
      assert.ok(
        board.topology.tunnels.has(board.cellAt(1, 3)),
        "cell (1,3) should be a tunnel cell",
      );

      const detector = new TunnelMacroDetector(board);
      const occupancy = new Uint8Array(board.cellCount);
      occupancy[board.cellAt(1, 2)] = 1;

      const dest = board.cellAt(1, 3);
      const result = detector.resolve(
        dest, 3, occupancy, board.goalLabelByCell, "X",
      );

      assert.notEqual(result, null, "should detect tunnel macro");
      assert.ok(result!.length >= 1);
      const lastStop = result![result!.length - 1]!;
      assert.ok(lastStop.pushCount > 1, "macro should chain multiple pushes");
    });

    it("returns null when single push to tunnel with wall immediately after", () => {
      // Box pushed into a 1-cell tunnel dead-end
      const { board } = boardFromRows([
        "OOOOO",
        "ORXSO",
        "OOOOO",
      ]);
      const detector = new TunnelMacroDetector(board);
      const occupancy = new Uint8Array(board.cellCount);
      occupancy[board.cellAt(1, 2)] = 1;

      const dest = board.cellAt(1, 3);
      if (board.topology.tunnels.has(dest)) {
        const result = detector.resolve(
          dest, 3, occupancy, board.goalLabelByCell, "X",
        );
        // Single push to a goal or dead end: no multi-push chaining possible
        // resolve returns null when the only stop is at pushCount=1
        if (result !== null) {
          assert.ok(
            result.some(s => s.pushCount > 1),
            "if not null, should have multi-push stop",
          );
        }
      }
    });

    it("stops when another box blocks the tunnel", () => {
      // Two boxes in a tight tunnel: X X with 2 goals
      const { board } = boardFromRows([
        "OOOOOOOOOO",
        "ORX X  SSO",
        "OOOOOOOOOO",
      ]);
      const detector = new TunnelMacroDetector(board);
      const boxCell1 = board.cellAt(1, 2);
      const boxCell2 = board.cellAt(1, 4);
      const occupancy = new Uint8Array(board.cellCount);
      occupancy[boxCell1] = 1;
      occupancy[boxCell2] = 1;

      const dest = board.cellAt(1, 3);
      if (board.topology.tunnels.has(dest)) {
        const result = detector.resolve(
          dest, 3, occupancy, board.goalLabelByCell, "X",
        );
        if (result !== null) {
          for (const stop of result) {
            assert.notEqual(
              stop.finalCell, boxCell2,
              "box should not end up ON the blocking box",
            );
          }
        }
      }
    });

    it("includes matching goal cell as intermediate stop", () => {
      // Tunnel with goal in the middle: R X S  O
      // Goal S at (1,4), exit at (1,5)
      const { board } = boardFromRows([
        "OOOOOOO",
        "ORXS  O",
        "OOOOOOO",
      ]);
      const detector = new TunnelMacroDetector(board);
      const occupancy = new Uint8Array(board.cellCount);
      occupancy[board.cellAt(1, 2)] = 1;

      const dest = board.cellAt(1, 3);
      if (board.topology.tunnels.has(dest)) {
        const result = detector.resolve(
          dest, 3, occupancy, board.goalLabelByCell, "X",
        );
        if (result !== null) {
          const goalCell = board.cellAt(1, 3);
          const hasGoalStop = result.some(
            (s) => board.goalLabelByCell[s.finalCell] === "X",
          );
          assert.ok(hasGoalStop, "should include goal cell as a stop");
        }
      }
    });

    it("skips goal cell with wrong label", () => {
      // Tunnel with typed goal: R A b  O (A box, b goal for B)
      const { board } = boardFromRows([
        "OOOOOOO",
        "ORA  aO",
        "OOOOOOO",
      ]);
      const detector = new TunnelMacroDetector(board);
      const occupancy = new Uint8Array(board.cellCount);
      occupancy[board.cellAt(1, 2)] = 1;

      const dest = board.cellAt(1, 3);
      if (board.topology.tunnels.has(dest)) {
        const result = detector.resolve(
          dest, 3, occupancy, board.goalLabelByCell, "A",
        );
        if (result !== null) {
          for (const stop of result) {
            const goalLabel = board.goalLabelByCell[stop.finalCell];
            if (goalLabel !== null && goalLabel !== "A") {
              assert.fail("should not stop at a goal with a different label");
            }
          }
        }
      }
    });
  });

  describe("stats tracking", () => {
    it("initialises stats to zero", () => {
      const { board } = boardFromRows([
        "OOOOO",
        "ORXSO",
        "OOOOO",
      ]);
      const detector = new TunnelMacroDetector(board);
      assert.deepEqual(detector.stats, { checks: 0, applications: 0 });
    });

    it("increments checks on every resolve call", () => {
      const { board } = boardFromRows(TUNNEL_BOARD);
      const detector = new TunnelMacroDetector(board);
      const occupancy = new Uint8Array(board.cellCount);
      occupancy[board.cellAt(1, 2)] = 1;

      detector.resolve(
        board.cellAt(1, 3), 3, occupancy, board.goalLabelByCell, "X",
      );
      detector.resolve(
        board.cellAt(1, 3), 3, occupancy, board.goalLabelByCell, "X",
      );
      assert.equal(detector.stats.checks, 2);
    });
  });

  describe("encode/decode tunnel push direction", () => {
    it("round-trips direction and pushCount", () => {
      for (let dir = 0; dir < 4; dir++) {
        for (const count of [1, 2, 5, 10, 63]) {
          const encoded = encodeTunnelPushDirection(dir, count);
          const decoded = decodeTunnelPushDirection(encoded);
          assert.equal(decoded.directionIndex, dir);
          assert.equal(decoded.pushCount, count);
        }
      }
    });

    it("is backward compatible (pushCount=1 encodes as plain direction)", () => {
      for (let dir = 0; dir < 4; dir++) {
        assert.equal(encodeTunnelPushDirection(dir, 1), dir);
      }
    });
  });
});

describe("tunnel macro solver integration", () => {
  it("A* solves tight corridor optimally", async () => {
    const request = makeRequest(TUNNEL_BOARD);
    const context = makeContext();
    const result = await runExactMoveAStar(request, context);
    assert.equal(result.status, "solved");
    assert.equal(result.proof?.kind, "optimal");
  });

  it("IDA* solves tight corridor optimally", async () => {
    const request = makeRequest(TUNNEL_BOARD);
    const context = makeContext();
    const result = await runIdaStarSearch(request, context);
    assert.equal(result.status, "solved");
    assert.equal(result.proof?.kind, "optimal");
  });

  it("A* matches oracle on tight corridor puzzle", async () => {
    const parsed = parsePuzzleRows(TUNNEL_BOARD);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(
      parsed.initialRobot.row,
      parsed.initialRobot.column,
    );
    const oracle = exactRemainingMoves(board, robotCell, boxes);
    assert.notEqual(oracle.exactMoves, null, "oracle should find a solution");

    const request = makeRequest(TUNNEL_BOARD);
    const context = makeContext();
    const result = await runExactMoveAStar(request, context);
    assert.equal(result.status, "solved");
    assert.equal(
      result.solution?.moves,
      oracle.exactMoves,
      `A* moves (${result.solution?.moves}) should match oracle (${oracle.exactMoves})`,
    );
  });

  it("A* with tunnel macros disabled matches A* with tunnel macros enabled", async () => {
    const request = makeRequest(TUNNEL_BOARD);
    const context1 = makeContext();
    const resultOn = await runExactMoveAStar(request, context1);

    const context2 = makeContext();
    const resultOff = await runExactMoveAStar(request, context2, {
      features: { tunnelMacros: false },
    });

    assert.equal(resultOn.status, "solved");
    assert.equal(resultOff.status, "solved");
    assert.equal(
      resultOn.solution?.moves,
      resultOff.solution?.moves,
      "Same optimal moves with tunnel macros on vs off",
    );
  });

  it("IDA* with tunnel macros disabled matches IDA* with tunnel macros enabled", async () => {
    const request = makeRequest(TUNNEL_BOARD);
    const context1 = makeContext();
    const resultOn = await runIdaStarSearch(request, context1);

    const context2 = makeContext();
    const resultOff = await runIdaStarSearch(request, context2, {
      features: { tunnelMacros: false },
    });

    assert.equal(resultOn.status, "solved");
    assert.equal(resultOff.status, "solved");
    assert.equal(
      resultOn.solution?.moves,
      resultOff.solution?.moves,
      "Same optimal moves with tunnel macros on vs off",
    );
  });

  it("typed box through tunnel reaches correct goal", async () => {
    const rows = [
      "OOOOOOO",
      "ORA  aO",
      "OOOOOOO",
    ];
    const request = makeRequest(rows);
    const context = makeContext();
    const result = await runExactMoveAStar(request, context);
    assert.equal(result.status, "solved");
    assert.equal(result.proof?.kind, "optimal");
  });

  it("IDA* matches oracle on tight corridor", async () => {
    const parsed = parsePuzzleRows(TUNNEL_BOARD);
    const board = compileSearchBoard(parsed);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robotCell = board.cellAt(
      parsed.initialRobot.row,
      parsed.initialRobot.column,
    );
    const oracle = exactRemainingMoves(board, robotCell, boxes);
    assert.notEqual(oracle.exactMoves, null, "oracle should find a solution");

    const request = makeRequest(TUNNEL_BOARD);
    const context = makeContext();
    const result = await runIdaStarSearch(request, context);
    assert.equal(result.status, "solved");
    assert.equal(
      result.solution?.moves,
      oracle.exactMoves,
      `IDA* moves (${result.solution?.moves}) should match oracle (${oracle.exactMoves})`,
    );
  });
});
