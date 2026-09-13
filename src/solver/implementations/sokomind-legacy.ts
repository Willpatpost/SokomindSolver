import { validateStrategicPlanContract } from "./sokomind-engine/strategic-validation.generated.js";
import type { StrategicPlanV2 } from "./sokomind-strategic-contract.ts";
// Conversion and validation at the legacy engine data boundary.
import {
  stepSnapshot,
  type Direction,
  type ParsedBoard,
  type Position,
} from "../../core/index.ts";
import type { SolutionStep, SolverRequest, SolverSolution } from "../contracts.ts";
import { scoreSolverObjective } from "../validation.ts";
import type { SemanticDiversityTrace } from "./sokomind-incumbents.ts";

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

const PREPARED_BOARD_BASE_BYTES = 1024 * 1024;

type LegacyDirection = keyof typeof LEGACY_DIRECTIONS;

export interface LegacyState {
  readonly rows: readonly string[];
  readonly robot: readonly [number, number];
  readonly boxes: readonly (readonly [string, string])[];
  readonly preparedBoard?: LegacyPreparedBoard;
}

export interface LegacyPreparedBoard {
  readonly schemaVersion: number;
  readonly boardContentKey: string;
  readonly [key: string]: unknown;
}

export interface LegacyRecord {
  readonly id: string;
  readonly parent: string | null;
  readonly segment: string | readonly string[];
  readonly robot: readonly [number, number];
}

export interface LegacySearchCheckpoint {
  readonly state: LegacyState;
  readonly path: readonly unknown[];
  readonly cost?: number;
  readonly estimate?: number;
}

export interface AnalyzerDoorwayTask {
  readonly boxIndex: number;
  readonly label: string;
  readonly target: string;
  readonly allowedTargets: readonly string[];
  readonly direction: "export" | "import";
  readonly roomIndex: number;
  readonly gate: string;
}

export interface AnalyzerTransitPrerequisite {
  readonly boxIndex: number;
  readonly target: string;
  readonly blockerBoxIndex: number;
  readonly blockerLabel: string;
  readonly releaseCells: readonly string[];
}

export interface AnalyzerRoomGuidance {
  readonly roomIndex: number;
  readonly cells: number;
  readonly goals: number;
  readonly boxes: number;
  readonly surplus: number;
  readonly forcedExports: number;
  readonly forcedImports: number;
  readonly interfacePhase: string;
  readonly interfaceMinimumCrossings: number;
  readonly interfaceMinimumExportsBeforeImport: number;
  readonly interfaceClearanceMethod: string;
}

export interface AnalyzerMatchingDomainSummary {
  readonly complete: boolean;
  readonly ambiguousBoxCount: number;
  readonly multiDomainTaskCount: number;
  readonly eliminatedEdges: number;
}

export interface AnalyzerGoalAccessSummary {
  readonly blockedGoalCount: number;
  readonly accessPenalty: number;
  readonly accessClauseCount: number;
}

export interface AnalyzerStructuralMetrics {
  readonly legalPushes: number;
  readonly surplusBoxes: number;
  readonly mandatoryDoorwayExports: number;
  readonly mandatoryDoorwayImports: number;
  readonly dependencyCount: number;
  readonly tunnelCells: number;
  readonly articulationCount: number;
  readonly searchScale: number;
  readonly pressure: number;
}

export interface StructuralConclusions {
  readonly doorwayTasks: readonly AnalyzerDoorwayTask[];
  readonly transitPrerequisites: readonly AnalyzerTransitPrerequisite[];
  readonly matchingDomainComplete: boolean;
}

