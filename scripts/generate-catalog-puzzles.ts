import { generatePuzzle } from "../src/features/generator/generate-puzzle.ts";
import type { GeneratorParams } from "../src/features/generator/generator-types.ts";
import type { Difficulty, PuzzleDefinition } from "../src/core/model.ts";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TierConfig {
  difficulty: Difficulty;
  target: number;
  params: Omit<GeneratorParams, "targetDifficulty" | "useLabels" | "maxAttempts">;
  maxAttempts: number;
}

const TIER_CONFIGS: TierConfig[] = [
  {
    difficulty: "tutorial",
    target: 25,
    params: { width: 6, height: 6, boxCount: 2 },
    maxAttempts: 150,
  },
  {
    difficulty: "tutorial",
    target: 20,
    params: { width: 7, height: 6, boxCount: 2 },
    maxAttempts: 150,
  },
  {
    difficulty: "beginner",
    target: 35,
    params: { width: 7, height: 7, boxCount: 2 },
    maxAttempts: 100,
  },
  {
    difficulty: "beginner",
    target: 20,
    params: { width: 7, height: 7, boxCount: 3 },
    maxAttempts: 100,
  },
  {
    difficulty: "beginner",
    target: 20,
    params: { width: 8, height: 7, boxCount: 3 },
    maxAttempts: 100,
  },
  {
    difficulty: "expert",
    target: 20,
    params: { width: 10, height: 10, boxCount: 5 },
    maxAttempts: 150,
  },
  {
    difficulty: "expert",
    target: 20,
    params: { width: 11, height: 11, boxCount: 6 },
    maxAttempts: 150,
  },
  {
    difficulty: "master",
    target: 10,
    params: { width: 12, height: 12, boxCount: 7 },
    maxAttempts: 200,
  },
  {
    difficulty: "master",
    target: 10,
    params: { width: 13, height: 13, boxCount: 8 },
    maxAttempts: 200,
  },
];

const TITLES: Record<Difficulty, string[]> = {
  tutorial: [
    "Letter Swap", "Twin Blocks", "Color Match", "Pair Up", "Simple Sort",
    "First Labels", "Easy Exchange", "Two Step", "Quick Match", "Mini Shuffle",
    "Starter Pair", "Label Intro", "Tiny Trade", "Basic Swap", "Warm Up",
    "Mirror Match", "Duo Move", "Short Path", "Match Maker", "Simple Slide",
    "Quick Pair", "Easy Match", "Double Step", "Letter Push", "Beginner Swap",
    "A-B Match", "Twin Goals", "Mini Logic", "First Puzzle", "Quick Sort",
    "Baby Steps", "Pair Puzzle", "Little Match", "Easy Logic", "Two Tones",
    "Label Basics", "Mini Trade", "Gentle Push", "Small Swap", "Start Here",
    "Tiny Puzzle", "Simple Push", "Short Swap", "Easy Two", "Basic Match",
  ],
  beginner: [
    "Garden Path", "Corner Match", "Three Way", "Hall Swap", "Room Sort",
    "Cross Match", "Label Lane", "Color Slide", "Puzzle Walk", "Match Walk",
    "Open Floor", "Block Dance", "Pair Paths", "Letter Lane", "Triple Step",
    "Easy Detour", "Path Cross", "Simple Maze", "Label Maze", "Swap Room",
    "Short Circuit", "Corridor", "Small Hall", "Box Shuffle", "Gentle Maze",
    "Match Room", "Twin Paths", "Low Bridge", "Quiet Corner", "Letter Walk",
    "Open Match", "Slide Path", "Trail Match", "Box Garden", "Light Swap",
    "Pair Lane", "Side Step", "Cross Lane", "Room Walk", "Three Blocks",
    "Easy Cross", "Garden Swap", "Block Trail", "Maze Match", "Path Sort",
    "Color Walk", "Triple Swap", "Small Cross", "Duo Trail", "Match Garden",
    "Box Cross", "Lane Match", "Corner Sort", "Open Swap", "Garden Sort",
    "Block Path", "Easy Trail", "Swap Lane", "Three Match", "Room Match",
    "Maze Swap", "Match Lane", "Quick Cross", "Trail Sort", "Garden Match",
    "Corner Walk", "Lane Sort", "Block Match", "Pair Sort", "Triple Match",
    "Path Match", "Small Swap", "Cross Sort", "Easy Sort",
  ],
  intermediate: [],
  advanced: [],
  expert: [
    "Vault Puzzle", "Iron Cross", "Grand Swap", "Deep Maze", "Color Vault",
    "Expert Exchange", "Six Pack", "Hard Swap", "Complex Path", "Tight Fit",
    "Puzzle Vault", "Grand Cross", "Deep Swap", "Iron Maze", "Vault Cross",
    "Expert Maze", "Hard Cross", "Complex Swap", "Deep Cross", "Iron Swap",
    "Grand Maze", "Tight Cross", "Expert Cross", "Vault Maze", "Hard Maze",
    "Complex Cross", "Deep Vault", "Iron Exchange", "Grand Exchange", "Tight Swap",
    "Expert Sort", "Vault Sort", "Hard Sort", "Complex Sort", "Deep Sort",
    "Iron Sort", "Grand Sort",
  ],
  master: [
    "Labyrinth", "Grand Master", "Final Exam", "Master Class", "End Game",
    "Ultimate Sort", "Color Storm", "Master Maze", "Grand Finale", "Peak Puzzle",
    "Master Swap", "Grand Vault", "Final Cross", "Master Cross", "Peak Cross",
    "Grand Storm", "Final Maze", "Master Sort", "Grand Lock", "Peak Swap",
  ],
};

