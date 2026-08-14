#!/usr/bin/env node

/** Keep the source-derived block in docs/PROJECT-REFERENCE.md synchronized. */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCUMENT = join(ROOT, "docs", "PROJECT-REFERENCE.md");
const START = "<!-- SOURCE_FACTS:START -->";
const END = "<!-- SOURCE_FACTS:END -->";
const CHECK = process.argv.includes("--check");

const readText = (path) => readFile(join(ROOT, path), "utf8");
const packageJson = JSON.parse(await readText("package.json"));
const metadata = JSON.parse(await readText("src/catalog/puzzle-metadata.json"));
const classicSource = await readText("src/solver/implementations/classic-solvers.ts");
const sokomindSource = await readText("src/solver/implementations/sokomind-solver.ts");
const optimalCacheSource = await readText("src/shared/optimal-cache.ts");
const staticBuildSource = await readText("tests/static-build.test.mjs");

const { STORAGE_KEYS, APP_SESSION_STORAGE_KEYS, APP_SESSION_STORAGE_PREFIXES } =
  await import("../src/shared/storage.ts");
const { STORED_PROGRESS_VERSION } =
  await import("../src/shared/progress-sync.ts");
const { MAX_ACTIVITY_DAYS, MAX_ACTIVITY_ENTRIES } =
  await import("../src/shared/progress.ts");
const { MAX_PROGRESS_IMPORT_BYTES, MAX_PROGRESS_IMPORT_RECORDS } =
  await import("../src/shared/progress-import.ts");
const { SAVED_SESSION_VERSION, MAX_SAVED_ACTIONS } =
  await import("../src/shared/session-persistence.ts");
const { EDITOR_DRAFT_STORE_VERSION, MAX_EDITOR_DRAFTS } =
  await import("../src/features/editor/editor-draft.ts");
const { EXPERIENCE_PREFERENCES_VERSION, DEFAULT_EXPERIENCE_PREFERENCES } =
  await import("../src/features/experience/experience-preferences.ts");
const { SOLVER_WORKER_PROTOCOL_VERSION } =
  await import("../src/solver/protocol.ts");
const { IDA_STAR_CHECKPOINT_SCHEMA_VERSION } =
  await import("../src/solver/search/ida-star-checkpoint.ts");
const { DEFAULT_SOKOMIND_REQUEST_OPTIONS } =
  await import("../src/solver/implementations/sokomind-options.ts");
const { EXACT_SEARCH_FEATURE_KEYS, DEFAULT_EXACT_SEARCH_FEATURES } =
  await import("../src/solver/search/exact-search-features.ts");
const { BENCHMARK_CORPUS, isClassicEligible } =
  await import("../tests/fixtures/solver-v2/benchmark-corpus.ts");
const { KNOWN_OPTIMA_BY_FIXTURE_ID } =
  await import("../tests/fixtures/solver-v2/known-optima.ts");

function metadataVersion(source, id) {
  const start = source.indexOf(`id: "${id}"`);
  if (start < 0) throw new Error(`Could not find solver metadata for ${id}`);
  const match = /version:\s*"([^"]+)"/u.exec(source.slice(start, start + 700));
  if (!match) throw new Error(`Could not find solver version for ${id}`);
  return match[1];
}

function numericConstant(source, name) {
  const match = new RegExp(`${name}:\\s*([0-9_]+)`, "u").exec(source);
  if (!match) throw new Error(`Could not find numeric constant ${name}`);
  return Number(match[1].replaceAll("_", ""));
}

const difficulties = new Map();
const collections = new Set();
const shards = new Set();
for (const tuple of metadata.puzzles) {
  difficulties.set(tuple[2], (difficulties.get(tuple[2]) ?? 0) + 1);
  collections.add(tuple[6]);
  shards.add(tuple[7]);
}

const optimalSchemaMatch = /readonly version:\s*([0-9]+);/u.exec(optimalCacheSource);
if (!optimalSchemaMatch) throw new Error("Could not find optimal-cache schema version");

