import {
  stepSnapshot,
  type Direction,
  type ParsedBoard,
  type Position,
} from "../../core/index.ts";
import type {
  SolutionStep,
  SolverAdapter,
  SolverExecutionContext,
  SolverMetadata,
  SolverRequest,
  SolverResult,
  SolverRunMetrics,
  SolverSolution,
} from "../contracts.ts";
import { runClassicSearch } from "../search/engine.ts";
import { scoreSolverObjective } from "../validation.ts";
import type {
  EngineCommand,
  EngineResult,
} from "./sokomind-engine/engine-protocol.ts";
import { isEngineResult } from "./sokomind-engine/engine-protocol.ts";
import {
  resolveSokomindTuning,
  sokomindTuningPayload,
  type SokomindTuningOverrides,
  type SokomindTuningProfile,
} from "./sokomind-tuning.ts";
import {
  extractSokomindOptions,
  type SokomindRequestOptions,
} from "./sokomind-options.ts";
import {
  WorkerExecutionRegistry,
  type WorkerMemoryBreakdown,
} from "./sokomind-worker-registry.ts";
import {
  BudgetTracker,
  type AggregateSnapshot,
  type BudgetStopReason,
} from "./sokomind-budget-tracker.ts";
import {
  runSequentialProof,
  runConcurrentProof,
  type SokomindProofWorker,
  type ProofCheckpointOptions,
} from "./sokomind-proof.ts";
import {
  IncumbentCollector,
  computeHarvestMs,
  selectForRewrite,
  selectBest,
} from "./sokomind-incumbents.ts";

const LEGACY_DIRECTIONS = Object.freeze({
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
} as const satisfies Readonly<Record<string, Direction>>);

const LEGACY_DIRECTION_CODES = Object.freeze({
  U: "Up",
  D: "Down",
  L: "Left",
  R: "Right",
} as const);

const LEGACY_DIRECTION_NAMES = Object.freeze({
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
} as const satisfies Readonly<Record<Direction, LegacyDirection>>);

const DIRECTION_VECTORS = Object.freeze([
  Object.freeze({ legacy: "Up", row: -1, column: 0 }),
  Object.freeze({ legacy: "Down", row: 1, column: 0 }),
  Object.freeze({ legacy: "Left", row: 0, column: -1 }),
  Object.freeze({ legacy: "Right", row: 0, column: 1 }),
] as const);

const DEFAULT_MAX_ENGINE_WORKERS = 3;
const STRUCTURAL_BOX_THRESHOLD = 10;
const STRUCTURAL_FLOOR_THRESHOLD = 100;
const DEFAULT_MEMORY_ESTIMATE_BYTES = 16 * 1024 * 1024;
const PREPARED_BOARD_BASE_BYTES = 1024 * 1024;
const ESTIMATED_SEARCH_RETAINED_STATE_BYTES = 1_536;
const ESTIMATED_BIDIRECTIONAL_RETAINED_STATE_BYTES = 384;
const ESTIMATED_CACHE_ENTRY_BYTES = 384;
const ESTIMATED_FRONTIER_STATE_BYTES = 1_024;
const ESTIMATED_RECORD_BASE_BYTES = 512;
const BIDIRECTIONAL_CLONE_RESERVE_BYTES = 1024 * 1024;
const PROGRESS_THROTTLE_MS = 200;
const WORKER_SILENCE_WATCHDOG_MS = 120_000;
function defaultImprovementMaxVisited(maxMemoryBytes?: number): number {
  if (maxMemoryBytes === undefined || !Number.isFinite(maxMemoryBytes)) {
    return 50_000;
  }
  const availableMB = maxMemoryBytes / (1024 * 1024);
  return Math.max(50_000, Math.min(500_000, Math.floor(availableMB * 200)));
}
const DEFAULT_IMPROVEMENT_MAX_ELAPSED_MS = 45_000;
const DEFAULT_IMPROVEMENT_MINIMUM_MOVES = 100;

type LegacyDirection = keyof typeof LEGACY_DIRECTIONS;
type PhaseStopReason = BudgetStopReason;

interface LegacyState {
  readonly rows: readonly string[];
  readonly robot: readonly [number, number];
  readonly boxes: readonly (readonly [string, string])[];
  readonly preparedBoard?: LegacyPreparedBoard;
}

interface LegacyPreparedBoard {
  readonly schemaVersion: number;
  readonly boardContentKey: string;
  readonly [key: string]: unknown;
}

interface LegacyRecord {
  readonly id: string;
  readonly parent: string | null;
  readonly segment: string | readonly string[];
  readonly robot: readonly [number, number];
}

interface EngineMessageEvent {
  readonly data: unknown;
}

interface EngineErrorEvent {
  readonly message?: string;
}

type EngineMessageListener = (event: EngineMessageEvent) => void;
type EngineErrorListener = (event: EngineErrorEvent) => void;

export interface SokomindEngineWorker {
  postMessage(message: EngineCommand): void;
  addEventListener(
    type: "message",
    listener: EngineMessageListener,
  ): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: EngineErrorListener,
  ): void;
  removeEventListener(
    type: "message",
    listener: EngineMessageListener,
  ): void;
  removeEventListener(
    type: "error" | "messageerror",
    listener: EngineErrorListener,
  ): void;
  terminate(): void;
}

export interface SokomindSolverAdapterOptions {
  readonly createWorker?: () => SokomindEngineWorker;
  readonly createProofWorker?: () => SokomindProofWorker;
  readonly hardwareConcurrency?: number;
  readonly deviceMemoryGb?: number;
  readonly workerSilenceTimeoutMs?: number;
  readonly structuralHeadStartMs?: number;
  readonly tuning?: SokomindTuningOverrides;
  /** Set to zero to disable the bounded post-solution rewrite lane. */
  readonly improvementMaxVisited?: number;
  /** Wall-clock budget for the rewrite lane. Set to zero to disable it. */
  readonly improvementMaxElapsedMs?: number;
  /** Number of independently replay-verified rewrite passes. */
  readonly improvementMaxPasses?: number;
  /** Routes shorter than this are returned immediately. */
  readonly improvementMinimumMoves?: number;
  /** Checkpoint options for IDA* proof runs. */
  readonly checkpointOptions?: ProofCheckpointOptions;
}

interface EnginePlan {
  readonly id: string;
  readonly label: string;
  readonly mode: EngineCommand["mode"];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly capturesPreparedBoard?: boolean;
}


interface SearchRunState {
  readonly startedAt: number;
  readonly deadline: number;
  readonly request: SolverRequest;
  readonly context: SolverExecutionContext;
  readonly profile: SokomindTuningProfile;
  readonly workerSilenceTimeoutMs: number;
  readonly structuralHeadStartLimitMs: number;
  readonly registry: WorkerExecutionRegistry;
  readonly budget: BudgetTracker;
  rejectedCandidates: number;
  completedWorkers: number;
  phaseTimeouts: number;
  watchdogTimeouts: number;
  lastProgressAt: number;
  progressPhase: "searching" | "harvesting" | "improving";
  initialSolutionMoves: number;
  bestSolutionMoves: number;
  solutionImprovements: number;
}

interface PhaseOutcome {
  readonly solution?: SolverSolution;
  readonly preparedBoard?: LegacyPreparedBoard;
  readonly stopReason?: PhaseStopReason;
  readonly phaseTimedOut?: boolean;
  readonly watchdogTimedOut?: boolean;
  readonly cutoff: boolean;
  readonly startedWorkers: number;
  readonly failedWorkers: number;
  readonly errors: readonly string[];
}

function defaultCreateWorker(): SokomindEngineWorker {
  return new Worker(
    new URL(
      "./sokomind-engine/sokomind-engine.worker.ts",
      import.meta.url,
    ),
    {
      type: "module",
      name: "sokomind-engine",
    },
  ) as unknown as SokomindEngineWorker;
}

function defaultCreateProofWorker(): SokomindProofWorker {
  return new Worker(
    new URL(
      "./sokomind-proof-worker.ts",
      import.meta.url,
    ),
    {
      type: "module",
      name: "sokomind-proof",
    },
  ) as unknown as SokomindProofWorker;
}