function generateId(difficulty: Difficulty, index: number): string {
  return `gen-${difficulty}-${String(index).padStart(3, "0")}`;
}

async function generateForTier(config: TierConfig): Promise<PuzzleDefinition[]> {
  const puzzles: PuzzleDefinition[] = [];
  const seenBoards = new Set<string>();
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 10;
  let titleIndex = 0;
  const titles = TITLES[config.difficulty];

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
      useLabels: config.params.boxCount >= 2,
      maxAttempts: config.maxAttempts,
    };

    const result = await generatePuzzle(params, undefined, undefined);

    if (result.status === "success") {
      const boardKey = result.puzzle.rows.join("|");
      if (seenBoards.has(boardKey)) {
        console.log(`  [${puzzles.length + 1}/${config.target}] Duplicate board, retrying...`);
        continue;
      }
      seenBoards.add(boardKey);

      const id = generateId(config.difficulty, puzzles.length + 1);
      const title = titles[titleIndex % titles.length] || `Generated ${config.difficulty} ${puzzles.length + 1}`;
      titleIndex++;

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
  console.log("=== Sokomind Puzzle Generator — Catalog Gap Filler ===");
  console.log("Generating labeled-box puzzles for underrepresented tiers...\n");

  const allPuzzles: PuzzleDefinition[] = [];

  for (const config of TIER_CONFIGS) {
    const puzzles = await generateForTier(config);
    allPuzzles.push(...puzzles);
  }

  const outputPath = join(__dirname, "..", "src", "catalog", "generated-puzzles.json");
  writeFileSync(outputPath, JSON.stringify(allPuzzles, null, 2) + "\n");

  console.log(`\n=== Generation Complete ===`);
  console.log(`Total puzzles generated: ${allPuzzles.length}`);
  console.log(`Output: ${outputPath}`);

  const byDifficulty: Record<string, number> = {};
  for (const p of allPuzzles) {
    byDifficulty[p.difficulty] = (byDifficulty[p.difficulty] ?? 0) + 1;
  }
  console.log("\nBreakdown:");
  for (const [d, c] of Object.entries(byDifficulty)) {
    console.log(`  ${d}: ${c}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