export interface SokomindAnalysisPlan {
  readonly strategicPlan?: StrategicPlanV2;
  readonly difficulty?: string;
  readonly phases: readonly string[];
  readonly doorwayTasks?: readonly AnalyzerDoorwayTask[];
  readonly transitPrerequisites?: readonly AnalyzerTransitPrerequisite[];
  readonly roomGuidance?: readonly AnalyzerRoomGuidance[];
  readonly matchingDomainSummary?: AnalyzerMatchingDomainSummary;
  readonly goalAccessSummary?: AnalyzerGoalAccessSummary;
  readonly structuralMetrics?: AnalyzerStructuralMetrics;
  readonly structuralConclusions?: StructuralConclusions;
  readonly recommendations: Readonly<{
    beamWidth?: number;
    beamVisited?: number;
    checkpointLimit?: number;
    reverseWorkerLimit?: number;
    sideVisitedLimit?: number;
    useSequenceMacros?: boolean;
    firstPushWalkWeight?: number;
    moveAwareDiscovery?: number;
    macroIntermediateQuota?: number;
  }>;
}

export function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function optionalFiniteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function numericProperty(
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

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasCallableProperty(value: unknown, property: string): boolean {
  return typeof objectRecord(value)?.[property] === "function";
}

export function preparedBoardFromAnalysis(
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

function extractDoorwayTasks(
  analysis: Record<string, unknown>,
): readonly AnalyzerDoorwayTask[] | undefined {
  const assignment = objectRecord(analysis.doorwayAssignment);
  if (!assignment || !Array.isArray(assignment.tasks)) return undefined;
  const boxDomains = Array.isArray(assignment.boxDomains)
    ? assignment.boxDomains
    : [];
  const tasks: AnalyzerDoorwayTask[] = [];
  for (const raw of assignment.tasks) {
    const task = objectRecord(raw);
    if (
      !task ||
      typeof task.box !== "string" ||
      typeof task.label !== "string" ||
      typeof task.target !== "string" ||
      !Array.isArray(task.allowedTargets) ||
      (task.direction !== "export" && task.direction !== "import") ||
      typeof task.roomIndex !== "number" ||
      typeof task.gate !== "string"
    ) continue;
    const directIndex = typeof task.boxIndex === "number" &&
      Number.isSafeInteger(task.boxIndex) && task.boxIndex >= 0
      ? task.boxIndex : -1;
    const boxIndex = directIndex >= 0 ? directIndex : boxDomains.findIndex(
      (domain) => objectRecord(domain)?.box === task.box &&
        objectRecord(domain)?.label === task.label,
    );
    tasks.push(Object.freeze({
      boxIndex: boxIndex >= 0 ? boxIndex : -1,
      label: task.label,
      target: task.target,
      allowedTargets: Object.freeze(
        task.allowedTargets.filter((target): target is string =>
          typeof target === "string"),
      ),
      direction: task.direction,
      roomIndex: task.roomIndex,
      gate: task.gate,
    }));
  }
  return tasks.length ? Object.freeze(tasks) : undefined;
}

function extractTransitPrerequisites(
  analysis: Record<string, unknown>,
): readonly AnalyzerTransitPrerequisite[] | undefined {
  const transport = objectRecord(analysis.transportPlan);
  const transit = objectRecord(transport?.goalTransit);
  if (!transit || !Array.isArray(transit.commitments)) return undefined;
  const prerequisites: AnalyzerTransitPrerequisite[] = [];
  for (const raw of transit.commitments) {
    const commitment = objectRecord(raw);
    if (
      !commitment ||
      typeof commitment.boxIndex !== "number" ||
      typeof commitment.target !== "string" ||
      !Array.isArray(commitment.prerequisites)
    ) continue;
    for (const rawPrereq of commitment.prerequisites) {
      const prereq = objectRecord(rawPrereq);
      if (
        !prereq ||
        typeof prereq.boxIndex !== "number" ||
        typeof prereq.label !== "string" ||
        !Array.isArray(prereq.releaseCells)
      ) continue;
      prerequisites.push(Object.freeze({
        boxIndex: commitment.boxIndex,
        target: commitment.target,
        blockerBoxIndex: prereq.boxIndex,
        blockerLabel: prereq.label,
        releaseCells: Object.freeze(
          prereq.releaseCells.filter((cell): cell is string =>
            typeof cell === "string"),
        ),
      }));
    }
  }
  return prerequisites.length ? Object.freeze(prerequisites) : undefined;
}

function extractRoomGuidance(
  analysis: Record<string, unknown>,
): readonly AnalyzerRoomGuidance[] | undefined {
  if (!Array.isArray(analysis.rooms)) return undefined;
  const rooms: AnalyzerRoomGuidance[] = [];
  for (let roomIndex = 0; roomIndex < analysis.rooms.length; roomIndex++) {
    const raw = objectRecord(analysis.rooms[roomIndex]);
    if (!raw) continue;
    rooms.push(Object.freeze({
      roomIndex,
      cells: finiteNonNegative(raw.cells),
      goals: finiteNonNegative(raw.goals),
      boxes: finiteNonNegative(raw.boxes),
      surplus: finiteNonNegative(raw.surplus),
      forcedExports: finiteNonNegative(raw.forcedExports),
      forcedImports: finiteNonNegative(raw.forcedImports),
      interfacePhase: typeof raw.interfacePhase === "string" ? raw.interfacePhase : "pack",
      interfaceMinimumCrossings: finiteNonNegative(raw.interfaceMinimumCrossings),
      interfaceMinimumExportsBeforeImport: finiteNonNegative(raw.interfaceMinimumExportsBeforeImport),
      interfaceClearanceMethod: typeof raw.interfaceClearanceMethod === "string"
        ? raw.interfaceClearanceMethod : "no-mixed-flow",
    }));
  }
  return rooms.length ? Object.freeze(rooms) : undefined;
}

function extractMatchingDomainSummary(
  analysis: Record<string, unknown>,
): AnalyzerMatchingDomainSummary | undefined {
  const assignment = objectRecord(analysis.doorwayAssignment);
  if (!assignment || !Array.isArray(assignment.boxDomains)) return undefined;
  let ambiguousBoxCount = 0;
  let multiDomainTaskCount = 0;
  for (const raw of assignment.boxDomains) {
    const domain = objectRecord(raw);
    if (!domain || !Array.isArray(domain.allowedTargets)) continue;
    if (domain.allowedTargets.length > 1) ambiguousBoxCount++;
  }
  const tasks = Array.isArray(assignment.tasks) ? assignment.tasks : [];
  for (const raw of tasks) {
    const task = objectRecord(raw);
    if (!task || !Array.isArray(task.allowedTargets)) continue;
    if (task.allowedTargets.length > 1) multiDomainTaskCount++;
  }
  return Object.freeze({
    complete: assignment.complete === true,
    ambiguousBoxCount,
    multiDomainTaskCount,
    eliminatedEdges: finiteNonNegative(assignment.eliminatedEdges),
  });
}

function extractGoalAccessSummary(
  analysis: Record<string, unknown>,
): AnalyzerGoalAccessSummary | undefined {
  if (
    typeof analysis.blockedGoalAccess !== "number" ||
    typeof analysis.goalAccessPenalty !== "number"
  ) return undefined;
  return Object.freeze({
    blockedGoalCount: finiteNonNegative(analysis.blockedGoalAccess),
    accessPenalty: finiteNonNegative(analysis.goalAccessPenalty),
    accessClauseCount: finiteNonNegative(analysis.goalAccessClauses),
  });
}

function extractStructuralMetrics(
  analysis: Record<string, unknown>,
): AnalyzerStructuralMetrics | undefined {
  if (typeof analysis.legalPushes !== "number") return undefined;
  return Object.freeze({
    legalPushes: finiteNonNegative(analysis.legalPushes),
    surplusBoxes: finiteNonNegative(analysis.surplusBoxes),
    mandatoryDoorwayExports: finiteNonNegative(analysis.mandatoryDoorwayExports),
    mandatoryDoorwayImports: finiteNonNegative(analysis.mandatoryDoorwayImports),
    dependencyCount: finiteNonNegative(analysis.dependencyCount),
    tunnelCells: finiteNonNegative(analysis.tunnelCells),
    articulationCount: finiteNonNegative(analysis.articulations),
    searchScale: finiteNonNegative(analysis.searchScale),
    pressure: finiteNonNegative(analysis.pressure),
  });
}

export function analysisPlanFromAnalysis(
  analysisValue: unknown,
): SokomindAnalysisPlan | undefined {
  const analysis = objectRecord(analysisValue);
  const recommendations = objectRecord(analysis?.recommendations);
  if (!analysis || !recommendations) return undefined;
  const phases = Array.isArray(analysis.phases)
    ? analysis.phases.flatMap((value) => {
        const phase = objectRecord(value);
        return typeof phase?.id === "string" ? [phase.id] : [];
      })
    : [];
  const optionalNumber = (key: string): number | undefined => {
    const value = recommendations[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  };
  const strategicPlan = validateStrategicPlanContract(analysis.strategicPlan)
    ? structuredClone(analysis.strategicPlan) : undefined;
  const freezeTree = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  };
  if (strategicPlan) freezeTree(strategicPlan);
  const doorwayTasks = extractDoorwayTasks(analysis);
  const transitPrerequisites = extractTransitPrerequisites(analysis);
  const roomGuidance = extractRoomGuidance(analysis);
  const matchingDomainSummary = extractMatchingDomainSummary(analysis);
  const goalAccessSummary = extractGoalAccessSummary(analysis);
  const structuralMetrics = extractStructuralMetrics(analysis);
  return Object.freeze({
    difficulty:
      typeof analysis.difficulty === "string" ? analysis.difficulty : undefined,
    ...(strategicPlan ? {strategicPlan} : {}),
    phases: Object.freeze(phases),
    ...(doorwayTasks ? {doorwayTasks} : {}),
    ...(transitPrerequisites ? {transitPrerequisites} : {}),
    ...(roomGuidance ? {roomGuidance} : {}),
    ...(matchingDomainSummary ? {matchingDomainSummary} : {}),
    ...(goalAccessSummary ? {goalAccessSummary} : {}),
    ...(structuralMetrics ? {structuralMetrics} : {}),
    ...(doorwayTasks ? {
      structuralConclusions: Object.freeze({
        doorwayTasks,
        transitPrerequisites: transitPrerequisites ?? Object.freeze([]),
        matchingDomainComplete: matchingDomainSummary?.complete === true,
      }),
    } : {}),
    recommendations: Object.freeze({
      beamWidth: optionalNumber("beamWidth"),
      beamVisited: optionalNumber("beamVisited"),
      checkpointLimit: optionalNumber("checkpointLimit"),
      reverseWorkerLimit: optionalNumber("reverseWorkerLimit"),
      sideVisitedLimit: optionalNumber("sideVisitedLimit"),
      useSequenceMacros:
        typeof recommendations.useSequenceMacros === "boolean"
          ? recommendations.useSequenceMacros
          : undefined,
      firstPushWalkWeight: optionalNumber("firstPushWalkWeight"),
      moveAwareDiscovery: optionalNumber("moveAwareDiscovery"),
      macroIntermediateQuota: optionalNumber("macroIntermediateQuota"),
    }),
  });
}

export function legacyCheckpointFromValue(
  value: unknown,
  request: SolverRequest,
  pathPrefix: readonly unknown[] = [],
): LegacySearchCheckpoint | undefined {
  const checkpoint = objectRecord(value);
  const checkpointState = objectRecord(checkpoint?.state);
  if (
    !checkpoint ||
    !checkpointState ||
    !Array.isArray(checkpoint.path) ||
    !checkpoint.path.every((move) => legacyDirection(move) !== undefined) ||
    !Array.isArray(checkpointState.rows) ||
    !checkpointState.rows.every((row) => typeof row === "string") ||
    checkpointState.rows.join("\n") !== request.board.rows.join("\n") ||
    !Array.isArray(checkpointState.robot) ||
    checkpointState.robot.length !== 2 ||
    !checkpointState.robot.every(
      (coordinate) => Number.isSafeInteger(coordinate) && coordinate >= 0,
    ) ||
    !Array.isArray(checkpointState.boxes) ||
    !checkpointState.boxes.every((box) =>
      Array.isArray(box) &&
      box.length === 2 &&
      typeof box[0] === "string" &&
      /^\d+,\d+$/.test(box[0]) &&
      typeof box[1] === "string" &&
      box[1].trim().length > 0)
  ) {
    return undefined;
  }
  const path = Object.freeze([...pathPrefix, ...checkpoint.path]);
  let replay = request.snapshot;
  let replayPushes = 0;
  for (const move of path) {
    const direction = legacyDirection(move);
    if (!direction) return undefined;
    const transition = stepSnapshot(request.board, replay, direction);
    if (!transition.moved) return undefined;
    if (transition.pushed) replayPushes += 1;
    replay = transition.snapshot;
  }
  if (
    replay.robot.row !== checkpointState.robot[0] ||
    replay.robot.column !== checkpointState.robot[1]
  ) {
    return undefined;
  }
  const expectedBoxes = replay.boxes
    .map((box) => `${positionKey(box.position.row, box.position.column)}|${box.label}`)
    .sort();
  const checkpointBoxes = checkpointState.boxes
    .map((box) => `${box[0]}|${box[1]}`)
    .sort();
  if (
    expectedBoxes.length !== checkpointBoxes.length ||
    expectedBoxes.some((box, index) => box !== checkpointBoxes[index])
  ) {
    return undefined;
  }
  const estimate = optionalFiniteNonNegative(checkpoint.estimate);
  return Object.freeze({
    state: Object.freeze({
      rows: Object.freeze([...checkpointState.rows]) as readonly string[],
      robot: Object.freeze([
        checkpointState.robot[0],
        checkpointState.robot[1],
      ]) as readonly [number, number],
      boxes: Object.freeze(checkpointState.boxes.map((box) =>
        Object.freeze([box[0], box[1]]) as readonly [string, string])),
    }),
    path,
    cost: replayPushes,
    ...(estimate === undefined ? {} : { estimate }),
  });
}

export function withPreparedBoard(
  state: LegacyState,
  preparedBoard: LegacyPreparedBoard,
): LegacyState {
  return Object.freeze({
    ...state,
    preparedBoard,
  });
}

export function preparedBoardMemoryEstimate(
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

const DIRECTION_DELTAS = Object.freeze({
  up: Object.freeze({ row: -1, column: 0 }),
  down: Object.freeze({ row: 1, column: 0 }),
  left: Object.freeze({ row: 0, column: -1 }),
  right: Object.freeze({ row: 0, column: 1 }),
} as const satisfies Readonly<
  Record<Direction, Readonly<{ row: number; column: number }>>
>);

/** Replay a verified route into actual box identities and final goal choices. */
export function semanticDiversityTrace(
  request: SolverRequest,
  solution: SolverSolution,
): SemanticDiversityTrace | undefined {
  let snapshot = request.snapshot;
  const identities = new Map<string, string>();
  request.snapshot.boxes.forEach((box, index) => {
    const position = positionKey(box.position.row, box.position.column);
    identities.set(position, `${box.label}@${position}#${index}`);
  });
  const pushes: string[] = [];
  for (const step of solution.steps) {
    const delta = DIRECTION_DELTAS[step.direction];
    const from = positionKey(
      snapshot.robot.row + delta.row,
      snapshot.robot.column + delta.column,
    );
    const to = positionKey(
      snapshot.robot.row + 2 * delta.row,
      snapshot.robot.column + 2 * delta.column,
    );
    const transition = stepSnapshot(request.board, snapshot, step.direction);
    if (!transition.moved || transition.pushed !== (step.kind === "push")) {
      return undefined;
    }
    if (transition.pushed) {
      const identity = identities.get(from);
      if (!identity || identities.has(to)) return undefined;
      identities.delete(from);
      identities.set(to, identity);
      pushes.push(`${identity}:${from}>${to}`);
    }
    snapshot = transition.snapshot;
  }
  if (!snapshot.solved) return undefined;
  const goals = [...identities]
    .map(([position, identity]) => `${identity}>${position}`)
    .sort()
    .join(";");
  return Object.freeze({ pushChain: pushes.join(";"), boxGoals: goals });
}

export function asLegacyPath(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function isLegacyRecord(value: unknown): value is LegacyRecord {
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

export function legacyPathFromSolution(
  solution: SolverSolution,
): readonly LegacyDirection[] {
  return Object.freeze(
    solution.steps.map(({ direction }) => LEGACY_DIRECTION_NAMES[direction]),
  );
}
