export type TopologyFamily =
  | "linear"
  | "hub"
  | "loop"
  | "branch"
  | "nested";

export type RoomRole =
  | "general"
  | "goal-room"
  | "staging"
  | "transit"
  | "packing"
  | "exchange";

export interface RoomNode {
  readonly id: number;
  readonly role: RoomRole;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

export interface PassageEdge {
  readonly from: number;
  readonly to: number;
  readonly width: 1 | 2;
  readonly cells: readonly PassageCell[];
}

export interface PassageCell {
  readonly row: number;
  readonly column: number;
}

export interface StructuralBlueprint {
  readonly seed: number;
  readonly family: TopologyFamily;
  readonly rooms: readonly RoomNode[];
  readonly passages: readonly PassageEdge[];
  readonly boardWidth: number;
  readonly boardHeight: number;
}

export interface BlueprintParams {
  readonly seed: number;
  readonly family: TopologyFamily | "random";
  readonly minRooms: number;
  readonly maxRooms: number;
  readonly minRoomSize: number;
  readonly maxRoomSize: number;
  readonly passageWidth: 1 | 2;
  readonly boardWidth: number;
  readonly boardHeight: number;
}

export const DEFAULT_BLUEPRINT_PARAMS: BlueprintParams = {
  seed: 0,
  family: "random",
  minRooms: 2,
  maxRooms: 5,
  minRoomSize: 3,
  maxRoomSize: 5,
  passageWidth: 1,
  boardWidth: 12,
  boardHeight: 12,
};

export const TOPOLOGY_FAMILIES: readonly TopologyFamily[] = [
  "linear",
  "hub",
  "loop",
  "branch",
  "nested",
];

export type GoalStyle =
  | "concentrated"
  | "multi-room"
  | "mixed"
  | "exchange";

export interface GoalPlacementParams {
  readonly seed: number;
  readonly boxCount: number;
  readonly goalStyle: GoalStyle | "auto";
}

export const DEFAULT_GOAL_PARAMS: GoalPlacementParams = {
  seed: 0,
  boxCount: 3,
  goalStyle: "auto",
};

export interface GoalCell {
  readonly row: number;
  readonly column: number;
  readonly roomId: number;
  readonly depthFromDoorway: number;
  readonly reversePullDirs: number;
}

export interface FunctionalBlueprint extends StructuralBlueprint {
  readonly rooms: readonly FunctionalRoom[];
}

export interface FunctionalRoom extends RoomNode {
  readonly isTerminal: boolean;
  readonly graphDegree: number;
  readonly distanceFromCenter: number;
}

export interface SolvedBlueprint {
  readonly blueprint: FunctionalBlueprint;
  readonly grid: readonly (readonly string[])[];
  readonly goals: readonly GoalCell[];
  readonly robotPosition: { readonly row: number; readonly column: number };
  readonly goalStyle: GoalStyle;
}

export interface BlueprintDiagnostics {
  readonly seed: number;
  readonly family: TopologyFamily;
  readonly roomCount: number;
  readonly passageCount: number;
  readonly doorwayCount: number;
  readonly totalFloor: number;
  readonly roomAreas: readonly number[];
  readonly largestRoomRatio: number;
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly connectivityDegrees: readonly number[];
}
