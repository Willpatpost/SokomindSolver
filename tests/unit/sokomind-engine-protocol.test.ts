import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dispatchEngineCommand,
  isEngineCommand,
  isEngineResult,
  type EnginePayload,
  type EngineRuntime,
  type EngineSearchResult,
} from "../../src/solver/implementations/sokomind-engine/engine-protocol.ts";

const VALID_LEGACY_STATE = Object.freeze({
  rows: Object.freeze(["OOOO", "OR O", "OX O", "OOOO"]),
  robot: Object.freeze([1, 1]),
  boxes: Object.freeze([Object.freeze(["2,1", "generic"])]),
});

const VALID_SEARCH_PAYLOAD: EnginePayload = Object.freeze({
  algorithm: "ultimate",
  state: VALID_LEGACY_STATE,
});

describe("Sokomind engine worker protocol", () => {
  it("accepts only supported modes with valid nested payloads", () => {
    for (const mode of ["search", "bidir-forward", "bidir-reverse"] as const) {
      assert.equal(
        isEngineCommand({
          mode,
          payload: {
            state: VALID_LEGACY_STATE,
            ...(mode === "search" ? { algorithm: "ultimate" } : {}),
          },
        }),
        true,
      );
    }

    assert.equal(isEngineCommand(null), false);
    assert.equal(isEngineCommand([]), false);
    assert.equal(isEngineCommand({ mode: "unknown", payload: {} }), false);
    assert.equal(isEngineCommand({ mode: "search" }), false);
    assert.equal(isEngineCommand({ mode: "search", payload: null }), false);
    assert.equal(isEngineCommand({ mode: "search", payload: [] }), false);
    assert.equal(isEngineCommand({ mode: "search", payload: new Map() }), false);
    assert.equal(isEngineCommand({ mode: "search", payload: new Date() }), false);
  });

  it("rejects malformed legacy states and missing search algorithms", () => {
    const invalidStates: readonly unknown[] = [
      undefined,
      null,
      [],
      { ...VALID_LEGACY_STATE, rows: [] },
      { ...VALID_LEGACY_STATE, rows: [""] },
      { ...VALID_LEGACY_STATE, rows: ["OOOO", 4] },
      { ...VALID_LEGACY_STATE, robot: [1] },
      { ...VALID_LEGACY_STATE, robot: [1, -1] },
      { ...VALID_LEGACY_STATE, robot: [1, 1.5] },
      { ...VALID_LEGACY_STATE, robot: [1, Number.MAX_SAFE_INTEGER + 1] },
      { ...VALID_LEGACY_STATE, boxes: null },
      { ...VALID_LEGACY_STATE, boxes: [["2,1"]] },
      { ...VALID_LEGACY_STATE, boxes: [[4, "generic"]] },
      { ...VALID_LEGACY_STATE, boxes: [["", "generic"]] },
      { ...VALID_LEGACY_STATE, boxes: [["2,1", " "]] },
    ];
    for (const state of invalidStates) {
      assert.equal(
        isEngineCommand({
          mode: "search",
          payload: { algorithm: "ultimate", state },
        }),
        false,
      );
    }

    for (const algorithm of [undefined, null, "", " ", 4]) {
      assert.equal(
        isEngineCommand({
          mode: "search",
          payload: { algorithm, state: VALID_LEGACY_STATE },
        }),
        false,
      );
    }
    assert.equal(
      isEngineCommand({
        mode: "bidir-forward",
        payload: { state: VALID_LEGACY_STATE },
      }),
      true,
    );
  });

  it("validates only the stable prepared-board envelope", () => {
    const preparedBoard = {
      schemaVersion: 3,
      boardContentKey: VALID_LEGACY_STATE.rows.join("\n"),
      floor: new Set(["1,1", "2,1"]),
      goals: new Map([["1,2", "generic"]]),
    };
    assert.equal(
      isEngineCommand({
        mode: "search",
        payload: {
          algorithm: "ultimate",
          state: { ...VALID_LEGACY_STATE, preparedBoard },
        },
      }),
      true,
    );

    for (const malformedPreparedBoard of [
      null,
      [],
      new Map(),
      { schemaVersion: 0, boardContentKey: "board" },
      { schemaVersion: 1.5, boardContentKey: "board" },
      { schemaVersion: Number.MAX_SAFE_INTEGER + 1, boardContentKey: "board" },
      { schemaVersion: "3", boardContentKey: "board" },
      { schemaVersion: 3, boardContentKey: "" },
      { schemaVersion: 3, boardContentKey: " " },
    ]) {
      assert.equal(
        isEngineCommand({
          mode: "search",
          payload: {
            algorithm: "ultimate",
            state: {
              ...VALID_LEGACY_STATE,
              preparedBoard: malformedPreparedBoard,
            },
          },
        }),
        false,
      );
    }
  });

  it("validates inbound engine result envelopes", () => {
    assert.equal(isEngineResult({ type: "progress", visited: 12 }), true);
    assert.equal(
      isEngineResult({ type: "done", status: "solved", path: ["Up"] }),
      true,
    );
    assert.equal(isEngineResult({ type: "unknown" }), false);
    assert.equal(isEngineResult({ type: "progress", visited: "12" }), false);
    assert.equal(isEngineResult({ type: "done", path: [42] }), false);
    assert.equal(isEngineResult({ type: "records", records: {} }), false);
  });

  it("rejects negative or fractional engine counters", () => {
    for (const counter of [
      "arenaStates",
      "compactArenaAllocatedBytes",
      "compactPathBytes",
      "frontier",
      "generated",
      "moveVisited",
      "peakFrontier",
      "retained",
      "visited",
    ] as const) {
      assert.equal(
        isEngineResult({ type: "progress", [counter]: -1 }),
        false,
        `${counter} must not be negative`,
      );
      assert.equal(
        isEngineResult({ type: "progress", [counter]: 1.5 }),
        false,
        `${counter} must be an integer`,
      );
    }
  });

  it("validates every nested record before accepting a record batch", () => {
    const validRecord = {
      id: "state-1",
      parent: null,
      segment: ["Up", "Left"],
      robot: [2, 3],
    };
    assert.equal(
      isEngineResult({ type: "records", records: [validRecord] }),
      true,
    );
    assert.equal(isEngineResult({ type: "records" }), false);
    assert.equal(
      isEngineResult({
        type: "records",
        records: [{ ...validRecord, parent: 4 }],
      }),
      false,
    );
    assert.equal(
      isEngineResult({
        type: "records",
        records: [{ ...validRecord, segment: ["Up", 2] }],
      }),
      false,
    );
    assert.equal(
      isEngineResult({
        type: "records",
        records: [{ ...validRecord, robot: [2, -1] }],
      }),
      false,
    );
  });

  it("rejects malformed nested performance telemetry", () => {
    assert.equal(
      isEngineResult({
        type: "progress",
        performance: {
          totalMs: 12.5,
          memory: { supported: true, usedBytes: null },
        },
      }),
      true,
    );
    assert.equal(
      isEngineResult({
        type: "progress",
        performance: { memory: new Map([["usedBytes", 12]]) },
      }),
      false,
    );
    assert.equal(
      isEngineResult({
        type: "progress",
        performance: { totalMs: Number.POSITIVE_INFINITY },
      }),
      false,
    );
  });

  it("turns malformed commands into a bounded failure without calling the engine", () => {
    let calls = 0;
    const runtime: EngineRuntime = {
      search: () => {
        calls += 1;
        return {};
      },
      bidirectionalSide: () => {
        calls += 1;
      },
    };

    for (const command of [
      { mode: "bogus" },
      {
        mode: "search",
        payload: {
          algorithm: "ultimate",
          state: { ...VALID_LEGACY_STATE, robot: [1, -1] },
        },
      },
    ]) {
      assert.deepEqual(dispatchEngineCommand(command, runtime), {
        type: "done",
        status: "failed",
        terminationReason: "invalid-command",
        error: "Malformed engine command.",
        path: null,
        visited: 0,
        generated: 0,
      });
    }
    assert.equal(calls, 0);
  });

  it("preserves search results and bidirectional dispatch semantics", () => {
    const searchPayload = VALID_SEARCH_PAYLOAD;
    const searchResult: EngineSearchResult = {
      status: "solved",
      path: ["Up"],
      visited: 7,
      generated: 11,
    };
    let bidirectionalPayload: EnginePayload | undefined;
    const runtime: EngineRuntime = {
      search: (payload) => {
        assert.equal(payload, searchPayload);
        return searchResult;
      },
      bidirectionalSide: (payload) => {
        bidirectionalPayload = payload;
      },
    };

    assert.deepEqual(
      dispatchEngineCommand(
        { mode: "search", payload: searchPayload },
        runtime,
      ),
      { type: "done", ...searchResult },
    );
    assert.equal(
      dispatchEngineCommand(
        {
          mode: "bidir-reverse",
          payload: {
            mode: "untrusted",
            shard: 2,
            state: VALID_LEGACY_STATE,
          },
        },
        runtime,
      ),
      null,
    );
    assert.deepEqual(bidirectionalPayload, {
      mode: "bidir-reverse",
      shard: 2,
      state: VALID_LEGACY_STATE,
    });
  });

  it("serializes engine exceptions as failed results", () => {
    const runtime: EngineRuntime = {
      search: () => {
        throw new Error("engine exploded");
      },
      bidirectionalSide: () => {},
    };

    assert.deepEqual(
      dispatchEngineCommand(
        { mode: "search", payload: VALID_SEARCH_PAYLOAD },
        runtime,
      ),
      {
        type: "done",
        status: "failed",
        terminationReason: "worker-exception",
        error: "engine exploded",
        path: null,
        visited: 0,
        generated: 0,
      },
    );
  });

  it("turns malformed runtime search results into bounded failures", () => {
    for (const searchResult of [
      { path: null, visited: -1 },
      { path: null, generated: 1.5 },
      { path: null, records: [{ id: "broken" }] },
    ]) {
      const runtime: EngineRuntime = {
        search: () => searchResult as EngineSearchResult,
        bidirectionalSide: () => {},
      };

      assert.deepEqual(
        dispatchEngineCommand(
          { mode: "search", payload: VALID_SEARCH_PAYLOAD },
          runtime,
        ),
        {
          type: "done",
          status: "failed",
          terminationReason: "worker-exception",
          error: "Engine returned a malformed search result.",
          path: null,
          visited: 0,
          generated: 0,
        },
      );
    }
  });
});
