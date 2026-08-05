/**
 * One-time script to convert all-imported.json into PuzzleDefinition-compatible JSON.
 *
 * Usage:
 *   node --experimental-strip-types scripts/prepare-imported-puzzles.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ImportedPuzzle {
  id: string;
  rows: string[];
  boxes: number;
  width: number;
  height: number;
  title?: string;
}

interface SourceData {
  puzzles: ImportedPuzzle[];
}

type Difficulty = "tutorial" | "beginner" | "intermediate" | "advanced" | "expert" | "master";

interface OutputPuzzle {
  id: string;
  title: string;
  difficulty: Difficulty;
  boxes: number;
  rows: string[];
  collection: string;
}

const COLLECTION_LABELS: Record<string, string> = {
  microban: "Microban",
  "boxoban-medium": "Boxoban Medium",
  "boxoban-hard": "Boxoban Hard",
  extremelyeasy: "Extremely Easy",
  illustrativelevels: "Illustrative Levels",
  seeminglyhard: "Seemingly Hard",
  caleb: "Caleb",
};

function parseCollection(id: string): { collection: string; number: string } {
  const match = id.match(/^(.*?)-(\d+)$/);
  if (!match) return { collection: id, number: "001" };

  let collectionKey = match[1];
  const number = match[2];

  // Normalize boxoban keys like "boxoban-medium-000" to "boxoban-medium"
  if (collectionKey.match(/^boxoban-(medium|hard)-\d+$/)) {
    collectionKey = collectionKey.replace(/-\d+$/, "");
  }

  return { collection: collectionKey, number };
}

function generateTitle(id: string, existingTitle: string | undefined): string {
  if (existingTitle) {
    // Clean up titles like 'ExtremelyEasy, "Easy #01"' to just 'Easy 01'
    const match = existingTitle.match(/"([^"]+)"/);
    if (match) {
      return match[1].replace(/#(\d+)/, "$1");
    }
    return existingTitle;
  }

  const { collection, number } = parseCollection(id);
  const label = COLLECTION_LABELS[collection] ?? collection;
  return `${label} ${number}`;
}

function assignDifficulty(id: string, boxes: number): Difficulty {
  const { collection } = parseCollection(id);

  if (collection === "extremelyeasy") return "beginner";
  if (collection === "seeminglyhard") return "expert";

  if (collection === "boxoban-hard") {
    if (boxes <= 4) return "advanced";
    if (boxes <= 8) return "expert";
    return "master";
  }

  // microban, boxoban-medium, illustrativelevels, caleb
  if (boxes <= 2) return "beginner";
  if (boxes <= 4) return "intermediate";
  if (boxes <= 7) return "advanced";
  if (boxes <= 10) return "expert";
  return "master";
}

function validateRows(rows: string[]): boolean {
  if (rows.length === 0) return false;
  const width = rows[0].length;
  if (width === 0) return false;
  if (!rows.every((row) => row.length === width)) return false;

  const flat = rows.join("");
  const robotCount = (flat.match(/R/g) ?? []).length;
  if (robotCount !== 1) return false;

  const genericBoxes = (flat.match(/X/g) ?? []).length;
  const genericGoals = (flat.match(/S/g) ?? []).length;
  if (genericBoxes !== genericGoals) return false;

  return true;
}

// --- Main ---

const sourcePath = resolve(
  __dirname,
  "../../Sokomind_extracted/data/collections/all-imported.json",
);
const outputPath = resolve(__dirname, "../src/catalog/imported-puzzles.json");

const source: SourceData = JSON.parse(readFileSync(sourcePath, "utf-8"));
console.log(`Read ${source.puzzles.length} puzzles from source.`);

const output: OutputPuzzle[] = [];
const skipped: string[] = [];

for (const puzzle of source.puzzles) {
  if (!validateRows(puzzle.rows)) {
    skipped.push(puzzle.id);
    continue;
  }

  const { collection } = parseCollection(puzzle.id);

  output.push({
    id: puzzle.id,
    title: generateTitle(puzzle.id, puzzle.title),
    difficulty: assignDifficulty(puzzle.id, puzzle.boxes),
    boxes: puzzle.boxes,
    rows: puzzle.rows,
    collection: COLLECTION_LABELS[collection] ?? collection,
  });
}

writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");

console.log(`Wrote ${output.length} puzzles to ${outputPath}`);
if (skipped.length > 0) {
  console.log(`Skipped ${skipped.length} invalid puzzles: ${skipped.join(", ")}`);
}

// Summary by difficulty
const byDifficulty = new Map<string, number>();
for (const p of output) {
  byDifficulty.set(p.difficulty, (byDifficulty.get(p.difficulty) ?? 0) + 1);
}
console.log("\nDifficulty distribution:");
for (const [diff, count] of [...byDifficulty].sort()) {
  console.log(`  ${diff}: ${count}`);
}

// Summary by collection
const byCollection = new Map<string, number>();
for (const p of output) {
  byCollection.set(p.collection, (byCollection.get(p.collection) ?? 0) + 1);
}
console.log("\nCollection distribution:");
for (const [coll, count] of [...byCollection].sort()) {
  console.log(`  ${coll}: ${count}`);
}
