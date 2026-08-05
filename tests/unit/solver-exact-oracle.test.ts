import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  compileSearchBoard,
  type CompiledSearchBoard,
} from "../../src/solver/search/compiled-board.ts";
import {
  assignmentLowerBound,
  minimumManhattanWalkToPotentialPush,
} from "../../src/solver/search/heuristic.ts";
import {
  toDenseBoxes,
  type DenseBox,
} from "../../src/solver/search/model.ts";
import { createExactStateCodec } from "../../src/solver/search/exact-state.ts";
import {
  exactRemainingMoves,
  allReachableStates,
} from "../support/exact-solver-oracle.ts";

function makeBoard(rows: string[]): CompiledSearchBoard {
  return compileSearchBoard(parsePuzzleRows(rows));
}

describe("exact move-cost oracle", () => {
  it("solves a trivial 1-box puzzle", () => {
    const board = makeBoard([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    const boxes = toDenseBoxes(board, parsePuzzleRows([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]).initialBoxes);
    const robot = board.cellAt(1, 1);
    const result = exactRemainingMoves(board, robot, boxes);
    assert.notEqual(result.exactMoves, null);
    assert.ok(result.exactMoves! > 0);
    assert.ok(result.exactPushes! >= 1);
  });

  it("reports null for an unsolvable configuration", () => {
    // Box is stuck in the top-left corner with goal on the opposite side.
    // The parser requires matching box/goal counts, so we include both.
    const board = makeBoard([
      "OOOOO",
      "OX SO",
      "O   O",
      "OR  O",
      "OOOOO",
    ]);
    // Box at (1,1) is in a corner — can't push left (wall) or up (wall).
    // The goal at (1,3) is unreachable from that corner.
    const robot = board.cellAt(3, 1);
    const boxes: DenseBox[] = [
      { id: "X:0", label: "X", cell: board.cellAt(1, 1) },
    ];
    const result = exactRemainingMoves(board, robot, boxes);
    assert.equal(result.exactMoves, null);
  });

  it("returns zero for an already-solved state", () => {
    const board = makeBoard([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    const goalCell = board.goalCellsByLabel.get("X")?.[0];
    assert.notEqual(goalCell, undefined);
    const boxes: DenseBox[] = [{ id: "X:0", label: "X", cell: goalCell! }];
    const robot = board.cellAt(1, 1);
    const result = exactRemainingMoves(board, robot, boxes);
    assert.equal(result.exactMoves, 0);
    assert.equal(result.exactPushes, 0);
  });
});

describe("heuristic admissibility on exhaustive tiny states", () => {
  it("assignment lower bound never exceeds exact remaining moves (2-box generic)", () => {
    const board = makeBoard([
      "OOOOOO",
      "ORXX O",
      "O    O",
      "O SS O",
      "OOOOOO",
    ]);
    let solvableChecked = 0;
    let totalChecked = 0;

    for (let c1 = 0; c1 < board.cellCount; c1++) {
      for (let c2 = c1 + 1; c2 < board.cellCount; c2++) {
        for (let r = 0; r < board.cellCount; r++) {
          if (r === c1 || r === c2) continue;
          totalChecked++;
          const boxes: DenseBox[] = [
            { id: "X:0", label: "X", cell: c1 },
            { id: "X:1", label: "X", cell: c2 },
          ];
          const oracleResult = exactRemainingMoves(board, r, boxes);
          if (oracleResult.exactMoves === null) continue;
          solvableChecked++;

          const pushBound = assignmentLowerBound(board, boxes);
          assert.ok(
            pushBound <= oracleResult.exactMoves,
            `Push bound ${pushBound} > exact ${oracleResult.exactMoves} at r=${r} boxes=[${c1},${c2}]`,
          );
        }
      }
    }

    assert.ok(totalChecked > 100, `Expected broad coverage; got ${totalChecked}`);
    assert.ok(solvableChecked > 30, `Expected solvable coverage; got ${solvableChecked}`);
  });

  it("corrected walk bound never exceeds exact remaining moves (2-box generic)", () => {
    const board = makeBoard([
      "OOOOOO",
      "ORXX O",
      "O    O",
      "O SS O",
      "OOOOOO",
    ]);
    let solvableChecked = 0;

    for (let c1 = 0; c1 < board.cellCount; c1++) {
      for (let c2 = c1 + 1; c2 < board.cellCount; c2++) {
        for (let r = 0; r < board.cellCount; r++) {
          if (r === c1 || r === c2) continue;
          const boxes: DenseBox[] = [
            { id: "X:0", label: "X", cell: c1 },
            { id: "X:1", label: "X", cell: c2 },
          ];
          const oracleResult = exactRemainingMoves(board, r, boxes);
          if (oracleResult.exactMoves === null) continue;
          solvableChecked++;

          const walkBound = minimumManhattanWalkToPotentialPush(board, r, boxes);
          assert.ok(
            walkBound <= oracleResult.exactMoves,
            `Walk bound ${walkBound} > exact ${oracleResult.exactMoves} at r=${r} boxes=[${c1},${c2}]`,
          );
        }
      }
    }

    assert.ok(solvableChecked > 30);
  });

  it("combined proof heuristic (push + walk) never exceeds exact moves", () => {
    const board = makeBoard([
      "OOOOOO",
      "ORXX O",
      "O    O",
      "O SS O",
      "OOOOOO",
    ]);
    let solvableChecked = 0;
    let violations = 0;

    for (let c1 = 0; c1 < board.cellCount; c1++) {
      for (let c2 = c1 + 1; c2 < board.cellCount; c2++) {
        for (let r = 0; r < board.cellCount; r++) {
          if (r === c1 || r === c2) continue;
          const boxes: DenseBox[] = [
            { id: "X:0", label: "X", cell: c1 },
            { id: "X:1", label: "X", cell: c2 },
          ];
          const oracleResult = exactRemainingMoves(board, r, boxes);
          if (oracleResult.exactMoves === null) continue;
          solvableChecked++;

          const pushBound = assignmentLowerBound(board, boxes);
          const walkBound = minimumManhattanWalkToPotentialPush(board, r, boxes);
          const combined = pushBound + walkBound;

          if (combined > oracleResult.exactMoves) {
            violations++;
          }
        }
      }
    }

    assert.equal(
      violations,
      0,
      `Combined heuristic violated admissibility ${violations} times`,
    );
    assert.ok(solvableChecked > 30);
  });
});

describe("heuristic admissibility with typed boxes", () => {
  it("assignment lower bound is admissible with typed labels", () => {
    const board = makeBoard([
      "OOOOOOO",
      "OR A  O",
      "O  B  O",
      "O ab  O",
      "OOOOOOO",
    ]);
    let solvableChecked = 0;

    for (let cA = 0; cA < board.cellCount; cA++) {
      for (let cB = 0; cB < board.cellCount; cB++) {
        if (cA === cB) continue;
        for (let r = 0; r < board.cellCount; r++) {
          if (r === cA || r === cB) continue;
          const boxes: DenseBox[] = [
            { id: "A:0", label: "A", cell: cA },
            { id: "B:0", label: "B", cell: cB },
          ];
          const oracleResult = exactRemainingMoves(board, r, boxes);
          if (oracleResult.exactMoves === null) continue;
          solvableChecked++;

          const pushBound = assignmentLowerBound(board, boxes);
          const walkBound = minimumManhattanWalkToPotentialPush(board, r, boxes);
          const combined = pushBound + walkBound;

          assert.ok(
            combined <= oracleResult.exactMoves,
            `h=${combined} > exact=${oracleResult.exactMoves} at r=${r} A=${cA} B=${cB}`,
          );
        }
      }
    }

    assert.ok(solvableChecked > 10);
  });
});

describe("ExactStateCodec collision-free on oracle states", () => {
  it("produces distinct identities for every reachable state", () => {
    const board = makeBoard([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    const parsed = parsePuzzleRows([
      "OOOOO",
      "OR  O",
      "O XSO",
      "OOOOO",
    ]);
    const initialBoxes = toDenseBoxes(board, parsed.initialBoxes);
    const robot = board.cellAt(1, 1);
    const labels = [...board.goalCellsByLabel.keys()].sort();
    const codec = createExactStateCodec(board.cellCount, labels);
    const states = allReachableStates(board, robot, initialBoxes);

    const identities = new Set<bigint>();
    for (const [, state] of states) {
      const tokens = codec.tokensFromBoxes(state.boxes);
      const identity = codec.packMoveState(state.robot, tokens);
      assert.ok(
        !identities.has(identity),
        `Collision at robot=${state.robot} boxes=${state.boxes.map((b) => `${b.label}@${b.cell}`).join(",")}`,
      );
      identities.add(identity);
    }

    assert.equal(identities.size, states.size);
    assert.ok(states.size > 10, `Expected many reachable states; got ${states.size}`);
  });
});

describe("solved-box-must-move-first regression", () => {
  it("finds a state where the optimal solution begins by moving a box off its goal", () => {
    // Board where box X:0 starts on its goal but must move to let X:1 pass.
    //
    //   OOOOO
    //   OSXSO
    //   O  XO
    //   O R O
    //   OOOOO
    //
    // X:0 is on the left goal (cell at row 1, col 1). X:1 is at (2,3).
    // The only way to solve is to push X:0 off its goal temporarily.
    const board = makeBoard([
      "OOOOO",
      "OSXSO",
      "O  XO",
      "O R O",
      "OOOOO",
    ]);
    const parsed = parsePuzzleRows([
      "OOOOO",
      "OSXSO",
      "O  XO",
      "O R O",
      "OOOOO",
    ]);
    const boxes = toDenseBoxes(board, parsed.initialBoxes);
    const robot = board.cellAt(3, 2);

    // Verify the initial setup: X:0 is on a goal
    const boxOnGoal = boxes.find(
      (b) => board.goalLabelByCell[b.cell] === b.label,
    );

    if (boxOnGoal) {
      // The puzzle is solvable — oracle should find a solution
      const result = exactRemainingMoves(board, robot, boxes);
      assert.notEqual(result.exactMoves, null, "Puzzle should be solvable");
      assert.ok(result.exactMoves! > 0);

      // The corrected walk bound should still be admissible
      const walkBound = minimumManhattanWalkToPotentialPush(board, robot, boxes);
      assert.ok(
        walkBound <= result.exactMoves!,
        `Walk bound ${walkBound} exceeds exact ${result.exactMoves}`,
      );

      const pushBound = assignmentLowerBound(board, boxes);
      const combined = pushBound + walkBound;
      assert.ok(
        combined <= result.exactMoves!,
        `Combined ${combined} exceeds exact ${result.exactMoves}`,
      );
    }
  });
});
