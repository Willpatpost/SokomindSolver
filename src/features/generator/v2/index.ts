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
  GeometryProfile,
  GoalCell,
  GoalPlacementParams,
  GoalStyle,
  MechanismDependencyEdge,
  MechanismEdgeType,
  MechanismEvidenceKind,
  MechanismEvidenceRequirement,
  MechanismGeometryRequirement,
  RelativeCellConstraint,
  GateMobilityConstraint,
  MechanismPlan,
  MechanismSpec,
  MechanismType,
  MechanismVerificationResult,
  PassageCell,
  PassageEdge,
  ReverseSearchProfile,
  RoomNode,
  RoomRole,
  SolvedBlueprint,
  StructuralBlueprint,
  TopologyFamily,
} from "./blueprint-types.ts";

export {
  DEFAULT_BLUEPRINT_PARAMS,
  DEFAULT_GOAL_PARAMS,
  DEFAULT_SEARCH_PROFILE,
  MECHANISM_TYPES,
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
  reverseBeamSearchV4,
  replayForwardSolution,
  candidateToRows,
  candidateToAscii,
  TranspositionTable,
  DiverseArchive,
  extractArchiveCandidates,
} from "./reverse-beam-search.ts";

export type {
  BeamSearchParams,
  BeamCandidate,
  BeamSearchResult,
  BeamSearchResultV4,
  RestartStats,
  PullRecord,
  ArchiveCandidate,
} from "./reverse-beam-search.ts";

export { DEFAULT_BEAM_PARAMS } from "./reverse-beam-search.ts";

export {
  scoreState,
  buildScoringContext,
  stateFingerprint,
  reverseStateKey,
  historyComplexityBonus,
  computeObjectiveVector,
  objectiveVectorComposite,
  buildMechanismReverseContext,
  DEFAULT_WEIGHTS,
} from "./reverse-scoring.ts";

export type {
  ReverseStateScore,
  ScoringContext,
  ScoringWeights,
  PullHistoryEntry,
  ReverseObjectiveVector,
  MechanismReverseContext,
} from "./reverse-scoring.ts";

export {
  evaluatePuzzle,
  evaluatePuzzleWithSteps,
  evaluatePuzzles,
  summarizePopulation,
} from "./puzzle-evaluator.ts";

export type {
  PuzzleEvaluationVector,
  PuzzleEvaluationResult,
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
  VerificationConfidence,
  DependencyEvidence,
} from "./dependency-graph.ts";

export {
  verifyDependenciesWithEvidence,
  verifyDependenciesCounterfactual,
  collectPassageCells,
} from "./dependency-verification.ts";

export type {
  DependencyEdgeVerification,
  DependencyVerificationResult,
} from "./dependency-verification.ts";

export {
  feasibleMechanisms,
  createMechanismPlan,
  placeGoalsFromPlan,
  mechanismCompatibility,
  verifyMechanismEvidence,
  deriveGeometryRequirements,
  selectTargetMechanisms,
  constrainBlueprintParams,
  MECHANISM_CATALOG,
} from "./mechanism-plan.ts";

export type {
  MechanismCatalogEntry,
  MechanismPlacementResult,
} from "./mechanism-plan.ts";

export {
  tightenPuzzle,
  tightenPuzzles,
  summarizeTighteningResults,
  buildPreservationContext,
  DEFAULT_TIGHTENING_PARAMS,
  DEFAULT_TIER_TIGHTENING_POLICIES,
} from "./geometry-tightening.ts";

export type {
  TighteningParams,
  TighteningPreservationContext,
  TighteningMetrics,
  TighteningResult,
  TighteningSummary,
  TierTighteningPolicy,
} from "./geometry-tightening.ts";

export {
  runForge,
  summarizeForgeRun,
  forgeCandidateToAscii,
  countBoxesAndGoals,
  forgeRunReport,
  blueprintStructuralScore,
  buildV4Fingerprint,
  validateBlueprintGeometry,
  validateFinalGeometry,
  resolveBoxTypingMode,
  DEFAULT_FORGE_CONFIG,
  DEFAULT_FORGE_GATES,
  QUALITY_PRESETS,
} from "./puzzle-forge.ts";

export type {
  BoxTypingMode,
  BoxTypingPolicy,
  FunnelBudgets,
  FunnelStageStats,
  QualityPreset,
  SolverCallReduction,
  BlueprintCandidate,
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
  DiagnosticCollector,
  formatDiagnosticReport,
} from "./generator-diagnostics.ts";

