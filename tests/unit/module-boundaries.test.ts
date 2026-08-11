import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SEARCH_DIR = resolve(import.meta.dirname, "../../src/solver/search");

function readSource(filename: string): string {
  return readFileSync(resolve(SEARCH_DIR, filename), "utf-8");
}

function extractImportSources(source: string): string[] {
  const matches = source.matchAll(/from\s+["']([^"']+)["']/g);
  return [...matches].map((m) => m[1]);
}

describe("module boundary: no engine.ts cycle through low-level builders", () => {
  it("pattern-database.ts does not import from engine.ts", () => {
    const sources = extractImportSources(readSource("pattern-database.ts"));
    const importsEngine = sources.some((s) => s.endsWith("/engine.ts") || s === "./engine.ts");
    assert.equal(
      importsEngine,
      false,
      "pattern-database.ts must not import from engine.ts (use scheduling.ts instead)",
    );
  });

  it("deadlock-tables.ts does not import from engine.ts", () => {
    const sources = extractImportSources(readSource("deadlock-tables.ts"));
    const importsEngine = sources.some((s) => s.endsWith("/engine.ts") || s === "./engine.ts");
    assert.equal(
      importsEngine,
      false,
      "deadlock-tables.ts must not import from engine.ts (use scheduling.ts instead)",
    );
  });

  it("scheduling.ts does not import from any search algorithm module", () => {
    const sources = extractImportSources(readSource("scheduling.ts"));
    const algorithmModules = [
      "engine.ts",
      "ida-star.ts",
      "exact-move-astar.ts",
      "heuristic.ts",
      "pattern-database.ts",
      "deadlock-tables.ts",
      "goal-partitioning.ts",
    ];
    for (const mod of algorithmModules) {
      const imports = sources.some((s) => s.endsWith(`/${mod}`) || s === `./${mod}`);
      assert.equal(imports, false, `scheduling.ts must not import from ${mod}`);
    }
  });
});
