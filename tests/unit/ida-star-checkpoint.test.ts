import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parsePuzzleRows } from "../../src/core/index.ts";
import {
  IDA_STAR_CHECKPOINT_SCHEMA_VERSION,
  createBoardContentKey,
  createExactStateCodecVersion,
  serializeCheckpoint,
  deserializeCheckpoint,
  validateCheckpointCompatibility,
  type IdaStarCheckpoint,
} from "../../src/solver/search/ida-star-checkpoint.ts";

const SIMPLE_ROWS = [
  "OOOOO",
  "OR  O",
  "O X O",
  "O  SO",
  "OOOOO",
];

function makeBoard() {
  return parsePuzzleRows(SIMPLE_ROWS);
}

function makeCheckpoint(overrides?: Partial<IdaStarCheckpoint>): IdaStarCheckpoint {
  const board = makeBoard();
  return {
    schemaVersion: IDA_STAR_CHECKPOINT_SCHEMA_VERSION,
    boardContentKey: createBoardContentKey(board),
    solverVersion: "1.1.0",
    objective: { kind: "moves" },
    exactStateCodecVersion: createExactStateCodecVersion(9, 1),
    currentThreshold: 6,
    lastExhaustedThreshold: 4,
    incumbent: null,
    partitionId: null,
    transpositionMetadata: { policy: "best-g-per-iteration" },
    counters: { expanded: 100, generated: 500, iterations: 2 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Board content key
// ---------------------------------------------------------------------------

describe("createBoardContentKey", () => {
  it("returns a 16-char hex string", () => {
    const key = createBoardContentKey(makeBoard());
    assert.equal(typeof key, "string");
    assert.equal(key.length, 16);
    assert.match(key, /^[0-9a-f]{16}$/);
  });

  it("is deterministic (same board → same key)", () => {
    const a = createBoardContentKey(makeBoard());
    const b = createBoardContentKey(makeBoard());
    assert.equal(a, b);
  });

  it("differs for different boards", () => {
    const a = createBoardContentKey(makeBoard());
    const b = createBoardContentKey(
      parsePuzzleRows([
        "OOOOOO",
        "OR X O",
        "O   SO",
        "OOOOOO",
      ]),
    );
    assert.notEqual(a, b);
  });

  it("differs for different start states on the same geometry", () => {
    const board = makeBoard();
    const moved = {
      robot: board.initialBoxes[0].position,
      boxes: [
        {
          ...board.initialBoxes[0],
          position: { row: 2, column: 3 },
        },
      ],
    };
    assert.notEqual(createBoardContentKey(board), createBoardContentKey(board, moved));
  });
});

// ---------------------------------------------------------------------------
// Exact state codec version
// ---------------------------------------------------------------------------

describe("createExactStateCodecVersion", () => {
  it("returns a non-negative integer", () => {
    const version = createExactStateCodecVersion(20, 2);
    assert.equal(typeof version, "number");
    assert.ok(version >= 0);
    assert.ok(Number.isSafeInteger(version));
  });

  it("is deterministic", () => {
    const a = createExactStateCodecVersion(20, 2);
    const b = createExactStateCodecVersion(20, 2);
    assert.equal(a, b);
  });

  it("differs for different cell counts", () => {
    const a = createExactStateCodecVersion(20, 2);
    const b = createExactStateCodecVersion(30, 2);
    assert.notEqual(a, b);
  });

  it("differs for different label counts", () => {
    const a = createExactStateCodecVersion(20, 1);
    const b = createExactStateCodecVersion(20, 2);
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// Serialization round-trip
// ---------------------------------------------------------------------------

describe("checkpoint serialization", () => {
  it("round-trips a checkpoint with null incumbent", () => {
    const cp = makeCheckpoint();
    const json = serializeCheckpoint(cp);
    const restored = deserializeCheckpoint(json);
    assert.deepEqual(restored, cp);
  });

  it("round-trips a checkpoint with an incumbent", () => {
    const cp = makeCheckpoint({
      incumbent: {
        solution: {
          steps: [{ direction: "down", kind: "push" }],
          moves: 1,
          pushes: 1,
          objective: { kind: "moves" },
          objectiveScore: 1,
          optimality: "unknown",
        },
        cost: 1,
      },
    });
    const json = serializeCheckpoint(cp);
    const restored = deserializeCheckpoint(json);
    assert.deepEqual(restored, cp);
  });

  it("round-trips a checkpoint with a partitionId", () => {
    const cp = makeCheckpoint({ partitionId: "3:1,5" });
    const json = serializeCheckpoint(cp);
    const restored = deserializeCheckpoint(json);
    assert.equal(restored.partitionId, "3:1,5");
  });

  it("produces valid JSON", () => {
    const cp = makeCheckpoint();
    const json = serializeCheckpoint(cp);
    assert.doesNotThrow(() => JSON.parse(json));
  });
});

// ---------------------------------------------------------------------------
// Deserialization validation
// ---------------------------------------------------------------------------

describe("checkpoint deserialization validation", () => {
  it("rejects non-object JSON", () => {
    assert.throws(
      () => deserializeCheckpoint('"hello"'),
      /must be a JSON object/,
    );
  });

  it("rejects wrong schema version", () => {
    const cp = makeCheckpoint();
    const json = serializeCheckpoint(cp).replace(
      `"schemaVersion":${IDA_STAR_CHECKPOINT_SCHEMA_VERSION}`,
      '"schemaVersion":99',
    );
    assert.throws(() => deserializeCheckpoint(json), /schema version/i);
  });

  it("rejects missing boardContentKey", () => {
    const obj = { ...makeCheckpoint() } as Record<string, unknown>;
    delete obj.boardContentKey;
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(obj)),
      /boardContentKey/,
    );
  });

  it("rejects missing counters", () => {
    const obj = { ...makeCheckpoint() } as Record<string, unknown>;
    delete obj.counters;
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(obj)),
      /counters/,
    );
  });

  it("rejects non-number currentThreshold", () => {
    const obj = { ...makeCheckpoint(), currentThreshold: "abc" };
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(obj)),
      /currentThreshold/,
    );
  });

  it("rejects NaN counters.expanded", () => {
    const cp = makeCheckpoint();
    const obj = { ...cp, counters: { ...cp.counters, expanded: null } };
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(obj)),
      /counters\.expanded/,
    );
  });

  it("rejects negative counters.generated", () => {
    const cp = makeCheckpoint();
    const obj = { ...cp, counters: { ...cp.counters, generated: -1 } };
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(obj)),
      /counters\.generated/,
    );
  });

  it("rejects incumbent with missing solution.steps", () => {
    const cp = makeCheckpoint({
      incumbent: {
        cost: 5,
        solution: {
          steps: [{ direction: "down", kind: "push" }],
          moves: 5,
          pushes: 1,
          objective: { kind: "moves" },
          objectiveScore: 5,
          optimality: "unknown",
        },
      },
    });
    const json = JSON.parse(serializeCheckpoint(cp));
    delete json.incumbent.solution.steps;
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(json)),
      /incumbent\.solution/,
    );
  });

  it("rejects incumbent with negative solution.moves", () => {
    const cp = makeCheckpoint({
      incumbent: {
        cost: 5,
        solution: {
          steps: [{ direction: "down", kind: "push" }],
          moves: 5,
          pushes: 1,
          objective: { kind: "moves" },
          objectiveScore: 5,
          optimality: "unknown",
        },
      },
    });
    const json = JSON.parse(serializeCheckpoint(cp));
    json.incumbent.solution.moves = -1;
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(json)),
      /incumbent\.solution/,
    );
  });
});

