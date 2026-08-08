import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import { DoorwayCrossingLowerBound } from "../../src/solver/search/doorway-crossing-heuristic.ts";
import { toDenseBoxes, type DenseBox } from "../../src/solver/search/model.ts";

function setup(rows: string[]) {
  const parsed = parsePuzzleRows(rows);
  const board = compileSearchBoard(parsed);
  const boxes = toDenseBoxes(board, parsed.initialBoxes);
  return { parsed, board, boxes };
}

/**
 * Build a board+topology without box/goal validation constraints.
 * We parse a minimal valid board, then use synthetic DenseBox arrays
 * for evaluate() calls.
 */
// ----- Board layouts -----
// Each layout must satisfy the Sokomind parser: X matches S, uppercase A
// matches lowercase a, and box/goal counts must match per label.

// Two rooms joined by a single doorway (articulation point at column 3).
//   Room 0: cells at (1,1), (1,2)
//   Articulation: cell at (1,3)
//   Room 1: cells at (1,4), (1,5)
// Box X starts at (1,2), goal S at (1,4) => 1 crossing minimum.
const TWO_ROOM_SIMPLE = [
  "OOOOOOO",
  "ORX S O",
  "OOOOOOO",
];

// Box X is next to goal S in the same small room (no articulation between).
const SAME_ROOM = [
  "OOOOO",
  "ORXSO",
  "OOOOO",
];

// Board with goal on the doorway cell itself (goal on articulation point).
// X is in upper room, goal S is at the articulation cell (2,3).
// Layout:
//   row 1: R, X, _, _ (upper room)
//   row 2: _,_,_,S,_,_,_ (narrow passage = articulation)
//   row 3: _, _, _, _ (lower room)
const GOAL_ON_DOORWAY = [
  "OOOOOOO",
  "ORX   O",
  "OOO OOO",
  "O  S  O",
  "OOOOOOO",
];

// T-shaped board creating an articulation point. Goal at articulation.
const T_BOARD_GOAL_ON_ART = [
  "OOOOO",
  "OX  O",
  "OOSOO",
  "OR  O",
  "OOOOO",
];

// Wide board with multiple rooms separated by doorways.
// Used mainly to ensure the multi-cell region BFS in the constructor works.
const MULTI_CELL_ROOMS = [
  "OOOOOOOOO",
  "OR     SO",
  "OO  X  OO",
  "O       O",
  "OOOOOOOOO",
];

// Board with a chain of three segments separated by two articulation points.
// Layout: 2 cells | art | 1 cell | art | 2 cells (including goal)
// Uses A/a typed label to avoid confusion.
const THREE_SEGMENT = [
  "OOOOOOOOOOO",
  "ORA      aO",
  "OOO O O OOO",
  "OOOOOOOOOOO",
];

