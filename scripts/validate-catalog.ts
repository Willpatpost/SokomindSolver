import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePuzzle } from "../src/core/puzzle.ts";
import type { PuzzleDefinition } from "../src/core/model.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const generated: PuzzleDefinition[] = JSON.parse(
  readFileSync(join(__dirname, "..", "src", "catalog", "generated-puzzles.json"), "utf-8"),
);

console.log(`Generated: ${generated.length}`);

let errors = 0;
for (const puzzle of generated) {
  const result = validatePuzzle(puzzle);
  if (!result.valid) {
    console.error(`INVALID: ${puzzle.id} — ${result.errors.map((e) => e.message).join("; ")}`);
    errors++;
  }
}

const genIds = new Set<string>();
for (const puzzle of generated) {
  if (genIds.has(puzzle.id)) {
    console.error(`DUPLICATE ID within generated: ${puzzle.id}`);
    errors++;
  }
  genIds.add(puzzle.id);
}

if (errors > 0) {
  console.error(`\n${errors} errors found!`);
  process.exit(1);
}

const byDiff: Record<string, number> = {};
const labeled: Record<string, number> = {};
for (const p of generated) {
  byDiff[p.difficulty] = (byDiff[p.difficulty] ?? 0) + 1;
  const allChars = p.rows.join("");
  const hasLabel = [...allChars].some(
    (ch) => ch >= "A" && ch <= "Z" && !["O", "R", "S", "X"].includes(ch),
  );
  if (hasLabel) {
    labeled[p.difficulty] = (labeled[p.difficulty] ?? 0) + 1;
  }
}

console.log("\nAll validation passed.\n");
console.log("Generated catalog:");
console.log("Tier          | Count  | With Labels");
console.log("------------- | ------ | -----------");
for (const d of ["tutorial", "beginner", "intermediate", "advanced", "expert", "master"] as const) {
  const count = byDiff[d] ?? 0;
  const lab = labeled[d] ?? 0;
  console.log(`${d.padEnd(13)} | ${String(count).padStart(6)} | ${lab}`);
}
console.log(`${"TOTAL".padEnd(13)} | ${String(generated.length).padStart(6)} | ${Object.values(labeled).reduce((a, b) => a + b, 0)}`);

console.log("\n(+ 19 canonical puzzles defined in puzzles.ts)");
console.log(`Grand total: ${generated.length + 19} puzzles`);