function runProof(
  request: SolverRequest,
  context: SolverExecutionContext,
  sokomindOptions: SokomindRequestOptions,
  discoveryResult: SolverResult,
  adapterOptions: SokomindSolverAdapterOptions,
): Promise<SolverResult> {
  if (sokomindOptions.proofParallelism > 1) {
    return runConcurrentProof(
      request,
      context,
      sokomindOptions,
      discoveryResult,
      {
        createProofWorker: adapterOptions.createProofWorker ?? defaultCreateProofWorker,
        proofParallelism: sokomindOptions.proofParallelism,
      },
    );
  }
  return runSequentialProof(
    request,
    context,
    sokomindOptions,
    discoveryResult,
    adapterOptions.checkpointOptions,
  );
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function optionalFiniteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function numericProperty(
  record: Readonly<Record<string, unknown>>,
  property: string,
): number {
  return finiteNonNegative(record[property]);
}

function positionKey(row: number, column: number): string {
  return `${row},${column}`;
}

function sortedFloor(board: ParsedBoard): readonly Position[] {
  return [...board.floor].sort(
    (left, right) =>
      left.row - right.row || left.column - right.column,
  );
}

/**
 * Legacy rows remain static puzzle source data. Dynamic occupants always come
 * from the exact request snapshot, which also supports mid-game solves.
 */
export function toLegacyState(request: SolverRequest): LegacyState {
  return Object.freeze({
    rows: Object.freeze([...request.board.rows]),
    robot: Object.freeze([
      request.snapshot.robot.row,
      request.snapshot.robot.column,
    ]) as readonly [number, number],
    // Preserve snapshot order. The structural planner has order-sensitive
    // successor caches even though same-label boxes are interchangeable in its
    // canonical closed-state identity.
    boxes: Object.freeze(
      request.snapshot.boxes.map(
        (box) =>
          Object.freeze([
            positionKey(box.position.row, box.position.column),
            box.label,
          ]) as readonly [string, string],
      ),
    ),
  });
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasCallableProperty(value: unknown, property: string): boolean {
  return typeof objectRecord(value)?.[property] === "function";
}

function preparedBoardFromAnalysis(
  analysisValue: unknown,
  rows: readonly string[],
): LegacyPreparedBoard | null {
  const analysis = objectRecord(analysisValue);
  const prepared = objectRecord(analysis?.preparedBoard);
  if (
    !prepared ||
    prepared.schemaVersion !== 3 ||
    prepared.boardContentKey !== rows.join("\n") ||
    !hasCallableProperty(prepared.floor, "has") ||
    !hasCallableProperty(prepared.goals, "get")
  ) {
    return null;
  }
  const singleBoxGraph = objectRecord(prepared.singleBoxGraph);
  const goalPushTables = objectRecord(prepared.goalPushTables);
  const dense = objectRecord(prepared.dense);
  if (
    !hasCallableProperty(singleBoxGraph?.nodes, "get") ||
    !hasCallableProperty(goalPushTables?.byGoal, "get") ||
    !hasCallableProperty(dense?.idByKey, "get")
  ) {
    return null;
  }
  return prepared as unknown as LegacyPreparedBoard;
}

function withPreparedBoard(
  state: LegacyState,
  preparedBoard: LegacyPreparedBoard,
): LegacyState {
  return Object.freeze({
    ...state,
    preparedBoard,
  });
}

function preparedBoardMemoryEstimate(
  preparedBoard: LegacyPreparedBoard,
): number {
  return (
    PREPARED_BOARD_BASE_BYTES +
    finiteNonNegative(preparedBoard.estimatedBytes)
  );
}

function legacyDirection(value: unknown): Direction | undefined {
  if (typeof value !== "string") return undefined;
  return LEGACY_DIRECTIONS[value as LegacyDirection];
}

export function solutionFromLegacyPath(
  request: SolverRequest,
  path: readonly unknown[],
): SolverSolution | null {
  let snapshot = request.snapshot;
  const steps: SolutionStep[] = [];
  let pushes = 0;

  for (const value of path) {
    const direction = legacyDirection(value);
    if (!direction) return null;
    const transition = stepSnapshot(request.board, snapshot, direction);
    if (!transition.moved) return null;
    const kind = transition.pushed ? "push" : "walk";
    if (transition.pushed) pushes += 1;
    steps.push(Object.freeze({ direction, kind }));
    snapshot = transition.snapshot;
    // Ignore any accidental diagnostic suffix after the first solved state.
    if (snapshot.solved) break;
  }

  if (!snapshot.solved) return null;
  const moves = steps.length;
  return Object.freeze({
    steps: Object.freeze(steps),
    moves,
    pushes,
    objective: request.objective,
    objectiveScore: scoreSolverObjective(request.objective, moves),
    optimality: "unknown",
  });
}

function asLegacyPath(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function isLegacyRecord(value: unknown): value is LegacyRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const robot = record.robot;
  return (
    typeof record.id === "string" &&
    (record.parent === null || typeof record.parent === "string") &&
    (typeof record.segment === "string" || Array.isArray(record.segment)) &&
    Array.isArray(robot) &&
    robot.length === 2 &&
    robot.every(Number.isFinite)
  );
}

function decodeLegacySegment(
  segment: string | readonly string[],
): LegacyDirection[] | null {
  const values = typeof segment === "string" ? [...segment] : [...segment];
  const decoded: LegacyDirection[] = [];
  for (const value of values) {
    const direction =
      value in LEGACY_DIRECTIONS
        ? value
        : LEGACY_DIRECTION_CODES[
            value as keyof typeof LEGACY_DIRECTION_CODES
          ];
    if (!direction) return null;
    decoded.push(direction as LegacyDirection);
  }
  return decoded;
}

/**
 * The current legacy push key stores base-36 `(labelId * cells + cellId)`
 * tokens, not the older `row,column,label` strings. Decode the compact form so
 * the robot-only bridge blocks the real boxes at a bidirectional meeting.
 */
function boxesFromMeetKey(
  board: ParsedBoard,
  meetKey: string,
): readonly Position[] | null {
  const separator = meetKey.indexOf("|");
  if (separator < 0) return null;
  const signature = meetKey.slice(separator + 1);
  if (!signature) return Object.freeze([]);

  const floor = sortedFloor(board);
  const labels = [...new Set(board.goals.map((goal) => goal.label))].sort();
  const boxes: Position[] = [];
  for (const encoded of signature.split(".")) {
    if (!/^[0-9a-z]+$/.test(encoded)) return null;
    const token = Number.parseInt(encoded, 36);
    if (!Number.isSafeInteger(token) || token < 0 || floor.length === 0) {
      return null;
    }
    const labelId = Math.floor(token / floor.length);
    const cell = token % floor.length;
    if (labelId >= labels.length || !floor[cell]) return null;
    boxes.push(floor[cell]);
  }
  return Object.freeze(boxes);
}

function walkBetween(
  board: ParsedBoard,
  boxes: readonly Position[],
  start: readonly [number, number],
  target: readonly [number, number],
): LegacyDirection[] | null {
  const floor = new Set(
    board.floor.map((position) => positionKey(position.row, position.column)),
  );
  const blocked = new Set(
    boxes.map((position) => positionKey(position.row, position.column)),
  );
  const startKey = positionKey(start[0], start[1]);
  const targetKey = positionKey(target[0], target[1]);
  if (!floor.has(startKey) || !floor.has(targetKey)) return null;

  const visited = new Set<string>([startKey]);
  const queue: Array<{
    row: number;
    column: number;
    parentIndex: number;
    direction: LegacyDirection;
  }> = [{ row: start[0], column: start[1], parentIndex: -1, direction: "Up" }];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    const key = positionKey(node.row, node.column);
    if (key === targetKey) {
      const path: LegacyDirection[] = [];
      let idx = head;
      while (queue[idx].parentIndex >= 0) {
        path.push(queue[idx].direction);
        idx = queue[idx].parentIndex;
      }
      path.reverse();
      return path;
    }

    for (const direction of DIRECTION_VECTORS) {
      const nextRow = node.row + direction.row;
      const nextColumn = node.column + direction.column;
      const nextKey = positionKey(nextRow, nextColumn);
      if (visited.has(nextKey) || blocked.has(nextKey) || !floor.has(nextKey)) {
        continue;
      }
      visited.add(nextKey);
      queue.push({
        row: nextRow,
        column: nextColumn,
        parentIndex: head,
        direction: direction.legacy,
      });
    }
  }
  return null;
}

export function reconstructBidirectionalPath(
  board: ParsedBoard,
  meetKey: string,
  forwardSeen: ReadonlyMap<string, LegacyRecord>,
  reverseSeen: ReadonlyMap<string, LegacyRecord>,
): readonly LegacyDirection[] | null {
  let current = forwardSeen.get(meetKey);
  if (!current || !reverseSeen.has(meetKey)) return null;

  const forwardSegments: LegacyDirection[] = [];
  while (current.parent) {
    const segment = decodeLegacySegment(current.segment);
    if (!segment) return null;
    forwardSegments.unshift(...segment);
    const parent = forwardSeen.get(current.parent);
    if (!parent) return null;
    current = parent;
  }

  const reverseSegments: LegacyDirection[] = [];
  current = reverseSeen.get(meetKey);
  while (current?.parent) {
    const segment = decodeLegacySegment(current.segment);
    if (!segment) return null;
    reverseSegments.push(...segment);
    const parent = reverseSeen.get(current.parent);
    if (!parent) return null;
    current = parent;
  }

  const forward = forwardSeen.get(meetKey);
  const reverse = reverseSeen.get(meetKey);
  const boxes = boxesFromMeetKey(board, meetKey);
  if (!forward || !reverse || !boxes) return null;
  const bridge = walkBetween(board, boxes, forward.robot, reverse.robot);
  if (!bridge) return null;
  return Object.freeze([
    ...forwardSegments,
    ...bridge,
    ...reverseSegments,
  ]);
}

function elapsed(run: SearchRunState): number {
  return Math.max(0, run.context.now() - run.startedAt);
}

function valueFromPerformance(
  performance: Readonly<Record<string, unknown>>,
  key: string,
): number {
  return numericProperty(performance, key);
}

function laneCounterStem(id: string): string {
  return id
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function aggregate(run: SearchRunState): AggregateSnapshot {
  let expandedStates = 0;
  let generatedStates = 0;
  let frontierSize = 0;
  let retainedStates = 0;
  let peakRetainedStates = 0;
  let currentWorkerMemoryBytes = 0;
  let browserProcessMemoryBytes = 0;
  let peakBrowserProcessMemoryBytes = 0;
  let currentMemory =
    run.budget.coordinatorEstimatedMemoryBytes +
    run.budget.preparedBoardEstimatedMemoryBytes;
  let historicalPeakCandidate = currentMemory;
  const memoryBreakdown = {
    runtimeBytes: 0,
    boardBytes: 0,
    retainedBytes: 0,
    frontierBytes: 0,
    cacheBytes: 0,
    arenaBytes: 0,
    recordBytes: 0,
    isolateSampleBytes: 0,
  };
  const laneCounters: Record<string, number> = {};
  let heuristicCalls = 0;
  let reachabilityFloods = 0;
  let deadlockPrunes = 0;
  let infeasiblePrunes = 0;

  for (const [id, telemetry] of run.registry.entries()) {
    expandedStates += telemetry.visited;
    generatedStates += telemetry.generatedForLimit;
    peakRetainedStates += telemetry.peakRetained;
    const stem = laneCounterStem(id);
    laneCounters[`memoryCurrent${stem}Bytes`] = telemetry.active
      ? telemetry.estimatedMemoryBytes
      : 0;
    laneCounters[`memoryPeak${stem}Bytes`] =
      telemetry.peakEstimatedMemoryBytes;
    laneCounters[`memoryCurrent${stem}ProcessBytes`] = telemetry.active
      ? telemetry.processMemoryBytes
      : 0;
    laneCounters[`memoryPeak${stem}ProcessBytes`] =
      telemetry.peakProcessMemoryBytes;
    laneCounters[`memory${stem}RetainedStates`] = telemetry.active
      ? telemetry.retained
      : 0;
    laneCounters[`memory${stem}FrontierStates`] = telemetry.active
      ? telemetry.frontier
      : 0;
    laneCounters[`memory${stem}CacheBytes`] = telemetry.active
      ? telemetry.memoryBreakdown.cacheBytes
      : 0;
    if (telemetry.active) {
      frontierSize += telemetry.frontier;
      retainedStates += telemetry.retained;
      currentWorkerMemoryBytes += telemetry.estimatedMemoryBytes;
      currentMemory += telemetry.estimatedMemoryBytes;
      historicalPeakCandidate += telemetry.peakEstimatedMemoryBytes;
      for (const key of Object.keys(
        memoryBreakdown,
      ) as (keyof WorkerMemoryBreakdown)[]) {
        memoryBreakdown[key] += telemetry.memoryBreakdown[key];
      }
      browserProcessMemoryBytes = Math.max(
        browserProcessMemoryBytes,
        telemetry.processMemoryBytes,
      );
    }
    peakBrowserProcessMemoryBytes = Math.max(
      peakBrowserProcessMemoryBytes,
      telemetry.peakProcessMemoryBytes,
    );
    const performance = telemetry.performance;
    heuristicCalls += valueFromPerformance(performance, "heuristicCalls");
    reachabilityFloods += valueFromPerformance(
      performance,
      "reachabilityCalls",
    );
    deadlockPrunes +=
      valueFromPerformance(performance, "staticDeadPrunes") +
      valueFromPerformance(performance, "dynamicDeadPrunes") +
      valueFromPerformance(performance, "patternDeadlockPrunes");
    infeasiblePrunes +=
      valueFromPerformance(performance, "macroDiscoveryRejections") +
      valueFromPerformance(performance, "macroPackingRejections") +
      valueFromPerformance(performance, "macroGoalAccessRejections");
  }
  // Chromium reports a process-wide heap sample from every worker. Count the
  // largest current sample once: ignoring it makes the declared ceiling
  // toothless, while summing it once per worker multiplies the same process.
  currentMemory = Math.max(currentMemory, browserProcessMemoryBytes);
  historicalPeakCandidate = Math.max(
    historicalPeakCandidate,
    peakBrowserProcessMemoryBytes,
  );
  run.budget.peakFrontierSize = Math.max(run.budget.peakFrontierSize, frontierSize);
  run.budget.peakEstimatedMemoryBytes = Math.max(
    run.budget.peakEstimatedMemoryBytes,
    currentMemory,
    historicalPeakCandidate,
  );
  return Object.freeze({
    expandedStates,
    generatedStates,
    frontierSize,
    peakFrontierSize: run.budget.peakFrontierSize,
    estimatedMemoryBytes: currentMemory,
    peakEstimatedMemoryBytes: run.budget.peakEstimatedMemoryBytes,
    counters: Object.freeze({
      uniqueStates: expandedStates,
      duplicateStates: Math.max(0, generatedStates - expandedStates),
      retainedStates,
      peakRetainedStates,
      deadlockPrunes,
      infeasiblePrunes,
      heuristicCalls,
      reachabilityFloods,
      estimatedMemoryBytes: currentMemory,
      currentEstimatedMemoryBytes: currentMemory,
      peakEstimatedMemoryBytes: run.budget.peakEstimatedMemoryBytes,
      currentWorkerMemoryBytes,
      currentCoordinatorMemoryBytes:
        run.budget.coordinatorEstimatedMemoryBytes,
      currentPreparedBoardMemoryBytes:
        run.budget.preparedBoardEstimatedMemoryBytes,
      workerRuntimeMemoryBytes: memoryBreakdown.runtimeBytes,
      workerBoardMemoryBytes: memoryBreakdown.boardBytes,
      workerRetainedMemoryBytes: memoryBreakdown.retainedBytes,
      workerFrontierMemoryBytes: memoryBreakdown.frontierBytes,
      workerCacheMemoryBytes: memoryBreakdown.cacheBytes,
      workerArenaMemoryBytes: memoryBreakdown.arenaBytes,
      workerRecordMemoryBytes: memoryBreakdown.recordBytes,
      workerIsolateSampleBytes: memoryBreakdown.isolateSampleBytes,
      browserProcessMemoryBytes,
      peakBrowserProcessMemoryBytes,
      workersCompleted: run.completedWorkers,
      rejectedCandidates: run.rejectedCandidates,
      phaseTimeouts: run.phaseTimeouts,
      watchdogTimeouts: run.watchdogTimeouts,
      coordinatorRecords: run.budget.coordinatorRecordCount,
      peakCoordinatorRecords: run.budget.peakCoordinatorRecordCount,
      initialSolutionMoves: run.initialSolutionMoves,
      bestSolutionMoves: run.bestSolutionMoves,
      solutionImprovements: run.solutionImprovements,
      ...laneCounters,
    }),
  });
}

function metrics(run: SearchRunState): SolverRunMetrics {
  const snapshot = aggregate(run);
  return Object.freeze({
    elapsedMs: elapsed(run),
    expandedStates: snapshot.expandedStates,
    generatedStates: snapshot.generatedStates,
    peakFrontierSize: snapshot.peakFrontierSize,
    counters: snapshot.counters,
  });
}

function report(
  run: SearchRunState,
  detail: string,
  force = false,
): void {
  const now = run.context.now();
  if (!force && now - run.lastProgressAt < PROGRESS_THROTTLE_MS) return;
  run.lastProgressAt = now;
  const snapshot = aggregate(run);
  run.context.reportProgress({
    phase: run.progressPhase,
    elapsedMs: Math.max(0, now - run.startedAt),
    expandedStates: snapshot.expandedStates,
    generatedStates: snapshot.generatedStates,
    frontierSize: snapshot.frontierSize,
    counters: snapshot.counters,
    detail,
  });
}

function updateTelemetry(
  run: SearchRunState,
  id: string,
  message: EngineResult,
): void {
  const telemetry = run.registry.get(id);
  if (!telemetry) return;
  if (Array.isArray(message.records)) {
    telemetry.publishedRecords += message.records.length;
  }
  telemetry.visited = Math.max(
    telemetry.visited,
    finiteNonNegative(message.visited),
    telemetry.publishedRecords,
  );
  telemetry.generated = Math.max(
    telemetry.generated,
    finiteNonNegative(message.generated),
  );
  const currentFrontier = optionalFiniteNonNegative(message.frontier);
  if (currentFrontier !== undefined) {
    telemetry.frontier = currentFrontier;
  }
  telemetry.peakFrontier = Math.max(
    telemetry.peakFrontier,
    finiteNonNegative(message.peakFrontier),
    telemetry.frontier,
  );
  const currentRetained =
    optionalFiniteNonNegative(message.retained) ??
    optionalFiniteNonNegative(message.arenaStates);
  if (currentRetained !== undefined) {
    telemetry.retained = currentRetained;
  }
  telemetry.peakRetained = Math.max(
    telemetry.peakRetained,
    telemetry.retained,
  );
  if (
    typeof message.performance === "object" &&
    message.performance !== null
  ) {
    telemetry.performance = message.performance;
  }
  const exactGenerated =
    typeof message.generated === "number" &&
    Number.isFinite(message.generated) &&
    message.generated >= 0;
  telemetry.generatedForLimit = Math.max(
    telemetry.generatedForLimit,
    exactGenerated
      ? finiteNonNegative(message.generated)
      : valueFromPerformance(telemetry.performance, "pushCandidates"),
  );
  const floorCells = run.request.board.floor.length;
  const fallbackBoardBytes =
    floorCells * 4 * 1024 +
    floorCells * run.request.board.goals.length * 64;
  const engineMemory = objectRecord(telemetry.performance.engineMemory);
  const boardBytes = Math.max(
    fallbackBoardBytes,
    finiteNonNegative(engineMemory?.boardBytes),
  );
  const cacheEntries = finiteNonNegative(engineMemory?.cacheEntries);
  const cacheBytes = Math.max(
    finiteNonNegative(engineMemory?.cacheBytes),
    cacheEntries * ESTIMATED_CACHE_ENTRY_BYTES,
  );
  const arenaBytes =
    finiteNonNegative(message.compactArenaAllocatedBytes) +
    finiteNonNegative(message.compactPathBytes);
  const retainedEntries =
    telemetry.mode === "search"
      ? telemetry.retained
      : Math.max(
          telemetry.retained,
          telemetry.visited,
          telemetry.publishedRecords,
        );
  const retainedBytes =
    telemetry.mode === "search" && arenaBytes === 0
      ? retainedEntries * ESTIMATED_SEARCH_RETAINED_STATE_BYTES
      : 0;
  const recordBytes =
    telemetry.mode === "search"
      ? 0
      : retainedEntries *
        ESTIMATED_BIDIRECTIONAL_RETAINED_STATE_BYTES;
  const frontierBytes =
    telemetry.frontier * ESTIMATED_FRONTIER_STATE_BYTES;
  const runtimeBytes =
    DEFAULT_MEMORY_ESTIMATE_BYTES +
    (telemetry.mode === "search"
      ? 0
      : BIDIRECTIONAL_CLONE_RESERVE_BYTES);
  const fallbackMemory =
    runtimeBytes +
    boardBytes +
    retainedBytes +
    frontierBytes +
    cacheBytes +
    arenaBytes +
    recordBytes;
  const memoryDetails = objectRecord(telemetry.performance.memory);
  const browserProcessSample =
    memoryDetails?.source === "browser-performance-memory";
  const reportedCurrentMemory = Math.max(
    valueFromPerformance(telemetry.performance, "heapUsedBytes"),
    finiteNonNegative(memoryDetails?.usedBytes),
  );
  const reportedPeakMemory = Math.max(
    valueFromPerformance(telemetry.performance, "heapPeakBytes"),
    finiteNonNegative(memoryDetails?.peakBytes),
  );
  // Chromium's non-standard performance.memory sample includes unrelated
  // page/process allocations and can start above the solver's entire budget.
  // Use deterministic per-worker state estimates there; injected runtimes can
  // still provide current and peak isolate-scoped absolute samples.
  telemetry.estimatedMemoryBytes =
    !browserProcessSample && reportedCurrentMemory > 0
      ? reportedCurrentMemory
      : fallbackMemory;
  telemetry.processMemoryBytes = browserProcessSample
    ? reportedCurrentMemory
    : 0;
  telemetry.peakProcessMemoryBytes = Math.max(
    telemetry.peakProcessMemoryBytes,
    browserProcessSample ? reportedPeakMemory : 0,
    telemetry.processMemoryBytes,
  );
  telemetry.peakEstimatedMemoryBytes = Math.max(
    telemetry.peakEstimatedMemoryBytes,
    telemetry.estimatedMemoryBytes,
    !browserProcessSample ? reportedPeakMemory : 0,
  );
  telemetry.memoryBreakdown = Object.freeze({
    runtimeBytes,
    boardBytes,
    retainedBytes,
    frontierBytes,
    cacheBytes,
    arenaBytes,
    recordBytes,
    isolateSampleBytes:
      !browserProcessSample && reportedCurrentMemory > 0
        ? reportedCurrentMemory
        : 0,
  });
}

function estimateLegacyRecordBytes(record: LegacyRecord): number {
  const segmentLength =
    typeof record.segment === "string"
      ? record.segment.length
      : record.segment.reduce(
          (total, direction) => total + direction.length,
          0,
        );
  return (
    ESTIMATED_RECORD_BASE_BYTES +
    4 *
      (record.id.length +
        (record.parent?.length ?? 0) +
        segmentLength)
  );
}

function retainLegacyRecord(
  run: SearchRunState,
  records: Map<string, LegacyRecord>,
  record: LegacyRecord,
): void {
  const previous = records.get(record.id);
  if (previous) {
    run.budget.updateRecord(
      estimateLegacyRecordBytes(previous),
      estimateLegacyRecordBytes(record),
    );
  } else {
    run.budget.retainRecord(estimateLegacyRecordBytes(record));
  }
  records.set(record.id, record);
}

function reachedLimit(run: SearchRunState): BudgetStopReason | undefined {
  const snapshot = aggregate(run);
  return run.budget.checkLimit(
    snapshot,
    run.request.limits,
    run.context.signal,
    run.context.now(),
    run.deadline,
  );
}

function recordMapForPlan(
  plan: EnginePlan,
  forwardRecords: Map<string, LegacyRecord>,
  reverseRecords: Map<string, Map<string, LegacyRecord>>,
): Map<string, LegacyRecord> | undefined {
  if (plan.mode === "bidir-forward") return forwardRecords;
  if (plan.mode === "bidir-reverse") {
    const records = new Map<string, LegacyRecord>();
    reverseRecords.set(plan.id, records);
    return records;
  }
  return undefined;
}

function phaseTimerDelay(run: SearchRunState): number | undefined {
  if (!Number.isFinite(run.deadline)) return undefined;
  return Math.max(0, run.deadline - run.context.now());
}

async function runPhase(
  run: SearchRunState,
  plans: readonly EnginePlan[],
  createWorker: () => SokomindEngineWorker,
  maxConcurrent = plans.length,
  maxPhaseElapsedMs?: number,
): Promise<PhaseOutcome> {
  if (plans.length === 0) {
    return {
      cutoff: false,
      startedWorkers: 0,
      failedWorkers: 0,
      errors: Object.freeze([]),
    };
  }

  return new Promise<PhaseOutcome>((resolve, reject) => {
    const active = new Map<
      string,
      {
        readonly worker: SokomindEngineWorker;
        readonly plan: EnginePlan;
        readonly onMessage: EngineMessageListener;
        readonly onError: EngineErrorListener;
        readonly onMessageError: EngineErrorListener;
      }
    >();
    const forwardRecords = new Map<string, LegacyRecord>();
    const reverseRecords = new Map<string, Map<string, LegacyRecord>>();
    const errors: string[] = [];
    let settled = false;
    let cutoff = false;
    let startedWorkers = 0;
    let failedWorkers = 0;
    let nextPlanIndex = 0;

    const cleanupWorker = (id: string) => {
      const entry = active.get(id);
      if (!entry) return;
      active.delete(id);
      entry.worker.removeEventListener("message", entry.onMessage);
      entry.worker.removeEventListener("error", entry.onError);
      entry.worker.removeEventListener(
        "messageerror",
        entry.onMessageError,
      );
      entry.worker.terminate();
      run.registry.deactivate(id);
      run.completedWorkers += 1;
    };

    const globalTimerDelay = phaseTimerDelay(run);
    const timerDelay =
      maxPhaseElapsedMs === undefined
        ? globalTimerDelay
        : Math.min(
            globalTimerDelay ?? Infinity,
            Math.max(0, maxPhaseElapsedMs),
          );
    const timerRepresentsGlobalDeadline =
      globalTimerDelay !== undefined &&
      (maxPhaseElapsedMs === undefined ||
        globalTimerDelay <= Math.max(0, maxPhaseElapsedMs));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let resetWatchdog = () => {};

    const finish = (
      outcome: Omit<
        PhaseOutcome,
        "cutoff" | "startedWorkers" | "failedWorkers" | "errors"
      > = {},
    ) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
      run.context.signal.removeEventListener("abort", onAbort);
      // Capture the concurrent worker + coordinator high-water mark before
      // terminating workers and releasing the phase-local meeting maps.
      aggregate(run);
      for (const id of [...active.keys()]) cleanupWorker(id);
      run.budget.resetPhase();
      resolve({
        ...outcome,
        cutoff,
        startedWorkers,
        failedWorkers,
        errors: Object.freeze([...errors]),
      });
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
      run.context.signal.removeEventListener("abort", onAbort);
      aggregate(run);
      for (const id of [...active.keys()]) cleanupWorker(id);
      run.budget.resetPhase();
      reject(error);
    };

    const stopForLimit = (reason: PhaseStopReason) => {
      cutoff = true;
      finish({ stopReason: reason });
    };

    const onAbort = () => {
      stopForLimit("cancelled");
    };
    if (timerDelay === undefined) {
      resetWatchdog = () => {
        if (settled) return;
        if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
        watchdogTimer = setTimeout(() => {
          if (settled) return;
          const silentWorkers = active.size;
          failedWorkers += silentWorkers;
          cutoff = true;
          run.watchdogTimeouts += 1;
          errors.push(
            `${silentWorkers} engine worker${silentWorkers === 1 ? "" : "s"} stopped reporting progress.`,
          );
          finish({ watchdogTimedOut: true });
        }, run.workerSilenceTimeoutMs);
      };
    }
    run.context.signal.addEventListener("abort", onAbort, { once: true });
    if (timerDelay !== undefined) {
      timer = setTimeout(() => {
        if (
          timerRepresentsGlobalDeadline ||
          run.context.now() >= run.deadline
        ) {
          stopForLimit("elapsed");
        } else {
          run.phaseTimeouts += 1;
          finish({ phaseTimedOut: true });
        }
      }, timerDelay);
    }

    const acceptPath = (path: readonly unknown[], label: string): boolean => {
      try {
        const limitBeforeReplay = reachedLimit(run);
        if (limitBeforeReplay) {
          stopForLimit(limitBeforeReplay);
          return true;
        }
        run.context.reportProgress({
          phase: "verifying",
          elapsedMs: elapsed(run),
          detail: `Verifying candidate from ${label}.`,
        });
        const solution = solutionFromLegacyPath(run.request, path);
        if (!solution) {
          run.rejectedCandidates += 1;
          report(run, `${label} returned a candidate that failed replay.`, true);
          return false;
        }
        const limitAfterReplay = reachedLimit(run);
        if (limitAfterReplay) {
          stopForLimit(limitAfterReplay);
          return true;
        }
        finish({ solution });
        return true;
      } catch (error) {
        fail(error);
        return true;
      }
    };

    const inspectMeetings = (
      plan: EnginePlan,
      records: readonly LegacyRecord[],
      ownRecords: Map<string, LegacyRecord>,
    ): boolean => {
      for (const record of records) {
        retainLegacyRecord(run, ownRecords, record);
      }
      const limit = reachedLimit(run);
      if (limit) {
        stopForLimit(limit);
        return true;
      }
      if (plan.mode === "bidir-forward") {
        for (const record of records) {
          for (const reverse of reverseRecords.values()) {
            if (!reverse.has(record.id)) continue;
            const path = reconstructBidirectionalPath(
              run.request.board,
              record.id,
              forwardRecords,
              reverse,
            );
            if (path && acceptPath(path, "bidirectional meeting")) {
              return true;
            }
          }
        }
      } else if (plan.mode === "bidir-reverse") {
        for (const record of records) {
          if (!forwardRecords.has(record.id)) continue;
          const path = reconstructBidirectionalPath(
            run.request.board,
            record.id,
            forwardRecords,
            ownRecords,
          );
          if (path && acceptPath(path, "bidirectional meeting")) return true;
        }
      }
      return false;
    };

    let launchAvailable = () => {};

    const continueOrFinish = () => {
      if (settled) return;
      launchAvailable();
      if (active.size === 0 && nextPlanIndex >= plans.length) finish();
    };

    const workerFinished = (id: string, message: EngineResult) => {
      const entry = active.get(id);
      if (!entry) return;
      cutoff ||= Boolean(message.cutoff) || message.status === "cutoff";
      if (message.status === "failed" || message.error) {
        failedWorkers += 1;
        errors.push(
          message.error ||
            `${entry.plan.label} failed: ${message.terminationReason || "unknown error"}`,
        );
      }
      cleanupWorker(id);
      report(
        run,
        `${entry.plan.label} finished without a verified route.`,
        true,
      );
      continueOrFinish();
    };

    const startPlan = (plan: EnginePlan) => {
      const executionId = run.registry.uniqueId(plan.id);
      try {
        const worker = createWorker();
        startedWorkers += 1;
        const recordMap = recordMapForPlan(
          plan,
          forwardRecords,
          reverseRecords,
        );
        run.registry.register(executionId, plan.label, plan.mode);

        const onMessage: EngineMessageListener = ({ data }) => {
          if (settled) return;
          if (!isEngineResult(data)) {
            failedWorkers += 1;
            errors.push(`${plan.label} emitted an invalid engine message.`);
            cleanupWorker(executionId);
            continueOrFinish();
            return;
          }
          resetWatchdog();
          const message: EngineResult = data;
          updateTelemetry(run, executionId, message);
          try {
            const limit = reachedLimit(run);
            if (limit) {
              stopForLimit(limit);
              return;
            }
            if (
              message.type === "records" &&
              recordMap &&
              Array.isArray(message.records)
            ) {
              const records = message.records.filter(isLegacyRecord);
              if (inspectMeetings(plan, records, recordMap)) return;
            }

            if (message.type === "done") {
              if (plan.capturesPreparedBoard) {
                const preparedBoard = preparedBoardFromAnalysis(
                  message.analysis,
                  run.request.board.rows,
                );
                if (preparedBoard) {
                  finish({ preparedBoard });
                  return;
                }
                errors.push(
                  "Typed board analysis returned no reusable prepared seed.",
                );
                workerFinished(executionId, message);
                return;
              }
              const path = asLegacyPath(message.path);
              if (path && acceptPath(path, plan.label)) return;
              workerFinished(executionId, message);
              return;
            }

            report(
              run,
              `${plan.label} is searching.`,
              message.type === "landmark",
            );
          } catch (error) {
            fail(error);
          }
        };
        const onError: EngineErrorListener = (event) => {
          if (settled) return;
          failedWorkers += 1;
          errors.push(
            event.message || `${plan.label} worker stopped unexpectedly.`,
          );
          cleanupWorker(executionId);
          continueOrFinish();
        };
        const onMessageError: EngineErrorListener = () => {
          if (settled) return;
          failedWorkers += 1;
          errors.push(`${plan.label} emitted an unreadable message.`);
          cleanupWorker(executionId);
          continueOrFinish();
        };
        active.set(executionId, {
          worker,
          plan,
          onMessage,
          onError,
          onMessageError,
        });
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.addEventListener("messageerror", onMessageError);
        const startupLimit = reachedLimit(run);
        if (startupLimit) {
          stopForLimit(startupLimit);
          return;
        }
        worker.postMessage({
          mode: plan.mode,
          payload: plan.payload,
        });
        resetWatchdog();
      } catch (error) {
        failedWorkers += 1;
        errors.push(
          error instanceof Error ? error.message : String(error),
        );
        cleanupWorker(executionId);
      }
    };

    launchAvailable = () => {
      const concurrency = Math.max(1, Math.floor(maxConcurrent));
      while (
        !settled &&
        active.size < concurrency &&
        nextPlanIndex < plans.length
      ) {
        const plan = plans[nextPlanIndex];
        nextPlanIndex += 1;
        startPlan(plan);
      }
    };

    if (settled) return;
    const initialLimit = reachedLimit(run);
    if (initialLimit) {
      stopForLimit(initialLimit);
      return;
    }
    launchAvailable();
    if (settled) return;
    if (active.size === 0 && nextPlanIndex >= plans.length) {
      finish();
      return;
    }
    try {
      report(
        run,
        plans.length === 1
          ? `${plans[0].label} started.`
          : `${plans.length} complementary searches started.`,
        true,
      );
    } catch (error) {
      fail(error);
    }
  });
}

function remainingStateBudget(
  request: SolverRequest,
  fallback: number,
  divisor = 1,
): number {
  const limit = request.limits?.maxExpandedStates;
  if (limit === undefined) return fallback;
  return Math.max(0, Math.min(fallback, Math.floor(limit / divisor)));
}

function remainingGeneratedBudget(
  request: SolverRequest,
  fallback: number,
  divisor = 1,
): number {
  const limit = request.limits?.maxGeneratedStates;
  if (limit === undefined) return fallback;
  return Math.max(0, Math.min(fallback, Math.floor(limit / divisor)));
}

function preparationPlan(state: LegacyState): EnginePlan {
  return Object.freeze({
    id: "prepare-board",
    label: "Typed board analysis",
    mode: "search",
    capturesPreparedBoard: true,
    payload: Object.freeze({
      algorithm: "analyze-puzzle",
      state,
    }),
  });
}

function structuralPlan(
  state: LegacyState,
  request: SolverRequest,
  tuning: Readonly<Record<string, number>>,
  budgetDivisor = 1,
): EnginePlan {
  const memoryLimit = request.limits?.maxMemoryBytes ?? Infinity;
  const transpositionLimit =
    memoryLimit <= 384 * 1024 * 1024
      ? 24_000
      : memoryLimit <= 768 * 1024 * 1024
        ? 36_000
        : memoryLimit <= 1_536 * 1024 * 1024
          ? 48_000
          : 60_000;
  return Object.freeze({
    id: "structural-plan",
    label: "Structural plan search",
    mode: "search",
    payload: Object.freeze({
      algorithm: "plan-macro-beam",
      state,
      maxDepth: 460,
      maxVisited: remainingStateBudget(request, 6_000, budgetDivisor),
      maxGenerated: remainingGeneratedBudget(
        request,
        60_000,
        budgetDivisor,
      ),
      transpositionLimit,
      sequenceMacroExplored: 48,
      sequenceMacroResults: 4,
      targetedMacroExplored: 64,
      progressIntervalMs: 1_000,
      ...tuning,
    }),
  });
}

export function sokomindDiscoveryBeamWidth(
  boxCount: number,
  floorCount: number,
  maxMemoryBytes = Infinity,
): number {
  const moderate = boxCount >= 5 || floorCount >= 45;
  if (!moderate) return 320;
  if (maxMemoryBytes <= 384 * 1024 * 1024) {
    return boxCount >= 8 ? 32 : 128;
  }
  if (maxMemoryBytes <= 768 * 1024 * 1024) {
    return boxCount >= 8 ? 64 : 256;
  }
  if (maxMemoryBytes <= 1_536 * 1024 * 1024) {
    return boxCount >= 8 ? 128 : 384;
  }
  return boxCount >= 8 ? 256 : 700;
}

function discoveryPlans(
  state: LegacyState,
  request: SolverRequest,
  maxWorkers: number,
  tuning: Readonly<Record<string, number>>,
  budgetDivisor = maxWorkers,
): readonly EnginePlan[] {
  const boxes = request.snapshot.boxes.length;
  const moderate = boxes >= 5 || request.board.floor.length >= 45;
  const memoryLimit = request.limits?.maxMemoryBytes ?? Infinity;
  const directVisitedFallback = moderate
    ? memoryLimit <= 384 * 1024 * 1024
      ? 60_000
      : memoryLimit <= 768 * 1024 * 1024
        ? 120_000
        : 180_000
    : memoryLimit <= 384 * 1024 * 1024
      ? 40_000
      : 80_000;
  const directGeneratedFallback = moderate
    ? memoryLimit <= 384 * 1024 * 1024
      ? 200_000
      : memoryLimit <= 768 * 1024 * 1024
        ? 600_000
        : memoryLimit <= 1_536 * 1024 * 1024
          ? 900_000
          : 1_200_000
    : memoryLimit <= 384 * 1024 * 1024
      ? 150_000
      : 300_000;
  const directBudget = remainingStateBudget(
    request,
    directVisitedFallback,
    budgetDivisor,
  );
  const directGeneratedBudget = remainingGeneratedBudget(
    request,
    directGeneratedFallback,
    budgetDivisor,
  );
  const beamWidth = sokomindDiscoveryBeamWidth(
    boxes,
    request.board.floor.length,
    request.limits?.maxMemoryBytes,
  );
  const transpositionLimit = !moderate
    ? 30_000
    : memoryLimit <= 384 * 1024 * 1024
      ? 24_000
      : memoryLimit <= 768 * 1024 * 1024
        ? 36_000
        : memoryLimit <= 1_536 * 1024 * 1024
          ? 48_000
          : 60_000;
  const direct: EnginePlan = Object.freeze({
    id: "direct-portfolio",
    label: "Guided push portfolio",
    mode: "search",
    payload: Object.freeze({
      algorithm: "ultimate",
      state,
      maxDepth: moderate ? 360 : 180,
      maxVisited: directBudget,
      maxGenerated: directGeneratedBudget,
      transpositionLimit,
      beamWidth,
      sequenceMacros: moderate,
      checkpointLimit: 8,
      progressInterval: 1_000,
      progressIntervalMs: 1_000,
      ...tuning,
    }),
  });

  if (maxWorkers < 3) return Object.freeze([direct]);
  return Object.freeze([
    direct,
    ...bidirectionalPlans(state, request, budgetDivisor),
  ]);
}

function bidirectionalPlans(
  state: LegacyState,
  request: SolverRequest,
  budgetDivisor = 2,
): readonly EnginePlan[] {
  const boxes = request.snapshot.boxes.length;
  const moderate = boxes >= 5 || request.board.floor.length >= 45;
  const sideBudget = remainingStateBudget(
    request,
    moderate ? 100_000 : 40_000,
    budgetDivisor,
  );
  return Object.freeze([
    Object.freeze({
      id: "bidirectional-forward",
      label: "Forward bidirectional search",
      mode: "bidir-forward",
      payload: Object.freeze({
        state,
        maxVisited: sideBudget,
        frontierLimit: 40_000,
      }),
    }),
    Object.freeze({
      id: "bidirectional-reverse",
      label: "Reverse bidirectional search",
      mode: "bidir-reverse",
      payload: Object.freeze({
        state,
        maxVisited: sideBudget,
        frontierLimit: 40_000,
        landmarkLimit: 64,
        reverseShard: Object.freeze({ index: 0, count: 1 }),
      }),
    }),
  ]);
}

function configuredBudget(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  return Math.floor(finiteNonNegative(value));
}

function legacyPathFromSolution(
  solution: SolverSolution,
): readonly LegacyDirection[] {
  return Object.freeze(
    solution.steps.map(({ direction }) => LEGACY_DIRECTION_NAMES[direction]),
  );
}

export function solutionImprovementPlan(
  state: LegacyState,
  incumbent: SolverSolution,
  maxVisited: number,
  pass: number,
  rewriteProfile: SokomindTuningProfile,
  candidateIndex = 0,
  maxGenerated = Infinity,
): EnginePlan {
  const windowVisited = rewriteProfile.rewriteWindowVisited;
  const moveScale = rewriteProfile.rewriteMoveWindowScale;
  return Object.freeze({
    id: `solution-rewrite-c${candidateIndex}-p${pass}`,
    label: `Move-count solution rewrite c${candidateIndex} p${pass}`,
    mode: "search",
    payload: Object.freeze({
      algorithm: "solution-window-rewrite",
      state,
      solutionPath: legacyPathFromSolution(incumbent),
      maxVisited,
      maxGenerated,
      permutationVisited: Math.floor(maxVisited * 0.2),
      permutationWindowPushes: Object.freeze([8, 16, 32]),
      perPermutationWindowVisited: 1_500,
      windowPushes: Object.freeze([8, 16, 32]),
      windowVisited,
      windowTotalVisited: Math.floor(maxVisited * 0.3),
      frontierLimit: windowVisited,
      moveWindowVisited: Math.floor(maxVisited * 0.5 * moveScale),
      moveWindowPushes: Object.freeze([1, 2, 4]),
      moveWindowAttempts: 12,
      perMoveWindowVisited: Math.floor(4_000 * moveScale),
      moveWindowExtraPushes: 4,
      moveWindowMinimumOverhead: 6,
      progressIntervalMs: 1_000,
    }),
  });
}

interface ImprovedIncumbent {
  readonly solution: SolverSolution;
  readonly cancelled: boolean;
}

export interface ParallelRewriteBudget {
  readonly maxVisited: number;
  readonly maxGenerated: number;
  readonly maxElapsedMs: number;
}

function dividedIntegerBudget(total: number, count: number): readonly number[] {
  if (count <= 0) return Object.freeze([]);
  if (!Number.isFinite(total)) {
    return Object.freeze(Array.from({ length: count }, () => Infinity));
  }
  const safeTotal = Math.floor(finiteNonNegative(total));
  const base = Math.floor(safeTotal / count);
  const remainder = safeTotal % count;
  return Object.freeze(
    Array.from(
      { length: count },
      (_, index) => base + (index < remainder ? 1 : 0),
    ),
  );
}

/**
 * Reserves disjoint state and wall-clock shares before parallel rewrites start.
 * Taking the snapshot once prevents every concurrent candidate from observing
 * and spending the same global remainder.
 */
export function allocateParallelRewriteBudgets(
  candidateCount: number,
  maxVisited: number,
  maxGenerated: number | undefined,
  maxElapsedMs: number,
): readonly ParallelRewriteBudget[] {
  const count = Math.max(0, Math.floor(finiteNonNegative(candidateCount)));
  const visitedShares = dividedIntegerBudget(maxVisited, count);
  const generatedShares = dividedIntegerBudget(maxGenerated ?? Infinity, count);
  const elapsedShares = dividedIntegerBudget(maxElapsedMs, count);
  return Object.freeze(
    Array.from({ length: count }, (_, index) => Object.freeze({
      maxVisited: visitedShares[index],
      maxGenerated: generatedShares[index],
      maxElapsedMs: elapsedShares[index],
    })),
  );
}

async function improveIncumbent(
  run: SearchRunState,
  state: LegacyState,
  incumbent: SolverSolution,
  createWorker: () => SokomindEngineWorker,
  options: SokomindSolverAdapterOptions,
  candidateIndex = 0,
  reservedGenerated = Infinity,
): Promise<ImprovedIncumbent> {
  run.initialSolutionMoves ||= incumbent.moves;
  run.bestSolutionMoves =
    run.bestSolutionMoves === 0
      ? incumbent.moves
      : Math.min(run.bestSolutionMoves, incumbent.moves);

  const minimumMoves = configuredBudget(
    options.improvementMinimumMoves,
    DEFAULT_IMPROVEMENT_MINIMUM_MOVES,
  );
  const memoryLimit = run.request.limits?.maxMemoryBytes ?? Infinity;
  const scaledDefault = defaultImprovementMaxVisited(run.request.limits?.maxMemoryBytes);
  const memoryVisitedCap =
    memoryLimit <= 384 * 1024 * 1024
      ? 20_000
      : memoryLimit <= 768 * 1024 * 1024
        ? 35_000
        : scaledDefault;
  const configuredVisited = Math.min(
    configuredBudget(
      options.improvementMaxVisited,
      scaledDefault,
    ),
    memoryVisitedCap,
  );
  const maxElapsedMs = configuredBudget(
    options.improvementMaxElapsedMs,
    DEFAULT_IMPROVEMENT_MAX_ELAPSED_MS,
  );
  const requestedElapsedMs = run.request.limits?.maxElapsedMs;
  const defaultPasses =
    requestedElapsedMs !== undefined && requestedElapsedMs >= 90_000 ? 2 : 1;
  const maxPasses = configuredBudget(
    options.improvementMaxPasses,
    defaultPasses,
  );
  if (
    incumbent.moves < minimumMoves ||
    configuredVisited === 0 ||
    maxElapsedMs === 0 ||
    maxPasses === 0
  ) {
    return Object.freeze({ solution: incumbent, cancelled: false });
  }

  run.progressPhase = "improving";
  const snapshot = aggregate(run);
  run.context.reportProgress({
    phase: "improving",
    elapsedMs: elapsed(run),
    expandedStates: snapshot.expandedStates,
    generatedStates: snapshot.generatedStates,
    frontierSize: snapshot.frontierSize,
    counters: snapshot.counters,
    incumbent: {
      moves: incumbent.moves,
      pushes: incumbent.pushes,
      objectiveScore: incumbent.objectiveScore,
    },
    detail: `Rewriting the ${incumbent.moves}-move route within a bounded local-search budget.`,
  });

  let best = incumbent;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const remainingRequest = withRemainingLimits(run);
    if (!remainingRequest) break;
    const maxVisited = Math.min(
      configuredVisited,
      remainingRequest.limits?.maxExpandedStates ?? Infinity,
    );
    const maxGenerated = Math.min(
      reservedGenerated,
      remainingRequest.limits?.maxGeneratedStates ?? Infinity,
    );
    if (maxVisited < 1 || maxGenerated < 1) break;

    try {
      const outcome = await runPhase(
        run,
        [
          solutionImprovementPlan(
            state,
            best,
            Math.floor(maxVisited),
            pass,
            run.profile,
            candidateIndex,
            Math.floor(maxGenerated),
          ),
        ],
        createWorker,
        1,
        maxElapsedMs,
      );
      if (
        outcome.stopReason === "cancelled" ||
        run.context.signal.aborted
      ) {
        return Object.freeze({ solution: best, cancelled: true });
      }
      const candidate = outcome.solution;
      if (!candidate || candidate.moves >= best.moves) break;
      best = candidate;
      run.solutionImprovements += 1;
      run.bestSolutionMoves = candidate.moves;
      if (outcome.phaseTimedOut || outcome.stopReason) break;
    } catch {
      // Improvement is opportunistic. A verified incumbent must survive an
      // optional worker failure or unsupported nested-worker environment.
      break;
    }
  }
  return Object.freeze({ solution: best, cancelled: false });
}

