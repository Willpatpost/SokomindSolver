// Isolated Node kernel experiments. Browser acceptance remains a separate gate.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { PUZZLE_BY_ID } from "../src/catalog/puzzles.ts";
import { createSession } from "../src/core/index.ts";
import { search } from "../src/solver/implementations/sokomind-engine/engine.generated.js";
import { solutionFromLegacyPath, toLegacyState } from "../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../src/solver/verification.ts";

const args = new Map(process.argv.slice(2).map(argument => {
  const [key, ...value] = argument.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const allowed = new Set(["ids", "budgets", "runs", "search-ms", "rewrite", "child"]);
for (const key of args.keys()) if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}`);
const integer = (value, maximum) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) throw new Error(`Invalid number: ${value}`);
  return result;
};
const ids = (args.get("ids") ?? "beginner-three,classic-1,adv-gallery,expert-maze,huge").split(",");
for (const id of ids) if (!Object.hasOwn(PUZZLE_BY_ID, id)) throw new Error(`Unknown puzzle: ${id}`);
const budgets = (args.get("budgets") ?? "0,100,250,500,1000").split(",").map(value => integer(value, 1000));
const runs = integer(args.get("runs") ?? 1, 100);
if (!runs) throw new Error("runs must be positive");
const searchMs = integer(args.get("search-ms") ?? 3000, 60000);
const rewrite = args.has("rewrite");
if (rewrite && searchMs) throw new Error("Rewrite experiments require --search-ms=0; rewrite has no cooperative deadline yet.");

if (args.has("child")) {
  const session = createSession(PUZZLE_BY_ID[ids[0]]);
  const request = {board: session.board, snapshot: session.snapshot, objective: {kind: "moves"}};
  const state = toLegacyState(request);
  globalThis.postMessage = () => {};
  const started = performance.now();
  const preparation = search({algorithm: "analyze-puzzle", state,
    ...(budgets[0] ? {strategicAnalysis: {maxMs: budgets[0]}} : {})});
  const analysisMs = performance.now() - started;
  const plan = preparation.analysis.strategicPlan;
  const searchStarted = performance.now();
  const result = search({algorithm: "plan-macro-beam", state,
    strategicPlan: plan, ...(searchMs ? {planSearchMs: searchMs} : {}),
    maxDepth: 460, maxVisited: 6000, transpositionLimit: 60000,
    planBeamWidth: 32, planBoxBranches: 6, maxPlanSegments: 160, planSlack: 240,
    sequenceMacroLimit: 24, sequenceMacroExplored: 48, sequenceMacroResults: 4,
    targetedMacroExplored: 64, planSolutionComparisonBudget: 0, planDiagnostics: true});
  const discoveryMs = performance.now() - searchStarted;
  let finalResult = result, rewriteMs = 0;
  if (rewrite && result.path) {
    const rewriteStarted = performance.now();
    finalResult = search({algorithm: "solution-window-rewrite", state, solutionPath: result.path,
      maxVisited: 50000, permutationVisited: 10000, permutationWindowPushes: [8, 16, 32],
      perPermutationWindowVisited: 1500, windowPushes: [8, 16, 32], windowVisited: 12000,
      windowTotalVisited: 15000, frontierLimit: 12000, moveWindowVisited: 25000,
      moveWindowPushes: [1, 2, 4], moveWindowAttempts: 12, perMoveWindowVisited: 4000,
      moveWindowExtraPushes: 4, moveWindowMinimumOverhead: 6, adaptiveMoveWindows: true,
      adaptiveMoveMinimumPriorImprovements: 8, moveWindowMissLimit: 1});
    rewriteMs = performance.now() - rewriteStarted;
  }
  const verificationStarted = performance.now();
  const solution = finalResult.path ? solutionFromLegacyPath(request, finalResult.path) : null;
  const verified = solution ? verifySolverSolution(request, solution).valid : false;
  const verificationMs = performance.now() - verificationStarted;
  console.log(JSON.stringify({id: ids[0], analysisBudgetMs: budgets[0], searchBudgetMs: searchMs || null,
    analysisMs, strategicStatistics: plan?.statistics, preparedCandidates: plan?.candidates.length ?? 0,
    preparedAccepted: result.preparedPlansAccepted ?? result.planDiagnostics?.preparedPlansAccepted ?? 0,
    discoveryMs, rewriteMs, verificationMs, totalMs: performance.now() - started,
    discoveryMoves: result.path?.length, moves: solution?.moves, pushes: solution?.pushes, verified,
    visited: result.visited, generated: result.generated, status: finalResult.status,
    terminationReason: finalResult.terminationReason,
    peakProcessRssBytes: process.resourceUsage().maxRSS * 1024}));
  if (solution && !verified) process.exitCode = 1;
} else {
  const samples = [];
  for (const id of ids) for (let run = 0; run < runs; run++) {
    // Alternate order to reduce systematic thermal/background-load bias.
    for (const budget of run % 2 ? [...budgets].reverse() : budgets) {
      const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url),
        "--child", `--ids=${id}`, `--budgets=${budget}`, `--search-ms=${searchMs}`,
        ...(rewrite ? ["--rewrite"] : [])], {encoding: "utf8", windowsHide: true, timeout: 90000});
      if (child.status !== 0) {
        samples.push({id, run, analysisBudgetMs: budget, error: child.error?.message || child.stderr});
        process.exitCode = 1;
      } else samples.push({run, ...JSON.parse(child.stdout)});
    }
  }
  console.log(JSON.stringify({schemaVersion: 1, environment: {node: process.version,
    platform: process.platform, architecture: process.arch,
    engineSha256: createHash("sha256").update(readFileSync(new URL(
      "../src/solver/implementations/sokomind-engine/engine.generated.js", import.meta.url))).digest("hex"),
    harnessSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    capturedAt: new Date().toISOString()}, methodology: "isolated-node-kernel",
    browserAcceptance: false, samples}, null, 2));
}