// ---------------------------------------------------------------------------
// Compatibility validation
// ---------------------------------------------------------------------------

describe("validateCheckpointCompatibility", () => {
  it("accepts a compatible checkpoint", () => {
    const board = makeBoard();
    const cp = makeCheckpoint();
    const result = validateCheckpointCompatibility(
      cp,
      board,
      "1.1.0",
      { kind: "moves" },
      9,
      1,
      { robot: board.initialRobot, boxes: board.initialBoxes },
    );
    assert.deepEqual(result, { compatible: true });
  });

  it("rejects mismatched solver version", () => {
    const board = makeBoard();
    const cp = makeCheckpoint();
    const result = validateCheckpointCompatibility(
      cp,
      board,
      "2.0.0",
      { kind: "moves" },
      9,
      1,
      { robot: board.initialRobot, boxes: board.initialBoxes },
    );
    assert.equal(result.compatible, false);
    if (!result.compatible) {
      assert.match(result.reason, /[Ss]olver version/);
    }
  });

  it("rejects mismatched board content key", () => {
    const differentBoard = parsePuzzleRows([
      "OOOOOO",
      "OR X O",
      "O   SO",
      "OOOOOO",
    ]);
    const cp = makeCheckpoint();
    const result = validateCheckpointCompatibility(
      cp,
      differentBoard,
      "1.1.0",
      { kind: "moves" },
      9,
      1,
      { robot: differentBoard.initialRobot, boxes: differentBoard.initialBoxes },
    );
    assert.equal(result.compatible, false);
    if (!result.compatible) {
      assert.match(result.reason, /[Bb]oard content key/);
    }
  });

  it("rejects mismatched codec version", () => {
    const board = makeBoard();
    const cp = makeCheckpoint();
    const result = validateCheckpointCompatibility(
      cp,
      board,
      "1.1.0",
      { kind: "moves" },
      20,
      1,
      { robot: board.initialRobot, boxes: board.initialBoxes },
    );
    assert.equal(result.compatible, false);
    if (!result.compatible) {
      assert.match(result.reason, /codec version/i);
    }
  });

  it("rejects a different start state on identical board geometry", () => {
    const board = makeBoard();
    const cp = makeCheckpoint();
    const result = validateCheckpointCompatibility(
      cp,
      board,
      "1.1.0",
      { kind: "moves" },
      9,
      1,
      {
        robot: board.initialBoxes[0].position,
        boxes: [
          {
            ...board.initialBoxes[0],
            position: { row: 2, column: 3 },
          },
        ],
      },
    );
    assert.equal(result.compatible, false);
  });

  it("rejects mismatched schema version", () => {
    const board = makeBoard();
    const cp = {
      ...makeCheckpoint(),
      schemaVersion: 99 as typeof IDA_STAR_CHECKPOINT_SCHEMA_VERSION,
    };
    const result = validateCheckpointCompatibility(
      cp,
      board,
      "1.1.0",
      { kind: "moves" },
      9,
      1,
      { robot: board.initialRobot, boxes: board.initialBoxes },
    );
    assert.equal(result.compatible, false);
    if (!result.compatible) {
      assert.match(result.reason, /[Ss]chema version/);
    }
  });
});