async function solvedWithImprovement(
  run: SearchRunState,
  state: LegacyState,
  incumbent: SolverSolution,
  createWorker: () => SokomindEngineWorker,
  options: SokomindSolverAdapterOptions,
  sokomindOptions?: SokomindRequestOptions,
  tuning?: Readonly<Record<string, number>>,
  maxWorkers?: number,
): Promise<SolverResult> {
  if (sokomindOptions && sokomindOptions.mode !== "fast" && tuning && maxWorkers !== undefined) {
    return harvestAndImprove(
      run, state, incumbent, createWorker, options, sokomindOptions, tuning, maxWorkers,
    );
  }

  if (sokomindOptions?.mode === "fast") {
    return Object.freeze({
      status: "solved" as const,
      solution: incumbent,
      metrics: metrics(run),
    });
  }

  const improved = await improveIncumbent(
    run,
    state,
    incumbent,
    createWorker,
    options,
  );
  if (improved.cancelled) {
    return Object.freeze({ status: "cancelled", metrics: metrics(run) });
  }
  const discoveryResult: SolverResult = Object.freeze({
    status: "solved" as const,
    solution: improved.solution,
    metrics: metrics(run),
  });
  return discoveryResult;
}

async function harvestAndImprove(
  run: SearchRunState,
  state: LegacyState,
  firstIncumbent: SolverSolution,
  createWorker: () => SokomindEngineWorker,
  options: SokomindSolverAdapterOptions,
  sokomindOptions: SokomindRequestOptions,
  tuning: Readonly<Record<string, number>>,
  maxWorkers: number,
): Promise<SolverResult> {
  const requestTimeMs = run.request.limits?.maxElapsedMs;
  const harvestMs = computeHarvestMs(sokomindOptions.harvestElapsedMs, requestTimeMs);

  const collector = new IncumbentCollector(sokomindOptions.maximumIncumbents);
  collector.offer(firstIncumbent);

  run.progressPhase = "harvesting";
  report(run, `Harvesting diverse incumbents (${harvestMs}ms budget).`, true);

  const harvestDeadline = run.context.now() + harvestMs;
  while (
    collector.incumbents.length < sokomindOptions.maximumIncumbents &&
    run.context.now() < harvestDeadline &&
    !run.context.signal.aborted
  ) {
    const remaining = harvestDeadline - run.context.now();
    if (remaining < 200) break;

    const harvestRequest = withRemainingLimits(run);
    if (!harvestRequest) break;

    const harvestWorkers = sokomindOptions.deterministic ? 1 : Math.max(1, maxWorkers);
    const planCount = harvestWorkers >= 3 ? 3 : 1;
    try {
      const outcome = await runPhase(
        run,
        discoveryPlans(state, harvestRequest, harvestWorkers, tuning, planCount),
        createWorker,
        harvestWorkers,
        remaining,
      );
      if (outcome.solution) {
        collector.offer(outcome.solution);
        report(
          run,
          `Harvested ${collector.incumbents.length} incumbent(s) (${collector.stats.duplicatesRejected} duplicates rejected).`,
          true,
        );
      }
      if (outcome.stopReason === "cancelled" || run.context.signal.aborted) break;
    } catch {
      break;
    }
  }

  if (run.context.signal.aborted) {
    return Object.freeze({ status: "cancelled", metrics: metrics(run) });
  }

  const rewriteCandidates = selectForRewrite(collector.incumbents);
  const rewriteCount = rewriteCandidates.length;

  run.progressPhase = "improving";
  report(
    run,
    `Rewriting ${rewriteCount} diverse incumbent(s) with divided budget.`,
    true,
  );

  const remainingRewriteRequest = withRemainingLimits(run);
  const configuredRewriteVisited = configuredBudget(
    options.improvementMaxVisited,
    defaultImprovementMaxVisited(run.request.limits?.maxMemoryBytes),
  );
  const totalRewriteVisited = Math.min(
    configuredRewriteVisited,
    remainingRewriteRequest?.limits?.maxExpandedStates ?? Infinity,
  );
  const configuredRewriteElapsed = configuredBudget(
    options.improvementMaxElapsedMs,
    DEFAULT_IMPROVEMENT_MAX_ELAPSED_MS,
  );
  const rewriteBudgets = remainingRewriteRequest
    ? allocateParallelRewriteBudgets(
        rewriteCount,
        totalRewriteVisited,
        remainingRewriteRequest.limits?.maxGeneratedStates,
        configuredRewriteElapsed,
      )
    : [];

  const rewrittenCandidates: { solution: SolverSolution; discoveryOrder: number }[] = [];
  const rewritePromises = rewriteCandidates.map(async (incumbent, candidateIndex) => {
    const budget = rewriteBudgets[candidateIndex];
    if (
      run.context.signal.aborted ||
      !budget ||
      budget.maxVisited < 1 ||
      budget.maxGenerated < 1 ||
      budget.maxElapsedMs < 1
    ) {
      return { solution: incumbent.solution, discoveryOrder: incumbent.discoveryOrder };
    }
    const dividedOptions: SokomindSolverAdapterOptions = {
      ...options,
      improvementMaxVisited: budget.maxVisited,
      improvementMaxElapsedMs: budget.maxElapsedMs,
      improvementMaxPasses: 1,
    };
    const improved = await improveIncumbent(
      run,
      state,
      incumbent.solution,
      createWorker,
      dividedOptions,
      candidateIndex,
      budget.maxGenerated,
    );
    return {
      solution: improved.solution,
      discoveryOrder: incumbent.discoveryOrder,
    };
  });
  const rewriteResults = await Promise.all(rewritePromises);
  for (const result of rewriteResults) {
    rewrittenCandidates.push(result);
  }

  if (rewrittenCandidates.length === 0) {
    rewrittenCandidates.push({
      solution: firstIncumbent,
      discoveryOrder: 0,
    });
  }

  const bestSolution = selectBest(rewrittenCandidates);
  run.bestSolutionMoves = bestSolution.moves;

  if (run.context.signal.aborted) {
    return Object.freeze({ status: "cancelled", metrics: metrics(run) });
  }

  const discoveryResult: SolverResult = Object.freeze({
    status: "solved" as const,
    solution: bestSolution,
    metrics: metrics(run),
  });
  return runProof(
    run.request,
    run.context,
    sokomindOptions,
    discoveryResult,
    options,
  );
}

