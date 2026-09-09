import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { EnginePayload, EngineSearchResult } from "../../src/solver/implementations/sokomind-engine/engine-protocol.ts";
import type { LegacyState } from "../../src/solver/implementations/sokomind-legacy.ts";

export interface PlanTraceState {
  readonly robot: readonly number[];
  readonly boxes: readonly (readonly [number, number, string])[];
  readonly cost?: number;
  readonly pushes?: number;
  readonly path?: readonly string[];
  readonly pushClass?: string;
  readonly pushedFrom?: string;
  readonly score?: number;
}

export interface PlanTraceEvent {
  readonly stage: string;
  readonly segment?: number;
  readonly current?: PlanTraceState;
  readonly state?: PlanTraceState;
  readonly states?: readonly PlanTraceState[];
  readonly reason?: string;
}

/** Offline only: the generated browser module does not export these internals. */
export function createPlanTraceRuntime() {
  const source = readFileSync(new URL("../../src/solver/implementations/sokomind-engine/engine.generated.js", import.meta.url), "utf8");
  const exports = /\nexport \{ bidirectionalSide, search, validateStrategicPlanContract, evaluateStrategicPlanState, rebaseStrategicPlan \};\s*$/u;
  assert.match(source, exports, "Generated engine exports changed; review the offline loader");
  const sandbox = createContext({ performance, structuredClone, postMessage() {} });
  runInContext(source.replace(exports, "") + `
    function offlineSearch(payload, observer) {
      const original = planMacroBeamSearch;
      if (observer) planMacroBeamSearch = value => original(value, observer);
      try { return search(payload); }
      finally { planMacroBeamSearch = original; }
    }
    function offlineReference(state, path, canonicalize) {
      if (!canonicalize) return {state, path, orientation: "identity"};
      const c = canonicalPlanTransform(state);
      if (c.transform.id === "identity") return {state, path, orientation: "identity"};
      return {state: {rows: c.rows, robot: c.robot, boxes: c.boxes},
        path: path.map(move => transformPlanMove(move, c.transform, c.height, c.width)),
        orientation: c.transform.id};
    }
  `, sandbox, { timeout: 10000 });
  return {
    run(payload: EnginePayload, observer?: (event: PlanTraceEvent) => void, timeoutMs = 120000): EngineSearchResult {
      sandbox.payload = structuredClone(payload);
      sandbox.observer = observer;
      try {
        return JSON.parse(JSON.stringify(runInContext("offlineSearch(payload, observer)", sandbox, { timeout: timeoutMs }))) as EngineSearchResult;
      } finally {
        delete sandbox.payload;
        delete sandbox.observer;
      }
    },
    reference(state: LegacyState, path: readonly string[], canonicalize = true): {state: LegacyState; path: string[]; orientation: string} {
      sandbox.state = structuredClone(state);
      sandbox.path = [...path];
      sandbox.canonicalize = canonicalize;
      try {
        return JSON.parse(JSON.stringify(runInContext("offlineReference(state, path, canonicalize)", sandbox, {timeout: 10000})));
      } finally {
        delete sandbox.state;
        delete sandbox.path;
        delete sandbox.canonicalize;
      }
    },
  };
}