export type {
  GeneratorDiagnostics,
  BoxScaleDiagnostics,
  RestartDiagnostics,
  RejectionBreakdown,
  ForgeDiagnosticReport,
  PassiveStoryDistribution,
  CounterfactualDiagnosticSummary,
  PassiveStoryNumericMetric,
  MetricDistribution,
} from "./generator-diagnostics.ts";

export {
  canonicalizeRows,
  framePuzzleRows,
  boardHash,
  symmetryHash,
  createGeneratedPuzzleId,
} from "./puzzle-identity.ts";

export type {
  GeneratedPuzzleManifest,
  GeneratedPuzzleManifestEntry,
  ReviewCandidatePack,
  ReviewCatalog,
  ReviewCatalogTierSummary,
} from "./catalog-manifest-types.ts";

export {
  CATALOG_GENERATOR_VERSION,
  REVIEW_CATALOG_SCHEMA_VERSION,
} from "./catalog-manifest-types.ts";

export {
  buildReviewPack,
  buildReviewCatalog,
  buildFinalReviewCatalog,
  formatReviewSummary,
  validateForAcceptance,
} from "./review-catalog.ts";

export type {
  ReviewCatalogOptions,
  AcceptanceResult,
  FinalReviewTierTarget,
} from "./review-catalog.ts";

export {
  checkReleaseGate,
  checkReviewManifestBinding,
  formatReleaseVerdict,
  DEFAULT_RELEASE_GATE_CONFIG,
} from "./release-gate.ts";

export type {
  ReleaseGateTierQuota,
  ReleaseGateConfig,
  ReleaseGateVerdict,
} from "./release-gate.ts";

export {
  enumerateForgeCombinations,
  createForgeSchedule,
} from "./forge-sampling.ts";

export type {
  ForgeCombination,
  ForgeScheduleEntry,
} from "./forge-sampling.ts";

export {
  enumerateReachablePushes,
  floodKeeperReachable,
} from "./reachable-pushes.ts";

export type {
  ReachablePush,
} from "./reachable-pushes.ts";

export {
  analyzeSolutionUsage,
} from "./solution-usage.ts";

export {
  analyzeSolutionDepth,
  analyzeSolutionDepthFromTrace,
} from "./solution-depth-analysis.ts";

export type {
  SolutionDepthMetrics,
} from "./solution-depth-analysis.ts";

export {
  computeV4Profile,
  classifyDifficultyByBoxCount,
  computeStructuralScale,
  computeSolutionDepthScore,
  computeHumanReasoningComplexity,
  computeTediumPenalty,
  benchmarkAgainstExpected,
  summarizeBenchmark,
  buildCalibrationReport,
  formatCalibrationReport,
  V4_TIER_THRESHOLDS,
} from "./difficulty-model.ts";

export type {
  V4DifficultyProfile,
  V4DifficultyThresholds,
  V4BenchmarkEntry,
  CalibrationEntry,
  CalibrationReport,
  ConfusionMatrix,
} from "./difficulty-model.ts";

export type {
  SolutionUsageMetrics,
} from "./solution-usage.ts";

export {
  analyzeInteraction,
  analyzeInteractionFromTrace,
} from "./interaction-analysis.ts";

export type {
  InteractionMetrics,
} from "./interaction-analysis.ts";

export {
  buildCanonicalSolutionTrace,
} from "./solution-trace.ts";

export type {
  CanonicalSolutionTrace,
  TraceBuildError,
  TraceBuildErrorCode,
  TraceBuildOptions,
  TraceBuildResult,
  TraceBox,
  TraceBoxKind,
  TraceGoal,
  TraceGoalKind,
  TracePhase,
  TracePosition,
  TracePushEvent,
  TracePushOption,
  TraceStepEvent,
} from "./solution-trace.ts";

export {
  buildSemanticZoneIndex,
  deriveSemanticZones,
} from "./semantic-zones.ts";

export type {
  SemanticZone,
  SemanticZoneKind,
  SemanticZoneMap,
  SemanticZonePosition,
} from "./semantic-zones.ts";

export {
  analyzePassiveSolutionStory,
  summarizePassiveStory,
  explainPassiveStory,
} from "./passive-story-analysis.ts";

export type {
  CrossTypeDependencyEvidence,
  CrossTypeSwitchEvidence,
  CrossTypeSharedCellEvidence,
  GateTrafficAnalysis,
  GateTrafficEvidence,
  GenericGoalMisdirectionAnalysis,
  GenericGoalMisdirectionEvidence,
  GoalPackingPlacement,
  GoalRoomPackingAnalysis,
  GoalRoomPackingEvidence,
  MixedBoxInteractionAnalysis,
  MultiRoomJourneyAnalysis,
  MultiRoomJourneyEvidence,
  PassiveStoryPhase,
  PassiveStoryPhaseKind,
  PassiveStoryProfile,
  PassiveStorySummary,
  ProgressReversalAnalysis,
  ProgressReversalEvidence,
  SolutionPhaseAnalysis,
  StructuralStoryIdentity,
  ZoneTransitionEvidence,
} from "./passive-story-analysis.ts";

