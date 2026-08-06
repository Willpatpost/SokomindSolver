import type { SolverRequest } from "../contracts.ts";

export type SokomindMode = "fast" | "quality" | "optimal";

export interface SokomindRequestOptions {
  readonly mode: SokomindMode;
  readonly proofAlgorithm: "auto" | "astar" | "ida-star";
  readonly deterministic: boolean;
  readonly maximumIncumbents: number;
  readonly harvestElapsedMs: number;
  readonly proofParallelism: number;
  readonly idaReachabilitySnapshots: "all" | "periodic" | "none";
  readonly idaSnapshotPeriod: number;
}

export const DEFAULT_SOKOMIND_REQUEST_OPTIONS: SokomindRequestOptions =
  Object.freeze({
    mode: "fast",
    proofAlgorithm: "auto",
    deterministic: false,
    maximumIncumbents: 4,
    harvestElapsedMs: 5_000,
    proofParallelism: 1,
    idaReachabilitySnapshots: "periodic",
    idaSnapshotPeriod: 4,
  });

const VALID_MODES: ReadonlySet<string> = new Set(["fast", "quality", "optimal"]);
const VALID_PROOF_ALGORITHMS: ReadonlySet<string> = new Set(["auto", "astar", "ida-star"]);
const VALID_IDA_SNAPSHOTS: ReadonlySet<string> = new Set(["all", "periodic", "none"]);

function validateEnum(
  key: string,
  value: unknown,
  valid: ReadonlySet<string>,
): string {
  if (typeof value !== "string" || !valid.has(value)) {
    const allowed = [...valid].join(", ");
    throw new Error(
      `sokomind-solver: ${key} must be ${allowed}; got '${String(value)}'`,
    );
  }
  return value;
}

function validateBoolean(key: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error(
      `sokomind-solver: ${key} must be a boolean; got ${typeof value}`,
    );
  }
  return value;
}

function validateInt(
  key: string,
  value: unknown,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      `sokomind-solver: ${key} must be an integer between ${min} and ${max}; got ${String(value)}`,
    );
  }
  return value;
}

export function parseSokomindOptions(raw: unknown): SokomindRequestOptions {
  if (raw == null) return DEFAULT_SOKOMIND_REQUEST_OPTIONS;

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("sokomind-solver options must be a plain object");
  }

  const obj = raw as Record<string, unknown>;
  const knownKeys = new Set(
    Object.keys(DEFAULT_SOKOMIND_REQUEST_OPTIONS),
  );

  const unknownKeys = Object.keys(obj).filter((k) => !knownKeys.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(
      `sokomind-solver: unknown option(s): ${unknownKeys.join(", ")}`,
    );
  }

  const validated: { -readonly [K in keyof SokomindRequestOptions]?: SokomindRequestOptions[K] } = {};

  if ("mode" in obj) {
    validated.mode = validateEnum("mode", obj.mode, VALID_MODES) as SokomindMode;
  }
  if ("proofAlgorithm" in obj) {
    validated.proofAlgorithm = validateEnum(
      "proofAlgorithm",
      obj.proofAlgorithm,
      VALID_PROOF_ALGORITHMS,
    ) as SokomindRequestOptions["proofAlgorithm"];
  }
  if ("deterministic" in obj) {
    validated.deterministic = validateBoolean("deterministic", obj.deterministic);
  }
  if ("maximumIncumbents" in obj) {
    validated.maximumIncumbents = validateInt(
      "maximumIncumbents",
      obj.maximumIncumbents,
      1,
      8,
    );
  }
  if ("harvestElapsedMs" in obj) {
    validated.harvestElapsedMs = validateInt(
      "harvestElapsedMs",
      obj.harvestElapsedMs,
      0,
      30_000,
    );
  }
  if ("proofParallelism" in obj) {
    validated.proofParallelism = validateInt(
      "proofParallelism",
      obj.proofParallelism,
      1,
      32,
    );
  }
  if ("idaReachabilitySnapshots" in obj) {
    validated.idaReachabilitySnapshots = validateEnum(
      "idaReachabilitySnapshots",
      obj.idaReachabilitySnapshots,
      VALID_IDA_SNAPSHOTS,
    ) as SokomindRequestOptions["idaReachabilitySnapshots"];
  }
  if ("idaSnapshotPeriod" in obj) {
    validated.idaSnapshotPeriod = validateInt(
      "idaSnapshotPeriod",
      obj.idaSnapshotPeriod,
      1,
      64,
    );
  }

  return Object.freeze({
    ...DEFAULT_SOKOMIND_REQUEST_OPTIONS,
    ...validated,
  });
}

export function extractSokomindOptions(
  request: SolverRequest,
): SokomindRequestOptions {
  return parseSokomindOptions(request.options?.["sokomind-solver"]);
}
