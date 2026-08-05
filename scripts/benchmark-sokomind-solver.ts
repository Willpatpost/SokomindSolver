/**
 * Reproducible Sokomind Solver benchmark and tuning boundary.
 *
 * Examples:
 *   npm.cmd run benchmark:solver -- --puzzle=huge
 *   npm.cmd run benchmark:solver -- --puzzle=master-exchange --rewrite-visited=0
 *
 * An optimizer may provide a partial JSON tuning profile through
 * SOKOMIND_TUNING_JSON. Output is JSON Lines so it can be consumed without
 * scraping human-oriented logs.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PUZZLE_BY_ID } from "../src/catalog/puzzles.ts";
import { createSession, type PuzzleDefinition } from "../src/core/index.ts";
import type { SolverRequest } from "../src/solver/contracts.ts";
import { search } from "../src/solver/implementations/sokomind-engine/engine.generated.js";
import {
  sokomindDiscoveryBeamWidth,
  sokomindSolverMetadata,
  solutionFromLegacyPath,
  toLegacyState,
} from "../src/solver/implementations/sokomind-solver.ts";
import {
  resolveSokomindTuning,
  sokomindTuningFingerprint,
  sokomindTuningPayload,
  type SokomindTuningOverrides,
  type SokomindTuningProfile,
} from "../src/solver/implementations/sokomind-tuning.ts";
import { verifySolverSolution } from "../src/solver/verification.ts";

const DEFAULT_CORPUS = Object.freeze([
  "beginner-three",
  "inter-rooms",
  "classic-1",
  "boxoban-hard-000-0000",
  "microban-005",
  "large",
  "adv-four-color",
  "theme-parking",
  "open-field",
  "microban-126",
  "expert-maze",
  "seeminglyhard-008",
  "huge",
  "master-exchange",
  "master-typed-grid",
  "microban-145",
  "microban-146",
  "caleb-022",
]);

interface BenchmarkOptions {
  readonly puzzleIds: readonly string[];
  readonly rewriteVisited: number;
  readonly rewritePasses: number;
  readonly permutationVisited: number | undefined;
  readonly pushWindowVisited: number | undefined;
  readonly moveWindowVisited: number | undefined;
  readonly perMoveWindowVisited: number;
  readonly moveWindowAttempts: number;
  readonly moveWindowExtraPushes: number;
  readonly finalMoveVisited: number;
  readonly caseTimeoutMs: number;
  readonly beamWidth: number | undefined;
  readonly memoryMiB: number;
  readonly seed: number;
}

function numberArgument(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix));
  if (!raw) return fallback;
  const value = Number(raw.slice(prefix.length));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative finite number.`);
  }
  return Math.floor(value);
}

function optionsFromArguments(): BenchmarkOptions {
  const puzzleIds = process.argv
    .filter((argument) => argument.startsWith("--puzzle="))
    .map((argument) => argument.slice("--puzzle=".length))
    .filter(Boolean);
  return Object.freeze({
    puzzleIds: Object.freeze(
      puzzleIds.length > 0 ? puzzleIds : [...DEFAULT_CORPUS],
    ),
    rewriteVisited: numberArgument("rewrite-visited", 50_000),
    rewritePasses: numberArgument("rewrite-passes", 1),
    permutationVisited:
      process.argv.some((argument) =>
        argument.startsWith("--permutation-visited="),
      )
        ? numberArgument("permutation-visited", 0)
        : undefined,
    pushWindowVisited:
      process.argv.some((argument) =>
        argument.startsWith("--push-window-visited="),
      )
        ? numberArgument("push-window-visited", 0)
        : undefined,
    moveWindowVisited:
      process.argv.some((argument) =>
        argument.startsWith("--move-window-visited="),
      )
        ? numberArgument("move-window-visited", 0)
        : undefined,
    perMoveWindowVisited: numberArgument("per-move-window-visited", 4_000),
    moveWindowAttempts: numberArgument("move-window-attempts", 12),
    moveWindowExtraPushes: numberArgument("move-window-extra-pushes", 4),
    finalMoveVisited: numberArgument("final-move-visited", 0),
    caseTimeoutMs: numberArgument("case-timeout-ms", 180_000),
    memoryMiB: numberArgument("memory-mib", 768),
    seed: numberArgument("seed", 0),
    beamWidth:
      process.argv.some((argument) => argument.startsWith("--beam-width="))
        ? numberArgument("beam-width", 0)
        : undefined,
  });
}

function tuningOverridesFromEnvironment(): SokomindTuningOverrides {
  const raw = process.env.SOKOMIND_TUNING_JSON;
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SOKOMIND_TUNING_JSON must contain a JSON object.");
  }
  return parsed as SokomindTuningOverrides;
}

function requestFor(puzzle: PuzzleDefinition): SolverRequest {
  const session = createSession(puzzle);
  return Object.freeze({
    board: session.board,
    snapshot: session.snapshot,
    objective: Object.freeze({ kind: "moves" as const }),
  });
}

function isStructural(request: SolverRequest): boolean {
  return request.snapshot.boxes.length >= 10 || request.board.floor.length >= 100;
}

function structuralPayload(
  request: SolverRequest,
  tuning: Readonly<Record<string, number>>,
  options: BenchmarkOptions,
): Readonly<Record<string, unknown>> {
  const memoryBytes = options.memoryMiB * 1024 * 1024;
  return Object.freeze({
    algorithm: "plan-macro-beam",
    state: toLegacyState(request),
    maxDepth: 460,
    maxVisited: 6_000,
    transpositionLimit:
      memoryBytes <= 384 * 1024 * 1024
        ? 24_000
        : memoryBytes <= 768 * 1024 * 1024
          ? 36_000
          : memoryBytes <= 1_536 * 1024 * 1024
            ? 48_000
            : 60_000,
    sequenceMacroExplored: 48,
    sequenceMacroResults: 4,
    targetedMacroExplored: 64,
    progressIntervalMs: 5_000,
    ...tuning,
  });
}

function discoveryPayload(
  request: SolverRequest,
  tuning: Readonly<Record<string, number>>,
  options: BenchmarkOptions,
): Readonly<Record<string, unknown>> {
  const moderate =
    request.snapshot.boxes.length >= 5 || request.board.floor.length >= 45;
  const memoryBytes = options.memoryMiB * 1024 * 1024;
  return Object.freeze({
    algorithm: "ultimate",
    state: toLegacyState(request),
    maxDepth: moderate ? 360 : 180,
    maxVisited: moderate ? 180_000 : 80_000,
    maxGenerated: moderate ? 1_200_000 : 300_000,
    transpositionLimit: !moderate
      ? 30_000
      : memoryBytes <= 384 * 1024 * 1024
        ? 24_000
        : memoryBytes <= 768 * 1024 * 1024
          ? 36_000
          : memoryBytes <= 1_536 * 1024 * 1024
            ? 48_000
            : 60_000,
    beamWidth:
      options.beamWidth ??
      sokomindDiscoveryBeamWidth(
        request.snapshot.boxes.length,
        request.board.floor.length,
        memoryBytes,
      ),
    seed: options.seed,
    sequenceMacros: moderate,
    checkpointLimit: 8,
    progressInterval: 5_000,
    progressIntervalMs: 5_000,
    ...tuning,
  });
}

function rewritePayload(
  request: SolverRequest,
  solutionPath: readonly string[],
  options: BenchmarkOptions,
  profile: SokomindTuningProfile,
): Readonly<Record<string, unknown>> {
  const maxVisited = options.rewriteVisited;
  const permutationVisited = Math.floor(maxVisited * 0.2);
  const moveScale = profile.rewriteMoveWindowScale;
  return Object.freeze({
    algorithm: "solution-window-rewrite",
    state: toLegacyState(request),
    solutionPath,
    maxVisited,
    permutationVisited: options.permutationVisited ?? permutationVisited,
    permutationWindowPushes: [8, 16, 32],
    perPermutationWindowVisited: 1_500,
    windowPushes: [8, 16, 32],
    windowVisited: profile.rewriteWindowVisited,
    windowTotalVisited:
      options.pushWindowVisited ?? Math.floor(maxVisited * 0.3),
    frontierLimit: profile.rewriteWindowVisited,
    moveWindowVisited:
      options.moveWindowVisited ?? Math.floor(maxVisited * 0.5 * moveScale),
    moveWindowPushes: [1, 2, 4],
    moveWindowAttempts: options.moveWindowAttempts,
    perMoveWindowVisited: Math.floor(options.perMoveWindowVisited * moveScale),
    moveWindowExtraPushes: options.moveWindowExtraPushes,
    moveWindowMinimumOverhead: 6,
  });
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function puzzleFitness(
  solved: boolean,
  verified: boolean,
  moves: number | undefined,
  boxes: number,
  floor: number,
  elapsedMs: number,
  timeoutMs: number,
): number {
  if (!solved || !verified || moves === undefined) return -1;
  const movesBudget = Math.max(1, boxes * floor * 0.3);
  const quality = Math.max(0, Math.min(1, 1 - moves / movesBudget));
  const timeRatio = Math.min(1, timeoutMs / Math.max(1, elapsedMs));
  return quality * Math.pow(timeRatio, 0.1);
}

function searchConfiguration(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number | string>> {
  return Object.freeze(
    Object.fromEntries(
      [
        "algorithm",
        "seed",
        "beamWidth",
        "transpositionLimit",
        "maxVisited",
        "maxGenerated",
        "maxDepth",
      ]
        .filter((key) => {
          const value = payload[key];
          return (
            typeof value === "string" ||
            (typeof value === "number" && Number.isFinite(value))
          );
        })
        .map((key) => [key, payload[key] as number | string]),
    ),
  );
}

const options = optionsFromArguments();
const childMode = process.argv.includes("--child");
if (!childMode) {
  const scriptPath = fileURLToPath(import.meta.url);
  const forwardedArguments = process.argv
    .slice(2)
    .filter(
      (argument) =>
        argument !== "--child" &&
        !argument.startsWith("--puzzle=") &&
        !argument.startsWith("--case-timeout-ms="),
    );
  const fitnessScores: number[] = [];
  let solvedCount = 0;
  let totalMoves = 0;
  let totalElapsedMs = 0;
  for (const puzzleId of options.puzzleIds) {
    const startedAt = performance.now();
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        scriptPath,
        "--child",
        `--puzzle=${puzzleId}`,
        `--case-timeout-ms=${options.caseTimeoutMs}`,
        ...forwardedArguments,
      ],
      {
        encoding: "utf8",
        env: process.env,
        timeout: options.caseTimeoutMs,
        windowsHide: true,
      },
    );
    if (child.stdout) {
      process.stdout.write(child.stdout);
      for (const line of child.stdout.split("\n").filter(Boolean)) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (typeof record.fitness === "number") {
            fitnessScores.push(record.fitness);
          } else {
            fitnessScores.push(-1);
          }
          if (record.solved) solvedCount += 1;
          totalMoves += numeric(record.moves);
          totalElapsedMs += numeric(record.elapsedMs);
        } catch { /* skip malformed lines */ }
      }
    }
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error || child.signal || child.status !== 0) {
      fitnessScores.push(-1);
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          puzzleId,
          solved: false,
          verified: false,
          fitness: -1,
          terminationReason:
            child.error?.message ??
            (child.signal
              ? `terminated-${child.signal}`
              : `exit-${child.status ?? "unknown"}`),
          elapsedMs: Math.round(performance.now() - startedAt),
        })}\n`,
      );
    }
  }
  const total = fitnessScores.length || 1;
  const meanFitness = fitnessScores.reduce((a, b) => a + b, 0) / total;
  const minFitness = fitnessScores.length > 0
    ? Math.min(...fitnessScores)
    : -1;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    type: "summary",
    puzzleCount: fitnessScores.length,
    solvedCount,
    solveRate: solvedCount / total,
    meanFitness,
    minFitness,
    totalMoves,
    totalElapsedMs: Math.round(totalElapsedMs),
    tuning: sokomindTuningFingerprint(
      resolveSokomindTuning(tuningOverridesFromEnvironment()),
    ),
  })}\n`);
  process.exit(0);
}

