import { isActionLog } from "../core/action-log.ts";
import { replayActionLog } from "../core/replay.ts";
import { isRecord } from "../core/type-guards.ts";
import type { PuzzleDefinition } from "../core/model.ts";
import {
  idbFencedGet,
  idbFencedUpdate,
} from "./idb-storage.ts";
import {
  DOCUMENT_APP_RESET_GENERATION,
  STORAGE_KEYS,
  readStoredValue,
  writeStoredValue,
} from "./storage.ts";
import { trackPersistenceResult } from "./persistence-health.ts";
import {
  isPuzzleRevisionFingerprint,
  puzzleRevisionFingerprint,
} from "../core/puzzle-revision.ts";

export { puzzleRevisionFingerprint } from "../core/puzzle-revision.ts";

export const PERSONAL_BEST_ROUTES_VERSION = 1 as const;
export const MAX_PERSONAL_BEST_ROUTES_PER_PUZZLE = 8;
export const MAX_PERSONAL_BEST_ROUTE_ACTIONS = 25_000;
export const MAX_PERSONAL_BEST_ROUTE_COUNT = 512;
export const MAX_PERSONAL_BEST_REPOSITORY_ACTIONS = 2_000_000;
const MAX_PERSONAL_BEST_PUZZLES = 250;

export interface PersonalBestRouteCandidate {
  readonly actionLog: string;
  readonly moves: number;
  readonly pushes: number;
  readonly elapsedMs?: number;
  readonly completedAt: string;
}

export interface SavedPersonalBestRoute extends PersonalBestRouteCandidate {
  readonly schemaVersion: typeof PERSONAL_BEST_ROUTES_VERSION;
  readonly routeId: string;
  readonly puzzleId: string;
  readonly puzzleFingerprint: string;
  readonly validation: "replay-verified";
}

export interface PersonalBestRouteHistory {
  readonly puzzleId: string;
  readonly puzzleFingerprint: string;
  /** Current best first, followed by increasingly older personal bests. */
  readonly routes: readonly SavedPersonalBestRoute[];
}

export interface PersonalBestRouteRepository {
  readonly version: typeof PERSONAL_BEST_ROUTES_VERSION;
  readonly resetGeneration: number;
  readonly puzzles: Readonly<Record<string, PersonalBestRouteHistory>>;
}

export interface PersonalBestRouteStorageStats {
  readonly status: "ready" | "missing" | "corrupt" | "unavailable";
  readonly puzzleCount: number;
  readonly routeCount: number;
  readonly actionCount: number;
  readonly approximateBytes: number;
  readonly discardedRecords: number;
}

export type PersonalBestRoutePromotion = Readonly<{
  status: "saved" | "not-better" | "rejected" | "unavailable";
  route?: SavedPersonalBestRoute;
}>;

export type PersonalBestRouteRead = Readonly<{
  status: "ready" | "missing" | "stale" | "corrupt" | "unavailable";
  routes: readonly SavedPersonalBestRoute[];
  discardedRecords: number;
}>;

export type PersonalBestRouteIndex = Readonly<{
  status: "ready" | "missing" | "corrupt" | "unavailable";
  /** Structurally valid candidates, ordered by most recent improvement. */
  puzzleIds: readonly string[];
}>;

interface NormalizedRepository {
  readonly repository: PersonalBestRouteRepository;
  readonly corrupt: boolean;
  readonly discardedRecords: number;
}

export const EMPTY_PERSONAL_BEST_ROUTE_REPOSITORY: PersonalBestRouteRepository =
  Object.freeze({
    version: PERSONAL_BEST_ROUTES_VERSION,
    resetGeneration: 0,
    puzzles: Object.freeze({}),
  });

