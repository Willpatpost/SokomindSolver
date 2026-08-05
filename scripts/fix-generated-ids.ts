import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Difficulty, PuzzleDefinition } from "../src/core/model.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const path = join(__dirname, "..", "src", "catalog", "generated-puzzles.json");

const puzzles: PuzzleDefinition[] = JSON.parse(readFileSync(path, "utf-8"));

const counters: Record<string, number> = {};

for (const puzzle of puzzles) {
  const d = puzzle.difficulty;
  counters[d] = (counters[d] ?? 0) + 1;
  // @ts-expect-error mutating readonly field for ID reassignment
  puzzle.id = `gen-${d}-${String(counters[d]).padStart(3, "0")}`;
}

// Check for any remaining duplicates
const ids = puzzles.map((p) => p.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length > 0) {
  console.error("Still have duplicates:", dupes);
  process.exit(1);
}

writeFileSync(path, JSON.stringify(puzzles, null, 2) + "\n");

console.log("Fixed IDs. Final distribution:");
for (const d of ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"] as Difficulty[]) {
  console.log(`  ${d}: ${counters[d] ?? 0}`);
}
console.log(`  Total: ${puzzles.length}`);
