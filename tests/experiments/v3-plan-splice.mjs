/**
 * Plan splice: use the default plan for the first N pushes,
 * then re-plan from the intermediate state using plan-macro-beam.
 *
 * This explores whether a different push sequence for the second
 * half of the solution could produce fewer total moves.
 */
import { writeFileSync } from "node:fs";
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession } from "../../src/core/index.ts";
import { search } from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import { solutionFromLegacyPath, toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

globalThis.postMessage = () => {};

const huge = PUZZLE_BY_ID.huge;
const session = createSession(huge);
const request = {
  board: session.board,
  snapshot: session.snapshot,
  objective: { kind: "moves" },
};
const state = toLegacyState(request);

// Step 1: Generate default plan and replay to get intermediate states
console.log("Generating default plan...");
const planResult = search({
  algorithm: "plan-macro-beam",
  state,
  maxDepth: 460,
  maxVisited: 6_000,
  transpositionLimit: 60_000,
  planBeamWidth: 32,
  planBoxBranches: 6,
  maxPlanSegments: 160,
  planSlack: 240,
  sequenceMacroLimit: 24,
  sequenceMacroExplored: 48,
  sequenceMacroResults: 4,
  targetedMacroExplored: 64,
  progressIntervalMs: 60_000,
});
const rawSol = solutionFromLegacyPath(request, planResult.path);
console.log(`Raw plan: m=${rawSol.moves} p=${rawSol.pushes} w=${rawSol.moves - rawSol.pushes}`);

// Replay solution to extract intermediate states at various push counts
const DIRS = {Up: [-1, 0], Down: [1, 0], Left: [0, -1], Right: [0, 1]};
const path = planResult.path;

function getStateAtPush(targetPush) {
  let robot = [...state.robot];
  let boxes = state.boxes.map(([pos, label]) => {
    const [y, x] = pos.split(",").map(Number);
    return [y, x, label];
  });
  let pushCount = 0;
  let moveIndex = 0;

  for (const move of path) {
    const dir = DIRS[move];
    if (!dir) { moveIndex++; continue; }
    const [dy, dx] = dir;
    const newR = robot[0] + dy;
    const newC = robot[1] + dx;

    const boxIdx = boxes.findIndex(([y, x]) => y === newR && x === newC);
    if (boxIdx >= 0) {
      pushCount++;
      if (pushCount > targetPush) break;
      boxes[boxIdx] = [newR + dy, newC + dx, boxes[boxIdx][2]];
    }
    robot = [newR, newC];
    moveIndex++;
  }
  return {
    robot,
    boxes: boxes.map(([y, x, l]) => [`${y},${x}`, l]),
    moveIndex,
    pushCount: Math.min(pushCount, targetPush),
  };
}

// Step 2: Try splicing at different push counts
const splicePoints = [50, 100, 150, 200, 250];
const results = [];

for (const spliceAt of splicePoints) {
  console.log(`\n=== Splice at push ${spliceAt}/${rawSol.pushes} ===`);
  const midState = getStateAtPush(spliceAt);
  const firstHalf = path.slice(0, midState.moveIndex);

  // Check how many goals are already solved
  const _solvedGoals = midState.boxes.filter(([_pos, _label]) => {
    // A goal is solved if a box is on its matching goal position
    // We'd need to check the board goals, but let's just count
    return false; // placeholder
  }).length;

  console.log(`  State at push ${spliceAt}: robot=${midState.robot}, ${midState.boxes.length} boxes`);
  console.log(`  First half: ${firstHalf.length} moves`);

  // Now run plan-macro-beam from this intermediate state
  const spliceState = {
    ...state,
    robot: midState.robot,
    boxes: midState.boxes,
  };

  const started = performance.now();
  const splicePlan = search({
    algorithm: "plan-macro-beam",
    state: spliceState,
    maxDepth: 460 - spliceAt,
    maxVisited: 8_000,
    transpositionLimit: 80_000,
    planBeamWidth: 32,
    planBoxBranches: 6,
    maxPlanSegments: 160,
    planSlack: 240,
    sequenceMacroLimit: 24,
    sequenceMacroExplored: 48,
    sequenceMacroResults: 4,
    targetedMacroExplored: 64,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);

  if (splicePlan.status !== "solved" || !Array.isArray(splicePlan.path)) {
    console.log(`  Re-plan FAILED (${splicePlan.status}) | ${Math.round(ms/1000)}s`);
    results.push({ spliceAt, status: "failed" });
    continue;
  }

  // Combine first half + re-planned second half
  const combined = [...firstHalf, ...splicePlan.path];
  const combinedSol = solutionFromLegacyPath(request, combined);
  const valid = verifySolverSolution(request, combinedSol).valid;
  console.log(`  Re-plan: ${splicePlan.path.length} moves, ${ms}ms`);
  console.log(`  Combined: m=${combinedSol.moves} p=${combinedSol.pushes} w=${combinedSol.moves - combinedSol.pushes} | valid=${valid} | ${Math.round(ms/1000)}s`);

  if (valid) {
    results.push({
      spliceAt,
      moves: combinedSol.moves,
      pushes: combinedSol.pushes,
      walks: combinedSol.moves - combinedSol.pushes,
      path: combined,
      status: "ok",
    });
  } else {
    results.push({ spliceAt, status: "invalid" });
  }
}

console.log("\n=== Summary ===");
for (const r of results) {
  if (r.status === "ok") {
    console.log(`  Splice@${r.spliceAt}: m=${r.moves} p=${r.pushes} w=${r.walks}`);
  } else {
    console.log(`  Splice@${r.spliceAt}: ${r.status}`);
  }
}

// Converge the best splice
const best = results.filter(r => r.status === "ok").sort((a, b) => a.moves - b.moves)[0];
if (best) {
  console.log(`\nBest splice: @${best.spliceAt} with ${best.moves} moves`);
  console.log("Converging...");
  let currentPath = best.path;
  for (let pass = 0; pass < 5; pass++) {
    const prevSol = solutionFromLegacyPath(request, currentPath);
    const prevMoves = prevSol.moves;
    const result = search({
      algorithm: "solution-window-rewrite",
      state,
      solutionPath: currentPath,
      maxVisited: 800_000,
      greedyPermutation: false,
      permutationVisited: 300_000,
      permutationWindowPushes: [16, 32, 48],
      perPermutationWindowVisited: 4000,
      permutationHeuristicWeight: 3,
      permutationBidirectional: true,
      permutationMSTHeuristic: true,
      permutationExtraPasses: 1,
      permutationTargetedPasses: 10,
      windowPushes: [16, 32, 48],
      windowVisited: 40_000,
      windowTotalVisited: 300_000,
      moveWindowVisited: 200_000,
      moveWindowPushes: [1, 2, 4, 8, 16],
      moveWindowAttempts: 30,
      moveWindowMinimumOverhead: 2,
      perMoveWindowVisited: 5000,
      moveWindowExtraPushes: 8,
      moveWindowRandomAttempts: 80,
      moveWindowSeed: pass * 1000,
      moveBridgeWeight: 2.0,
      progressIntervalMs: 60_000,
    });
    if (!result.path) {
      console.log(`  Pass ${pass + 1}: converged at ${prevMoves}`);
      break;
    }
    const pSol = solutionFromLegacyPath(request, result.path);
    if (pSol.moves >= prevMoves) {
      console.log(`  Pass ${pass + 1}: converged at ${prevMoves}`);
      break;
    }
    currentPath = result.path;
    console.log(`  Pass ${pass + 1}: m=${pSol.moves} p=${pSol.pushes} w=${pSol.moves - pSol.pushes} | delta=${pSol.moves - prevMoves}`);
  }
  const finalSol = solutionFromLegacyPath(request, currentPath);
  const valid = verifySolverSolution(request, finalSol).valid;
  console.log(`\n=== FINAL: ${finalSol.moves} moves / ${finalSol.pushes} pushes / ${finalSol.moves - finalSol.pushes} walks | valid=${valid} ===`);
  writeFileSync("/tmp/v3-splice-best.json", JSON.stringify(currentPath));
  if (finalSol.moves < 700) console.log("*** TARGET ACHIEVED ***");
}
