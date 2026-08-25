export {
  generateBlueprint,
  generateBlueprintWithRetry,
  rasterizeBlueprint,
} from "./blueprint-graph.ts";

export {
  computeDiagnostics,
  blueprintToAscii,
} from "./blueprint-diagnostics.ts";

export type {
  BlueprintDiagnostics,
  BlueprintParams,
  FunctionalBlueprint,
  FunctionalRoom,
  GoalCell,
  GoalPlacementParams,
  GoalStyle,
  PassageCell,
  PassageEdge,
  RoomNode,
  RoomRole,
  SolvedBlueprint,
  StructuralBlueprint,
  TopologyFamily,
} from "./blueprint-types.ts";

export {
  DEFAULT_BLUEPRINT_PARAMS,
  DEFAULT_GOAL_PARAMS,
  TOPOLOGY_FAMILIES,
} from "./blueprint-types.ts";

export { assignRoomRoles } from "./room-roles.ts";

export {
  placeGoals,
  toSolvedTemplate,
  solvedBlueprintToAscii,
  collectRoomFloorCells,
  chooseRobotPosition,
  findDoorways,
  selectGoals,
  isFloor,
  findRoomForCell,
} from "./goal-placement.ts";

export type { RoomFloorCell } from "./goal-placement.ts";

export {
  analyzeGrid,
  analyzeBlueprintFidelity,
  parseRowsToGrid,
} from "./structural-metrics.ts";

export type {
  DetectedRegion,
  StructuralMetrics,
  BlueprintFidelity,
} from "./structural-metrics.ts";

export {
  reverseBeamSearch,
  replayForwardSolution,
  candidateToRows,
  candidateToAscii,
} from "./reverse-beam-search.ts";

export type {
  BeamSearchParams,
  BeamCandidate,
  BeamSearchResult,
  PullRecord,
} from "./reverse-beam-search.ts";

export { DEFAULT_BEAM_PARAMS } from "./reverse-beam-search.ts";

export {
  scoreState,
  buildScoringContext,
  stateFingerprint,
  DEFAULT_WEIGHTS,
} from "./reverse-scoring.ts";

export type {
  ReverseStateScore,
  ScoringContext,
  ScoringWeights,
} from "./reverse-scoring.ts";

export {
  evaluatePuzzle,
  evaluatePuzzles,
  summarizePopulation,
} from "./puzzle-evaluator.ts";

export type {
  PuzzleEvaluationVector,
  PopulationSummary,
} from "./puzzle-evaluator.ts";

export {
  placeGoalsWithMotif,
  MOTIF_TYPES,
  DEFAULT_MOTIF_PARAMS,
} from "./motifs.ts";

export type {
  MotifType,
  MotifParams,
  MotifPlacementResult,
  DependencyHint,
} from "./motifs.ts";

export {
  composeMotifs,
  findCompatibleCompositions,
  isAcyclic,
  topologicalOrder,
  verifyDependencies,
  generateComposedPuzzle,
  generateVerifiedMotifPuzzle,
  COMPOSITION_TYPES,
  DEFAULT_COMPOSITION_PARAMS,
} from "./dependency-graph.ts";

export type {
  DependencyEdgeType,
  DependencyNode,
  DependencyEdge,
  DependencyDAG,
  CompositionType,
  CompositionParams,
  DependencyRealizationResult,
  EdgeRealizationDetail,
  ComposedPuzzleResult,
} from "./dependency-graph.ts";

export {
  tightenPuzzle,
  tightenPuzzles,
  summarizeTighteningResults,
  DEFAULT_TIGHTENING_PARAMS,
} from "./geometry-tightening.ts";

export type {
  TighteningParams,
  TighteningMetrics,
  TighteningResult,
  TighteningSummary,
} from "./geometry-tightening.ts";

export {
  runForge,
  summarizeForgeRun,
  forgeCandidateToAscii,
  forgeRunReport,
  DEFAULT_FORGE_CONFIG,
  DEFAULT_FORGE_GATES,
} from "./puzzle-forge.ts";

export type {
  ForgeConfig,
  ForgeAcceptanceGates,
  ForgeGenerationMode,
  ForgeProvenance,
  ForgeCandidate,
  ForgeRejectionReason,
  ForgeRejection,
  ForgeRunResult,
  ForgeSummary,
} from "./puzzle-forge.ts";

export {
  canonicalizeRows,
  boardHash,
  symmetryHash,
  createGeneratedPuzzleId,
} from "./puzzle-identity.ts";

export {
  enumerateForgeCombinations,
  createForgeSchedule,
} from "./forge-sampling.ts";

export type {
  ForgeCombination,
  ForgeScheduleEntry,
} from "./forge-sampling.ts";
