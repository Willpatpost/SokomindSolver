import assert from "node:assert/strict";
import { createSession, decodeActionLog, stepSnapshot } from "../src/core/index.ts";
import type { Direction, GameSnapshot, ParsedBoard } from "../src/core/index.ts";
import { PUZZLE_BY_ID } from "../src/catalog/puzzles.ts";
import { createNodeSolverAdapter } from "../src/solver/node-runner.ts";
import { verifySolverSolution } from "../src/solver/verification.ts";

interface BoxSchedule {
  boxId: string;
  label: string;
  pushCount: number;
  phaseCount: number;
  firstPushStep: number;
  lastPushStep: number;
  prePushWalking: number;
  goalCell: { row: number; column: number } | null;
}

interface RouteAnalysis {
  source: string;
  moves: number;
  pushes: number;
  walks: number;
  boxSwitches: number;
  boxes: BoxSchedule[];
}

interface RouteDiff {
  metric: string;
  left: number | string;
  right: number | string;
  delta: number | string;
}

function analyzeRoute(
  board: ParsedBoard,
  snapshot: GameSnapshot,
  directions: readonly Direction[],
  source: string,
): RouteAnalysis {
  let current = snapshot;
  let lastPushedBoxId: string | null = null;
  let walksSinceLastPush = 0;
  let boxSwitches = 0;
  let totalPushes = 0;
  let totalWalks = 0;

  const boxPushes = new Map<string, {
    pushCount: number;
    phaseCount: number;
    firstPushStep: number;
    lastPushStep: number;
    prePushWalking: number;
    inPhase: boolean;
  }>();

  for (const box of snapshot.boxes) {
    boxPushes.set(box.id, {
      pushCount: 0,
      phaseCount: 0,
      firstPushStep: -1,
      lastPushStep: -1,
      prePushWalking: 0,
      inPhase: false,
    });
  }

  for (let i = 0; i < directions.length; i++) {
    const transition = stepSnapshot(board, current, directions[i]);
    assert.ok(transition.moved, `Step ${i} blocked`);

    if (transition.pushed && transition.pushedBoxId) {
      totalPushes++;
      const entry = boxPushes.get(transition.pushedBoxId)!;
      entry.pushCount++;
      entry.prePushWalking += walksSinceLastPush;
      if (entry.firstPushStep === -1) entry.firstPushStep = i;
      entry.lastPushStep = i;
      if (!entry.inPhase) {
        entry.phaseCount++;
        entry.inPhase = true;
      }

      if (lastPushedBoxId !== null && lastPushedBoxId !== transition.pushedBoxId) {
        boxSwitches++;
      }

      for (const [id, e] of boxPushes) {
        if (id !== transition.pushedBoxId) e.inPhase = false;
      }

      lastPushedBoxId = transition.pushedBoxId;
      walksSinceLastPush = 0;
    } else {
      totalWalks++;
      walksSinceLastPush++;
    }

    current = transition.snapshot;
  }

  const goalMap = new Map(
    board.goals.map((g) => [`${g.position.row},${g.position.column}`, g.label]),
  );

  const boxes: BoxSchedule[] = [];
  for (const box of current.boxes) {
    const entry = boxPushes.get(box.id)!;
    const cellKey = `${box.position.row},${box.position.column}`;
    const onGoal = goalMap.has(cellKey);
    boxes.push({
      boxId: box.id,
      label: box.label,
      pushCount: entry.pushCount,
      phaseCount: entry.phaseCount,
      firstPushStep: entry.firstPushStep,
      lastPushStep: entry.lastPushStep,
      prePushWalking: entry.prePushWalking,
      goalCell: onGoal ? { row: box.position.row, column: box.position.column } : null,
    });
  }

  return {
    source,
    moves: directions.length,
    pushes: totalPushes,
    walks: totalWalks,
    boxSwitches,
    boxes,
  };
}

function diffAnalyses(left: RouteAnalysis, right: RouteAnalysis): RouteDiff[] {
  const diffs: RouteDiff[] = [];
  const num = (metric: string, l: number, r: number) => {
    diffs.push({ metric, left: l, right: r, delta: r - l });
  };
  num("moves", left.moves, right.moves);
  num("pushes", left.pushes, right.pushes);
  num("walks", left.walks, right.walks);
  num("boxSwitches", left.boxSwitches, right.boxSwitches);

  const rightBoxMap = new Map(right.boxes.map((b) => [b.boxId, b]));
  for (const lb of left.boxes) {
    const rb = rightBoxMap.get(lb.boxId);
    if (!rb) continue;
    if (lb.pushCount !== rb.pushCount || lb.phaseCount !== rb.phaseCount || lb.prePushWalking !== rb.prePushWalking) {
      num(`  ${lb.label}[${lb.boxId}].pushes`, lb.pushCount, rb.pushCount);
      num(`  ${lb.label}[${lb.boxId}].phases`, lb.phaseCount, rb.phaseCount);
      num(`  ${lb.label}[${lb.boxId}].preWalk`, lb.prePushWalking, rb.prePushWalking);
    }
  }
  return diffs;
}