function isStructuralPuzzle(request: SolverRequest): boolean {
  return (
    request.snapshot.boxes.length >= STRUCTURAL_BOX_THRESHOLD ||
    request.board.floor.length >= STRUCTURAL_FLOOR_THRESHOLD
  );
}

function configuredWorkerCount(
  options: SokomindSolverAdapterOptions,
  request: SolverRequest,
): number {
  const hardware = Math.max(
    1,
    Math.floor(
      options.hardwareConcurrency ??
        globalThis.navigator?.hardwareConcurrency ??
        2,
    ),
  );
  const memoryGb =
    options.deviceMemoryGb ??
    (
      globalThis.navigator as Navigator & {
        readonly deviceMemory?: number;
      }
    )?.deviceMemory;
  const declaredMemoryBytes = request.limits?.maxMemoryBytes ?? Infinity;
  const memoryBound =
    declaredMemoryBytes <= 768 * 1024 * 1024 ||
    (memoryGb !== undefined && memoryGb <= 4)
      ? 1
      : declaredMemoryBytes <= 1_536 * 1024 * 1024 ||
          (memoryGb !== undefined && memoryGb <= 8)
        ? 2
        : DEFAULT_MAX_ENGINE_WORKERS;
  return Math.max(
    1,
    Math.min(DEFAULT_MAX_ENGINE_WORKERS, hardware - 1 || 1, memoryBound),
  );
}

