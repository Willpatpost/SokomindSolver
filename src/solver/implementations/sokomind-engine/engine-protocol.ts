export const ENGINE_MODES = Object.freeze([
  "search",
  "bidir-forward",
  "bidir-reverse",
] as const);

export type EngineMode = (typeof ENGINE_MODES)[number];
export type EnginePayload = Readonly<Record<string, unknown>>;

export interface EngineCommand {
  readonly mode: EngineMode;
  readonly payload: EnginePayload;
}

export type EngineResultType =
  | "contour"
  | "done"
  | "landmark"
  | "landmarks"
  | "progress"
  | "records"
  | "reverse-starts";

/** Fields returned by search or consumed from incremental worker telemetry. */
export interface EngineResultPayload {
  readonly adaptiveMovePriorImprovements?: number;
  readonly analysis?: unknown;
  readonly arenaStates?: number;
  readonly compactArenaAllocatedBytes?: number;
  readonly compactPathBytes?: number;
  readonly checkpoint?: unknown;
  readonly checkpoints?: readonly unknown[];
  readonly cutoff?: boolean;
  readonly error?: string;
  readonly frontier?: number;
  readonly generated?: number;
  readonly improvements?: number;
  readonly moveVisited?: number;
  readonly moveImprovements?: number;
  readonly moveWindowAdaptiveStop?: boolean;
  readonly path?: readonly string[] | null;
  readonly peakFrontier?: number;
  readonly performance?: Readonly<Record<string, unknown>>;
  readonly permutationVisited?: number;
  readonly pushWindowImprovements?: number;
  readonly retained?: number;
  readonly status?: string;
  readonly terminationReason?: string;
  readonly visited?: number;
  readonly windows?: number;
}

export type EngineSearchResult = EngineResultPayload;

export interface EngineRecord {
  readonly id: string;
  readonly parent: string | null;
  readonly segment: string | readonly string[];
  readonly robot: readonly [number, number];
}

export interface EngineResult extends EngineResultPayload {
  readonly type: EngineResultType;
  readonly records?: readonly EngineRecord[];
}

export interface EngineRuntime {
  search(payload: EnginePayload): EngineSearchResult;
  bidirectionalSide(payload: EnginePayload): void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function isPreparedBoardEnvelope(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.schemaVersion === "number" &&
    Number.isSafeInteger(value.schemaVersion) &&
    value.schemaVersion > 0 &&
    isNonEmptyString(value.boardContentKey);
}

function isLegacyState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !Array.isArray(value.rows) ||
    value.rows.length === 0 ||
    !value.rows.every(
      (row) => typeof row === "string" && row.length > 0,
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(value.robot) ||
    value.robot.length !== 2 ||
    !value.robot.every(isNonNegativeSafeInteger)
  ) {
    return false;
  }
  if (
    !Array.isArray(value.boxes) ||
    !value.boxes.every(
      (box) =>
        Array.isArray(box) &&
        box.length === 2 &&
        isNonEmptyString(box[0]) &&
        isNonEmptyString(box[1]),
    )
  ) {
    return false;
  }
  return value.preparedBoard === undefined ||
    isPreparedBoardEnvelope(value.preparedBoard);
}

export function isEngineCommand(value: unknown): value is EngineCommand {
  if (!isRecord(value)) return false;
  if (!ENGINE_MODES.some((mode) => mode === value.mode)) return false;
  if (!isRecord(value.payload) || !isLegacyState(value.payload.state)) {
    return false;
  }
  return value.mode !== "search" || isNonEmptyString(value.payload.algorithm);
}

const NON_NEGATIVE_INTEGER_FIELDS = Object.freeze([
  "arenaStates",
  "compactArenaAllocatedBytes",
  "compactPathBytes",
  "frontier",
  "generated",
  "moveVisited",
  "peakFrontier",
  "retained",
  "visited",
] as const);

function hasOptionalNonNegativeInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return value[key] === undefined ||
    (typeof value[key] === "number" &&
      Number.isSafeInteger(value[key]) &&
      value[key] >= 0);
}

function hasOptionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function isEngineRecord(value: unknown): value is EngineRecord {
  if (!isRecord(value)) return false;
  const segment = value.segment;
  const robot = value.robot;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.parent === null || typeof value.parent === "string") &&
    (typeof segment === "string" ||
      (Array.isArray(segment) &&
        segment.every((step) => typeof step === "string"))) &&
    Array.isArray(robot) &&
    robot.length === 2 &&
    robot.every(
      (coordinate) =>
        typeof coordinate === "number" &&
        Number.isSafeInteger(coordinate) &&
        coordinate >= 0,
    )
  );
}

function isTelemetryValue(
  value: unknown,
  seen: Set<unknown>,
  depth: number,
): boolean {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 8 || seen.has(value)) return false;
  if (Array.isArray(value)) {
    seen.add(value);
    const valid = value.every((entry) => isTelemetryValue(entry, seen, depth + 1));
    seen.delete(value);
    return valid;
  }
  if (!isRecord(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((entry) =>
    isTelemetryValue(entry, seen, depth + 1)
  );
  seen.delete(value);
  return valid;
}

function hasValidOptionalPerformance(
  value: Readonly<Record<string, unknown>>,
): boolean {
  return value.performance === undefined ||
    (isRecord(value.performance) &&
      isTelemetryValue(value.performance, new Set<unknown>(), 0));
}

export function isEngineResult(value: unknown): value is EngineResult {
  if (!isRecord(value)) return false;
  if (!ENGINE_RESULT_TYPES.has(value.type)) return false;
  if (NON_NEGATIVE_INTEGER_FIELDS.some(
    (field) => !hasOptionalNonNegativeInteger(value, field),
  )) {
    return false;
  }
  if (
    value.path !== undefined &&
    value.path !== null &&
    (!Array.isArray(value.path) ||
      value.path.some((step) => typeof step !== "string"))
  ) {
    return false;
  }
  if (
    value.records !== undefined &&
    (!Array.isArray(value.records) || !value.records.every(isEngineRecord))
  ) {
    return false;
  }
  if (value.checkpoints !== undefined && !Array.isArray(value.checkpoints)) {
    return false;
  }
  if (value.type === "records" && !Array.isArray(value.records)) return false;
  if (!hasOptionalString(value, "status")) return false;
  if (!hasOptionalString(value, "terminationReason")) return false;
  if (!hasOptionalString(value, "error")) return false;
  if (value.cutoff !== undefined && typeof value.cutoff !== "boolean") return false;
  if (!hasValidOptionalPerformance(value)) return false;
  return true;
}

const ENGINE_RESULT_TYPES: ReadonlySet<unknown> = new Set<unknown>([
  "contour",
  "done",
  "landmark",
  "landmarks",
  "progress",
  "records",
  "reverse-starts",
]);

function failedResult(
  terminationReason: "invalid-command" | "worker-exception",
  error: string,
): EngineResult {
  return {
    type: "done",
    status: "failed",
    terminationReason,
    error,
    path: null,
    visited: 0,
    generated: 0,
  };
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validates and dispatches one worker command. Bidirectional searches publish
 * their own incremental results and therefore return `null` here.
 */
export function dispatchEngineCommand(
  value: unknown,
  runtime: EngineRuntime,
): EngineResult | null {
  try {
    if (!isEngineCommand(value)) {
      return failedResult("invalid-command", "Malformed engine command.");
    }

    if (value.mode === "bidir-forward" || value.mode === "bidir-reverse") {
      runtime.bidirectionalSide({
        ...value.payload,
        mode: value.mode,
      });
      return null;
    }

    const payload = runtime.search(value.payload);
    if (!isRecord(payload)) {
      return failedResult(
        "worker-exception",
        "Engine returned a malformed search result.",
      );
    }
    const result = {
      ...payload,
      type: "done",
    };
    return isEngineResult(result)
      ? result
      : failedResult(
          "worker-exception",
          "Engine returned a malformed search result.",
        );
  } catch (error) {
    return failedResult("worker-exception", serializeError(error));
  }
}