function loadPersonalBestRouteResetGeneration(): number {
  const serialized = readStoredValue(STORAGE_KEYS.personalBestRoutesReset);
  if (!serialized) return 0;
  try {
    const value: unknown = JSON.parse(serialized);
    return isRecord(value) &&
      value.version === 1 &&
      isCount(value.generation)
      ? value.generation
      : 0;
  } catch {
    return 0;
  }
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeSavedRoute(value: unknown): SavedPersonalBestRoute | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schemaVersion !== PERSONAL_BEST_ROUTES_VERSION ||
    typeof value.routeId !== "string" ||
    value.routeId.length === 0 ||
    value.routeId.length > 160 ||
    typeof value.puzzleId !== "string" ||
    value.puzzleId.length === 0 ||
    value.puzzleId.length > 100 ||
    typeof value.puzzleFingerprint !== "string" ||
    !isPuzzleRevisionFingerprint(value.puzzleFingerprint) ||
    !isActionLog(value.actionLog) ||
    value.actionLog.length > MAX_PERSONAL_BEST_ROUTE_ACTIONS ||
    !isCount(value.moves) ||
    value.moves !== value.actionLog.length ||
    !isCount(value.pushes) ||
    value.pushes > value.moves ||
    !isCanonicalTimestamp(value.completedAt) ||
    value.validation !== "replay-verified" ||
    (value.elapsedMs !== undefined &&
      (typeof value.elapsedMs !== "number" ||
        !Number.isFinite(value.elapsedMs) ||
        value.elapsedMs < 0))
  ) {
    return undefined;
  }

  return Object.freeze({
    schemaVersion: PERSONAL_BEST_ROUTES_VERSION,
    routeId: value.routeId,
    puzzleId: value.puzzleId,
    puzzleFingerprint: value.puzzleFingerprint,
    actionLog: value.actionLog,
    moves: value.moves,
    pushes: value.pushes,
    ...(value.elapsedMs === undefined
      ? {}
      : { elapsedMs: Math.round(value.elapsedMs) }),
    completedAt: value.completedAt,
    validation: "replay-verified",
  });
}

function compareRoutes(
  first: SavedPersonalBestRoute,
  second: SavedPersonalBestRoute,
): number {
  if (first.moves !== second.moves) return first.moves - second.moves;
  if (first.pushes !== second.pushes) return first.pushes - second.pushes;
  const timestamp = second.completedAt.localeCompare(first.completedAt);
  return timestamp || first.routeId.localeCompare(second.routeId);
}

function normalizeRepositoryWithReport(value: unknown): NormalizedRepository {
  if (!isRecord(value) || value.version !== PERSONAL_BEST_ROUTES_VERSION ||
      !isRecord(value.puzzles)) {
    return {
      repository: EMPTY_PERSONAL_BEST_ROUTE_REPOSITORY,
      corrupt: value !== undefined,
      discardedRecords: 0,
    };
  }

  const resetGeneration = value.resetGeneration === undefined
    ? 0
    : isCount(value.resetGeneration)
      ? value.resetGeneration
      : undefined;
  if (resetGeneration === undefined) {
    return {
      repository: EMPTY_PERSONAL_BEST_ROUTE_REPOSITORY,
      corrupt: true,
      discardedRecords: 0,
    };
  }

  let discardedRecords = 0;
  const puzzles: Record<string, PersonalBestRouteHistory> = {};
  for (const [puzzleId, candidate] of Object.entries(value.puzzles)) {
    if (
      !puzzleId ||
      puzzleId.length > 100 ||
      !isRecord(candidate) ||
      candidate.puzzleId !== puzzleId ||
      typeof candidate.puzzleFingerprint !== "string" ||
      !isPuzzleRevisionFingerprint(candidate.puzzleFingerprint) ||
      !Array.isArray(candidate.routes)
    ) {
      discardedRecords += 1;
      continue;
    }

    const routeIds = new Set<string>();
    const routes: SavedPersonalBestRoute[] = [];
    for (const rawRoute of candidate.routes) {
      const route = normalizeSavedRoute(rawRoute);
      if (
        !route ||
        route.puzzleId !== puzzleId ||
        route.puzzleFingerprint !== candidate.puzzleFingerprint ||
        routeIds.has(route.routeId)
      ) {
        discardedRecords += 1;
        continue;
      }
      routeIds.add(route.routeId);
      routes.push(route);
    }
    routes.sort(compareRoutes);
    if (routes.length === 0) continue;
    puzzles[puzzleId] = Object.freeze({
      puzzleId,
      puzzleFingerprint: candidate.puzzleFingerprint,
      routes: Object.freeze(routes.slice(0, MAX_PERSONAL_BEST_ROUTES_PER_PUZZLE)),
    });
  }

  return {
    repository: boundPersonalBestRouteRepository({
      version: PERSONAL_BEST_ROUTES_VERSION,
      resetGeneration,
      puzzles,
    }),
    corrupt: false,
    discardedRecords,
  };
}