function withRemainingLimits(
  run: SearchRunState,
): SolverRequest | null {
  const aggregateMetrics = aggregate(run);
  const original = run.request.limits;
  const remainingMs = Number.isFinite(run.deadline)
    ? Math.max(0, run.deadline - run.context.now())
    : undefined;
  const remainingExpanded =
    original?.maxExpandedStates === undefined
      ? undefined
      : Math.max(
          0,
          original.maxExpandedStates - aggregateMetrics.expandedStates,
        );
  const remainingGenerated =
    original?.maxGeneratedStates === undefined
      ? undefined
      : Math.max(
          0,
          original.maxGeneratedStates - aggregateMetrics.generatedStates,
        );
  if (
    remainingMs === 0 ||
    remainingExpanded === 0 ||
    remainingGenerated === 0
  ) {
    return null;
  }
  return Object.freeze({
    ...run.request,
    limits: Object.freeze({
      ...original,
      ...(remainingMs === undefined
        ? {}
        : { maxElapsedMs: Math.max(1, Math.ceil(remainingMs)) }),
      ...(remainingExpanded === undefined
        ? {}
        : { maxExpandedStates: Math.max(1, remainingExpanded) }),
      ...(remainingGenerated === undefined
        ? {}
        : { maxGeneratedStates: Math.max(1, remainingGenerated) }),
    }),
  });
}

