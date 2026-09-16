/**
 * MC-PDB tuning diagnostic for Grand Hall.
 * Measures probe telemetry across parameter sweeps to guide Phase 6 tuning.
 */
import { parsePuzzleRows } from "../src/core/index.ts";
import { compileSearchBoard } from "../src/solver/search/compiled-board.ts";
import { toDenseBoxes } from "../src/solver/search/model.ts";
import {
  probeAndSelectPatterns,
  type PatternSelectionOptions,
} from "../src/solver/search/move-cost-pattern-pdb.ts";
import { sortedBoxes } from "../src/solver/search/engine.ts";

const GRAND_HALL = [
  "OOOOOOOOOOOOOOO",
  "OaSS   S   SSbO",
  "OSCS  OOO  SDSO",
  "OX X  OOO  X XO",
  "O     OOO     O",
  "OOOO   X   OOOO",
  "O      O      O",
  "O G hOOOOOH g O",
  "O      O      O",
  "OOO         OOO",
  "OOO   X X   OOO",
  "OOOOOOOROOOOOOO",
  "O B X X X X A O",
  "O Sc       dS O",
  "OOOOOOOOOOOOOOO",
];

const parsed = parsePuzzleRows(GRAND_HALL);
const board = compileSearchBoard(parsed);
const initialRobot = board.cellAt(
  parsed.initialRobot.row,
  parsed.initialRobot.column,
);
const initialBoxes = sortedBoxes(
  toDenseBoxes(board, parsed.initialBoxes),
);

interface Config {
  label: string;
  options: Partial<PatternSelectionOptions>;
}

const configs: Config[] = [
  {
    label: "baseline (probe=20k, full=50k, maxK=7)",
    options: { probeStates: 20_000, fullBuildStates: 50_000, maxK: 7, minK: 2 },
  },
  {
    label: "small-k only (maxK=3, probe=50k, full=200k)",
    options: { probeStates: 50_000, fullBuildStates: 200_000, maxK: 3, minK: 2 },
  },
  {
    label: "mid-k (maxK=5, probe=50k, full=200k)",
    options: { probeStates: 50_000, fullBuildStates: 200_000, maxK: 5, minK: 2 },
  },
  {
    label: "large probe (probe=100k, full=500k, maxK=7)",
    options: { probeStates: 100_000, fullBuildStates: 500_000, maxK: 7, minK: 2 },
  },
  {
    label: "many patterns (maxSelected=4, probe=50k, full=200k)",
    options: {
      probeStates: 50_000, fullBuildStates: 200_000, maxK: 7, minK: 2,
      maxSelectedPatterns: 4,
    },
  },
  {
    label: "incumbent=515 (probe=50k, full=200k, maxK=7)",
    options: {
      probeStates: 50_000, fullBuildStates: 200_000, maxK: 7, minK: 2,
      incumbentCost: 515,
    },
  },
];

console.log("MC-PDB Grand Hall Tuning Diagnostic");
console.log("=".repeat(70));
console.log(`Board: ${board.cellCount} cells, ${initialBoxes.length} boxes`);
console.log();

for (const config of configs) {
  const start = performance.now();
  const { collection, telemetry } = probeAndSelectPatterns(
    board, undefined, () => performance.now(),
    config.options, initialBoxes, initialRobot,
  );
  const elapsed = performance.now() - start;

  const rootValue = collection.evaluate(initialBoxes, initialRobot);

  console.log(`--- ${config.label} ---`);
  console.log(`  candidates: ${telemetry.candidatesGenerated} generated, ${telemetry.candidatesProbed} probed, ${telemetry.candidatesSelected} selected`);
  console.log(`  settled: ${telemetry.totalSettledStates}, retained: ${(telemetry.totalRetainedBytes / 1024).toFixed(0)} KB`);
  console.log(`  probe time: ${telemetry.probeTotalMs.toFixed(0)} ms, build time: ${telemetry.buildTotalMs.toFixed(0)} ms, total: ${elapsed.toFixed(0)} ms`);
  console.log(`  collection root value: ${rootValue}`);
  console.log(`  per-probe:`);
  for (const p of telemetry.probes) {
    console.log(`    k=${p.pattern.boxCount} "${p.pattern.label}" goals=[${p.pattern.goalCells.join(",")}]: settled=${p.settledStates}, radius=${p.completedRadius}, rootVal=${p.rootValue}, score=${p.score.toFixed(1)}`);
  }
  console.log();
}