export {
  buildMechanismConstructionPlan,
  verifyMechanismConstruction,
} from "./mechanism-construction.ts";

export {
  applyStoryAwareTyping,
  verifyStoryAwareTyping,
} from "./story-aware-typing.ts";

export type {
  StoryAwareTypingPlan,
  StoryAwareTypingResult,
  StoryAwareTypingTargetPlan,
  StoryAwareTypingTargetVerification,
  StoryAwareTypingVerification,
} from "./story-aware-typing.ts";

export type {
  ConstructedEvidenceReference,
  ConstructedStoryEvidenceKind,
  MechanismConstructionDirective,
  MechanismConstructionPlan,
  MechanismConstructionTarget,
  MechanismConstructionTargetResult,
  MechanismConstructionVerification,
  MechanismGoalTarget,
} from "./mechanism-construction.ts";

export {
  evaluateFinalist,
  evaluateFinalists,
  evaluateFinalistV4,
  computeCurationObjectives,
  DEFAULT_FINALIST_CONFIG,
} from "./finalist-evaluator.ts";

export type {
  SolverEvidence,
  FinalistEvaluation,
  FinalistEvaluationV4,
  CurationObjectives,
  FinalistEvaluatorConfig,
} from "./finalist-evaluator.ts";

export {
  assignSolverRoles,
  analyzeSolverBottleneck,
  extractCorrelationData,
  DEFAULT_V4_POLICY,
} from "./solver-bottleneck.ts";

export type {
  SolverRole,
  SolverRoleAssignment,
  V4EvaluatorPolicy,
  SolverBottleneckEntry,
  SolverBottleneckReport,
  SolverCorrelationData,
  CorrelationEvaluationInput,
  CorrelationFinalistInput,
} from "./solver-bottleneck.ts";

export {
  assessQuality,
  computePurposefulGeometry,
  computeInteractionQuality,
  computeCausalDepth,
  computeDecisionQuality,
  computeMechanismIntegrity,
  computeElegance,
  computeTedium,
  QUALITY_FLOORS,
} from "./quality-gate.ts";

export type {
  PuzzleQualityProfile,
  QualityFloor,
} from "./quality-gate.ts";

export {
  nonDominatedSort,
  computeNoveltyScores,
  selectByParetoNovelty,
  selectWithDiversityQuotas,
  buildNormalizationContext,
  diagnosePopulation,
} from "./curation.ts";

export type {
  CuratedCandidate,
  DiversityQuotas,
  NormalizationContext,
  PopulationDiagnostics,
} from "./curation.ts";

export { WALL_CHAR } from "./tile-semantics.ts";
export { curateForgeCandidates } from "./puzzle-forge.ts";
export {
  STORY_DIVERSITY_VERSION, DEFAULT_STORY_DIVERSITY_POLICY, storyLayoutKeys,
  buildStoryDiversityProfile, storyDiversityDistance, selectStoryDiverse,
  summarizeStoryDiversity, storyDiversityLimits, formatStorySelection,
  checkStoryDiversityForRelease,
} from "./story-diversity.ts";
export type {
  StoryDiversityProfile, StoryDiversityPolicy, StorySelectionEntry, StorySelectionDecision,
  StorySelectionReason, StorySelectionReport, StoryCatalogDiversity, StoryDiversityNeighbor,
} from "./story-diversity.ts";

export {
  assessStoryQuality, assessCandidateQuality, storyQualityViolations, checkStoryQualityForRelease,
  DEFAULT_STORY_QUALITY_POLICY, STORY_QUALITY_POLICY_VERSION, STORY_QUALITY_FAMILIES,
} from "./story-quality-policy.ts";
export type {
  StoryQualityInput, StoryQualityPolicy, StoryQualityFamily, StoryBoxParticipation,
  StoryQualityMeasurements, StoryQualityReport, StoryQualityRejectionCode, StoryQualityViolation,
} from "./story-quality-policy.ts";

export { analyzeCounterfactualStory, DEFAULT_COUNTERFACTUAL_BUDGET } from "./counterfactual-analysis.ts";
export type {
  CounterfactualBudget,
  CounterfactualOutcome,
  CounterfactualProbeKind,
  CounterfactualClassification,
  CounterfactualState,
  CounterfactualProbeEvidence,
  CounterfactualStoryProfile,
} from "./counterfactual-analysis.ts";