function structuralHeadStartMs(run: SearchRunState): number {
  if (!Number.isFinite(run.deadline)) {
    return run.structuralHeadStartLimitMs;
  }
  const remaining = Math.max(0, run.deadline - run.context.now());
  return Math.min(
    run.structuralHeadStartLimitMs,
    remaining * run.profile.structuralTimeShare,
  );
}

function withStructuralStateBudget(
  request: SolverRequest,
  stateShare: number,
): SolverRequest | null {
  const availableExpanded = request.limits?.maxExpandedStates;
  const availableGenerated = request.limits?.maxGeneratedStates;
  if (
    (availableExpanded !== undefined && availableExpanded <= 1) ||
    (availableGenerated !== undefined && availableGenerated <= 1)
  ) {
    return null;
  }
  const structuralExpanded =
    availableExpanded === undefined
      ? undefined
      : Math.max(
          1,
          Math.min(
            availableExpanded - 1,
            Math.floor(
              availableExpanded * stateShare,
            ),
          ),
        );
  const structuralGenerated =
    availableGenerated === undefined
      ? undefined
      : Math.max(
          1,
          Math.min(
            availableGenerated - 1,
            Math.floor(
              availableGenerated * stateShare,
            ),
          ),
        );
  return Object.freeze({
    ...request,
    limits: Object.freeze({
      ...request.limits,
      ...(structuralExpanded === undefined
        ? {}
        : { maxExpandedStates: structuralExpanded }),
      ...(structuralGenerated === undefined
        ? {}
        : { maxGeneratedStates: structuralGenerated }),
    }),
  });
}

