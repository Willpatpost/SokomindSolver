import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Difficulty, PuzzleDefinition } from "../src/core/model.ts";
import { DIFFICULTIES } from "../src/core/model.ts";
import { validatePuzzle } from "../src/core/puzzle.ts";
import { classifyFromMetrics } from "../src/features/generator/difficulty-classifier.ts";
import {
  runForge,
  summarizeForgeRun,
  forgeRunReport,
  forgeCandidateToAscii,
  evaluatePuzzles,
  summarizePopulation,
  DEFAULT_FORGE_CONFIG,
  DEFAULT_FORGE_GATES,
  type ForgeConfig,
  type ForgeCandidate,
  type PuzzleEvaluationVector,
  type PopulationSummary,
  type TopologyFamily,
  type ForgeGenerationMode,
} from "../src/features/generator/v2/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dirname, "../src/catalog/generated-puzzles.json");
const dryRun = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Per-tier forge configurations
// ---------------------------------------------------------------------------

interface TierConfig {
  readonly difficulty: Difficulty;
  readonly config: ForgeConfig;
}

// Board size note: the blueprint generator needs ≥12×12 to reliably place
// rooms + corridors. Easier tiers use 12×12 with fewer boxes; tightening
// removes unused floor to keep the effective area small.
const TIER_CONFIGS: readonly TierConfig[] = [
  {
    difficulty: "tutorial",
    config: {
      ...DEFAULT_FORGE_CONFIG,
      batchSize: 200,
      retainTarget: 10,
      families: ["linear", "hub"] as TopologyFamily[],
      boxCounts: [2],
      difficulties: ["tutorial"],
      modes: ["plain"] as ForgeGenerationMode[],
      boardWidth: 12,
      boardHeight: 12,
      beamParams: { maxDepth: 10 },
      baseSeed: 100000,
      gates: {
        ...DEFAULT_FORGE_GATES,
        minSolutionPushes: 2,
        maxMovesPerPush: 4,
        minSolverExpandedStates: 2,
      },
    },
  },
  {
    difficulty: "beginner",
    config: {
      ...DEFAULT_FORGE_CONFIG,
      batchSize: 200,
      retainTarget: 15,
      families: ["linear", "hub", "loop"] as TopologyFamily[],
      boxCounts: [2, 3],
      difficulties: ["beginner"],
      modes: ["plain", "motif"] as ForgeGenerationMode[],
      boardWidth: 12,
      boardHeight: 12,
      beamParams: { maxDepth: 20 },
      baseSeed: 110000,
      gates: {
        ...DEFAULT_FORGE_GATES,
        minSolutionPushes: 3,
        maxMovesPerPush: 5,
      },
    },
  },
  {
    difficulty: "intermediate",
    config: {
      ...DEFAULT_FORGE_CONFIG,
      batchSize: 200,
      retainTarget: 25,
      families: ["linear", "hub", "loop", "branch"] as TopologyFamily[],
      boxCounts: [3, 4],
      difficulties: ["intermediate"],
      modes: ["plain", "motif", "composed"] as ForgeGenerationMode[],
      boardWidth: 12,
      boardHeight: 12,
      beamParams: { maxDepth: 35 },
      baseSeed: 120000,
    },
  },
  {
    difficulty: "advanced",
    config: {
      ...DEFAULT_FORGE_CONFIG,
      batchSize: 200,
      retainTarget: 25,
      families: ["linear", "hub", "loop", "branch", "nested"] as TopologyFamily[],
      boxCounts: [3, 4, 5],
      difficulties: ["advanced"],
      modes: ["plain", "motif", "composed"] as ForgeGenerationMode[],
      boardWidth: 14,
      boardHeight: 14,
      beamParams: { maxDepth: 45 },
      baseSeed: 130000,
      gates: {
        ...DEFAULT_FORGE_GATES,
        minSolutionPushes: 6,
        minSolverExpandedStates: 10,
      },
    },
  },
  {
    difficulty: "expert",
    config: {
      ...DEFAULT_FORGE_CONFIG,
      batchSize: 150,
      retainTarget: 25,
      families: ["hub", "loop", "branch", "nested"] as TopologyFamily[],
      boxCounts: [4, 5, 6],
      difficulties: ["expert"],
      modes: ["plain", "motif", "composed"] as ForgeGenerationMode[],
      boardWidth: 14,
      boardHeight: 14,
      beamParams: { maxDepth: 55 },
      baseSeed: 140000,
      gates: {
        ...DEFAULT_FORGE_GATES,
        minSolutionPushes: 10,
        minSolverExpandedStates: 20,
        maxBoxIndependenceRatio: 0.85,
      },
    },
  },
  {
    difficulty: "master",
    config: {
      ...DEFAULT_FORGE_CONFIG,
      batchSize: 150,
      retainTarget: 20,
      families: ["loop", "branch", "nested"] as TopologyFamily[],
      boxCounts: [5, 6, 7],
      difficulties: ["master"],
      modes: ["plain", "motif", "composed"] as ForgeGenerationMode[],
      boardWidth: 14,
      boardHeight: 14,
      beamParams: { maxDepth: 70 },
      baseSeed: 150000,
      gates: {
        ...DEFAULT_FORGE_GATES,
        minSolutionPushes: 12,
        minSolverExpandedStates: 30,
        maxBoxIndependenceRatio: 0.80,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Difficulty reclassification
// ---------------------------------------------------------------------------

const TIER_RANK = new Map<Difficulty, number>(
  DIFFICULTIES.map((d, i) => [d, i]),
);

function reclassifyDifficulty(
  intended: Difficulty,
  ev: PuzzleEvaluationVector,
): { classified: Difficulty; note: string } {
  const classified = classifyFromMetrics(
    ev.solutionMoves,
    ev.solutionPushes,
    ev.boxCount,
  );

  const intendedRank = TIER_RANK.get(intended)!;
  const classifiedRank = TIER_RANK.get(classified)!;
  const gap = intendedRank - classifiedRank;

  if (gap <= 0) return { classified, note: "matches or harder" };
  return { classified, note: `${gap} tier(s) easier per V1 thresholds` };
}

// ---------------------------------------------------------------------------
// Catalog conversion
// ---------------------------------------------------------------------------

const TITLE_LABELS: Record<Difficulty, string> = {
  tutorial: "Tutorial",
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
  expert: "Expert",
  master: "Master",
};

function forgeCandidateToCatalogEntry(
  candidate: ForgeCandidate,
  difficulty: Difficulty,
  index: number,
): PuzzleDefinition {
  const num = String(index + 1).padStart(3, "0");
  return {
    id: `gen-${difficulty}-${num}`,
    title: `${TITLE_LABELS[difficulty]} ${index + 1}`,
    difficulty,
    boxes: candidate.puzzle.boxes,
    collection: "Sokomind Generated",
    rows: [...candidate.puzzle.rows],
  };
}

// ---------------------------------------------------------------------------
// Comparison reporting
// ---------------------------------------------------------------------------

function formatMetric(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}

function comparisonReport(
  v1Summary: PopulationSummary,
  v2Summary: PopulationSummary,
): string {
  const lines: string[] = [
    "",
    "=".repeat(60),
    "V1 vs V2 Comparison",
    "=".repeat(60),
    "",
    `${"Metric".padEnd(30)} ${"V1 Avg".padStart(10)} ${"V2 Avg".padStart(10)} ${"Δ".padStart(8)}`,
    "-".repeat(60),
  ];

  const m = (s: PopulationSummary, key: string): number => s.avg[key] ?? 0;

  const metrics: { label: string; v1: number; v2: number; lowerBetter: boolean }[] = [
    { label: "Solution Moves", v1: m(v1Summary, "solutionMoves"), v2: m(v2Summary, "solutionMoves"), lowerBetter: false },
    { label: "Solution Pushes", v1: m(v1Summary, "solutionPushes"), v2: m(v2Summary, "solutionPushes"), lowerBetter: false },
    { label: "Box Independence", v1: m(v1Summary, "boxIndependenceRatio"), v2: m(v2Summary, "boxIndependenceRatio"), lowerBetter: true },
    { label: "Empty Walk Ratio", v1: m(v1Summary, "emptyWalkRatio"), v2: m(v2Summary, "emptyWalkRatio"), lowerBetter: true },
    { label: "Unused Floor Ratio", v1: m(v1Summary, "unusedFloorRatio"), v2: m(v2Summary, "unusedFloorRatio"), lowerBetter: true },
    { label: "Deadlock Density", v1: m(v1Summary, "deadlockDensity"), v2: m(v2Summary, "deadlockDensity"), lowerBetter: false },
    { label: "Solver Expanded States", v1: m(v1Summary, "solverExpandedStates"), v2: m(v2Summary, "solverExpandedStates"), lowerBetter: false },
    { label: "Moves Per Push", v1: m(v1Summary, "movesPerPush"), v2: m(v2Summary, "movesPerPush"), lowerBetter: true },
    { label: "Repetitive Push Ratio", v1: m(v1Summary, "repetitivePushRatio"), v2: m(v2Summary, "repetitivePushRatio"), lowerBetter: true },
    { label: "Total Floor", v1: m(v1Summary, "totalFloor"), v2: m(v2Summary, "totalFloor"), lowerBetter: false },
  ];

  for (const m of metrics) {
    const delta = m.v2 - m.v1;
    const sign = delta >= 0 ? "+" : "";
    const indicator = (delta > 0) === !m.lowerBetter ? " ✓" : delta === 0 ? "" : " ✗";
    lines.push(
      `${m.label.padEnd(30)} ${formatMetric(m.v1).padStart(10)} ${formatMetric(m.v2).padStart(10)} ${(sign + formatMetric(delta)).padStart(8)}${indicator}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const totalStart = performance.now();
  console.log(`\nSokomind V2 Catalog Generator${dryRun ? " (DRY RUN)" : ""}`);
  console.log("=".repeat(50));

  // Phase 1: Run forge per tier
  const allCandidates = new Map<Difficulty, readonly ForgeCandidate[]>();
  const tierReports: string[] = [];

  for (const { difficulty, config } of TIER_CONFIGS) {
    console.log(`\n>>> Generating ${difficulty} tier (batch=${config.batchSize}, target=${config.retainTarget})...`);
    const result = await runForge(config);
    const summary = summarizeForgeRun(result);
    const report = forgeRunReport(result);
    tierReports.push(report);

    console.log(`    Attempted: ${result.totalAttempted} | Valid: ${result.totalValid} | Retained: ${result.totalRetained} (${summary.elapsedMs.toFixed(0)}ms)`);
    allCandidates.set(difficulty, result.candidates);
  }

  // Phase 2: Log difficulty classification (informational — forge gates
  // already enforce quality, so we trust the assigned tier)
  console.log("\n>>> Difficulty classification check...");
  const retainedByTier = new Map<Difficulty, readonly ForgeCandidate[]>();
  let classifierMismatches = 0;

  for (const difficulty of DIFFICULTIES) {
    const candidates = allCandidates.get(difficulty) ?? [];
    retainedByTier.set(difficulty, candidates);

    for (const c of candidates) {
      const { classified, note } = reclassifyDifficulty(
        difficulty,
        c.evaluation,
      );
      if (classified !== difficulty) {
        classifierMismatches++;
        console.log(`    [info] ${c.puzzle.id}: intended=${difficulty}, classified=${classified} — ${note}`);
      }
    }
  }

  console.log(`    Classifier mismatches: ${classifierMismatches} (informational only, all candidates kept)`);

  // Phase 3: Convert to catalog format
  console.log("\n>>> Converting to catalog format...");
  const catalogEntries: PuzzleDefinition[] = [];

  for (const difficulty of DIFFICULTIES) {
    const candidates = retainedByTier.get(difficulty) ?? [];
    for (let i = 0; i < candidates.length; i++) {
      const entry = forgeCandidateToCatalogEntry(candidates[i], difficulty, i);
      const validation = validatePuzzle(entry);
      if (!validation.valid) {
        console.error(`    VALIDATION FAILED: ${entry.id} — ${validation.errors.map(e => e.message).join("; ")}`);
        continue;
      }
      catalogEntries.push(entry);
    }
  }

  // Check ID uniqueness
  const ids = new Set<string>();
  for (const entry of catalogEntries) {
    if (ids.has(entry.id)) {
      console.error(`    DUPLICATE ID: ${entry.id}`);
    }
    ids.add(entry.id);
  }

  console.log(`    Total catalog entries: ${catalogEntries.length}`);

  // Phase 4: V1 vs V2 comparison
  console.log("\n>>> Evaluating V1 catalog for comparison...");
  const v1Puzzles: PuzzleDefinition[] = JSON.parse(
    readFileSync(CATALOG_PATH, "utf-8"),
  );
  const v1NonTutorial = v1Puzzles.filter((p) => p.difficulty !== "tutorial");
  const v2NonTutorial = catalogEntries.filter((p) => p.difficulty !== "tutorial");

  let v1CompReport = "(skipped — no V1 non-tutorial puzzles)";
  if (v1NonTutorial.length > 0 && v2NonTutorial.length > 0) {
    const v1Evals = await evaluatePuzzles(v1NonTutorial);
    const v1Summary = summarizePopulation(v1Evals);

    const v2Evals: PuzzleEvaluationVector[] = [];
    for (const difficulty of DIFFICULTIES) {
      if (difficulty === "tutorial") continue;
      const candidates = retainedByTier.get(difficulty) ?? [];
      for (const c of candidates) {
        v2Evals.push(c.evaluation);
      }
    }
    const v2Summary = summarizePopulation(v2Evals);
    v1CompReport = comparisonReport(v1Summary, v2Summary);
  }

  // Phase 5: Distribution table
  const distribution: string[] = [
    "",
    "=".repeat(50),
    "Final Distribution",
    "=".repeat(50),
    "",
    `${"Tier".padEnd(15)} ${"Count".padStart(8)}`,
    "-".repeat(25),
  ];
  for (const difficulty of DIFFICULTIES) {
    const count = catalogEntries.filter((e) => e.difficulty === difficulty).length;
    distribution.push(`${difficulty.padEnd(15)} ${String(count).padStart(8)}`);
  }
  distribution.push("-".repeat(25));
  distribution.push(`${"Total".padEnd(15)} ${String(catalogEntries.length).padStart(8)}`);

  // Phase 6: ASCII samples (up to 2 per tier)
  const samples: string[] = [
    "",
    "=".repeat(50),
    "Sample Puzzles (up to 2 per tier)",
    "=".repeat(50),
  ];
  for (const difficulty of DIFFICULTIES) {
    const candidates = retainedByTier.get(difficulty) ?? [];
    const sampleCount = Math.min(2, candidates.length);
    for (let i = 0; i < sampleCount; i++) {
      samples.push("");
      samples.push(`--- ${difficulty} sample ${i + 1} ---`);
      samples.push(forgeCandidateToAscii(candidates[i]));
    }
  }

  // Print full report
  console.log("\n" + "=".repeat(60));
  console.log("FULL REPORT");
  console.log("=".repeat(60));

  for (const report of tierReports) {
    console.log(report);
  }

  console.log(v1CompReport);
  console.log(distribution.join("\n"));
  console.log(samples.join("\n"));

  // Write output
  if (dryRun) {
    console.log("\n[DRY RUN] Would write generated-puzzles.json with " + catalogEntries.length + " puzzles.");
  } else {
    writeFileSync(
      CATALOG_PATH,
      JSON.stringify(catalogEntries, null, 2) + "\n",
    );
    console.log(`\nWrote ${catalogEntries.length} puzzles to ${CATALOG_PATH}`);
    console.log("Next steps:");
    console.log("  1. npm run prepare:catalog");
    console.log("  2. npm run typecheck");
    console.log("  3. npm run test:unit");
  }

  const totalMs = performance.now() - totalStart;
  console.log(`\nTotal runtime: ${(totalMs / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
