/**
 * Type declarations for engine.generated.js, a build artifact produced by
 * concatenating the classic-script sources in ./source/. Regenerate it with:
 *   npm run prepare:sokomind-solver
 * See scripts/prepare-sokomind-engine.mjs and the README.md in this directory.
 */
import type {
  EngineSearchResult,
} from "./engine-protocol.ts";

export function search(
  payload: Readonly<Record<string, unknown>>,
): EngineSearchResult;

export function bidirectionalSide(
  payload: Readonly<Record<string, unknown>>,
): void;

export function validateStrategicPlanContract(value: unknown): value is import("../sokomind-strategic-contract.ts").StrategicPlanV2;
export function evaluateStrategicPlanState(
  state: {readonly boxes: readonly (readonly [number, number, string])[]},
  plan: import("../sokomind-strategic-contract.ts").StrategicPlanV2,
): import("../sokomind-strategic-contract.ts").StrategicPlanProgress;
export function rebaseStrategicPlan(
  plan: import("../sokomind-strategic-contract.ts").StrategicPlanV2,
  root: import("../sokomind-legacy.ts").LegacyState,
  checkpoint: import("../sokomind-legacy.ts").LegacyState,
  path: readonly unknown[],
): import("../sokomind-strategic-contract.ts").StrategicPlanV2 | undefined;
