/** Wire contract for advisory strategy; task predicates never authorize pruning. */
export type StrategicPredicate =
  | Readonly<{ kind: "box-at-cells"; boxIndex: number; cells: readonly string[] }>
  | Readonly<{ kind: "goal-filled"; label: string; cells: readonly string[] }>
  | Readonly<{ kind: "cells-clear"; cells: readonly string[] }>;

export interface StrategicTask {
  readonly id: string;
  readonly kind: "release" | "export" | "stage" | "commit-goal";
  readonly boxIndex: number;
  readonly boxCandidates?: readonly number[];
  readonly requires: readonly StrategicPredicate[];
  readonly completesWhen: StrategicPredicate;
  readonly dependsOn: readonly string[];
  /** A clearance realization is active only while its consumer needs execution. */
  readonly forTaskId?: string;
  readonly evidence: Readonly<{
    strength: "heuristic";
    scope: "hypothesis";
    hypothesisId: string;
    snapshotKey: string;
    rule: string;
    sourceIds: readonly string[];
  }>;
}
export interface StrategicResource {
  readonly id: string;
  readonly cells: readonly string[];
  readonly consumerTaskId: string;
  /** Any one final-push approach suffices; own-box occupancy is permitted. */
  readonly alternatives?: readonly (readonly string[])[];
  readonly availableFrom: "task-enabled";
  readonly availableUntil: "task-complete";
}
export interface StrategicPlanV2 {
  readonly schemaVersion: 2;
  readonly snapshotKey: string;
  readonly orientation: "canonical";
  readonly tasks: readonly StrategicTask[];
  readonly resources: readonly StrategicResource[];
  readonly hypotheses: readonly Readonly<{
    id: string; taskIds: readonly string[]; assumption: "root-assignment-and-transit";
  }>[];
  readonly candidates: readonly Readonly<{
    path: readonly string[]; moves: number; pushes: number; tasks: readonly string[];
    endpoint: Readonly<{robot: readonly number[]; boxes: readonly (readonly (number | string)[])[]}>;
    solved: boolean; estimatedRemainingPushes: number;
  }>[];
  readonly options: Readonly<Record<string, number>>;
  readonly statistics: Readonly<Record<string, number | boolean>>;
  readonly status: "partial" | "solved";
}
export interface StrategicPlanProgress {
  readonly completed: readonly string[];
  readonly enabled: readonly string[];
  readonly pending: number;
  readonly resourceRisk: number;
  readonly commitmentRisk: number;
}