export function normalizePersonalBestRouteRepository(
  value: unknown,
): PersonalBestRouteRepository {
  return normalizeRepositoryWithReport(value).repository;
}

/**
 * Retains the current best for as many recent puzzles as fit, then fills the
 * remaining budget with recent prior bests. Summary progress remains intact
 * even when an old route falls outside these explicit bounds.
 */
export function boundPersonalBestRouteRepository(
  repository: PersonalBestRouteRepository,
): PersonalBestRouteRepository {
  const histories = Object.values(repository.puzzles)
    .sort((first, second) =>
      second.routes[0]!.completedAt.localeCompare(first.routes[0]!.completedAt))
    .slice(0, MAX_PERSONAL_BEST_PUZZLES);
  const selected = new Map<string, SavedPersonalBestRoute[]>();
  let routeCount = 0;
  let actionCount = 0;

  for (let routeIndex = 0;
    routeIndex < MAX_PERSONAL_BEST_ROUTES_PER_PUZZLE;
    routeIndex += 1) {
    for (const history of histories) {
      const route = history.routes[routeIndex];
      if (!route) continue;
      if (
        routeCount >= MAX_PERSONAL_BEST_ROUTE_COUNT ||
        actionCount + route.actionLog.length > MAX_PERSONAL_BEST_REPOSITORY_ACTIONS
      ) {
        continue;
      }
      const routes = selected.get(history.puzzleId) ?? [];
      routes.push(route);
      selected.set(history.puzzleId, routes);
      routeCount += 1;
      actionCount += route.actionLog.length;
    }
  }

  const puzzles: Record<string, PersonalBestRouteHistory> = {};
  for (const history of histories) {
    const routes = selected.get(history.puzzleId);
    if (!routes || routes.length === 0) continue;
    puzzles[history.puzzleId] = Object.freeze({
      puzzleId: history.puzzleId,
      puzzleFingerprint: history.puzzleFingerprint,
      routes: Object.freeze(routes),
    });
  }
  return Object.freeze({
    version: PERSONAL_BEST_ROUTES_VERSION,
    resetGeneration: repository.resetGeneration,
    puzzles: Object.freeze(puzzles),
  });
}

