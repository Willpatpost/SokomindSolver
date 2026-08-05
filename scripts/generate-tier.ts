import { generatePuzzle } from "../src/features/generator/generate-puzzle.ts";
import type { GeneratorParams } from "../src/features/generator/generator-types.ts";
import type { Difficulty, PuzzleDefinition } from "../src/core/model.ts";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tier = process.argv[2] as Difficulty;

if (!["tutorial", "beginner", "intermediate", "advanced", "expert", "master"].includes(tier)) {
  console.error("Usage: generate-tier.ts <difficulty>");
  process.exit(1);
}

interface VariantConfig {
  params: Omit<GeneratorParams, "targetDifficulty" | "useLabels" | "maxAttempts">;
  maxAttempts: number;
  weight: number;
}

const TIER_VARIANTS: Record<Difficulty, VariantConfig[]> = {
  tutorial: [
    { params: { width: 6, height: 6, boxCount: 2 }, maxAttempts: 150, weight: 3 },
    { params: { width: 7, height: 6, boxCount: 2 }, maxAttempts: 150, weight: 2 },
    { params: { width: 7, height: 7, boxCount: 2 }, maxAttempts: 150, weight: 1 },
  ],
  beginner: [
    { params: { width: 7, height: 7, boxCount: 2 }, maxAttempts: 100, weight: 2 },
    { params: { width: 7, height: 7, boxCount: 3 }, maxAttempts: 120, weight: 3 },
    { params: { width: 8, height: 7, boxCount: 3 }, maxAttempts: 120, weight: 2 },
    { params: { width: 8, height: 8, boxCount: 3 }, maxAttempts: 120, weight: 1 },
  ],
  intermediate: [
    { params: { width: 8, height: 8, boxCount: 3 }, maxAttempts: 100, weight: 2 },
    { params: { width: 8, height: 8, boxCount: 4 }, maxAttempts: 120, weight: 3 },
    { params: { width: 9, height: 9, boxCount: 4 }, maxAttempts: 120, weight: 3 },
    { params: { width: 9, height: 9, boxCount: 5 }, maxAttempts: 150, weight: 2 },
    { params: { width: 10, height: 9, boxCount: 5 }, maxAttempts: 150, weight: 1 },
  ],
  advanced: [
    { params: { width: 9, height: 9, boxCount: 5 }, maxAttempts: 150, weight: 1 },
    { params: { width: 10, height: 10, boxCount: 5 }, maxAttempts: 150, weight: 2 },
    { params: { width: 10, height: 10, boxCount: 6 }, maxAttempts: 150, weight: 3 },
    { params: { width: 11, height: 11, boxCount: 6 }, maxAttempts: 150, weight: 2 },
    { params: { width: 11, height: 11, boxCount: 7 }, maxAttempts: 180, weight: 2 },
  ],
  expert: [
    { params: { width: 12, height: 12, boxCount: 8 }, maxAttempts: 200, weight: 3 },
    { params: { width: 13, height: 13, boxCount: 8 }, maxAttempts: 200, weight: 2 },
    { params: { width: 13, height: 13, boxCount: 9 }, maxAttempts: 200, weight: 3 },
    { params: { width: 14, height: 13, boxCount: 9 }, maxAttempts: 200, weight: 1 },
    { params: { width: 14, height: 14, boxCount: 10 }, maxAttempts: 250, weight: 1 },
  ],
  master: [
    { params: { width: 14, height: 14, boxCount: 11 }, maxAttempts: 250, weight: 3 },
    { params: { width: 15, height: 15, boxCount: 11 }, maxAttempts: 250, weight: 2 },
    { params: { width: 15, height: 15, boxCount: 12 }, maxAttempts: 250, weight: 3 },
    { params: { width: 16, height: 15, boxCount: 13 }, maxAttempts: 300, weight: 1 },
    { params: { width: 16, height: 16, boxCount: 14 }, maxAttempts: 300, weight: 1 },
  ],
};

function pickVariant(variants: VariantConfig[], rng: () => number): VariantConfig {
  const totalWeight = variants.reduce((s, v) => s + v.weight, 0);
  let r = rng() * totalWeight;
  for (const v of variants) {
    r -= v.weight;
    if (r <= 0) return v;
  }
  return variants[variants.length - 1];
}