const tuning = resolveSokomindTuning(tuningOverridesFromEnvironment());
const tuningPayload = sokomindTuningPayload(tuning);
const originalPostMessage = globalThis.postMessage;
globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;

try {
  for (const puzzleId of options.puzzleIds) {
    const puzzle = PUZZLE_BY_ID[puzzleId];
    if (!puzzle) {
      throw new Error(`Unknown benchmark puzzle "${puzzleId}".`);
    }
    const request = requestFor(puzzle);
    const heapBeforeBytes = process.memoryUsage().heapUsed;
    const startedAt = performance.now();

    const structuralCase = isStructural(request);
    let initialPayload = structuralCase
      ? structuralPayload(request, tuningPayload, options)
      : discoveryPayload(request, tuningPayload, options);
    const initialConfigurations = [searchConfiguration(initialPayload)];
    let initial = search(initialPayload);
    let lane = structuralCase ? "structural" : "discovery";
    if (!Array.isArray(initial.path) && lane === "structural") {
      initialPayload = discoveryPayload(request, tuningPayload, options);
      initialConfigurations.push(searchConfiguration(initialPayload));
      initial = search(initialPayload);
      lane = "structural+discovery";
    }

    const initialPath = Array.isArray(initial.path) ? initial.path : null;
    let bestPath = initialPath;
    let rewriteVisited = 0;
    let rewriteImprovements = 0;
    let rewritePasses = 0;
    let rewriteMoveVisited = 0;
    let rewriteMoveImprovements = 0;
    let rewritePermutationVisited = 0;
    let rewriteWindows = 0;
    for (
      let pass = 0;
      bestPath &&
      options.rewriteVisited > 0 &&
      pass < options.rewritePasses;
      pass += 1
    ) {
      const rewrite = search(
        rewritePayload(request, bestPath, options, tuning),
      );
      rewriteVisited += numeric(rewrite.visited);
      rewriteImprovements += numeric(rewrite.improvements);
      rewriteMoveVisited += numeric(rewrite.moveVisited);
      rewriteMoveImprovements += numeric(rewrite.moveImprovements);
      rewritePermutationVisited += numeric(rewrite.permutationVisited);
      rewriteWindows += numeric(rewrite.windows);
      rewritePasses += 1;
      if (
        !Array.isArray(rewrite.path) ||
        rewrite.path.length >= bestPath.length
      ) {
        break;
      }
      bestPath = rewrite.path;
    }
    if (bestPath && options.finalMoveVisited > 0) {
      const moveOnlyOptions: BenchmarkOptions = {
        ...options,
        rewriteVisited: options.finalMoveVisited,
        permutationVisited: 0,
        pushWindowVisited: 0,
        moveWindowVisited: options.finalMoveVisited,
      };
      const rewrite = search(
        rewritePayload(request, bestPath, moveOnlyOptions, tuning),
      );
      rewriteVisited += numeric(rewrite.visited);
      rewriteImprovements += numeric(rewrite.improvements);
      rewriteMoveVisited += numeric(rewrite.moveVisited);
      rewriteMoveImprovements += numeric(rewrite.moveImprovements);
      rewritePermutationVisited += numeric(rewrite.permutationVisited);
      rewriteWindows += numeric(rewrite.windows);
      rewritePasses += 1;
      if (
        Array.isArray(rewrite.path) &&
        rewrite.path.length < bestPath.length
      ) {
        bestPath = rewrite.path;
      }
    }

    const solution = bestPath
      ? solutionFromLegacyPath(request, bestPath)
      : null;
    const verified =
      solution !== null && verifySolverSolution(request, solution).valid;
    const elapsedMs = performance.now() - startedAt;
    const memory = process.memoryUsage();
    const solved = solution !== null;
    const moves = solution?.moves;
    const boxes = request.snapshot.boxes.length;
    const floor = request.board.floor.length;
    const fitness = puzzleFitness(
      solved,
      verified,
      moves,
      boxes,
      floor,
      elapsedMs,
      options.caseTimeoutMs,
    );
    const record = {
      schemaVersion: 1,
      puzzleId,
      title: puzzle.title,
      typed: request.snapshot.boxes.some(({ label }) => label !== "X"),
      boxes,
      floor,
      lane,
      solved,
      verified,
      fitness,
      initialMoves: initialPath?.length,
      moves,
      pushes: solution?.pushes,
      elapsedMs: Math.round(elapsedMs),
      initialVisited: numeric(initial.visited),
      initialGenerated: numeric(initial.generated),
      initialRetained: numeric(initial.retained),
      initialPeakFrontier: numeric(initial.peakFrontier),
      rewriteVisited,
      rewriteImprovements,
      rewritePasses,
      rewriteMoveVisited,
      rewriteMoveImprovements,
      rewritePermutationVisited,
      rewriteWindows,
      heapBeforeBytes,
      heapAfterBytes: memory.heapUsed,
      heapDeltaBytes: memory.heapUsed - heapBeforeBytes,
      rssBytes: memory.rss,
      processMaxRssKiB: process.resourceUsage().maxRSS,
      tuning: sokomindTuningFingerprint(tuning),
      configuration: {
        solverVersion: sokomindSolverMetadata.version,
        seed: options.seed,
        memoryLimitMiB: options.memoryMiB,
        caseTimeoutMs: options.caseTimeoutMs,
        initialPlans: initialConfigurations,
        rewriteVisited: options.rewriteVisited,
        rewritePasses: options.rewritePasses,
        permutationVisited:
          options.permutationVisited ??
          Math.floor(options.rewriteVisited * 0.2),
        pushWindowVisited:
          options.pushWindowVisited ??
          Math.floor(options.rewriteVisited * 0.3),
        moveWindowVisited:
          options.moveWindowVisited ??
          Math.floor(options.rewriteVisited * 0.5),
        perMoveWindowVisited: options.perMoveWindowVisited,
        moveWindowAttempts: options.moveWindowAttempts,
        moveWindowExtraPushes: options.moveWindowExtraPushes,
        finalMoveVisited: options.finalMoveVisited,
      },
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
} finally {
  if (originalPostMessage === undefined) {
    Reflect.deleteProperty(globalThis, "postMessage");
  } else {
    globalThis.postMessage = originalPostMessage;
  }
}
