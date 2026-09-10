import type { SolverSolution } from "../contracts.ts";
import type { LegacyState } from "./sokomind-legacy.ts";

export type RescheduleRecommendation = "skip" | "light" | "full";

export interface ReschedulePrediction {
  readonly recommendation: RescheduleRecommendation;
  readonly walkPushRatio: number;
  readonly boxCount: number;
  readonly floorBoxRatio: number;
}

export function predictRescheduleValue(
  state: LegacyState,
  incumbent: SolverSolution,
): ReschedulePrediction {
  const boxCount = state.boxes.length;
  const pushes = incumbent.pushes;
  const walks = incumbent.moves - pushes;
  const walkPushRatio = pushes > 0 ? walks / pushes : 0;
  const floorCount = state.rows.reduce(
    (count: number, row: string) => count + [...row].filter((ch) => ch !== "O").length,
    0,
  );
  const floorBoxRatio = boxCount > 0 ? floorCount / boxCount : 0;

  let recommendation: RescheduleRecommendation;
  if (walkPushRatio < 1.5 && boxCount < 4) {
    recommendation = "skip";
  } else if (walkPushRatio < 2.0 || boxCount < 6) {
    recommendation = "light";
  } else {
    recommendation = "full";
  }

  return {
    recommendation,
    walkPushRatio,
    boxCount,
    floorBoxRatio,
  };
}