function simpleRng(): () => number {
  let s = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TARGET = 400;
const SAVE_INTERVAL = 5;
const MAX_CONSECUTIVE_FAILURES = 20;

const outputPath = join(__dirname, "..", "src", "catalog", `generated-${tier}.json`);

// Load existing progress if resuming
let puzzles: PuzzleDefinition[] = [];
const seenBoards = new Set<string>();
if (existsSync(outputPath)) {
  puzzles = JSON.parse(readFileSync(outputPath, "utf-8"));
  for (const p of puzzles) seenBoards.add(p.rows.join("|"));
}

// Count how many we already have from existing generated-puzzles.json
const mainGenPath = join(__dirname, "..", "src", "catalog", "generated-puzzles.json");
let existingCount = 0;
if (existsSync(mainGenPath)) {
  const existing: PuzzleDefinition[] = JSON.parse(readFileSync(mainGenPath, "utf-8"));
  existingCount = existing.filter((p) => p.difficulty === tier).length;
  for (const p of existing.filter((p) => p.difficulty === tier)) {
    seenBoards.add(p.rows.join("|"));
  }
}

// Canonical counts
const canonicalCounts: Record<Difficulty, number> = {
  tutorial: 5, beginner: 5, intermediate: 7, advanced: 9, expert: 4, master: 2,
};

const totalHave = canonicalCounts[tier] + existingCount + puzzles.length;
const needed = Math.max(0, TARGET - totalHave);

console.log(`=== Generating ${tier} puzzles ===`);
console.log(`Canonical: ${canonicalCounts[tier]}, Existing generated: ${existingCount}, This batch: ${puzzles.length}`);
console.log(`Total have: ${totalHave}, Need: ${needed}`);

if (needed === 0) {
  console.log("Already at target!");
  process.exit(0);
}

const variants = TIER_VARIANTS[tier];
const rng = simpleRng();
let consecutiveFailures = 0;
let generated = 0;

async function run() {
  while (generated < needed) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(`  WARNING: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, resetting counter and continuing...`);
      consecutiveFailures = 0;
    }

    const variant = pickVariant(variants, rng);
    const params: GeneratorParams = {
      ...variant.params,
      targetDifficulty: tier,
      useLabels: variant.params.boxCount >= 2,
      maxAttempts: variant.maxAttempts,
    };

    const result = await generatePuzzle(params, undefined, undefined);

    if (result.status === "success") {
      const boardKey = result.puzzle.rows.join("|");
      if (seenBoards.has(boardKey)) {
        continue;
      }
      seenBoards.add(boardKey);

      const idx = existingCount + puzzles.length + 1;
      const id = `gen-${tier}-${String(idx).padStart(3, "0")}`;

      const puzzle: PuzzleDefinition = {
        id,
        title: `${tier.charAt(0).toUpperCase() + tier.slice(1)} ${idx}`,
        difficulty: result.puzzle.difficulty,
        boxes: result.puzzle.boxes,
        rows: result.puzzle.rows,
        collection: "Sokomind Generated",
      };

      puzzles.push(puzzle);
      generated++;
      consecutiveFailures = 0;

      const total = totalHave + generated;
      const w = variant.params.width;
      const h = variant.params.height;
      const b = variant.params.boxCount;
      console.log(
        `  [${total}/${TARGET}] ${id} — ${result.puzzle.difficulty}, ` +
        `${result.solverMoves}mv/${result.solverPushes}pu, ` +
        `${w}x${h}/${b}box (${result.attempts} att)`,
      );

      if (generated % SAVE_INTERVAL === 0) {
        writeFileSync(outputPath, JSON.stringify(puzzles, null, 2) + "\n");
      }
    } else {
      consecutiveFailures++;
      if (consecutiveFailures % 5 === 0) {
        console.log(
          `  [FAIL x${consecutiveFailures}] ${result.lastReason} (${result.attempts} att)`,
        );
      }
    }
  }

  writeFileSync(outputPath, JSON.stringify(puzzles, null, 2) + "\n");
  console.log(`\n=== ${tier} COMPLETE: ${puzzles.length} new + ${existingCount} existing + ${canonicalCounts[tier]} canonical = ${totalHave + generated} total ===`);
}

run().catch((err) => {
  writeFileSync(outputPath, JSON.stringify(puzzles, null, 2) + "\n");
  console.error(`Fatal error after generating ${generated} puzzles:`, err);
  process.exit(1);
});
