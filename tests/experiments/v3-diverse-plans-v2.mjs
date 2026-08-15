/**
 * Diverse plan generation v2: vary STRUCTURAL plan parameters
 * (beam width, box branches, slack, macro exploration, move preference)
 * instead of noise injection which breaks the fragile beam.
 *
 * Phase 1: Generate plans with different structural parameters
 * Phase 2: Quick convergence on each valid plan (3 passes with MST+random)
 * Phase 3: Full optimization on the best converged plan
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

const configs = [
  { name: "default", beamWidth: 32, boxBranches: 6, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: false, moveDom: 0 },
  { name: "wide-64", beamWidth: 64, boxBranches: 6, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: false, moveDom: 0 },
  { name: "wide-96", beamWidth: 96, boxBranches: 6, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: false, moveDom: 0 },
  { name: "wide-128", beamWidth: 128, boxBranches: 6, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: false, moveDom: 0 },
  { name: "pref-moves", beamWidth: 32, boxBranches: 6, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: true,
    keeperDiv: false, moveDom: 0 },
  { name: "pref-moves-wide", beamWidth: 64, boxBranches: 6, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: true,
    keeperDiv: false, moveDom: 0 },
  { name: "movedominance-01", beamWidth: 32, boxBranches: 6, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: false, moveDom: 0.01 },
  { name: "movedominance-02", beamWidth: 64, boxBranches: 6, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: false, moveDom: 0.02 },
  { name: "boxes-8", beamWidth: 32, boxBranches: 8, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: false, moveDom: 0 },
  { name: "boxes-10", beamWidth: 64, boxBranches: 10, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: false, moveDom: 0 },
  { name: "slack-300", beamWidth: 32, boxBranches: 6, slack: 300, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: false, moveDom: 0 },
  { name: "slack-300-wide", beamWidth: 64, boxBranches: 6, slack: 300, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: false, moveDom: 0 },
  { name: "macro-deep", beamWidth: 32, boxBranches: 6, slack: 240, macroLimit: 32,
    macroExplored: 96, macroResults: 6, targetMacro: 128, prefMoves: false,
    keeperDiv: false, moveDom: 0 },
  { name: "macro-deep-wide", beamWidth: 64, boxBranches: 6, slack: 240, macroLimit: 32,
    macroExplored: 96, macroResults: 6, targetMacro: 128, prefMoves: false,
    keeperDiv: false, moveDom: 0 },
  { name: "keeper-div", beamWidth: 32, boxBranches: 6, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: true, moveDom: 0 },
  { name: "keeper-div-wide", beamWidth: 64, boxBranches: 6, slack: 240, macroLimit: 24,
    macroExplored: 48, macroResults: 4, targetMacro: 64, prefMoves: false,
    keeperDiv: true, moveDom: 0 },
  // Combined configs
  { name: "combo-wide-pref-dom", beamWidth: 96, boxBranches: 8, slack: 300, macroLimit: 32,
    macroExplored: 96, macroResults: 6, targetMacro: 128, prefMoves: true,
    keeperDiv: true, moveDom: 0.01 },
  { name: "combo-mega", beamWidth: 128, boxBranches: 10, slack: 300, macroLimit: 32,
    macroExplored: 96, macroResults: 6, targetMacro: 128, prefMoves: true,
    keeperDiv: true, moveDom: 0.02 },
];

console.log("=== Phase 1: Diverse Plan Generation ===");
const plans = [];
for (const cfg of configs) {
  const started = performance.now();
  const planResult = search({
    algorithm: "plan-macro-beam",
    state,
    maxDepth: 460,
    maxVisited: Math.max(6_000, Math.ceil(cfg.beamWidth / 32) * 6_000),
    transpositionLimit: Math.max(60_000, Math.ceil(cfg.beamWidth / 32) * 60_000),
    planBeamWidth: cfg.beamWidth,
    planBoxBranches: cfg.boxBranches,
    maxPlanSegments: 160,
    planSlack: cfg.slack,
    sequenceMacroLimit: cfg.macroLimit,
    sequenceMacroExplored: cfg.macroExplored,
    sequenceMacroResults: cfg.macroResults,
    targetedMacroExplored: cfg.targetMacro,
    planPreferLowerMoves: cfg.prefMoves,
    planKeeperDiversity: cfg.keeperDiv,
    planMoveDominanceWeight: cfg.moveDom,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);

  if (planResult.status !== "solved" || !Array.isArray(planResult.path)) {
    console.log(`  ${cfg.name}: FAILED (${planResult.status}) | ${Math.round(ms/1000)}s`);
    continue;
  }
  const sol = solutionFromLegacyPath(request, planResult.path);
  const valid = verifySolverSolution(request, sol).valid;
  console.log(`  ${cfg.name}: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid} | ${Math.round(ms/1000)}s`);
  if (valid) {
    plans.push({ label: cfg.name, path: planResult.path, moves: sol.moves, pushes: sol.pushes,
      walks: sol.moves - sol.pushes });
  }
}

console.log(`\nGenerated ${plans.length} valid plans`);
const unique = new Map();
for (const p of plans) {
  const key = `${p.moves}/${p.pushes}`;
  if (!unique.has(key)) unique.set(key, p);
}
console.log(`Unique plans: ${unique.size} (by moves/pushes)`);
plans.sort((a, b) => a.moves - b.moves);
for (const p of plans) {
  console.log(`  ${p.label}: m=${p.moves} p=${p.pushes} w=${p.walks}`);
}

// Phase 2: Quick convergence on unique plans
console.log("\n=== Phase 2: Quick Convergence ===");
const topPlans = [...unique.values()].sort((a, b) => a.moves - b.moves).slice(0, 6);
const convergedPlans = [];

for (const plan of topPlans) {
  console.log(`\n--- Converging: ${plan.label} (raw ${plan.moves} moves) ---`);
  let currentPath = plan.path;
  for (let pass = 0; pass < 4; pass++) {
    const prevSol = solutionFromLegacyPath(request, currentPath);
    const prevMoves = prevSol.moves;
    const result = search({
      algorithm: "solution-window-rewrite",
      state,
      solutionPath: currentPath,
      maxVisited: 600_000,
      greedyPermutation: false,
      permutationVisited: 200_000,
      permutationWindowPushes: [8, 16, 32, 48],
      perPermutationWindowVisited: 3000,
      permutationHeuristicWeight: 3,
      permutationBidirectional: true,
      permutationMSTHeuristic: true,
      permutationExtraPasses: 1,
      permutationTargetedPasses: 10,
      windowPushes: [8, 16, 32, 48],
      windowVisited: 30_000,
      windowTotalVisited: 200_000,
      moveWindowVisited: 150_000,
      moveWindowPushes: [1, 2, 4, 8, 16],
      moveWindowAttempts: 25,
      moveWindowMinimumOverhead: 2,
      perMoveWindowVisited: 4000,
      moveWindowExtraPushes: 8,
      moveWindowRandomAttempts: 60,
      moveBridgeWeight: 2.0,
      progressIntervalMs: 60_000,
    });
    if (!result.path) {
      console.log(`  Pass ${pass + 1}: converged at ${prevMoves}`);
      break;
    }
    const passSol = solutionFromLegacyPath(request, result.path);
    if (passSol.moves >= prevMoves) {
      console.log(`  Pass ${pass + 1}: converged at ${prevMoves}`);
      break;
    }
    currentPath = result.path;
    console.log(`  Pass ${pass + 1}: m=${passSol.moves} p=${passSol.pushes} w=${passSol.moves - passSol.pushes} | delta=${passSol.moves - prevMoves}`);
  }
  const finalSol = solutionFromLegacyPath(request, currentPath);
  convergedPlans.push({ label: plan.label, path: currentPath,
    moves: finalSol.moves, pushes: finalSol.pushes,
    walks: finalSol.moves - finalSol.pushes, rawMoves: plan.moves });
  console.log(`  Final: m=${finalSol.moves} p=${finalSol.pushes} w=${finalSol.moves - finalSol.pushes}`);
}

console.log("\n=== Convergence Summary ===");
convergedPlans.sort((a, b) => a.moves - b.moves);
for (const p of convergedPlans) {
  console.log(`  ${p.label}: raw=${p.rawMoves} → converged=${p.moves} (p=${p.pushes} w=${p.walks})`);
}

// Phase 3: Full optimization on best converged plan
const best = convergedPlans[0];
console.log(`\n=== Phase 3: Full Optimization on "${best.label}" (${best.moves} moves) ===`);
let currentPath = best.path;
writeFileSync("/tmp/v3-diverse2-baseline.json", JSON.stringify(currentPath));

const tiers = [
  { name: "medium-mst", hWeight: 3, bidir: true, coarse: false, mbWeight: 2.0,
    mst: true, extraPasses: 1, targeted: 15,
    bridgeBidir: true, bridgeExtra: 2, bridgeWt: 1.3,
    permVis: 400_000, permWin: [16, 32, 48], perPerm: 6000,
    winPush: [16, 32, 48], winVis: 50_000, winTotal: 400_000,
    moveVis: 200_000, movePush: [1, 2, 4, 8, 16], moveAttempts: 40,
    moveMin: 2, perMove: 6000, moveExtra: 8, moveRandom: 80, maxVis: 1_000_000 },
  { name: "large-mst", hWeight: 5, bidir: true, coarse: true, mbWeight: 2.5,
    mst: true, extraPasses: 2, targeted: 25,
    bridgeBidir: true, bridgeExtra: 3, bridgeWt: 1.4,
    permVis: 800_000, permWin: [32, 48, 64], perPerm: 10000,
    winPush: [32, 48, 64], winVis: 80_000, winTotal: 600_000,
    moveVis: 300_000, movePush: [1, 2, 4, 8, 16, 32], moveAttempts: 50,
    moveMin: 1, perMove: 8000, moveExtra: 10, moveRandom: 120, maxVis: 1_500_000 },
  { name: "mega-mst", hWeight: 5, bidir: true, coarse: true, mbWeight: 3.0,
    mst: true, extraPasses: 2, targeted: 40,
    bridgeBidir: true, bridgeExtra: 4, bridgeWt: 1.5,
    permVis: 1_200_000, permWin: [48, 64, 96], perPerm: 15000,
    winPush: [48, 64, 96, 128], winVis: 120_000, winTotal: 1_000_000,
    moveVis: 400_000, movePush: [1, 2, 4, 8, 16, 32, 48], moveAttempts: 60,
    moveMin: 1, perMove: 12000, moveExtra: 14, moveRandom: 160, maxVis: 2_500_000 },
  { name: "ultra-mst", hWeight: 8, bidir: true, coarse: true, mbWeight: 3.0,
    mst: true, extraPasses: 2, targeted: 50,
    bridgeBidir: true, bridgeExtra: 4, bridgeWt: 1.5,
    permVis: 1_500_000, permWin: [64, 96, 128], perPerm: 20000,
    winPush: [64, 96, 128], winVis: 150_000, winTotal: 1_500_000,
    moveVis: 500_000, movePush: [1, 2, 4, 8, 16, 32, 48], moveAttempts: 80,
    moveMin: 1, perMove: 15000, moveExtra: 16, moveRandom: 200, maxVis: 3_000_000 },
];

const MAX_ROUNDS = 40;
let totalMs = 0;
let staleCount = 0;

for (let round = 0; round < MAX_ROUNDS; round++) {
  const tierIdx = Math.min(Math.floor(round / 3), tiers.length - 1);
  const tier = tiers[tierIdx];
  const prevSol = solutionFromLegacyPath(request, currentPath);
  const prevMoves = prevSol.moves;

  console.log(`\n--- Round ${round + 1} (${tier.name}, from ${prevMoves} moves) ---`);
  const started = performance.now();
  const result = search({
    algorithm: "solution-window-rewrite",
    state,
    solutionPath: currentPath,
    maxVisited: tier.maxVis,
    greedyPermutation: false,
    permutationVisited: tier.permVis,
    permutationWindowPushes: tier.permWin,
    perPermutationWindowVisited: tier.perPerm,
    permutationHeuristicWeight: tier.hWeight || undefined,
    permutationBidirectional: tier.bidir,
    permutationCoarseIdentity: tier.coarse,
    permutationExtraPasses: tier.extraPasses,
    permutationTargetedPasses: tier.targeted,
    permutationMSTHeuristic: tier.mst,
    bridgeBidirectional: tier.bridgeBidir,
    bridgeExtraPushes: tier.bridgeExtra,
    bridgeWeight: tier.bridgeWt,
    windowPushes: tier.winPush,
    windowVisited: tier.winVis,
    windowTotalVisited: tier.winTotal,
    moveWindowVisited: tier.moveVis,
    moveWindowPushes: tier.movePush,
    moveWindowAttempts: tier.moveAttempts,
    moveWindowMinimumOverhead: tier.moveMin,
    perMoveWindowVisited: tier.perMove,
    moveWindowExtraPushes: tier.moveExtra,
    moveWindowRandomAttempts: tier.moveRandom,
    moveBridgeWeight: tier.mbWeight,
    progressIntervalMs: 60_000,
  });
  const ms = Math.round(performance.now() - started);
  totalMs += ms;

  if (!result.path) {
    console.log(`  No path | ${Math.round(ms/1000)}s`);
    staleCount++;
    if (staleCount >= 4 && tierIdx >= tiers.length - 1) break;
    continue;
  }

  const roundSol = solutionFromLegacyPath(request, result.path);
  const delta = roundSol.moves - prevMoves;
  if (delta >= 0) {
    console.log(`  No improvement (${roundSol.moves} >= ${prevMoves}) | ${Math.round(ms/1000)}s`);
    staleCount++;
    if (staleCount >= 4 && tierIdx >= tiers.length - 1) break;
    continue;
  }
  staleCount = 0;
  const roundValid = verifySolverSolution(request, roundSol).valid;
  console.log(`  Result: m=${roundSol.moves} p=${roundSol.pushes} w=${roundSol.moves - roundSol.pushes} | delta=${delta} | valid=${roundValid} | ${Math.round(ms/1000)}s`);
  currentPath = result.path;
  writeFileSync("/tmp/v3-diverse2-best.json", JSON.stringify(currentPath));
  if (roundSol.moves < 700) {
    console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
    break;
  }
}

const finalSol = solutionFromLegacyPath(request, currentPath);
const finalValid = verifySolverSolution(request, finalSol).valid;
console.log(`\n=== FINAL: ${finalSol.moves} moves / ${finalSol.pushes} pushes / ${finalSol.moves - finalSol.pushes} walks | ${Math.round(totalMs/1000)}s | valid=${finalValid} ===`);
if (finalSol.moves < 700) {
  console.log("*** TARGET ACHIEVED: UNDER 700 MOVES ***");
}
