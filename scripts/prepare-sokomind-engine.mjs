import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractValidatorSource, stripRegistration } from "./sokomind-engine-artifacts.mjs";
import { SOKOMIND_ENGINE_SOURCE_FILES } from "./sokomind-engine-files.mjs";

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
const validatorPath = path.join(engineDirectory, "strategic-validation.generated.js");

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
  for (const file of SOKOMIND_ENGINE_SOURCE_FILES) {
    const source = stripRegistration(
      await fs.readFile(path.join(sourceDirectory, file), "utf8"),
      file,
    );
    modules.push(`\n/* ===== ${file} ===== */\n${source.trimEnd()}\n`);
  }
  return `${banner}${modules.join("")}\nexport { bidirectionalSide, search, validateStrategicPlanContract, evaluateStrategicPlanState, rebaseStrategicPlan };\n`;
}

const contractSource = await fs.readFile(path.join(sourceDirectory, "strategic-contract.js"), "utf8");
const validatorSource = extractValidatorSource(contractSource);
const artifacts = [
  [outputPath, await generatedSource()],
  [validatorPath, banner + validatorSource + "\nexport { validateStrategicPlanContract };\n"],
];
for (const [artifactPath, expected] of artifacts) {
  let existing = "";
  try {
    existing = await fs.readFile(artifactPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (process.argv.includes("--check")) {
    if (existing !== expected) throw new Error(
      "Sokomind engine artifact is stale. Run npm run prepare:sokomind-solver.");
  } else if (existing !== expected) {
    await fs.writeFile(artifactPath, expected, "utf8");
  }
}
if (process.argv.includes("--check")) {
  // The validator artifact is imported on its own, so it must load without
  // the engine's shared scope.
  const validator = await import(pathToFileURL(validatorPath).href);
  if (typeof validator.validateStrategicPlanContract !== "function") throw new Error(
    "strategic-validation.generated.js does not export validateStrategicPlanContract.");
}
