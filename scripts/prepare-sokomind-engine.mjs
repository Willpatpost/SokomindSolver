import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const engineDirectory = path.join(
  repositoryRoot,
  "src",
  "solver",
  "implementations",
  "sokomind-engine",
);
const sourceDirectory = path.join(engineDirectory, "source");
const outputPath = path.join(engineDirectory, "engine.generated.js");

// These classic scripts deliberately share one lexical scope. Their original
// browser worker loaded them in this dependency order with importScripts().
const SOURCE_FILES = Object.freeze([
  "state.js",
  "memo.js",
  "metrics.js",
  "topology.js",
  "board.js",
  "heuristic.js",
  "deadlock.js",
  "analysis.js",
  "push-generation.js",
  "solver-search.js",
]);

const banner = `/*
 * GENERATED FILE - DO NOT EDIT DIRECTLY.
 *
 * Regenerate with: npm run prepare:sokomind-solver
 *
 * Provenance:
 * - baseline search engine: ../Sokomind/src
 * - assignment heuristic: ../Sokomind/src/heuristic.js
 * - adapter protocol: record telemetry and structural generated-state cap
 *
 * The source modules are vendored beside this file. They are concatenated
 * because the original engine is a classic-worker script family whose
 * declarations intentionally share one lexical scope.
 */
`;

async function generatedSource() {
  const modules = [];
  for (const file of SOURCE_FILES) {
    const source = (
      await fs.readFile(path.join(sourceDirectory, file), "utf8")
    )
      // The vendored sources retain their old classic-script test exports.
      // The generated ESM has explicit exports below and should neither expose
      // CommonJS globals nor publish debugging namespaces on the worker.
      .replace(
        /^if \(typeof module === "object" && module\.exports\).*$/gmu,
        "",
      )
      .replace(
        /^if \(typeof globalThis !== "undefined"\) globalThis\.Sokomind.*$/gmu,
        "",
      )
      .replace(/^globalThis\.SokomindHardPruningRules.*$/gmu, "");
    modules.push(`\n/* ===== ${file} ===== */\n${source.trimEnd()}\n`);
  }
  return `${banner}${modules.join("")}\nexport { bidirectionalSide, search };\n`;
}

const expected = await generatedSource();
let existing = "";
try {
  existing = await fs.readFile(outputPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (process.argv.includes("--check")) {
  if (existing !== expected) {
    throw new Error(
      "Sokomind engine bundle is stale. Run npm run prepare:sokomind-solver.",
    );
  }
} else if (existing !== expected) {
  await fs.writeFile(outputPath, expected, "utf8");
}
