import assert from "node:assert/strict";
import { createSession } from "../src/core/index.ts";
import { PUZZLE_BY_ID } from "../src/catalog/puzzles.ts";
import { search } from "../src/solver/implementations/sokomind-engine/engine.generated.js";
import { createNodeSolverAdapter } from "../src/solver/node-runner.ts";
import { verifySolverSolution } from "../src/solver/verification.ts";
import { toLegacyState, solutionFromLegacyPath } from "../src/solver/implementations/sokomind-solver.ts";

interface BoxScheduleEntry {
  boxIndex: number;
  label: string;
  original: {
    pushCount: number;
    phaseCount: number;
    firstPushIndex: number;
    lastPushIndex: number;
    prePushWalking: number;
  };
  repaired: {
    pushCount: number;
    phaseCount: number;
    firstPushIndex: number;
    lastPushIndex: number;
    prePushWalking: number;
  } | null;
  improvement: {
    pushesDelta: number;
    phasesDelta: number;
    walkingDelta: number;
  } | null;
}

function formatTraceTable(entries: readonly BoxScheduleEntry[]): string {
  const header = `${"Box".padEnd(12)} ${"Pushes".padStart(14)} ${"Phases".padStart(14)} ${"Walking".padStart(16)} ${"Improved?".padStart(10)}`;
  const sep = "-".repeat(header.length);
  const rows = entries.map((e) => {
    const orig = e.original;
    const rep = e.repaired;
    const pushStr = rep
      ? `${orig.pushCount} -> ${rep.pushCount}`
      : `${orig.pushCount}`;
    const phaseStr = rep
      ? `${orig.phaseCount} -> ${rep.phaseCount}`
      : `${orig.phaseCount}`;
    const walkStr = rep
      ? `${orig.prePushWalking} -> ${rep.prePushWalking}`
      : `${orig.prePushWalking}`;
    const improved = e.improvement
      ? (e.improvement.pushesDelta > 0 || e.improvement.walkingDelta > 0 ? "yes" : "no")
      : "-";
    return `${`${e.label}[${e.boxIndex}]`.padEnd(12)} ${pushStr.padStart(14)} ${phaseStr.padStart(14)} ${walkStr.padStart(16)} ${improved.padStart(10)}`;
  });
  return [sep, header, sep, ...rows, sep].join("\n");
}

// --- CLI ---

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)(?:=(.+))?$/u.exec(arg);
    assert.ok(match, `Expected --name=value: ${arg}`);
    return [match[1], match[2] ?? "true"] as const;
  }),
);

const KNOWN_ARGS = ["fixture"];
for (const key of args.keys()) {
  assert.ok(KNOWN_ARGS.includes(key), `Unknown argument: --${key}`);
}

const fixture = args.get("fixture") ?? "huge";
const puzzle = PUZZLE_BY_ID[fixture];
assert.ok(
  puzzle,
  `Unknown fixture: ${fixture}. Available: ${Object.keys(PUZZLE_BY_ID).slice(0, 10).join(", ")}...`,
);

const session = createSession(puzzle);
const request = { board: session.board, snapshot: session.snapshot, objective: { kind: "moves" as const } };

console.log(`Step 1: Solving ${fixture} with quality mode...`);
const adapter = createNodeSolverAdapter({ hardwareConcurrency: 2 });
const solverResult = await adapter.solve(request, {
  signal: new AbortController().signal,
  now: () => performance.now(),
  reportProgress() {},
});
assert.equal(solverResult.status, "solved", `Solver returned ${solverResult.status}`);
assert.ok(solverResult.status === "solved");
const verification = verifySolverSolution(request, solverResult.solution);
assert.ok(verification.valid, `Verification failed`);

const incumbentPath = solverResult.solution.steps.map((s) => {
  const map: Record<string, string> = { up: "U", down: "D", left: "L", right: "R" };
  return map[s.direction];
});

console.log(`  Discovery: ${incumbentPath.length} moves, ${solverResult.solution.pushes} pushes`);

console.log(`Step 2: Rescheduling with diagnostics...`);
const state = toLegacyState(request);
const rescheduleResult = search({
  algorithm: "solution-box-reschedule",
  state,
  solutionPath: incumbentPath,
  maxVisited: 300_000,
  maxGenerated: 2_000_000,
  rescheduleRounds: 2,
  diagnostics: true,
}) as Record<string, unknown>;

const rescheduledPath = rescheduleResult.path as readonly string[] | null;
assert.ok(rescheduledPath, "Rescheduling produced no path");

const rescheduledSolution = solutionFromLegacyPath(request, rescheduledPath);
assert.ok(rescheduledSolution, "Rescheduled path failed replay");
const rescheduledVerification = verifySolverSolution(request, rescheduledSolution);
assert.ok(rescheduledVerification.valid, "Rescheduled solution failed verification");

console.log(`\nFixture: ${fixture}`);
console.log(`Discovery: ${incumbentPath.length} moves`);
console.log(`Rescheduled: ${rescheduledPath.length} moves`);

const scheduleTrace = rescheduleResult.scheduleTrace as readonly BoxScheduleEntry[] | undefined;
if (scheduleTrace) {
  console.log(`\nSchedule Trace (${scheduleTrace.length} boxes):`);
  console.log(formatTraceTable(scheduleTrace));
} else {
  console.log("\nNo schedule trace returned.");
}

const boxRescheduling = rescheduleResult.boxRescheduling as Record<string, unknown> | undefined;
if (boxRescheduling) {
  console.log(`\nRescheduling summary:`);
  console.log(`  Original: ${boxRescheduling.originalMoves} moves`);
  console.log(`  Final: ${boxRescheduling.finalMoves} moves`);
}

console.log("\nJSON output:");
console.log(JSON.stringify({
  fixture,
  discoveryMoves: incumbentPath.length,
  rescheduledMoves: rescheduledPath.length,
  scheduleTrace: scheduleTrace ?? null,
  boxRescheduling: boxRescheduling ?? null,
}, null, 2));
