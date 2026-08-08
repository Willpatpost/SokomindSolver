import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  ForcedPushMacroDetector,
} from "../../src/solver/search/forced-push-macros.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";
import type { KeeperReachabilityResult } from "../../src/solver/search/reachability.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function allReachable(): KeeperReachabilityResult {
  return {
    start: 0,
    canonicalCell: 0,
    reachableCount: 999,
    isReachable: () => true,
    distanceTo: () => 1,
    pathTo: () => [],
  };
}

function reachableFrom(cells: ReadonlySet<number>): KeeperReachabilityResult {
  return {
    start: 0,
    canonicalCell: 0,
    reachableCount: cells.size,
    isReachable: (cell: number) => cells.has(cell),
    distanceTo: (cell: number) => (cells.has(cell) ? 1 : -1),
    pathTo: () => [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ForcedPushMacroDetector", () => {
  describe("constructor and stats", () => {
    it("initialises stats to zero", () => {
      const { board } = boardFromRows([
        "OOOOO",
        "ORXSO",
        "OOOOO",
      ]);
      const detector = new ForcedPushMacroDetector(board);
      assert.deepEqual(detector.stats, { checks: 0, applications: 0 });
    });
  });

  describe("forced push via restricted reachability", () => {
    it("detects forced push when keeper can only reach one support cell", () => {
      // Box at (1,3) in a corridor. Walls above and below, open left and right.
      // With all-reachable, push-left and push-right are both legal (2 pushes).
      // Restricting keeper to only the cell left of the box forces push-right.
      const { board } = boardFromRows([
        "OOOOOO",
        "OR X O",
        "OOOSOO",
      ]);

      const boxCell = board.cellAt(1, 3);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxCell },
      ];
      const detector = new ForcedPushMacroDetector(board);
      const occupancy = buildOccupancy(board, boxes);

      const leftOfBox = board.cellAt(1, 2);
      const reachable = reachableFrom(new Set([leftOfBox]));

      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, true);
      assert.equal(result.boxIndex, 0);
      assert.equal(result.direction, 3); // right
      assert.deepEqual(detector.stats, { checks: 1, applications: 1 });
    });

    it("detects forced downward push when keeper is only above the box", () => {
      const { board } = boardFromRows([
        "OOOOOO",
        "O R  O",
        "O X  O",
        "O S  O",
        "OOOOOO",
      ]);

      const boxCell = board.cellAt(2, 2);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxCell },
      ];
      const detector = new ForcedPushMacroDetector(board);
      const occupancy = buildOccupancy(board, boxes);

      const aboveBox = board.cellAt(1, 2);
      const reachable = reachableFrom(new Set([aboveBox]));

      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, true);
      assert.equal(result.boxIndex, 0);
      assert.equal(result.direction, 1); // down
    });
  });

  describe("box in open space (multiple legal pushes)", () => {
    it("returns forced=false when multiple pushes are legal", () => {
      const { board, boxes } = boardFromRows([
        "OOOOO",
        "OR  O",
        "O X O",
        "O  SO",
        "OOOOO",
      ]);
      const detector = new ForcedPushMacroDetector(board);
      const occupancy = buildOccupancy(board, boxes);
      const reachable = allReachable();

      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, false);
      assert.equal(result.direction, undefined);
      assert.equal(result.boxIndex, undefined);
    });
  });

  describe("no legal pushes at all", () => {
    it("returns forced=false when the box is in a corner (no push possible)", () => {
      // Box at (1,2): wall above (row 0), wall right (col 3 = O).
      // All 4 push directions fail due to geometry.
      const { board, boxes } = boardFromRows([
        "OOOOO",
        "ORXOO",
        "O S O",
        "OOOOO",
      ]);
      const detector = new ForcedPushMacroDetector(board);
      const occupancy = buildOccupancy(board, boxes);
      const reachable = allReachable();

      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, false);
    });

    it("returns forced=false when keeper cannot reach any support cell", () => {
      const { board, boxes } = boardFromRows([
        "OOOOO",
        "OR  O",
        "O X O",
        "O  SO",
        "OOOOO",
      ]);
      const detector = new ForcedPushMacroDetector(board);
      const occupancy = buildOccupancy(board, boxes);
      const reachable = reachableFrom(new Set<number>());

      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, false);
    });
  });

  describe("destination occupied blocks a push", () => {
    it("skips directions where another box occupies the destination", () => {
      const { board, boxes } = boardFromRows([
        "OOOOOOO",
        "OR    O",
        "O  XA O",
        "O  SaOO",
        "OOOOOOO",
      ]);
      const detector = new ForcedPushMacroDetector(board);
      const occupancy = buildOccupancy(board, boxes);
      const reachable = allReachable();

      const result = detector.detect(boxes, occupancy, reachable);

      // Multiple pushes still legal (each box has some open directions).
      assert.equal(result.forced, false);
    });

    it("detects forced push when occupancy blocks 3 of 4 destinations", () => {
      // Box at (2,3). Block destinations up, left, right with occupancy.
      // Only push-down destination (3,3) remains open.
      const { board } = boardFromRows([
        "OOOOOOO",
        "OR    O",
        "O  X  O",
        "O  S  O",
        "O     O",
        "OOOOOOO",
      ]);

      const boxCell = board.cellAt(2, 3);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxCell },
      ];
      const occupancy = new Uint8Array(board.cellCount);
      occupancy[boxCell] = 1;
      occupancy[board.cellAt(1, 3)] = 1; // block push-up dest
      occupancy[board.cellAt(2, 2)] = 1; // block push-left dest
      occupancy[board.cellAt(2, 4)] = 1; // block push-right dest

      const detector = new ForcedPushMacroDetector(board);
      const reachable = allReachable();

      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, true);
      assert.equal(result.boxIndex, 0);
      assert.equal(result.direction, 1); // down
    });
  });

  describe("multiple boxes", () => {
    it("returns forced when only one legal push exists across all boxes", () => {
      // Box A at (1,1) is in a corner: 0 legal pushes from geometry.
      // Box X at (2,3) has 1 legal push via restricted reachability.
      const { board } = boardFromRows([
        "OOOOOO",
        "OAR  O",
        "O  X O",
        "O  SaO",
        "OOOOOO",
      ]);

      const boxA = board.cellAt(1, 1);
      const boxX = board.cellAt(2, 3);
      const boxes: DenseBox[] = [
        { id: "A:0", label: "A", cell: boxA },
        { id: "X:0", label: "X", cell: boxX },
      ];
      const occupancy = buildOccupancy(board, boxes);

      // Only (1,3) above X is reachable. A has no reachable support.
      // X push-down: support=(1,3) reachable, dest=(3,3) empty. Legal.
      const aboveX = board.cellAt(1, 3);
      const reachable = reachableFrom(new Set([aboveX]));

      const detector = new ForcedPushMacroDetector(board);
      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, true);
      assert.equal(result.boxIndex, 1);
      assert.equal(result.direction, 1); // down
    });

    it("returns forced=false when two boxes each have a legal push", () => {
      const { board } = boardFromRows([
        "OOOOOOO",
        "OR X  O",
        "O  A  O",
        "O  Sa O",
        "OOOOOOO",
      ]);

      const boxX = board.cellAt(1, 3);
      const boxA = board.cellAt(2, 3);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxX },
        { id: "A:0", label: "A", cell: boxA },
      ];
      const occupancy = buildOccupancy(board, boxes);
      const reachable = allReachable();

      const detector = new ForcedPushMacroDetector(board);
      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, false);
    });
  });

  describe("stats tracking", () => {
    it("increments checks on every call and applications only on forced results", () => {
      const { board } = boardFromRows([
        "OOOOOO",
        "OR X O",
        "O  S O",
        "OOOOOO",
      ]);

      const boxCell = board.cellAt(1, 3);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxCell },
      ];
      const occupancy = buildOccupancy(board, boxes);
      const detector = new ForcedPushMacroDetector(board);

      // Call 1: forced (keeper only left of box).
      const leftOfBox = board.cellAt(1, 2);
      detector.detect(boxes, occupancy, reachableFrom(new Set([leftOfBox])));
      assert.deepEqual(detector.stats, { checks: 1, applications: 1 });

      // Call 2: not forced (keeper unreachable).
      detector.detect(boxes, occupancy, reachableFrom(new Set<number>()));
      assert.deepEqual(detector.stats, { checks: 2, applications: 1 });

      // Call 3: forced again (keeper only right of box).
      const rightOfBox = board.cellAt(1, 4);
      detector.detect(boxes, occupancy, reachableFrom(new Set([rightOfBox])));
      assert.deepEqual(detector.stats, { checks: 3, applications: 2 });
    });
  });

  describe("early exit optimisation", () => {
    it("returns forced=false as soon as legalCount exceeds 1", () => {
      const { board, boxes } = boardFromRows([
        "OOOOO",
        "OR  O",
        "O X O",
        "O  SO",
        "OOOOO",
      ]);
      const detector = new ForcedPushMacroDetector(board);
      const occupancy = buildOccupancy(board, boxes);
      const reachable = allReachable();

      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, false);
      assert.equal(detector.stats.checks, 1);
      assert.equal(detector.stats.applications, 0);
    });
  });

  describe("box at wall edge", () => {
    it("detects forced push along a wall edge via restricted reachability", () => {
      // Box at (1,3) against the top wall. Push-up dest is wall, push-down
      // support is wall. Left and right are geometrically legal.
      // Restrict keeper to left-of-box only -> forced push right.
      const { board } = boardFromRows([
        "OOOOOO",
        "OR X O",
        "O    O",
        "O  S O",
        "OOOOOO",
      ]);

      const boxCell = board.cellAt(1, 3);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxCell },
      ];
      const occupancy = buildOccupancy(board, boxes);

      const leftOfBox = board.cellAt(1, 2);
      const reachable = reachableFrom(new Set([leftOfBox]));

      const detector = new ForcedPushMacroDetector(board);
      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, true);
      assert.equal(result.direction, 3); // right
    });
  });

  describe("ForcedPushResult interface", () => {
    it("returns optional fields only when forced is true", () => {
      const { board, boxes } = boardFromRows([
        "OOOOO",
        "OR  O",
        "O X O",
        "O  SO",
        "OOOOO",
      ]);
      const detector = new ForcedPushMacroDetector(board);
      const occupancy = buildOccupancy(board, boxes);

      const notForced = detector.detect(boxes, occupancy, allReachable());
      assert.equal(notForced.forced, false);
      assert.equal(notForced.direction, undefined);
      assert.equal(notForced.boxIndex, undefined);
    });

    it("includes direction and boxIndex when forced is true", () => {
      const { board } = boardFromRows([
        "OOOOOO",
        "OR X O",
        "O  S O",
        "OOOOOO",
      ]);
      const boxCell = board.cellAt(1, 3);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxCell },
      ];
      const occupancy = buildOccupancy(board, boxes);

      const leftOfBox = board.cellAt(1, 2);
      const result = new ForcedPushMacroDetector(board).detect(
        boxes,
        occupancy,
        reachableFrom(new Set([leftOfBox])),
      );

      assert.equal(result.forced, true);
      assert.equal(typeof result.direction, "number");
      assert.equal(typeof result.boxIndex, "number");
    });
  });

  describe("OPPOSITE direction mapping", () => {
    it("push-left requires support from the right side", () => {
      const { board } = boardFromRows([
        "OOOOOO",
        "O XR O",
        "O S  O",
        "OOOOOO",
      ]);

      const boxCell = board.cellAt(1, 2);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxCell },
      ];
      const occupancy = buildOccupancy(board, boxes);

      const rightOfBox = board.cellAt(1, 3);
      const reachable = reachableFrom(new Set([rightOfBox]));

      const detector = new ForcedPushMacroDetector(board);
      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, true);
      assert.equal(result.direction, 2); // left
    });

    it("push-up requires support from below", () => {
      const { board } = boardFromRows([
        "OOOOOO",
        "O  S O",
        "O  X O",
        "O  R O",
        "OOOOOO",
      ]);

      const boxCell = board.cellAt(2, 3);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxCell },
      ];
      const occupancy = buildOccupancy(board, boxes);

      const belowBox = board.cellAt(3, 3);
      const reachable = reachableFrom(new Set([belowBox]));

      const detector = new ForcedPushMacroDetector(board);
      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, true);
      assert.equal(result.direction, 0); // up
    });

    it("push-down requires support from above", () => {
      const { board } = boardFromRows([
        "OOOOOO",
        "O  R O",
        "O  X O",
        "O  S O",
        "OOOOOO",
      ]);

      const boxCell = board.cellAt(2, 3);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxCell },
      ];
      const occupancy = buildOccupancy(board, boxes);

      const aboveBox = board.cellAt(1, 3);
      const reachable = reachableFrom(new Set([aboveBox]));

      const detector = new ForcedPushMacroDetector(board);
      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, true);
      assert.equal(result.direction, 1); // down
    });
  });

  describe("zero boxes", () => {
    it("returns forced=false with zero legal moves", () => {
      // Board requires matching box+goal. We parse it but pass empty box array.
      const { board } = boardFromRows([
        "OOOOO",
        "ORXSO",
        "OOOOO",
      ]);
      const detector = new ForcedPushMacroDetector(board);
      const occupancy = new Uint8Array(board.cellCount);
      const boxes: DenseBox[] = [];

      const result = detector.detect(boxes, occupancy, allReachable());

      assert.equal(result.forced, false);
      assert.equal(detector.stats.checks, 1);
      assert.equal(detector.stats.applications, 0);
    });
  });

  describe("geometry constrains available pushes", () => {
    it("box in a vertical tube has 2 opposite legal pushes (not forced)", () => {
      // Box at (2,2): walls left and right. Up and down are both legal.
      const { board } = boardFromRows([
        "OOOOOO",
        "OR   O",
        "OOX  O",
        "OOS  O",
        "OOOOOO",
      ]);

      const boxCell = board.cellAt(2, 2);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxCell },
      ];
      const occupancy = buildOccupancy(board, boxes);
      const reachable = allReachable();

      const detector = new ForcedPushMacroDetector(board);
      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, false);
    });

    it("box in a horizontal tube has 2 opposite legal pushes (not forced)", () => {
      // 1-wide horizontal tunnel: walls above and below the box.
      const { board } = boardFromRows([
        "OOOOOOO",
        "OOOO  O",
        "OR X  O",
        "OOOOSOO",
      ]);

      const boxCell = board.cellAt(2, 3);
      const boxes: DenseBox[] = [
        { id: "X:0", label: "X", cell: boxCell },
      ];
      const occupancy = buildOccupancy(board, boxes);
      const reachable = allReachable();

      const detector = new ForcedPushMacroDetector(board);
      const result = detector.detect(boxes, occupancy, reachable);

      assert.equal(result.forced, false);
    });
  });
});
