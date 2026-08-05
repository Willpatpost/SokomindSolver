import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePuzzle } from "../src/core/puzzle.ts";
import type { PuzzleDefinition, Difficulty } from "../src/core/model.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(__dirname, "..", "src", "catalog");

const TIERS: Difficulty[] = [
  "tutorial", "beginner", "intermediate", "advanced", "expert", "master",
];

// Load existing generated puzzles
const mainPath = join(catalogDir, "generated-puzzles.json");
let existing: PuzzleDefinition[] = [];
if (existsSync(mainPath)) {
  existing = JSON.parse(readFileSync(mainPath, "utf-8"));
}

// Load per-tier batches
const perTier: PuzzleDefinition[] = [];
for (const tier of TIERS) {
  const path = join(catalogDir, `generated-${tier}.json`);
  if (existsSync(path)) {
    const batch: PuzzleDefinition[] = JSON.parse(readFileSync(path, "utf-8"));
    perTier.push(...batch);
    console.log(`  ${tier}: ${batch.length} new puzzles from batch`);
  }
}

// Merge: existing + per-tier batches, dedup by board content
const seenBoards = new Set<string>();
const merged: PuzzleDefinition[] = [];

for (const p of [...existing, ...perTier]) {
  const key = p.rows.join("|");
  if (seenBoards.has(key)) continue;
  seenBoards.add(key);
  merged.push(p);
}

// Re-assign IDs per difficulty
const counters: Record<string, number> = {};
for (const puzzle of merged) {
  const d = puzzle.difficulty;
  counters[d] = (counters[d] ?? 0) + 1;
  // @ts-expect-error mutating readonly fields for ID reassignment
  puzzle.id = `gen-${d}-${String(counters[d]).padStart(3, "0")}`;
  // @ts-expect-error mutating readonly fields for title reassignment
  puzzle.title = `${d.charAt(0).toUpperCase() + d.slice(1)} ${counters[d]}`;
}

// Validate all
let errors = 0;
for (const p of merged) {
  const result = validatePuzzle(p);
  if (!result.valid) {
    console.error(`INVALID: ${p.id} — ${result.errors.map((e) => e.message).join("; ")}`);
    errors++;
  }
}

// Check no duplicate IDs
const ids = merged.map((p) => p.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length > 0) {
  console.error("DUPLICATE IDs:", dupes);
  errors++;
}

if (errors > 0) {
  console.error(`\n${errors} errors found!`);
  process.exit(1);
}

writeFileSync(mainPath, JSON.stringify(merged, null, 2) + "\n");

// Print final stats
console.log(`\nMerged ${merged.length} puzzles (from ${existing.length} existing + ${perTier.length} new batch)`);
console.log("\nFinal distribution:");

const canonical: Record<string, number> = {
  tutorial: 5, beginner: 5, intermediate: 7, advanced: 9, expert: 4, master: 2,
};

console.log("Tier          | Generated | Canonical | Total");
console.log("------------- | --------- | --------- | -----");
let totalGen = 0, totalAll = 0;
for (const d of TIERS) {
  const gen = counters[d] ?? 0;
  const can = canonical[d] ?? 0;
  const total = gen + can;
  totalGen += gen;
  totalAll += total;
  console.log(`${d.padEnd(13)} | ${String(gen).padStart(9)} | ${String(can).padStart(9)} | ${String(total).padStart(5)}`);
}
console.log(`------------- | --------- | --------- | -----`);
console.log(`${"TOTAL".padEnd(13)} | ${String(totalGen).padStart(9)} | ${String(32).padStart(9)} | ${String(totalAll).padStart(5)}`);

// Check labeled
let labeled = 0;
for (const p of merged) {
  const chars = new Set([...p.rows.join("")].filter(
    (ch) => ch >= "A" && ch <= "Z" && !["O", "R", "S", "X"].includes(ch),
  ));
  if (chars.size >= 2) labeled++;
}
console.log(`\nMulti-label puzzles: ${labeled}/${merged.length}`);
