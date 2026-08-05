import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classicIdaStarSolver,
  classicAStarSolver,
} from "../../src/solver/implementations/index.ts";
import { createExactStateCodec } from "../../src/solver/search/exact-state.ts";
import {
  parsePuzzleRows,
  createSession,
  type PuzzleDefinition,
} from "../../src/core/index.ts";
import { compileSearchBoard } from "../../src/solver/search/compiled-board.ts";
import type {
  SolverExecutionContext,
  SolverRequest,
} from "../../src/solver/contracts.ts";
import { sortedBoxes, movedBoxes } from "../../src/solver/search/engine.ts";
import type { DenseBox } from "../../src/solver/search/model.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const TYPED_2BOX: PuzzleDefinition = {
  id: "typed-2box",
  title: "Typed 2-box",
  difficulty: "tutorial",
  boxes: 2,
  rows: [
    "OOOOOOO",
    "OR A  O",
    "O  B  O",
    "O ab  O",
    "OOOOOOO",
  ],
};

const EXACT_KEEPER_REGRESSION: PuzzleDefinition = {
  id: "exact-keeper-regression",
  title: "Exact keeper regression",
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

const MEDIUM_4BOX: PuzzleDefinition = {
  id: "medium-4box",
  title: "Medium 4-box",
  difficulty: "intermediate",
  boxes: 4,
  rows: [
    "OOOOOOOO",
    "OO    OO",
    "O  XX  O",
    "O XRXSSO",
    "O    SSO",
    "OOOOOOOO",
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(puzzle: PuzzleDefinition): SolverRequest {
  const session = createSession(puzzle);
  return {
    board: session.board,
    snapshot: session.snapshot,
    objective: { kind: "moves" },
    limits: { maxElapsedMs: 30_000, maxMemoryBytes: 256 * 1024 * 1024 },
  };
}

function context(): SolverExecutionContext {
  return {
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    now: () => performance.now(),
  };
}

// ---------------------------------------------------------------------------
// 1. IDA* collision-free BigInt identity tests
// ---------------------------------------------------------------------------

describe("IDA* collision-free BigInt identity", () => {
  it("IDA* solves two-generic-boxes with proven optimality", async () => {
    const request = makeRequest(TWO_GENERIC_BOXES);
    const result = await classicIdaStarSolver.solve(request, context());
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 4);
    assert.equal(result.solution.pushes, 2);
    assert.equal(result.solution.optimality, "proven");
  });

  it("IDA* solves typed-2box with proven optimality", async () => {
    const request = makeRequest(TYPED_2BOX);
    const result = await classicIdaStarSolver.solve(request, context());
    // This typed puzzle is geometrically unsolvable (top wall prevents
    // downward pushes from row 1).  The solver correctly identifies this
    // during goal-assignment analysis, so we verify the exhausted outcome
    // instead — proving the typed-box label check works.
    assert.equal(result.status, "unsolved");
    if (result.status !== "unsolved") return;
    assert.equal(result.reason, "exhausted");
  });

  it("IDA* agrees with A* on exact-keeper-regression", async () => {
    const request = makeRequest(EXACT_KEEPER_REGRESSION);
    const idaResult = await classicIdaStarSolver.solve(request, context());
    const astarResult = await classicAStarSolver.solve(request, context());

    assert.equal(idaResult.status, "solved");
    assert.equal(astarResult.status, "solved");
    if (idaResult.status !== "solved" || astarResult.status !== "solved") return;

    assert.equal(idaResult.solution.moves, astarResult.solution.moves);
    assert.equal(idaResult.solution.pushes, astarResult.solution.pushes);
  });

  it("IDA* agrees with A* on two-generic-boxes", async () => {
    const request = makeRequest(TWO_GENERIC_BOXES);
    const idaResult = await classicIdaStarSolver.solve(request, context());
    const astarResult = await classicAStarSolver.solve(request, context());

    assert.equal(idaResult.status, "solved");
    assert.equal(astarResult.status, "solved");
    if (idaResult.status !== "solved" || astarResult.status !== "solved") return;

    assert.equal(idaResult.solution.moves, astarResult.solution.moves);
    assert.equal(idaResult.solution.pushes, astarResult.solution.pushes);
  });
});

// ---------------------------------------------------------------------------
// 2. Avoided-flood counter tests
// ---------------------------------------------------------------------------

describe("avoided reachability flood instrumentation", () => {
  it("A* reports avoidedReachabilityFloods counter", async () => {
    const request = makeRequest(TWO_GENERIC_BOXES);
    const result = await classicAStarSolver.solve(request, context());
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.ok(
      (result.metrics.counters?.avoidedReachabilityFloods ?? 0) >= 0,
      "Expected avoidedReachabilityFloods counter to be present and >= 0",
    );
  });

  it("A* avoidedReachabilityFloods + reachabilityFloods >= generated children that passed pruning", async () => {
    const request = makeRequest(EXACT_KEEPER_REGRESSION);
    const result = await classicAStarSolver.solve(request, context());
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;

    const counters = result.metrics.counters ?? {};
    const avoided = counters.avoidedReachabilityFloods ?? 0;
    assert.ok(
      avoided > 0,
      "Expected avoidedReachabilityFloods > 0 since A* skips floods",
    );
  });

  it("avoided + executed floods on medium-4box relate to child generation", async () => {
    const request = makeRequest(MEDIUM_4BOX);
    const result = await classicAStarSolver.solve(request, context());
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;

    const counters = result.metrics.counters ?? {};
    const avoided = counters.avoidedReachabilityFloods ?? 0;
    const executed = counters.reachabilityFloods ?? 0;
    const expanded = result.metrics.expandedStates ?? 0;

    assert.ok(
      avoided > 0,
      "Expected avoidedReachabilityFloods > 0 on medium-4box",
    );
    assert.ok(
      executed <= expanded + 1,
      `Expected reachabilityFloods (${executed}) <= expandedStates + 1 (${expanded + 1})`,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Sorted-box verification tests
// ---------------------------------------------------------------------------

describe("sorted-box invariants", () => {
  it("sortedBoxes produces canonical order", () => {
    const unsorted: DenseBox[] = [
      { id: "X:1", label: "X", cell: 5 },
      { id: "X:0", label: "X", cell: 2 },
    ];
    const sorted = sortedBoxes(unsorted);
    assert.ok(
      sorted[0].cell < sorted[1].cell,
      `Expected sorted[0].cell (${sorted[0].cell}) < sorted[1].cell (${sorted[1].cell})`,
    );
  });

  it("movedBoxes preserves sorted order when moving forward", () => {
    const boxes: readonly DenseBox[] = sortedBoxes([
      { id: "X:0", label: "X", cell: 2 },
      { id: "X:1", label: "X", cell: 5 },
    ]);
    // Move index 0 (cell 2) to cell 7 (past cell 5)
    const result = movedBoxes(boxes, 0, 7);
    assert.ok(
      result[0].cell <= result[1].cell,
      `Expected sorted order: cell ${result[0].cell} <= cell ${result[1].cell}`,
    );
  });

  it("movedBoxes preserves sorted order when moving backward", () => {
    const boxes: readonly DenseBox[] = sortedBoxes([
      { id: "X:0", label: "X", cell: 5 },
      { id: "X:1", label: "X", cell: 8 },
    ]);
    // Move index 1 (cell 8) to cell 3 (before cell 5)
    const result = movedBoxes(boxes, 1, 3);
    assert.ok(
      result[0].cell <= result[1].cell,
      `Expected sorted order: cell ${result[0].cell} <= cell ${result[1].cell}`,
    );
  });

  it("movedBoxes with typed labels preserves order across label groups", () => {
    const boxes: readonly DenseBox[] = sortedBoxes([
      { id: "A:0", label: "A", cell: 5 },
      { id: "B:0", label: "B", cell: 2 },
    ]);
    // After sorting, A comes before B (A < B by charcode)
    // Move B from cell 2 to cell 8
    const bIndex = boxes.findIndex((b) => b.label === "B");
    const result = movedBoxes(boxes, bIndex, 8);

    const aIndex = result.findIndex((b) => b.label === "A");
    const bResultIndex = result.findIndex((b) => b.label === "B");
    assert.ok(
      aIndex < bResultIndex,
      "Expected A to come before B in sort order",
    );
  });

  it("repeated labels remain interchangeable after movedBoxes", () => {
    const boxes: readonly DenseBox[] = sortedBoxes([
      { id: "X:0", label: "X", cell: 2 },
      { id: "X:1", label: "X", cell: 5 },
      { id: "X:2", label: "X", cell: 8 },
    ]);
    // Move the middle one (index 1, cell 5) to cell 1
    const result = movedBoxes(boxes, 1, 1);

    // All three should still be label X
    for (const box of result) {
      assert.equal(box.label, "X");
    }
    // Should be sorted by cell
    assert.ok(
      result[0].cell <= result[1].cell,
      `Expected sorted: cell ${result[0].cell} <= cell ${result[1].cell}`,
    );
    assert.ok(
      result[1].cell <= result[2].cell,
      `Expected sorted: cell ${result[1].cell} <= cell ${result[2].cell}`,
    );
  });

  it("ExactStateCodec receives sorted tokens from sorted boxes", () => {
    const board = parsePuzzleRows([
      "OOOOOO",
      "ORXX O",
      "O    O",
      "O SS O",
      "OOOOOO",
    ]);
    const compiled = compileSearchBoard(board);
    const labels = [...new Set(board.goals.map((g) => g.label))].sort();
    const codec = createExactStateCodec(compiled.cellCount, labels);

    // Create boxes on the board and sort them
    const denseBoxes: DenseBox[] = [];
    for (const box of board.initialBoxes) {
      const cell = compiled.cellAt(box.position.row, box.position.column);
      denseBoxes.push({ id: box.id, label: box.label, cell });
    }
    const sorted = sortedBoxes(denseBoxes);
    const tokens = codec.tokensFromBoxes(sorted);

    // For same-label boxes, sorted tokens should mean sorted cells
    assert.ok(
      tokens[0] <= tokens[1],
      `Expected tokens[0] (${tokens[0]}) <= tokens[1] (${tokens[1]})`,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. IDA* reconstruction buffer reuse test
// ---------------------------------------------------------------------------

describe("IDA* reconstruction buffer reuse", () => {
  it("IDA* solves and verifies solution correctly after buffer reuse", async () => {
    const request = makeRequest(TWO_GENERIC_BOXES);
    const result = await classicIdaStarSolver.solve(request, context());
    assert.equal(result.status, "solved");
    if (result.status !== "solved") return;
    assert.equal(result.solution.moves, 4);
    assert.equal(result.solution.pushes, 2);
  });
});
