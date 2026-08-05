import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionLogError,
  MAX_SHARED_ACTIONS,
  createSession,
  decodeActionCode,
  decodeActionLog,
  encodeActionLog,
  encodeDirection,
  isActionCode,
  isActionLog,
  isShareableActionLog,
  move,
  replayActionLog,
  stepSnapshot,
  undo,
  type PuzzleDefinition,
} from "../../src/core/index.ts";

function puzzle(
  rows: readonly string[],
  boxes = 1,
): PuzzleDefinition {
  return {
    id: "action-log-test",
    title: "Action Log Test",
    difficulty: "tutorial",
    boxes,
    rows,
  };
}

test("encodes and strictly decodes compact U/D/L/R actions", () => {
  assert.equal(encodeDirection("left"), "L");
  assert.equal(decodeActionCode("D"), "down");
  assert.equal(
    encodeActionLog(["up", "down", "left", "right"]),
    "UDLR",
  );
  assert.deepEqual(decodeActionLog("RDLU"), [
    "right",
    "down",
    "left",
    "up",
  ]);
  assert.equal(isActionCode("R"), true);
  assert.equal(isActionCode("X"), false);
  assert.equal(isActionLog(""), true);
  assert.equal(isActionLog("UDLR"), true);
  assert.equal(isActionLog("u"), false);
  assert.ok(Object.isFrozen(decodeActionLog("R")));
});

test("shared action logs are limited to the outbound sharing budget", () => {
  assert.equal(MAX_SHARED_ACTIONS, 2_000);
  assert.equal(isShareableActionLog("R".repeat(MAX_SHARED_ACTIONS)), true);
  assert.equal(isShareableActionLog("R".repeat(MAX_SHARED_ACTIONS + 1)), false);
  assert.equal(isShareableActionLog("R?"), false);
});

test("reports the exact index and symbol of a corrupt action log", () => {
  assert.throws(
    () => decodeActionLog("RRXU"),
    (error) => {
      assert.ok(error instanceof ActionLogError);
      assert.equal(error.code, "invalid-action-code");
      assert.equal(error.index, 2);
      assert.equal(error.action, "X");
      return true;
    },
  );

  assert.throws(
    () => decodeActionLog({ actions: "R" }),
    (error) => {
      assert.ok(error instanceof ActionLogError);
      assert.equal(error.code, "invalid-log-type");
      assert.equal(error.index, undefined);
      return true;
    },
  );
});

test("replays only legal logs through the canonical game transition", () => {
  const definition = puzzle([
    "OOOOOOO",
    "OR X SO",
    "OOOOOOO",
  ]);
  const replayed = replayActionLog(definition, "RRR");

  assert.equal(replayed.actionLog, "RRR");
  assert.equal(replayed.moves, 3);
  assert.equal(replayed.pushes, 2);
  assert.equal(replayed.solved, true);
  assert.deepEqual(replayed.snapshot.robot, { row: 1, column: 4 });
  assert.deepEqual(replayed.snapshot.boxes[0]?.position, {
    row: 1,
    column: 5,
  });
  assert.equal(replayed.history.length, 3);
});

test("rejects a syntactically valid replay as soon as an action is blocked", () => {
  const definition = puzzle([
    "OOOOO",
    "ORXSO",
    "OOOOO",
  ]);

  assert.throws(
    () => replayActionLog(definition, "U"),
    (error) => {
      assert.ok(error instanceof ActionLogError);
      assert.equal(error.code, "blocked-action");
      assert.equal(error.index, 0);
      assert.equal(error.action, "U");
      return true;
    },
  );
});

test("a solved session rejects an otherwise legal walk and replay trailing walk", () => {
  const definition = puzzle([
    "OOOOOO",
    "ORXS O",
    "O    O",
    "OOOOOO",
  ]);
  const solved = move(createSession(definition), "right");

  assert.equal(solved.solved, true);
  assert.equal(solved.actionLog, "R");
  assert.equal(move(solved, "down"), solved);

  assert.throws(
    () => replayActionLog(definition, "RD"),
    (error) => {
      assert.ok(error instanceof ActionLogError);
      assert.equal(error.code, "blocked-action");
      assert.equal(error.index, 1);
      assert.equal(error.action, "D");
      return true;
    },
  );
});

test("a solved session rejects pushing a box off its goal and replay trailing push", () => {
  const definition = puzzle(["OOOOOO", "ORXS O", "OOOOOO"]);
  const solved = move(createSession(definition), "right");

  assert.equal(solved.solved, true);
  assert.equal(solved.actionLog, "R");
  assert.equal(move(solved, "right"), solved);

  assert.throws(
    () => replayActionLog(definition, "RR"),
    (error) => {
      assert.ok(error instanceof ActionLogError);
      assert.equal(error.code, "blocked-action");
      assert.equal(error.index, 1);
      assert.equal(error.action, "R");
      return true;
    },
  );
});

test("snapshot transitions are exact, immutable, and history-free", () => {
  const session = createSession(
    puzzle([
      "OOOOO",
      "ORXSO",
      "OOOOO",
    ]),
  );

  const blocked = stepSnapshot(session.board, session.snapshot, "up");
  assert.equal(blocked.moved, false);
  assert.equal(blocked.pushed, false);
  assert.equal(blocked.snapshot, session.snapshot);

  const pushed = stepSnapshot(session.board, session.snapshot, "right");
  assert.equal(pushed.moved, true);
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.snapshot.moves, 1);
  assert.equal(pushed.snapshot.pushes, 1);
  assert.equal(pushed.snapshot.solved, true);
  assert.deepEqual(session.snapshot.robot, { row: 1, column: 1 });
  assert.ok(Object.isFrozen(pushed));
  assert.ok(Object.isFrozen(pushed.snapshot));
});

test("long sessions structurally share undo history and replay exactly", () => {
  const definition = puzzle([
    "OOOOOO",
    "OR   O",
    "O    O",
    "O X SO",
    "OOOOOO",
  ]);
  const cycle = ["right", "down", "left", "up"] as const;
  const actionLog = encodeActionLog(
    Array.from({ length: 500 }, () => cycle).flat(),
  );
  const initial = createSession(definition);
  const first = move(initial, "right");
  const second = move(first, "down");

  assert.equal(second.history.head?.previous, first.history.head);
  assert.equal(undo(second).history.head, first.history.head);

  const replayed = replayActionLog(definition, actionLog);
  assert.equal(replayed.moves, 2_000);
  assert.equal(replayed.history.length, 2_000);
  assert.equal(replayed.actionLog, actionLog);
  assert.deepEqual(replayed.snapshot.robot, initial.snapshot.robot);
});
