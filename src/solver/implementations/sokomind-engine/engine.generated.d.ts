/**
 * Type declarations for engine.generated.js, a build artifact produced by
 * concatenating the classic-script sources in ./source/. Regenerate it with:
 *   npm run prepare:sokomind-solver
 * See scripts/prepare-sokomind-engine.mjs and the README.md in this directory.
 */
import type {
  EnginePayload,
  EngineSearchResult,
} from "./engine-protocol.ts";

export function search(
  payload: EnginePayload,
): EngineSearchResult;

export function bidirectionalSide(
  payload: EnginePayload,
): void;
