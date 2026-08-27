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

export interface GeometryProfile {
  readonly boardWidthRange: readonly [number, number];
  readonly boardHeightRange: readonly [number, number];
  readonly minRooms: number;
  readonly maxRooms: number;
  readonly minRoomSize: number;
  readonly maxRoomSize: number;
  readonly passageWidths: readonly (1 | 2)[];
  readonly minPlayableFloor: number;
  readonly maxPlayableFloor?: number;
  readonly minFloorCoverage: number;
  readonly minRegions: number;
  readonly minChokepoints: number;
}

export interface BlueprintParams {
  readonly seed: number;
  readonly family: TopologyFamily | "random";
  readonly minRooms: number;
  readonly maxRooms: number;
  readonly minRoomSize: number;
  readonly maxRoomSize: number;
  readonly passageWidth: 1 | 2;
  readonly passageWidths?: readonly (1 | 2)[];
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
  readonly goalId?: string;
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

export interface ReverseSearchProfile {
  readonly beamWidth: number;
  readonly maxDepth: number;
  readonly maxExpandedStates?: number;
  readonly maxElapsedMs?: number;
  readonly restartCount: number;
  readonly diverseArchiveSize: number;
  readonly diversityRadius: number;
  readonly stochasticTieBreaking: boolean;
  readonly antiImmediateUndo: boolean;
  readonly restartJitterScale?: number;
}

export const DEFAULT_SEARCH_PROFILE: ReverseSearchProfile = {
  beamWidth: 8,
  maxDepth: 60,
  restartCount: 1,
  diverseArchiveSize: 16,
  diversityRadius: 2,
  stochasticTieBreaking: true,
  antiImmediateUndo: true,
};

// ---------------------------------------------------------------------------
// Mechanism-driven generation (Phase 5)
// ---------------------------------------------------------------------------

export type MechanismType =
  | "packing-chain"
  | "gatekeeper"
  | "gate-reopening"
  | "staging-dependency"
  | "corridor-traffic"
  | "temporary-parking"
  | "dependency-chain"
  | "cross-room-exchange";

export const MECHANISM_TYPES: readonly MechanismType[] = [
  "packing-chain",
  "gatekeeper",
  "gate-reopening",
  "staging-dependency",
  "corridor-traffic",
  "temporary-parking",
  "dependency-chain",
  "cross-room-exchange",
];

export interface MechanismSpec {
  readonly type: MechanismType;
  readonly primaryRoomIds: readonly number[];
  readonly minGoals: number;
  readonly weight: number;
}

export type MechanismEvidenceKind =
  | "completion-order"
  | "access-blocked"
  | "staging-displacement"
  | "shared-route"
  | "shared-passage"
  | "gate-displacement"
  | "gate-return"
  | "temporary-park"
  | "chain-ordering"
  | "cross-exchange";

export interface MechanismEvidenceRequirement {
  readonly mechanismType: MechanismType;
  readonly requiredKinds: readonly MechanismEvidenceKind[];
  readonly minEvidenceCount: number;
  readonly description: string;
}

export interface MechanismPlan {
  readonly mechanisms: readonly MechanismSpec[];
  readonly intendedDependencies: readonly MechanismDependencyEdge[];
  readonly evidenceRequirements: readonly MechanismEvidenceRequirement[];
  readonly tier: string;
  readonly seed: number;
}

export interface MechanismDependencyEdge {
  readonly fromMechanism: number;
  readonly toMechanism: number;
  readonly edgeType: MechanismEdgeType;
  readonly description: string;
}

export type MechanismEdgeType =
  | "must-precede"
  | "must-stage"
  | "shares-passage"
  | "blocks-access"
  | "must-reopen"
  | "must-park"
  | "chain-link"
  | "exchange-cross";

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