function formatTable(diffs: RouteDiff[]): string {
  const header = `${"Metric".padEnd(32)} ${"Left".padStart(8)} ${"Right".padStart(8)} ${"Delta".padStart(8)}`;
  const sep = "-".repeat(header.length);
  const rows = diffs.map((d) =>
    `${String(d.metric).padEnd(32)} ${String(d.left).padStart(8)} ${String(d.right).padStart(8)} ${String(d.delta).padStart(8)}`,
  );
  return [sep, header, sep, ...rows, sep].join("\n");
}

async function solveRoute(
  board: ParsedBoard,
  snapshot: GameSnapshot,
  mode: string,
): Promise<readonly Direction[]> {
  const adapter = createNodeSolverAdapter({ hardwareConcurrency: 2 });
  const request = {
    board,
    snapshot,
    objective: { kind: "moves" as const },
    options: {
      "sokomind-solver": {
        mode,
        deterministic: true,
        maximumIncumbents: 1,
        harvestElapsedMs: 0,
      },
    },
    limits: {
      maxElapsedMs: 45_000,
      maxExpandedStates: 200_000,
      maxGeneratedStates: 2_000_000,
      maxMemoryBytes: 2048 * 1024 ** 2,
    },
  };

  const controller = new AbortController();
  const result = await adapter.solve(request, {
    signal: controller.signal,
    now: () => performance.now(),
    reportProgress() {},
  });

  assert.equal(result.status, "solved", `Solver returned ${result.status}`);
  assert.ok(result.status === "solved");
  const verification = verifySolverSolution(request, result.solution);
  assert.ok(verification.valid, `Verification failed`);
  return result.solution.steps.map((s) => s.direction);
}

// --- CLI ---

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)(?:=(.+))?$/u.exec(arg);
    assert.ok(match, `Expected --name=value: ${arg}`);
    return [match[1], match[2] ?? "true"] as const;
  }),
);

const KNOWN_ARGS = ["fixture", "left", "right", "left-route", "right-route"];
for (const key of args.keys()) {
  assert.ok(KNOWN_ARGS.includes(key), `Unknown argument: --${key}`);
}

const fixture = args.get("fixture") ?? "huge";
const puzzle = PUZZLE_BY_ID[fixture];
assert.ok(puzzle, `Unknown fixture: ${fixture}. Available: ${Object.keys(PUZZLE_BY_ID).slice(0, 10).join(", ")}...`);

const session = createSession(puzzle);
const { board, snapshot } = session;

async function getRoute(
  label: string,
  routeArg: string | undefined,
  modeArg: string | undefined,
): Promise<{ directions: readonly Direction[]; source: string }> {
  if (routeArg) {
    assert.match(routeArg, /^[UDLR]+$/u, `${label} route must be U/D/L/R`);
    return { directions: decodeActionLog(routeArg), source: `${label}-route (${routeArg.length} chars)` };
  }
  const mode = modeArg ?? (label === "left" ? "fast" : "quality");
  console.log(`Solving ${label} with mode=${mode}...`);
  const directions = await solveRoute(board, snapshot, mode);
  return { directions, source: `sokomind-solver mode=${mode}` };
}

const left = await getRoute("left", args.get("left-route"), args.get("left"));
const right = await getRoute("right", args.get("right-route"), args.get("right"));

const leftAnalysis = analyzeRoute(board, snapshot, left.directions, left.source);
const rightAnalysis = analyzeRoute(board, snapshot, right.directions, right.source);

console.log(`\nFixture: ${fixture}`);
console.log(`Left:  ${left.source}`);
console.log(`Right: ${right.source}\n`);

const diffs = diffAnalyses(leftAnalysis, rightAnalysis);
console.log(formatTable(diffs));

console.log("\nJSON output:");
console.log(JSON.stringify({ fixture, left: leftAnalysis, right: rightAnalysis, diffs }, null, 2));