const ADDITIVE_FALLBACK_COUNTERS = new Set([
  "uniqueStates",
  "duplicateStates",
  "deadlockPrunes",
  "infeasiblePrunes",
  "heuristicCalls",
  "reachabilityFloods",
  "reopens",
  "identityFloods",
  "heuristicCacheHits",
]);

const MAXIMUM_FALLBACK_COUNTERS = new Set([
  "estimatedMemoryBytes",
  "maxDepth",
]);

function fallbackCounterName(name: string): string {
  return `classicFallback${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function mergeFallbackCounters(
  legacy: Readonly<Record<string, number>>,
  fallback: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  const combined: Record<string, number> = { ...legacy };
  for (const [name, value] of Object.entries(fallback ?? {})) {
    const previous = combined[name];
    if (previous === undefined) {
      combined[name] = value;
    } else if (ADDITIVE_FALLBACK_COUNTERS.has(name)) {
      combined[name] = previous + value;
    } else if (MAXIMUM_FALLBACK_COUNTERS.has(name)) {
      combined[name] = Math.max(previous, value);
    } else {
      combined[fallbackCounterName(name)] = value;
    }
  }
  return Object.freeze(combined);
}

function combineClassicResult(
  run: SearchRunState,
  result: SolverResult,
): SolverResult {
  const legacy = aggregate(run);
  const combinedCounters = {
    ...mergeFallbackCounters(
      legacy.counters,
      result.metrics.counters,
    ),
    legacyExpandedStates: legacy.expandedStates,
    legacyGeneratedStates: legacy.generatedStates,
  };
  const combinedMetrics: SolverRunMetrics = Object.freeze({
    elapsedMs: elapsed(run),
    expandedStates:
      legacy.expandedStates + (result.metrics.expandedStates ?? 0),
    generatedStates:
      legacy.generatedStates + (result.metrics.generatedStates ?? 0),
    peakFrontierSize: Math.max(
      legacy.peakFrontierSize,
      result.metrics.peakFrontierSize ?? 0,
    ),
    counters: Object.freeze(combinedCounters),
  });
  return Object.freeze({
    ...result,
    metrics: combinedMetrics,
  }) as SolverResult;
}

async function runClassicFallback(
  run: SearchRunState,
): Promise<SolverResult | null> {
  const request = withRemainingLimits(run);
  if (!request) return null;
  const offset = elapsed(run);
  const legacy = aggregate(run);
  const context: SolverExecutionContext = {
    signal: run.context.signal,
    now: run.context.now,
    reportProgress(progress) {
      run.context.reportProgress({
        ...progress,
        elapsedMs: offset + progress.elapsedMs,
        expandedStates:
          legacy.expandedStates + (progress.expandedStates ?? 0),
        generatedStates:
          legacy.generatedStates + (progress.generatedStates ?? 0),
        counters: mergeFallbackCounters(
          legacy.counters,
          progress.counters,
        ),
        detail: progress.detail
          ? `Compatibility fallback: ${progress.detail}`
          : "Compatibility fallback is searching.",
      });
    },
  };
  const result = await runClassicSearch(request, context, {
    strategy: "greedy",
  });
  return combineClassicResult(run, result);
}

function stopDetail(reason: PhaseStopReason): string {
  switch (reason) {
    case "cancelled":
      return "Search cancelled.";
    case "elapsed":
      return "The time limit was reached.";
    case "expanded":
      return "The expanded-state limit was reached.";
    case "generated":
      return "The generated-state limit was reached.";
    case "memory":
      return "The estimated-memory limit was reached.";
  }
}

function emptySolution(request: SolverRequest): SolverSolution {
  return Object.freeze({
    steps: Object.freeze([]),
    moves: 0,
    pushes: 0,
    objective: request.objective,
    objectiveScore: 0,
    optimality: "unknown",
  });
}

export const sokomindSolverMetadata: SolverMetadata = Object.freeze({
  id: "sokomind-solver",
  displayName: "Sokomind Solver",
  description:
    "Typed-box Sokoban search with structural macros, compact bidirectional frontiers, and bounded move-count improvement.",
  version: "1.1.0",
  capabilities: Object.freeze({
    executionTargets: ["web-worker"] as const,
    runtime: "javascript",
    objectives: ["moves"] as const,
    quality: "bounded",
    labeledBoxes: true,
    genericBoxes: true,
    partialState: true,
    reportsProgress: true,
    cooperativeCancellation: true,
    // Parallel first-solution races can finish in a different order.
    deterministic: false,
  }),
});

export function createSokomindSolverAdapter(
  options: SokomindSolverAdapterOptions = {},
): SolverAdapter {
  const createWorker = options.createWorker ?? defaultCreateWorker;
  const profile = resolveSokomindTuning(options.tuning);
  const tuning = sokomindTuningPayload(profile);
  return Object.freeze({
    metadata: sokomindSolverMetadata,
    async solve(
      request: SolverRequest,
      context: SolverExecutionContext,
    ): Promise<SolverResult> {
      const sokomindOptions = extractSokomindOptions(request);
      const startedAt = context.now();
      const maxElapsed = request.limits?.maxElapsedMs;
      const run: SearchRunState = {
        startedAt,
        deadline:
          maxElapsed === undefined ? Infinity : startedAt + maxElapsed,
        request,
        context,
        profile,
        workerSilenceTimeoutMs:
          finiteNonNegative(options.workerSilenceTimeoutMs) ||
          WORKER_SILENCE_WATCHDOG_MS,
        structuralHeadStartLimitMs:
          finiteNonNegative(options.structuralHeadStartMs) ||
          profile.structuralHeadStartMs,
        registry: new WorkerExecutionRegistry(),
        budget: new BudgetTracker(),
        rejectedCandidates: 0,
        completedWorkers: 0,
        phaseTimeouts: 0,
        watchdogTimeouts: 0,
        lastProgressAt: -Infinity,
        progressPhase: "searching",
        initialSolutionMoves: 0,
        bestSolutionMoves: 0,
        solutionImprovements: 0,
      };

      if (context.signal.aborted) {
        return Object.freeze({ status: "cancelled", metrics: metrics(run) });
      }
      if (request.snapshot.solved) {
        return Object.freeze({
          status: "solved",
          solution: emptySolution(request),
          metrics: metrics(run),
        });
      }

      context.reportProgress({
        phase: "preparing",
        elapsedMs: 0,
        detail: "Compiling typed geometry and search plans.",
      });

      let state = toLegacyState(request);
      const maxWorkers = sokomindOptions.deterministic
        ? 1
        : configuredWorkerCount(options, request);
      let cutoff = false;
      let errors: string[] = [];
      let stopReason: PhaseStopReason | undefined;
      let engineWorkersStarted = 0;
      let engineWorkersFailed = 0;
      const structural = isStructuralPuzzle(request);

      if (structural) {
        const preparation = await runPhase(
          run,
          [preparationPlan(state)],
          createWorker,
          1,
        );
        if (preparation.preparedBoard) {
          state = withPreparedBoard(state, preparation.preparedBoard);
          run.budget.preparedBoardEstimatedMemoryBytes =
            preparedBoardMemoryEstimate(preparation.preparedBoard);
        }
        errors = [...errors, ...preparation.errors];
        cutoff ||= preparation.cutoff;
        if (preparation.stopReason) {
          stopReason = preparation.stopReason;
        }
      }

      if (structural && !stopReason) {
        const remainingRequest = withRemainingLimits(run);
        if (!remainingRequest) {
          stopReason = reachedLimit(run) ?? "elapsed";
        } else {
          const structuralRequest =
            withStructuralStateBudget(remainingRequest, profile.structuralStateShare);
          if (structuralRequest) {
            const outcome = await runPhase(
              run,
              [structuralPlan(state, structuralRequest, tuning)],
              createWorker,
              1,
              structuralHeadStartMs(run),
            );
            engineWorkersStarted += outcome.startedWorkers;
            engineWorkersFailed += outcome.failedWorkers;
            cutoff ||= outcome.cutoff || Boolean(outcome.phaseTimedOut);
            errors = [...errors, ...outcome.errors];
            if (outcome.solution) {
              return solvedWithImprovement(
                run,
                state,
                outcome.solution,
                createWorker,
                options,
                sokomindOptions,
                tuning,
                maxWorkers,
              );
            }
            if (outcome.stopReason) stopReason = outcome.stopReason;
          }
        }
      }

      if (!stopReason) {
        const discoveryRequest = withRemainingLimits(run);
        if (!discoveryRequest) {
          stopReason = reachedLimit(run) ?? "elapsed";
        } else {
          const remainingExpanded =
            discoveryRequest.limits?.maxExpandedStates;
          const remainingGenerated =
            discoveryRequest.limits?.maxGeneratedStates;
          const remainingStateLaneBudget = Math.min(
            remainingExpanded ?? Infinity,
            remainingGenerated ?? Infinity,
          );
          const discoveryWorkers =
            !Number.isFinite(remainingStateLaneBudget)
              ? maxWorkers
              : Math.max(
                  1,
                  Math.min(
                    maxWorkers,
                    Math.floor(remainingStateLaneBudget),
                  ),
                );
          const discoveryPlanCount =
            discoveryWorkers >= 3 ? 3 : 1;
          const outcome = await runPhase(
            run,
            discoveryPlans(
              state,
              discoveryRequest,
              discoveryWorkers,
              tuning,
              discoveryPlanCount,
            ),
            createWorker,
            discoveryWorkers,
          );
          engineWorkersStarted += outcome.startedWorkers;
          engineWorkersFailed += outcome.failedWorkers;
          cutoff ||= outcome.cutoff;
          errors = [...errors, ...outcome.errors];
          if (outcome.solution) {
            return solvedWithImprovement(
              run,
              state,
              outcome.solution,
              createWorker,
              options,
              sokomindOptions,
              tuning,
              maxWorkers,
            );
          }
          if (outcome.stopReason) stopReason = outcome.stopReason;
        }
      }

      if (!stopReason && maxWorkers === 2) {
        const bidirectionalRequest = withRemainingLimits(run);
        const remainingLaneBudget = Math.min(
          bidirectionalRequest?.limits?.maxExpandedStates ?? Infinity,
          bidirectionalRequest?.limits?.maxGeneratedStates ?? Infinity,
        );
        if (
          bidirectionalRequest &&
          (!Number.isFinite(remainingLaneBudget) ||
            remainingLaneBudget >= 2)
        ) {
          const outcome = await runPhase(
            run,
            bidirectionalPlans(state, bidirectionalRequest, 2),
            createWorker,
            2,
          );
          engineWorkersStarted += outcome.startedWorkers;
          engineWorkersFailed += outcome.failedWorkers;
          cutoff ||= outcome.cutoff;
          errors = [...errors, ...outcome.errors];
          if (outcome.solution) {
            return solvedWithImprovement(
              run,
              state,
              outcome.solution,
              createWorker,
              options,
              sokomindOptions,
              tuning,
              maxWorkers,
            );
          }
          if (outcome.stopReason) stopReason = outcome.stopReason;
        }
      }

      if (stopReason === "cancelled" || context.signal.aborted) {
        return Object.freeze({ status: "cancelled", metrics: metrics(run) });
      }
      if (stopReason) {
        return Object.freeze({
          status: "unsolved",
          reason: "limit-reached",
          detail: stopDetail(stopReason),
          metrics: metrics(run),
        });
      }

      // A same-origin nested worker is unavailable on a few embedded browsers.
      // The existing cooperative engine remains a useful compatibility lane,
      // and also broadens the portfolio when all first-found lanes exhaust.
      const fallback = await runClassicFallback(run);
      if (fallback) {
        if (sokomindOptions.mode !== "fast" && fallback.status === "solved") {
          return runProof(
            run.request,
            run.context,
            sokomindOptions,
            fallback,
            options,
          );
        }
        return fallback;
      }

      const allWorkersFailed =
        engineWorkersStarted === 0 ||
        (engineWorkersFailed > 0 &&
          engineWorkersFailed >= engineWorkersStarted);
      return Object.freeze({
        status: "unsolved",
        reason: allWorkersFailed || cutoff ? "limit-reached" : "exhausted",
        detail:
          errors.length > 0
            ? `Sokomind engine: ${errors.join(" ")}`
            : "The first-found portfolio completed without a verified route.",
        metrics: metrics(run),
      });
    },
  });
}

export const sokomindSolver = createSokomindSolverAdapter();