const solverRows = [
  ["classic-dfs", metadataVersion(classicSource, "classic-dfs"), "first-found"],
  ["classic-greedy", metadataVersion(classicSource, "classic-greedy"), "first-found"],
  ["classic-astar", metadataVersion(classicSource, "classic-astar"), "move-optimal proof"],
  ["classic-ida-star", metadataVersion(classicSource, "classic-ida-star"), "move-optimal proof"],
  ["sokomind-solver", metadataVersion(sokomindSource, "sokomind-solver"), "bounded discovery/rewrite/proof portfolio"],
];

const routeRows = [
  ["Home", "`#/`"],
  ["Difficulties", "`#/puzzles`"],
  ["Difficulty", "`#/puzzles/:difficulty?page=N`"],
  ["Collection", "`#/puzzles/:difficulty/:collection?page=N`"],
  ["Play", "`#/play/:puzzleId?play=UDLR...`"],
  ["Editor", "`#/editor?custom=...`"],
  ["Stats", "`#/stats`"],
];

const lines = [
  START,
  "",
  "> Generated from source by `scripts/generate-project-reference.mjs`. Do not edit this block manually.",
  "",
  "### Runtime and catalog",
  "",
  `- Package version: \`${packageJson.version}\``,
  `- Supported Node.js: \`${packageJson.engines.node}\``,
  `- Catalog schema: \`${metadata.version}\``,
  `- Puzzles: **${metadata.puzzles.length.toLocaleString("en-US")}** across **${collections.size}** collections and **${shards.size}** shards`,
  `- Difficulty counts: ${[...difficulties].map(([name, count]) => `\`${name}\` ${count}`).join(", ")}`,
  "",
  "### Routes",
  "",
  "| Surface | Canonical hash |",
  "|---|---|",
  ...routeRows.map(([name, route]) => `| ${name} | ${route} |`),
  "",
  "### Persistent identifiers",
  "",
  "| Owner | Key |",
  "|---|---|",
  ...Object.entries(STORAGE_KEYS).map(([owner, key]) => `| ${owner} | \`${key}\` |`),
  ...APP_SESSION_STORAGE_KEYS.map((key) => `| session-only | \`${key}\` |`),
  ...APP_SESSION_STORAGE_PREFIXES.map((key) => `| session-only prefix | \`${key}*\` |`),
  `| progress payload schema | \`${STORED_PROGRESS_VERSION}\` |`,
  `| saved-session payload schema | \`${SAVED_SESSION_VERSION}\` |`,
  `| editor-draft payload schema | \`${EDITOR_DRAFT_STORE_VERSION}\` |`,
  `| optimal-record payload schema | \`${optimalSchemaMatch[1]}\` |`,
  "",
  "### Bounded local data",
  "",
  `- Saved action-log limit: **${MAX_SAVED_ACTIONS.toLocaleString("en-US")}** actions`,
  `- Progress import limit: **${MAX_PROGRESS_IMPORT_BYTES.toLocaleString("en-US")} bytes** and **${MAX_PROGRESS_IMPORT_RECORDS.toLocaleString("en-US")} records**`,
  `- Completion activity retention: **${MAX_ACTIVITY_DAYS.toLocaleString("en-US")} days** and **${MAX_ACTIVITY_ENTRIES.toLocaleString("en-US")} entries**`,
  `- Named editor draft limit: **${MAX_EDITOR_DRAFTS.toLocaleString("en-US")} drafts**`,
  "",
  "### User-facing defaults",
  "",
  `- Audio master: **${DEFAULT_EXPERIENCE_PREFERENCES.soundEnabled ? "on" : "off"}**`,
  `- Music: **${DEFAULT_EXPERIENCE_PREFERENCES.musicEnabled ? "on" : "off"}**`,
  `- Effects volume: **${Math.round(DEFAULT_EXPERIENCE_PREFERENCES.effectsVolume * 100)}%**`,
  `- Music volume: **${Math.round(DEFAULT_EXPERIENCE_PREFERENCES.musicVolume * 100)}%**`,
  `- Theme: \`${DEFAULT_EXPERIENCE_PREFERENCES.theme}\`; motion: \`${DEFAULT_EXPERIENCE_PREFERENCES.motion}\`; preference schema: \`${EXPERIENCE_PREFERENCES_VERSION}\``,
  "",
  "### Solver identities",
  "",
  "| Solver ID | Version | Contract |",
  "|---|---:|---|",
  ...solverRows.map(([id, version, contract]) => `| \`${id}\` | \`${version}\` | ${contract} |`),
  "",
  "### Solver protocol and default portfolio",
  "",
  `- Outer worker protocol: \`${SOLVER_WORKER_PROTOCOL_VERSION}\``,
  `- IDA* checkpoint schema: \`${IDA_STAR_CHECKPOINT_SCHEMA_VERSION}\``,
  `- Sokomind mode: \`${DEFAULT_SOKOMIND_REQUEST_OPTIONS.mode}\``,
  `- Proof algorithm: \`${DEFAULT_SOKOMIND_REQUEST_OPTIONS.proofAlgorithm}\`; proof parallelism: **${DEFAULT_SOKOMIND_REQUEST_OPTIONS.proofParallelism}**`,
  `- Maximum harvested incumbents: **${DEFAULT_SOKOMIND_REQUEST_OPTIONS.maximumIncumbents}**; harvest window: **${DEFAULT_SOKOMIND_REQUEST_OPTIONS.harvestElapsedMs.toLocaleString("en-US")} ms**`,
  `- IDA* reachability snapshots: \`${DEFAULT_SOKOMIND_REQUEST_OPTIONS.idaReachabilitySnapshots}\` every **${DEFAULT_SOKOMIND_REQUEST_OPTIONS.idaSnapshotPeriod}** levels`,
  "",
  "### Exact-search controls",
  "",
  ...EXACT_SEARCH_FEATURE_KEYS.map((key) =>
    `- \`${key}\`: ${DEFAULT_EXACT_SEARCH_FEATURES[key] ? "enabled" : "disabled"} by default`),
  "",
  "### Frozen solver evidence",
  "",
  `- Immutable benchmark fixtures: **${BENCHMARK_CORPUS.length}**`,
  `- Classic-eligible fixtures: **${BENCHMARK_CORPUS.filter(isClassicEligible).length}**`,
  `- Frozen exact optima: **${Object.keys(KNOWN_OPTIMA_BY_FIXTURE_ID).length}**`,
  "- Current performance artifact schema: **3**; schema-2 `baseline-v0.json` is historical only.",
  "",
  "### Delivery ceilings",
  "",
  `- All scripts and styles: **${numericConstant(staticBuildSource, "allScriptsAndStylesGzipBytes").toLocaleString("en-US")} gzip bytes**`,
  `- Largest asset: **${numericConstant(staticBuildSource, "largestAssetGzipBytes").toLocaleString("en-US")} gzip bytes**`,
  `- Solver worker: **${numericConstant(staticBuildSource, "solverWorkerGzipBytes").toLocaleString("en-US")} gzip bytes**`,
  `- Nested engine worker: **${numericConstant(staticBuildSource, "engineWorkerGzipBytes").toLocaleString("en-US")} gzip bytes**`,
  "",
  END,
].join("\n");

const document = await readFile(DOCUMENT, "utf8");
const start = document.indexOf(START);
const end = document.indexOf(END, start + START.length);
if (start < 0 || end < 0) {
  throw new Error(`${DOCUMENT} is missing the source-facts markers`);
}
const expected = `${document.slice(0, start)}${lines}${document.slice(end + END.length)}`;
if (expected === document) {
  console.log("Project reference source facts are current.");
} else if (CHECK) {
  console.error("docs/PROJECT-REFERENCE.md is stale. Run npm run prepare:project-reference.");
  process.exitCode = 1;
} else {
  await writeFile(DOCUMENT, expected, "utf8");
  console.log("Updated docs/PROJECT-REFERENCE.md from source.");
}
