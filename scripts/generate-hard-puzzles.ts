import { generatePuzzle } from "../src/features/generator/generate-puzzle.ts";
import type { GeneratorParams } from "../src/features/generator/generator-types.ts";
import type { Difficulty, PuzzleDefinition } from "../src/core/model.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TierConfig {
  difficulty: Difficulty;
  target: number;
  params: Omit<GeneratorParams, "targetDifficulty" | "useLabels" | "maxAttempts">;
  maxAttempts: number;
}

// Expert needs boxes > 7 (advanced maxBoxes) to classify correctly.
// Master needs boxes > 10 (expert maxBoxes) OR moves > 500.
// Using box count as the primary lever since it's deterministic.
const TIER_CONFIGS: TierConfig[] = [
  // Expert: 8-9 boxes on 12x12 and 13x13
  {
    difficulty: "expert",
    target: 15,
    params: { width: 12, height: 12, boxCount: 8 },
    maxAttempts: 200,
  },
  {
    difficulty: "expert",
    target: 15,
    params: { width: 13, height: 13, boxCount: 9 },
    maxAttempts: 200,
  },
  // Master: 11-12 boxes on 14x14 and 15x15
  {
    difficulty: "master",
    target: 10,
    params: { width: 14, height: 14, boxCount: 11 },
    maxAttempts: 250,
  },
  {
    difficulty: "master",
    target: 10,
    params: { width: 15, height: 15, boxCount: 12 },
    maxAttempts: 250,
  },
];

const TITLES: Record<string, string[]> = {
  expert: [
    "Vault Puzzle", "Iron Cross", "Grand Swap", "Deep Maze", "Color Vault",
    "Expert Exchange", "Six Pack", "Hard Swap", "Complex Path", "Tight Fit",
    "Puzzle Vault", "Grand Cross", "Deep Swap", "Iron Maze", "Vault Cross",
    "Expert Maze", "Hard Cross", "Complex Swap", "Deep Cross", "Iron Swap",
    "Grand Maze", "Tight Cross", "Expert Cross", "Vault Maze", "Hard Maze",
    "Complex Cross", "Deep Vault", "Iron Exchange", "Grand Exchange", "Tight Swap",
  ],
  master: [
    "Labyrinth", "Grand Master", "Final Exam", "Master Class", "End Game",
    "Ultimate Sort", "Color Storm", "Master Maze", "Grand Finale", "Peak Puzzle",
    "Master Swap", "Grand Vault", "Final Cross", "Master Cross", "Peak Cross",
    "Grand Storm", "Final Maze", "Master Sort", "Grand Lock", "Peak Swap",
  ],
};

async function generateForTier(
  config: TierConfig,
  startIndex: number,
): Promise<PuzzleDefinition[]> {
  const puzzles: PuzzleDefinition[] = [];
  const seenBoards = new Set<string>();
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 15;
  let titleIndex = 0;
  const titles = TITLES[config.difficulty] ?? [];

  console.log(
    `\n--- Generating ${config.target} ${config.difficulty} puzzles ` +
    `(${config.params.width}x${config.params.height}, ${config.params.boxCount} boxes, labeled) ---`,
  );

  while (puzzles.length < config.target) {
    if (consecutiveFailures >= maxConsecutiveFailures) {
      console.log(
        `  Stopping after ${maxConsecutiveFailures} consecutive failures. ` +
        `Generated ${puzzles.length}/${config.target}`,
      );
      break;
    }

    const params: GeneratorParams = {
      ...config.params,
      targetDifficulty: config.difficulty,
      useLabels: true,
      maxAttempts: config.maxAttempts,
    };

    const result = await generatePuzzle(params, undefined, undefined);

    if (result.status === "success") {
      const boardKey = result.puzzle.rows.join("|");
      if (seenBoards.has(boardKey)) {
        console.log(`  Duplicate board, retrying...`);
        continue;
      }
      seenBoards.add(boardKey);

      const idx = startIndex + puzzles.length + 1;
      const id = `gen-${config.difficulty}-${String(idx).padStart(3, "0")}`;
      const title = titles[(titleIndex++) % titles.length] ||
        `Generated ${config.difficulty} ${idx}`;

      const puzzle: PuzzleDefinition = {
        id,
        title,
        difficulty: result.puzzle.difficulty,
        boxes: result.puzzle.boxes,
        rows: result.puzzle.rows,
        collection: "Sokomind Generated",
      };

      puzzles.push(puzzle);
      consecutiveFailures = 0;

      console.log(
        `  [${puzzles.length}/${config.target}] ${id} — ` +
        `${result.puzzle.difficulty}, ${result.solverMoves} moves, ` +
        `${result.solverPushes} pushes (${result.attempts} attempts)`,
      );
    } else {
      consecutiveFailures++;
      console.log(
        `  [FAIL ${consecutiveFailures}/${maxConsecutiveFailures}] ` +
        `${result.lastReason} (${result.attempts} attempts)`,
      );
    }
  }

  return puzzles;
}

async function main() {
  console.log("=== Generating Expert + Master Puzzles (high box counts) ===\n");

  const outputPath = join(__dirname, "..", "src", "catalog", "generated-puzzles.json");
  const existing: PuzzleDefinition[] = JSON.parse(readFileSync(outputPath, "utf-8"));

  const expertCount = existing.filter((p) => p.difficulty === "expert").length;
  const masterCount = existing.filter((p) => p.difficulty === "master").length;

  console.log(`Existing: ${existing.length} total (${expertCount} expert, ${masterCount} master)`);

  const newPuzzles: PuzzleDefinition[] = [];

  for (const config of TIER_CONFIGS) {
    const startIdx = config.difficulty === "expert"
      ? expertCount + newPuzzles.filter((p) => p.difficulty === "expert").length
      : masterCount + newPuzzles.filter((p) => p.difficulty === "master").length;
    const puzzles = await generateForTier(config, startIdx);
    newPuzzles.push(...puzzles);
  }

  const combined = [...existing, ...newPuzzles];
  writeFileSync(outputPath, JSON.stringify(combined, null, 2) + "\n");

  console.log(`\n=== Complete ===`);
  console.log(`Added ${newPuzzles.length} puzzles. Total: ${combined.length}`);

  const byDifficulty: Record<string, number> = {};
  for (const p of combined) {
    byDifficulty[p.difficulty] = (byDifficulty[p.difficulty] ?? 0) + 1;
  }
  console.log("\nFull breakdown:");
  for (const [d, c] of Object.entries(byDifficulty).sort()) {
    console.log(`  ${d}: ${c}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