/** Canonically replays and verifies every counter before a route can be saved. */
export function verifyPersonalBestRoute(
  puzzle: PuzzleDefinition,
  candidate: PersonalBestRouteCandidate,
): SavedPersonalBestRoute | null {
  if (
    !isActionLog(candidate.actionLog) ||
    candidate.actionLog.length > MAX_PERSONAL_BEST_ROUTE_ACTIONS ||
    !isCount(candidate.moves) ||
    candidate.moves !== candidate.actionLog.length ||
    !isCount(candidate.pushes) ||
    candidate.pushes > candidate.moves ||
    !isCanonicalTimestamp(candidate.completedAt) ||
    (candidate.elapsedMs !== undefined &&
      (!Number.isFinite(candidate.elapsedMs) || candidate.elapsedMs < 0))
  ) {
    return null;
  }

  try {
    const replayed = replayActionLog(puzzle, candidate.actionLog);
    if (
      !replayed.solved ||
      replayed.moves !== candidate.moves ||
      replayed.pushes !== candidate.pushes ||
      replayed.actionLog !== candidate.actionLog
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const puzzleFingerprint = puzzleRevisionFingerprint(puzzle);
  const routeId = `${candidate.completedAt}:${candidate.moves}:${hashText(candidate.actionLog)}`;
  return Object.freeze({
    schemaVersion: PERSONAL_BEST_ROUTES_VERSION,
    routeId,
    puzzleId: puzzle.id,
    puzzleFingerprint,
    actionLog: candidate.actionLog,
    moves: candidate.moves,
    pushes: candidate.pushes,
    ...(candidate.elapsedMs === undefined || candidate.elapsedMs <= 0
      ? {}
      : { elapsedMs: Math.round(candidate.elapsedMs) }),
    completedAt: candidate.completedAt,
    validation: "replay-verified",
  });
}

export async function promoteVerifiedPersonalBestRoute(
  puzzle: PuzzleDefinition,
  route: SavedPersonalBestRoute,
  expectedResetGeneration = loadPersonalBestRouteResetGeneration(),
): Promise<PersonalBestRoutePromotion> {
  const reverified = verifyPersonalBestRoute(puzzle, route);
  if (
    !reverified ||
    reverified.routeId !== route.routeId ||
    reverified.puzzleFingerprint !== route.puzzleFingerprint
  ) {
    return Object.freeze({ status: "rejected" });
  }
  let promoted = false;
  let rejectedByReset = false;
  try {
    const result = await idbFencedUpdate(
      STORAGE_KEYS.personalBestRoutes,
      DOCUMENT_APP_RESET_GENERATION,
      (stored) => {
        const storedRepository = normalizePersonalBestRouteRepository(stored);
        if (storedRepository.resetGeneration > expectedResetGeneration) {
          rejectedByReset = true;
          return storedRepository;
        }
        const repository = storedRepository.resetGeneration === expectedResetGeneration
          ? storedRepository
          : {
              version: PERSONAL_BEST_ROUTES_VERSION,
              resetGeneration: expectedResetGeneration,
              puzzles: {},
            };
        const existing = repository.puzzles[route.puzzleId];
        const compatibleRoutes = existing?.puzzleFingerprint === route.puzzleFingerprint
          ? existing.routes.flatMap((candidate) => {
              const verified = verifyPersonalBestRoute(puzzle, candidate);
              return verified?.routeId === candidate.routeId ? [verified] : [];
            })
          : [];
        const compatible = compatibleRoutes.length > 0
          ? { ...existing!, routes: compatibleRoutes }
          : undefined;
        const currentBest = compatible?.routes[0];
        if (currentBest && currentBest.moves <= route.moves) return repository;

        promoted = true;
        const history: PersonalBestRouteHistory = {
          puzzleId: route.puzzleId,
          puzzleFingerprint: route.puzzleFingerprint,
          routes: [route, ...(compatible?.routes ?? [])],
        };
        return boundPersonalBestRouteRepository({
          version: PERSONAL_BEST_ROUTES_VERSION,
          resetGeneration: expectedResetGeneration,
          puzzles: { ...repository.puzzles, [route.puzzleId]: history },
        });
      },
    );
    if (!result.applied) return Object.freeze({ status: "unavailable" });
    if (rejectedByReset) return Object.freeze({ status: "rejected" });
    return promoted
      ? Object.freeze({ status: "saved", route })
      : Object.freeze({ status: "not-better" });
  } catch {
    return Object.freeze({ status: "unavailable" });
  }
}

export async function loadPersonalBestRoutes(
  puzzle: PuzzleDefinition,
): Promise<PersonalBestRouteRead> {
  try {
    const stored = await idbFencedGet<unknown>(
      STORAGE_KEYS.personalBestRoutes,
      DOCUMENT_APP_RESET_GENERATION,
    );
    if (stored === undefined) {
      return Object.freeze({ status: "missing", routes: [], discardedRecords: 0 });
    }
    const normalized = normalizeRepositoryWithReport(stored);
    if (normalized.corrupt) {
      return Object.freeze({ status: "corrupt", routes: [], discardedRecords: 0 });
    }
    if (
      normalized.repository.resetGeneration !==
      loadPersonalBestRouteResetGeneration()
    ) {
      return Object.freeze({
        status: "missing",
        routes: [],
        discardedRecords: normalized.discardedRecords,
      });
    }
    const history = normalized.repository.puzzles[puzzle.id];
    if (!history) {
      return Object.freeze({
        status: "missing",
        routes: [],
        discardedRecords: normalized.discardedRecords,
      });
    }
    if (history.puzzleFingerprint !== puzzleRevisionFingerprint(puzzle)) {
      return Object.freeze({
        status: "stale",
        routes: [],
        discardedRecords: normalized.discardedRecords,
      });
    }
    const routes = history.routes.flatMap((candidate) => {
      const verified = verifyPersonalBestRoute(puzzle, candidate);
      return verified?.routeId === candidate.routeId ? [verified] : [];
    });
    const discardedRecords = normalized.discardedRecords +
      history.routes.length - routes.length;
    if (routes.length === 0) {
      return Object.freeze({
        status: "corrupt",
        routes: [],
        discardedRecords,
      });
    }
    return Object.freeze({
      status: "ready",
      routes: Object.freeze(routes),
      discardedRecords,
    });
  } catch {
    return Object.freeze({ status: "unavailable", routes: [], discardedRecords: 0 });
  }
}

/**
 * Lists candidate puzzle IDs without loading catalog shards. Callers still use
 * loadPersonalBestRoutes with the current puzzle before presenting a route.
 */
export async function loadPersonalBestRouteIndex(): Promise<PersonalBestRouteIndex> {
  try {
    const stored = await idbFencedGet<unknown>(
      STORAGE_KEYS.personalBestRoutes,
      DOCUMENT_APP_RESET_GENERATION,
    );
    if (stored === undefined) {
      return Object.freeze({ status: "missing", puzzleIds: [] });
    }
    const normalized = normalizeRepositoryWithReport(stored);
    if (normalized.corrupt) {
      return Object.freeze({ status: "corrupt", puzzleIds: [] });
    }
    if (
      normalized.repository.resetGeneration !==
      loadPersonalBestRouteResetGeneration()
    ) {
      return Object.freeze({ status: "missing", puzzleIds: [] });
    }
    const puzzleIds = Object.values(normalized.repository.puzzles)
      .sort((first, second) =>
        second.routes[0]!.completedAt.localeCompare(first.routes[0]!.completedAt))
      .map((history) => history.puzzleId);
    return Object.freeze({
      status: "ready",
      puzzleIds: Object.freeze(puzzleIds),
    });
  } catch {
    return Object.freeze({ status: "unavailable", puzzleIds: [] });
  }
}

export async function loadPersonalBestRouteStorageStats(): Promise<PersonalBestRouteStorageStats> {
  try {
    const stored = await idbFencedGet<unknown>(
      STORAGE_KEYS.personalBestRoutes,
      DOCUMENT_APP_RESET_GENERATION,
    );
    if (stored === undefined) {
      return Object.freeze({
        status: "missing",
        puzzleCount: 0,
        routeCount: 0,
        actionCount: 0,
        approximateBytes: 0,
        discardedRecords: 0,
      });
    }
    const normalized = normalizeRepositoryWithReport(stored);
    if (normalized.corrupt) {
      return Object.freeze({
        status: "corrupt",
        puzzleCount: 0,
        routeCount: 0,
        actionCount: 0,
        approximateBytes: 0,
        discardedRecords: 0,
      });
    }
    if (
      normalized.repository.resetGeneration !==
      loadPersonalBestRouteResetGeneration()
    ) {
      return Object.freeze({
        status: "missing",
        puzzleCount: 0,
        routeCount: 0,
        actionCount: 0,
        approximateBytes: 0,
        discardedRecords: normalized.discardedRecords,
      });
    }
    const histories = Object.values(normalized.repository.puzzles);
    const routes = histories.flatMap((history) => history.routes);
    return Object.freeze({
      status: "ready",
      puzzleCount: histories.length,
      routeCount: routes.length,
      actionCount: routes.reduce((total, route) => total + route.actionLog.length, 0),
      approximateBytes: new TextEncoder().encode(
        JSON.stringify(normalized.repository),
      ).length,
      discardedRecords: normalized.discardedRecords,
    });
  } catch {
    return Object.freeze({
      status: "unavailable",
      puzzleCount: 0,
      routeCount: 0,
      actionCount: 0,
      approximateBytes: 0,
      discardedRecords: 0,
    });
  }
}

export async function clearPersonalBestRoutes(): Promise<boolean> {
  const currentGeneration = loadPersonalBestRouteResetGeneration();
  try {
    const result = await idbFencedUpdate(
      STORAGE_KEYS.personalBestRoutes,
      DOCUMENT_APP_RESET_GENERATION,
      (stored) => {
        const storedGeneration = normalizePersonalBestRouteRepository(stored)
          .resetGeneration;
        const baseGeneration = Math.max(currentGeneration, storedGeneration);
        if (baseGeneration >= Number.MAX_SAFE_INTEGER) {
          throw new Error("Replay reset generation is exhausted.");
        }
        return Object.freeze({
          version: PERSONAL_BEST_ROUTES_VERSION,
          resetGeneration: baseGeneration + 1,
          puzzles: Object.freeze({}),
        });
      },
    );
    if (!result.applied || !result.value) return false;
    const markerResult = trackPersistenceResult(writeStoredValue(
      STORAGE_KEYS.personalBestRoutesReset,
      JSON.stringify({
        version: 1,
        generation: result.value.resetGeneration,
      }),
    ));
    return markerResult.ok;
  } catch {
    return false;
  }
}
