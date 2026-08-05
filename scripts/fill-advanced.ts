import { generatePuzzle } from "../src/features/generator/generate-puzzle.ts";
import type { GeneratorParams } from "../src/features/generator/generator-types.ts";
import type { PuzzleDefinition } from "../src/core/model.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainPath = join(__dirname, "..", "src", "catalog", "generated-puzzles.json");
const allPuzzles: PuzzleDefinition[] = JSON.parse(readFileSync(mainPath, "utf-8"));

const advancedCount = allPuzzles.filter((p) => p.difficulty === "advanced").length;
const needed = Math.max(0, 391 - advancedCount); // 400 - 9 canonical = 391 generated needed
console.log(`Have ${advancedCount} advanced generated, need ${needed} more`);

if (needed === 0) {
  console.log("Done!");
  process.exit(0);
}

const seenBoards = new Set(allPuzzles.map((p) => p.rows.join("|")));

// Configurations that reliably produce advanced-tier puzzles
// Key: 5-7 boxes, moderate board sizes
// With 5 boxes: fails intermediate maxBoxes=5, so classified as advanced if moves ≤200
// With 6-7 boxes: same, reliably advanced
const CONFIGS = [
  { width: 10, height: 10, boxCount: 6, maxAttempts: 150 },
  { width: 10, height: 10, boxCount: 7, maxAttempts: 150 },
  { width: 11, height: 11, boxCount: 6, maxAttempts: 150 },
  { width: 11, height: 11, boxCount: 7, maxAttempts: 180 },
  { width: 9, height: 9, boxCount: 6, maxAttempts: 120 },
];

let generated = 0;
let configIdx = 0;

async function run() {
  while (generated < needed) {
    const config = CONFIGS[configIdx % CONFIGS.length];
    configIdx++;

    const params: GeneratorParams = {
      ...config,
      targetDifficulty: "advanced",
      useLabels: true,
      maxAttempts: config.maxAttempts,
    };

    const result = await generatePuzzle(params, undefined, undefined);

    if (result.status !== "success") continue;
    if (result.puzzle.difficulty !== "advanced") continue;

    const boardKey = result.puzzle.rows.join("|");
    if (seenBoards.has(boardKey)) continue;
    seenBoards.add(boardKey);

    const idx = advancedCount + generated + 1;
    const puzzle: PuzzleDefinition = {
      id: `gen-advanced-${String(idx).padStart(3, "0")}`,
      title: `Advanced ${idx}`,
      difficulty: "advanced",
      boxes: result.puzzle.boxes,
      rows: result.puzzle.rows,
      collection: "Sokomind Generated",
    };

    allPuzzles.push(puzzle);
    generated++;

    console.log(
      `  [${generated}/${needed}] ${puzzle.id} — ` +
      `${result.solverMoves}mv/${result.solverPushes}pu, ` +
      `${config.width}x${config.height}/${config.boxCount}box ` +
      `(${result.attempts} att)`,
    );

    if (generated % 5 === 0) {
      writeFileSync(mainPath, JSON.stringify(allPuzzles, null, 2) + "\n");
    }
  }

  writeFileSync(mainPath, JSON.stringify(allPuzzles, null, 2) + "\n");
  console.log(`\nDone! Added ${generated} advanced puzzles.`);
  console.log(`Total in file: ${allPuzzles.length}`);
}

run().catch((err) => {
  writeFileSync(mainPath, JSON.stringify(allPuzzles, null, 2) + "\n");
  console.error("Error:", err);
  process.exit(1);
});