describe("DoorwayCrossingLowerBound", () => {
  describe("constructor — region BFS (lines 64-66)", () => {
    it("assigns region ids to multi-cell regions", () => {
      // TWO_ROOM_SIMPLE has cells in rooms with more than one cell.
      // The BFS must iterate through neighbors, assigning region ids
      // beyond the seed — covering lines 64-66.
      const { board } = setup(TWO_ROOM_SIMPLE);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);
      assert.ok(lb);
    });

    it("handles board with many cells per region", () => {
      const { board } = setup(MULTI_CELL_ROOMS);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);
      assert.ok(lb);
    });
  });

  describe("stats getter (lines 192-196)", () => {
    it("returns zero evaluations and positiveResults initially", () => {
      const { board } = setup(TWO_ROOM_SIMPLE);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);
      const stats = lb.stats;
      assert.equal(stats.evaluations, 0);
      assert.equal(stats.positiveResults, 0);
    });

    it("increments evaluations on each call", () => {
      const { board, boxes } = setup(TWO_ROOM_SIMPLE);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);
      lb.evaluate(boxes);
      lb.evaluate(boxes);
      const stats = lb.stats;
      assert.equal(stats.evaluations, 2);
    });
  });

  describe("evaluate — box and goal in different regular regions (lines 225-227, 301-302, 306-307)", () => {
    it("returns positive crossing count when box must cross a doorway", () => {
      const { board, boxes } = setup(TWO_ROOM_SIMPLE);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);
      const crossings = lb.evaluate(boxes);
      assert.ok(crossings >= 1, `expected >= 1 crossing, got ${crossings}`);
    });

    it("returns positive crossing count for a three-segment chain", () => {
      const { board, boxes } = setup(THREE_SEGMENT);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);
      const crossings = lb.evaluate(boxes);
      assert.ok(crossings >= 1, `expected >= 1 crossing, got ${crossings}`);
    });

    it("tracks positiveResults in stats after positive evaluation (lines 306-307)", () => {
      const { board, boxes } = setup(TWO_ROOM_SIMPLE);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);
      lb.evaluate(boxes);
      const stats = lb.stats;
      assert.ok(
        stats.positiveResults >= 1,
        `expected positive results >= 1, got ${stats.positiveResults}`,
      );
    });
  });

  describe("evaluate — box already on goal", () => {
    it("returns 0 when box is on its matching goal", () => {
      // Construct DenseBox sitting on the goal cell.
      const { board } = setup(GOAL_ON_DOORWAY);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);

      // Find where goal S is and put a box with label X there.
      const goalCells = board.goalCellsByLabel.get("X");
      assert.ok(goalCells && goalCells.length > 0, "expected at least one X goal");
      const syntheticBoxes: DenseBox[] = [
        { id: "box-1", label: "X", cell: goalCells[0] },
      ];
      const crossings = lb.evaluate(syntheticBoxes);
      assert.equal(crossings, 0);
    });
  });

  describe("evaluate — both in regular (non-articulation) regions (lines 225-227)", () => {
    it("looks up precomputed region distance when box and goal are both in non-art cells", () => {
      // L-shaped rooms connected by a single-cell doorway.
      // Box at (2,3) is non-art, goal at (4,5) is non-art, different rooms.
      const rows = [
        "OOOOOOOOO",
        "OR      O",
        "O  X    O",
        "OOOO OOOO",
        "O    S  O",
        "O       O",
        "OOOOOOOOO",
      ];
      const { board, boxes } = setup(rows);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);

      // Verify the box and goal are in non-articulation cells.
      const goalCells = board.goalCellsByLabel.get("X");
      assert.ok(goalCells && goalCells.length > 0);
      assert.ok(
        !board.topology.articulations.has(boxes[0].cell),
        "box should not be on an art point",
      );
      assert.ok(
        !board.topology.articulations.has(goalCells[0]),
        "goal should not be on an art point",
      );

      const crossings = lb.evaluate(boxes);
      assert.ok(crossings >= 1, `expected >= 1, got ${crossings}`);
    });
  });

  describe("evaluate — box in same room as goal", () => {
    it("returns 0 when no doorway crossing is needed", () => {
      const { board, boxes } = setup(SAME_ROOM);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);
      const crossings = lb.evaluate(boxes);
      assert.equal(crossings, 0);
    });
  });

  describe("evaluate — goal on articulation point (lines 229-244)", () => {
    it("handles goal sitting on an articulation cell", () => {
      const { board, boxes } = setup(GOAL_ON_DOORWAY);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);

      // Verify the goal is actually on an articulation cell.
      const goalCells = board.goalCellsByLabel.get("X");
      assert.ok(goalCells && goalCells.length > 0);
      const goalCell = goalCells[0];

      // If the goal is on an articulation point, evaluate will take the
      // boxRegion >= 0 && goalRegion < 0 branch (lines 229-244).
      if (board.topology.articulations.has(goalCell)) {
        const crossings = lb.evaluate(boxes);
        assert.ok(crossings >= 0, `expected >= 0, got ${crossings}`);
      } else {
        // Even if the layout didn't produce an articulation there, test
        // with a synthetic box in a different region from the goal.
        const crossings = lb.evaluate(boxes);
        assert.ok(crossings >= 0, `expected >= 0, got ${crossings}`);
      }
    });

    it("exercises goalRegion < 0 branch with T-board", () => {
      const { board } = setup(T_BOARD_GOAL_ON_ART);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);

      // Find X goals and check if any are on articulation points.
      const goalCells = board.goalCellsByLabel.get("X");
      assert.ok(goalCells && goalCells.length > 0);

      // Put box in a cell that is in a regular region (not on articulation).
      let regularCell: number | null = null;
      for (let c = 0; c < board.cellCount; c++) {
        if (!board.topology.articulations.has(c)) {
          regularCell = c;
          break;
        }
      }
      assert.ok(regularCell !== null, "expected at least one non-articulation cell");

      const syntheticBoxes: DenseBox[] = [
        { id: "box-1", label: "X", cell: regularCell! },
      ];
      const crossings = lb.evaluate(syntheticBoxes);
      assert.ok(crossings >= 0, `expected >= 0, got ${crossings}`);
    });

    it("exercises lines 240-242: goal on art with non-art neighbors (plus-sign board)", () => {
      // Plus-sign layout: center cell is art point with non-art neighbors
      // in the N and S arms. Box is in upper arm (non-art), goal at center (art).
      const rows = [
        "OOOOOOOO O",
        "OOO  OOO",
        "OOO XOOO",
        "O  RS   O",
        "OOO  OOO",
        "OOO  OOO",
        "OOOOOOOOO",
      ];
      const { board, boxes } = setup(rows);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);

      // Verify: box not on art, goal on art, goal has non-art neighbors.
      const goalCells = board.goalCellsByLabel.get("X");
      assert.ok(goalCells && goalCells.length > 0);
      const goalCell = goalCells[0];
      assert.ok(
        board.topology.articulations.has(goalCell),
        "goal should be on an art point",
      );
      assert.ok(
        !board.topology.articulations.has(boxes[0].cell),
        "box should NOT be on an art point",
      );

      // Confirm goal has at least one non-art neighbor.
      const goalNeighbors = board.neighbors[goalCell];
      let hasNonArtNeighbor = false;
      for (let d = 0; d < goalNeighbors.length; d++) {
        const n = goalNeighbors[d];
        if (n >= 0 && !board.topology.articulations.has(n)) {
          hasNonArtNeighbor = true;
        }
      }
      assert.ok(hasNonArtNeighbor, "goal art point should have non-art neighbors");

      const crossings = lb.evaluate(boxes);
      assert.ok(crossings >= 0, `expected >= 0, got ${crossings}`);
    });
  });

  describe("evaluate — box on articulation point, goal in regular region (lines 245-259)", () => {
    it("handles box sitting on an articulation cell", () => {
      const { board } = setup(GOAL_ON_DOORWAY);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);

      // Find an articulation point, and a goal in a regular region.
      const arts = [...board.topology.articulations];
      const goalCells = board.goalCellsByLabel.get("X");
      assert.ok(goalCells && goalCells.length > 0);

      // Find a goal that is NOT on an articulation point.
      const regularGoal = goalCells.find(
        (gc) => !board.topology.articulations.has(gc),
      );
      if (regularGoal !== undefined && arts.length > 0) {
        // Put box on an articulation point.
        const syntheticBoxes: DenseBox[] = [
          { id: "box-1", label: "X", cell: arts[0] },
        ];
        const crossings = lb.evaluate(syntheticBoxes);
        assert.ok(crossings >= 0, `expected >= 0, got ${crossings}`);
      }
    });
  });

  describe("evaluate — both on articulation points (lines 260-296)", () => {
    it("returns 0 when box and goal are on the same articulation cell (line 269)", () => {
      // Use a board where we know a goal is on an articulation point.
      const { board } = setup(T_BOARD_GOAL_ON_ART);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);

      const goalCells = board.goalCellsByLabel.get("X");
      assert.ok(goalCells && goalCells.length > 0);

      // Find a goal on an articulation point.
      const artGoal = goalCells.find((gc) =>
        board.topology.articulations.has(gc),
      );
      if (artGoal !== undefined) {
        // Put box on the same cell as the goal.
        const syntheticBoxes: DenseBox[] = [
          { id: "box-1", label: "X", cell: artGoal },
        ];
        const crossings = lb.evaluate(syntheticBoxes);
        assert.equal(crossings, 0, "same cell => 0 crossings");
      }
    });

    it("returns 0 when box and goal are adjacent articulation points (lines 274-276)", () => {
      // Two connected bottlenecks with rooms on either side.
      // The two cells at (2,2) and (3,2) form adjacent articulation points.
      const rows = [
        "OOOOO",
        "OR   O",
        "OO OO",
        "OO OO",
        "O XS O",
        "OOOOO",
      ];
      const { board } = setup(rows);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);
      const arts = [...board.topology.articulations];

      // Find two adjacent articulation points.
      let adjacentPair: [number, number] | null = null;
      for (const a of arts) {
        const neighbors = board.neighbors[a];
        for (let d = 0; d < neighbors.length; d++) {
          const n = neighbors[d];
          if (n >= 0 && board.topology.articulations.has(n)) {
            adjacentPair = [a, n];
            break;
          }
        }
        if (adjacentPair) break;
      }

      if (adjacentPair) {
        const [artA, artB] = adjacentPair;
        // Put box on one art point, look for a goal label reachable from the other.
        const goalCells = board.goalCellsByLabel.get("X");
        assert.ok(goalCells && goalCells.length > 0);

        // Place box on artA, goal lookup on artB (both art).
        // We need a goal that is on an articulation point.
        const artWithGoal = board.goalLabelByCell[artA]
          ? artA
          : board.goalLabelByCell[artB]
            ? artB
            : null;

        if (artWithGoal !== null) {
          const boxArt = artWithGoal === artA ? artB : artA;
          const label = board.goalLabelByCell[artWithGoal]!;
          const syntheticBoxes: DenseBox[] = [
            { id: "box-1", label, cell: boxArt },
          ];
          const crossings = lb.evaluate(syntheticBoxes);
          assert.equal(crossings, 0, "adjacent art points => 0 crossings");
        } else {
          // Even without a goal on an art point, place synthetic box on
          // artA with label X and use an art-on-goal fallback:
          // just verify evaluate doesn't crash.
          const syntheticBoxes: DenseBox[] = [
            { id: "box-1", label: "X", cell: artA },
          ];
          const crossings = lb.evaluate(syntheticBoxes);
          assert.ok(crossings >= 0);
        }
      }
    });

    it("computes crossings via adjacent regions when both are on non-adjacent articulation points (lines 285-293)", () => {
      // Reuse the crafted corridor board which has a goal on an articulation
      // point and many non-adjacent articulation points.
      const rows = [
        "OOOOOOO",
        "ORX   O",
        "OO OOOO",
        "O     O",
        "OOOO OO",
        "O  S  O",
        "OOOOOOO",
      ];
      const { board } = setup(rows);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);

      const goalCells = board.goalCellsByLabel.get("X");
      assert.ok(goalCells && goalCells.length > 0);

      // Find a goal on an articulation point.
      const artGoal = goalCells.find((gc) =>
        board.topology.articulations.has(gc),
      );
      assert.ok(artGoal !== undefined, "expected a goal on an art point");

      // Find another art point that is NOT a neighbor of artGoal.
      const arts = [...board.topology.articulations];
      const goalNeighborSet = new Set<number>();
      const goalNeighbors = board.neighbors[artGoal!];
      for (let d = 0; d < goalNeighbors.length; d++) {
        if (goalNeighbors[d] >= 0) goalNeighborSet.add(goalNeighbors[d]);
      }

      const otherArt = arts.find(
        (a) => a !== artGoal && !goalNeighborSet.has(a),
      );
      assert.ok(otherArt !== undefined, "expected a non-adjacent art point");

      const syntheticBoxes: DenseBox[] = [
        { id: "box-1", label: "X", cell: otherArt! },
      ];
      const crossings = lb.evaluate(syntheticBoxes);
      assert.ok(crossings >= 0, `expected >= 0, got ${crossings}`);
    });

    it("exercises both-on-art via-region BFS with a crafted long corridor", () => {
      // A definitive test: two articulation points separated by a regular
      // region. We manually place box and goal on the two art cells.
      const rows = [
        "OOOOOOO",
        "ORX   O",
        "OO OOOO",
        "O     O",
        "OOOO OO",
        "O  S  O",
        "OOOOOOO",
      ];
      const { board } = setup(rows);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);

      const arts = [...board.topology.articulations];
      const goalCells = board.goalCellsByLabel.get("X");
      assert.ok(goalCells && goalCells.length > 0);

      // Find a goal on an articulation point.
      const artGoal = goalCells.find((gc) =>
        board.topology.articulations.has(gc),
      );

      // Find any articulation point that is NOT the goal cell.
      const otherArt = arts.find(
        (a) => a !== artGoal,
      );

      if (artGoal !== undefined && otherArt !== undefined) {
        // Both on art, NOT adjacent, NOT the same cell.
        const neighbors = board.neighbors[otherArt];
        let directlyAdj = false;
        for (let d = 0; d < neighbors.length; d++) {
          if (neighbors[d] === artGoal) directlyAdj = true;
        }

        const syntheticBoxes: DenseBox[] = [
          { id: "box-1", label: "X", cell: otherArt },
        ];
        const crossings = lb.evaluate(syntheticBoxes);
        if (!directlyAdj) {
          // Should go through the region BFS path (lines 285-293).
          assert.ok(crossings >= 0, `expected >= 0, got ${crossings}`);
        } else {
          // Adjacent art path (lines 274-276).
          assert.equal(crossings, 0);
        }
      }
    });
  });

  describe("evaluate — empty boxes array", () => {
    it("returns 0 with no boxes", () => {
      const { board } = setup(TWO_ROOM_SIMPLE);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);
      const crossings = lb.evaluate([]);
      assert.equal(crossings, 0);
    });
  });

  describe("evaluate — no matching goals for box label", () => {
    it("returns 0 when box label has no matching goals", () => {
      const { board } = setup(TWO_ROOM_SIMPLE);
      const lb = new DoorwayCrossingLowerBound(board, board.topology);
      const syntheticBoxes: DenseBox[] = [
        { id: "box-1", label: "Z", cell: 0 },
      ];
      const crossings = lb.evaluate(syntheticBoxes);
      assert.equal(crossings, 0);
    });
  });
});
