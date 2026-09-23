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
import { TUNNEL_SOUNDNESS_BY_ID } from "../fixtures/solver-v2/tunnel-soundness.ts";

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

// tunnelMacros defaults to false, so integration tests opt in explicitly.
const TUNNEL_ON = { features: { tunnelMacros: true } } as const;

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
      assert.ok(result!.stops.length >= 1);
      const lastStop = result!.stops[result!.stops.length - 1]!;
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
            result.stops.some(s => s.pushCount > 1),
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
          for (const stop of result.stops) {
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
          const hasGoalStop = result.stops.some(
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
          for (const stop of result.stops) {
            const goalLabel = board.goalLabelByCell[stop.finalCell];
            if (goalLabel !== null && goalLabel !== "A") {
              assert.fail("should not stop at a goal with a different label");
            }
          }
        }
      }
    });

    it("returns the tunnel exit as an extra multi-push stop, never a replacement", () => {
      // Long tunnel: the detector proposes the 5-push stop as an additional
      // successor. The kernels always keep the ordinary single push.
      const { board } = boardFromRows([
        "OOOOOOOOO",
        "ORX    SO",
        "OOOOOOOOO",
      ]);
      const detector = new TunnelMacroDetector(board);
      const occupancy = new Uint8Array(board.cellCount);
      occupancy[board.cellAt(1, 2)] = 1;

      const dest = board.cellAt(1, 3);
      assert.ok(board.topology.tunnels.has(dest), "cell (1,3) should be a tunnel cell");
      const result = detector.resolve(
        dest, 3, occupancy, board.goalLabelByCell, "X",
      );
      assert.notEqual(result, null);
      assert.deepEqual(result!.stops, [
        { finalCell: board.cellAt(1, 7), pushCount: 5, robotCell: board.cellAt(1, 6) },
      ]);
      assert.equal("replacesSinglePush" in result!, false);
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
    const result = await runExactMoveAStar(request, context, TUNNEL_ON);
    assert.equal(result.status, "solved");
    assert.equal(result.proof?.kind, "optimal");
  });

  it("IDA* solves tight corridor optimally", async () => {
    const request = makeRequest(TUNNEL_BOARD);
    const context = makeContext();
    const result = await runIdaStarSearch(request, context, TUNNEL_ON);
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
    const result = await runExactMoveAStar(request, context, TUNNEL_ON);
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
    // tunnelMacros is off by default, and forced-push macros hide the tunnel
    // path on this corridor, so both sides set the features explicitly.
    const resultOn = await runExactMoveAStar(request, context1, {
      features: { tunnelMacros: true, forcedPushMacros: false },
    });

    const context2 = makeContext();
    const resultOff = await runExactMoveAStar(request, context2, {
      features: { tunnelMacros: false, forcedPushMacros: false },
    });
    assert.ok(
      (resultOn.metrics.counters?.tunnelMacroApplications ?? 0) > 0,
      "the enabled run must exercise the tunnel macro",
    );

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
    // tunnelMacros is off by default, and forced-push macros hide the tunnel
    // path on this corridor, so both sides set the features explicitly.
    const resultOn = await runIdaStarSearch(request, context1, {
      features: { tunnelMacros: true, forcedPushMacros: false },
    });

    const context2 = makeContext();
    const resultOff = await runIdaStarSearch(request, context2, {
      features: { tunnelMacros: false, forcedPushMacros: false },
    });
    assert.ok(
      (resultOn.metrics.counters?.tunnelMacroApplications ?? 0) > 0,
      "the enabled run must exercise the tunnel macro",
    );

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
    const result = await runExactMoveAStar(request, context, TUNNEL_ON);
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
    const result = await runIdaStarSearch(request, context, TUNNEL_ON);
    assert.equal(result.status, "solved");
    assert.equal(
      result.solution?.moves,
      oracle.exactMoves,
      `IDA* moves (${result.solution?.moves}) should match oracle (${oracle.exactMoves})`,
    );
  });

  // Forced-push macros run before the tunnel resolve and hid the unsound
  // single-push replacement. With them off, es01a (oracle 16) returned
  // exhausted on both kernels while the macro replaced the single push.
  const FORCED_PUSH_OFF_CONFIGS = [
    { label: "forcedPushMacros:false", features: { forcedPushMacros: false } },
    {
      label: "forcedPushMacros:false + tunnelMacros:true",
      features: { forcedPushMacros: false, tunnelMacros: true },
    },
  ] as const;
  const FORCED_PUSH_OFF_BOARDS: readonly (readonly [string, string[]])[] = [
    ["TUNNEL_BOARD", TUNNEL_BOARD],
    ["es01a", [...TUNNEL_SOUNDNESS_BY_ID.es01a.rows]],
  ];
  for (const [boardName, rows] of FORCED_PUSH_OFF_BOARDS) {
    for (const { label, features } of FORCED_PUSH_OFF_CONFIGS) {
      it(`A* and IDA* match the oracle on ${boardName} with ${label}`, async () => {
        const { board, boxes, robotCell } = boardFromRows(rows);
        const oracle = exactRemainingMoves(board, robotCell, boxes);
        assert.notEqual(oracle.exactMoves, null, "oracle should find a solution");

        const results = [
          ["A*", await runExactMoveAStar(makeRequest(rows), makeContext(), { features })],
          ["IDA*", await runIdaStarSearch(makeRequest(rows), makeContext(), { features })],
        ] as const;
        for (const [engine, result] of results) {
          const tag = `${engine} ${label} on ${boardName}`;
          assert.equal(result.status, "solved", tag);
          assert.equal(result.solution?.moves, oracle.exactMoves, `${tag} moves`);
          assert.equal(result.proof?.kind, "optimal", `${tag} proof kind`);
        }
      });
    }
  }
});
