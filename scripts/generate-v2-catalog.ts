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
  createGeneratedPuzzleId,
  boardHash,
  symmetryHash,
  evaluateFinalist,
  computeCurationObjectives,
  nonDominatedSort,
  computeNoveltyScores,
  selectByParetoNovelty,
  diagnosePopulation,
  DEFAULT_FORGE_CONFIG,
  DEFAULT_FORGE_GATES,
  type ForgeConfig,
  type ForgeCandidate,
  type ForgeRejectionReason,
  type PuzzleEvaluationVector,
  type PopulationSummary,
  type TopologyFamily,
  type ForgeGenerationMode,
  type GeneratedPuzzleManifest,
  type GeneratedPuzzleManifestEntry,
  type FinalistEvaluation,
  type CurationObjectives,
} from "../src/features/generator/v2/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dirname, "../src/catalog/generated-puzzles.json");
const MANIFEST_PATH = join(__dirname, "../src/catalog/generated-puzzles.manifest.json");
const HANDCRAFTED_BENCHMARK_PATH = join(__dirname, "../tests/fixtures/generator/handcrafted-benchmark.json");

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const dryRun = process.argv.includes("--dry-run");
const verbose = process.argv.includes("--verbose");

function cliFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length
    ? process.argv[idx + 1]
    : undefined;
}

const tierFilter = cliFlag("--tier") as Difficulty | undefined;
const maxSeedWindows = Number(cliFlag("--max-seed-windows") ?? "3");
const SEED_WINDOW_SIZE = 10000;

// ---------------------------------------------------------------------------
// Per-tier forge configurations
// ---------------------------------------------------------------------------

interface TierConfig {
  readonly difficulty: Difficulty;
  readonly config: ForgeConfig;
}

const TIER_CONFIGS: readonly TierConfig[] = [
  {
    difficulty: "tutorial",
    config: {
      ...DEFAULT_FORGE_CONFIG,
      batchSize: 200,
      retainTarget: 20,
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
      retainTarget: 20,
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
      retainTarget: 20,
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
      retainTarget: 20,
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
      batchSize: 200,
      retainTarget: 20,
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
      batchSize: 200,
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
// Difficulty policy
// ---------------------------------------------------------------------------

const TIER_RANK = new Map<Difficulty, number>(
  DIFFICULTIES.map((d, i) => [d, i]),
);

function classifyCandidate(
  ev: PuzzleEvaluationVector,
): Difficulty {
  return classifyFromMetrics(
    ev.solutionMoves,
    ev.solutionPushes,
    ev.boxCount,
  );
}

function difficultyGap(intended: Difficulty, classified: Difficulty): number {
  return (TIER_RANK.get(intended) ?? 0) - (TIER_RANK.get(classified) ?? 0);
}

interface CatalogCandidate {
  readonly candidate: ForgeCandidate;
  readonly intendedDifficulty: Difficulty;
  readonly classifiedDifficulty: Difficulty;
  readonly gap: number;
  assignedDifficulty: Difficulty;
  rejected: boolean;
  rejectionReason?: ForgeRejectionReason;
  finalistEval?: FinalistEvaluation;
  curationObjectives?: CurationObjectives;
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

function catalogCandidateToEntry(
  cc: CatalogCandidate,
  index: number,
): PuzzleDefinition {
  return {
    id: createGeneratedPuzzleId(cc.candidate.provenance.seed, cc.candidate.puzzle.rows),
    title: `${TITLE_LABELS[cc.assignedDifficulty]} ${index + 1}`,
    difficulty: cc.assignedDifficulty,
    boxes: cc.candidate.puzzle.boxes,
    collection: "Sokomind Generated",
    rows: [...cc.candidate.puzzle.rows],
  };
}

// ---------------------------------------------------------------------------
// Comparison reporting
// ---------------------------------------------------------------------------

function formatMetric(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}

function comparisonReport(
  baselineSummary: PopulationSummary,
  v2Summary: PopulationSummary,
): string {
  const lines: string[] = [
    "",
    "=".repeat(60),
    "Handcrafted Baseline vs V2.1 Generated",
    "=".repeat(60),
    "",
    `${"Metric".padEnd(30)} ${"Baseline".padStart(10)} ${"V2.1".padStart(10)} ${"Δ".padStart(8)}`,
    "-".repeat(60),
  ];

  const m = (s: PopulationSummary, key: string): number => s.avg[key] ?? 0;

  const metrics: { label: string; baseline: number; v2: number; lowerBetter: boolean }[] = [
    { label: "Solution Moves", baseline: m(baselineSummary, "solutionMoves"), v2: m(v2Summary, "solutionMoves"), lowerBetter: false },
    { label: "Solution Pushes", baseline: m(baselineSummary, "solutionPushes"), v2: m(v2Summary, "solutionPushes"), lowerBetter: false },
    { label: "Box Independence", baseline: m(baselineSummary, "boxIndependenceRatio"), v2: m(v2Summary, "boxIndependenceRatio"), lowerBetter: true },
    { label: "Empty Walk Ratio", baseline: m(baselineSummary, "emptyWalkRatio"), v2: m(v2Summary, "emptyWalkRatio"), lowerBetter: true },
    { label: "Unused Floor Ratio", baseline: m(baselineSummary, "unusedFloorRatio"), v2: m(v2Summary, "unusedFloorRatio"), lowerBetter: true },
    { label: "Deadlock Density", baseline: m(baselineSummary, "deadlockDensity"), v2: m(v2Summary, "deadlockDensity"), lowerBetter: false },
    { label: "Solver Expanded States", baseline: m(baselineSummary, "solverExpandedStates"), v2: m(v2Summary, "solverExpandedStates"), lowerBetter: false },
    { label: "Moves Per Push", baseline: m(baselineSummary, "movesPerPush"), v2: m(v2Summary, "movesPerPush"), lowerBetter: true },
    { label: "Repetitive Push Ratio", baseline: m(baselineSummary, "repetitivePushRatio"), v2: m(v2Summary, "repetitivePushRatio"), lowerBetter: true },
    { label: "Total Floor", baseline: m(baselineSummary, "totalFloor"), v2: m(v2Summary, "totalFloor"), lowerBetter: false },
  ];

  for (const mt of metrics) {
    const delta = mt.v2 - mt.baseline;
    const sign = delta >= 0 ? "+" : "";
    const indicator = (delta > 0) === !mt.lowerBetter ? " ✓" : delta === 0 ? "" : " ✗";
    lines.push(
      `${mt.label.padEnd(30)} ${formatMetric(mt.baseline).padStart(10)} ${formatMetric(mt.v2).padStart(10)} ${(sign + formatMetric(delta)).padStart(8)}${indicator}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Global dedup
// ---------------------------------------------------------------------------

function globalDedup(
  pools: Map<Difficulty, CatalogCandidate[]>,
): { exactDupes: number; symmetryDupes: number } {
  let exactDupes = 0;
  let symmetryDupes = 0;

  const exactSeen = new Map<string, { cc: CatalogCandidate; diff: Difficulty }>();
  const symSeen = new Map<string, { cc: CatalogCandidate; diff: Difficulty }>();

  for (const difficulty of DIFFICULTIES) {
    const candidates = pools.get(difficulty) ?? [];
    for (const cc of candidates) {
      if (cc.rejected) continue;

      const hash = boardHash(cc.candidate.puzzle.rows);
      const existing = exactSeen.get(hash);
      if (existing) {
        const existingGap = Math.abs(existing.cc.gap);
        const currentGap = Math.abs(cc.gap);
        if (currentGap < existingGap) {
          existing.cc.rejected = true;
          existing.cc.rejectionReason = "duplicate-cross-tier";
          exactSeen.set(hash, { cc, diff: cc.assignedDifficulty });
        } else {
          cc.rejected = true;
          cc.rejectionReason = "duplicate-cross-tier";
        }
        exactDupes++;
        continue;
      }
      exactSeen.set(hash, { cc, diff: cc.assignedDifficulty });

      const symHash = symmetryHash(cc.candidate.puzzle.rows);
      const symExisting = symSeen.get(symHash);
      if (symExisting) {
        const existingGap = Math.abs(symExisting.cc.gap);
        const currentGap = Math.abs(cc.gap);
        if (currentGap < existingGap) {
          symExisting.cc.rejected = true;
          symExisting.cc.rejectionReason = "duplicate-symmetry";
          symSeen.set(symHash, { cc, diff: cc.assignedDifficulty });
        } else {
          cc.rejected = true;
          cc.rejectionReason = "duplicate-symmetry";
        }
        symmetryDupes++;
        continue;
      }
      symSeen.set(symHash, { cc, diff: cc.assignedDifficulty });
    }
  }

  return { exactDupes, symmetryDupes };
}

// ---------------------------------------------------------------------------
// Difficulty reclassification policy
// ---------------------------------------------------------------------------

function applyDifficultyPolicy(
  pools: Map<Difficulty, CatalogCandidate[]>,
  tierTargets: Map<Difficulty, number>,
): number {
  let rejectedCount = 0;

  for (const difficulty of DIFFICULTIES) {
    const candidates = pools.get(difficulty) ?? [];
    for (const cc of candidates) {
      if (cc.rejected) continue;

      const absGap = Math.abs(cc.gap);
      if (absGap >= 4) {
        cc.rejected = true;
        cc.rejectionReason = "difficulty-mismatch";
        rejectedCount++;
        if (verbose) {
          console.log(
            `    [difficulty] Rejecting seed ${cc.candidate.provenance.seed}: ` +
            `intended=${cc.intendedDifficulty}, classified=${cc.classifiedDifficulty} (gap=${cc.gap})`,
          );
        }
        continue;
      }

      if (absGap === 1 && cc.classifiedDifficulty !== cc.intendedDifficulty) {
        const classifiedPool = pools.get(cc.classifiedDifficulty) ?? [];
        const classifiedActive = classifiedPool.filter((c) => !c.rejected).length;
        const classifiedTarget = tierTargets.get(cc.classifiedDifficulty) ?? 0;

        if (classifiedActive < classifiedTarget) {
          const oldPool = pools.get(cc.intendedDifficulty);
          if (oldPool) {
            const idx = oldPool.indexOf(cc);
            if (idx >= 0) oldPool.splice(idx, 1);
          }
          cc.assignedDifficulty = cc.classifiedDifficulty;
          classifiedPool.push(cc);
          if (verbose) {
            console.log(
              `    [difficulty] Reclassifying seed ${cc.candidate.provenance.seed}: ` +
              `${cc.intendedDifficulty} → ${cc.classifiedDifficulty}`,
            );
          }
        }
      }
    }
  }

  return rejectedCount;
}

// ---------------------------------------------------------------------------
// Build manifest
// ---------------------------------------------------------------------------

function buildManifest(
  entries: readonly PuzzleDefinition[],
  ccMap: Map<string, CatalogCandidate>,
  tierTargets: Map<Difficulty, number>,
): GeneratedPuzzleManifest {
  const allRows = entries.map((e) => e.rows.join("\n")).join("\n\n");
  const catalogHashValue = boardHash(allRows.split("\n"));

  const tierQuotas = {} as Record<Difficulty, { target: number; actual: number }>;
  for (const d of DIFFICULTIES) {
    tierQuotas[d] = {
      target: tierTargets.get(d) ?? 0,
      actual: entries.filter((e) => e.difficulty === d).length,
    };
  }

  const puzzles: GeneratedPuzzleManifestEntry[] = entries.map((entry) => {
    const cc = ccMap.get(entry.id);
    const p = cc?.candidate.provenance;
    const ev = cc?.candidate.evaluation;
    return {
      id: entry.id,
      title: entry.title,
      difficulty: entry.difficulty,
      seed: p?.seed ?? 0,
      family: p?.family ?? ("linear" as const),
      boxCount: p?.boxCount ?? entry.boxes,
      mode: p?.mode ?? ("plain" as const),
      motifType: p?.motifType,
      compositionType: p?.compositionType,
      boardHash: boardHash(entry.rows),
      symmetryHash: symmetryHash(entry.rows),
      tightened: p?.tightened ?? false,
      cellsRemoved: p?.cellsRemoved ?? 0,
      dependencyEdges: p?.dependencyEdges,
      dependencyRealized: p?.dependencyRealized,
      dependencyRealizationRate: p?.dependencyRealizationRate,
      intendedDifficulty: cc?.intendedDifficulty ?? entry.difficulty,
      classifiedDifficulty: cc?.classifiedDifficulty ?? entry.difficulty,
      difficultyGap: cc?.gap ?? 0,
      solutionMoves: ev?.solutionMoves ?? 0,
      solutionPushes: ev?.solutionPushes ?? 0,
      totalFloor: ev?.totalFloor ?? 0,
      solversAttempted: cc?.finalistEval?.solversAttempted,
      solversSucceeded: cc?.finalistEval?.solversSucceeded,
      solverAgreement: cc?.finalistEval?.solverAgreement,
      avgExpandedStates: cc?.finalistEval?.avgExpandedStates,
    };
  });

  return {
    schemaVersion: 1,
    generatorVersion: "2.2.0",
    catalogHash: catalogHashValue,
    tierQuotas,
    puzzles,
  };
}

// ---------------------------------------------------------------------------
// Invariant checks
// ---------------------------------------------------------------------------

interface InvariantResult {
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

function checkInvariants(
  entries: readonly PuzzleDefinition[],
  tierTargets: Map<Difficulty, number>,
): InvariantResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      errors.push(`DUPLICATE ID: ${entry.id}`);
    }
    ids.add(entry.id);

    if (!entry.id.startsWith("gen-v2-")) {
      errors.push(`ID does not use gen-v2- prefix: ${entry.id}`);
    }

    const validation = validatePuzzle(entry);
    if (!validation.valid) {
      errors.push(
        `VALIDATION FAILED: ${entry.id} — ${validation.errors.map((e) => e.message).join("; ")}`,
      );
    }
  }

  const boardHashes = new Map<string, string>();
  for (const entry of entries) {
    const hash = boardHash(entry.rows);
    const existing = boardHashes.get(hash);
    if (existing) {
      errors.push(`DUPLICATE CANONICAL BOARD: ${entry.id} and ${existing} (hash=${hash})`);
    }
    boardHashes.set(hash, entry.id);
  }

  const symHashes = new Map<string, string>();
  for (const entry of entries) {
    const hash = symmetryHash(entry.rows);
    const existing = symHashes.get(hash);
    if (existing) {
      errors.push(`DUPLICATE SYMMETRY BOARD: ${entry.id} and ${existing} (hash=${hash})`);
    }
    symHashes.set(hash, entry.id);
  }

  for (const difficulty of DIFFICULTIES) {
    const count = entries.filter((e) => e.difficulty === difficulty).length;
    const target = tierTargets.get(difficulty) ?? 0;
    if (count < target) {
      warnings.push(
        `QUOTA SHORTFALL: tier=${difficulty} expected=${target} actual=${count}`,
      );
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const totalStart = performance.now();
  console.log(`\nSokomind V2.1 Atomic Catalog Generator${dryRun ? " (DRY RUN)" : ""}`);
  console.log("=".repeat(60));

  const activeTierConfigs = tierFilter
    ? TIER_CONFIGS.filter((tc) => tc.difficulty === tierFilter)
    : TIER_CONFIGS;

  if (tierFilter && activeTierConfigs.length === 0) {
    console.error(`Unknown tier: ${tierFilter}`);
    process.exit(1);
  }

  const tierTargets = new Map<Difficulty, number>(
    activeTierConfigs.map((tc) => [tc.difficulty, tc.config.retainTarget]),
  );

  // -----------------------------------------------------------------------
  // Phase 1: Per-tier forge generation
  // -----------------------------------------------------------------------

  console.log("\n>>> Phase 1: Per-tier forge generation...");
  const pools = new Map<Difficulty, CatalogCandidate[]>();
  const tierReports: string[] = [];

  for (const { difficulty, config } of activeTierConfigs) {
    console.log(`\n    [forge] ${difficulty} tier (batch=${config.batchSize}, target=${config.retainTarget})...`);
    const result = await runForge(config);
    const report = forgeRunReport(result);
    tierReports.push(report);

    const summary = summarizeForgeRun(result);
    console.log(
      `    Attempted: ${result.totalAttempted} | Valid: ${result.totalValid} | ` +
      `Retained: ${result.totalRetained} (${summary.elapsedMs.toFixed(0)}ms)`,
    );

    const candidates: CatalogCandidate[] = result.candidates.map((c) => {
      const classified = classifyCandidate(c.evaluation);
      const gap = difficultyGap(difficulty, classified);
      return {
        candidate: c,
        intendedDifficulty: difficulty,
        classifiedDifficulty: classified,
        gap,
        assignedDifficulty: difficulty,
        rejected: false,
      };
    });

    pools.set(difficulty, candidates);
  }

  // -----------------------------------------------------------------------
  // Phase 2: Difficulty policy
  // -----------------------------------------------------------------------

  console.log("\n>>> Phase 2: Difficulty policy...");
  const diffRejects = applyDifficultyPolicy(pools, tierTargets);
  console.log(`    Difficulty mismatches rejected: ${diffRejects}`);

  // -----------------------------------------------------------------------
  // Phase 3: Global cross-tier dedup
  // -----------------------------------------------------------------------

  console.log("\n>>> Phase 3: Global cross-tier dedup...");
  const { exactDupes, symmetryDupes } = globalDedup(pools);
  console.log(`    Exact cross-tier duplicates removed: ${exactDupes}`);
  console.log(`    Symmetry duplicates removed: ${symmetryDupes}`);

  // -----------------------------------------------------------------------
  // Phase 4: Quota reconciliation with retry seed windows
  // -----------------------------------------------------------------------

  console.log("\n>>> Phase 4: Quota reconciliation...");
  for (const { difficulty, config } of activeTierConfigs) {
    for (let window = 1; window <= maxSeedWindows; window++) {
      const active = (pools.get(difficulty) ?? []).filter((c) => !c.rejected);
      const target = tierTargets.get(difficulty) ?? 0;
      if (active.length >= target) break;

      const shortfall = target - active.length;
      const retrySeed = config.baseSeed + SEED_WINDOW_SIZE * window;
      console.log(
        `    [quota] ${difficulty}: ${active.length}/${target} — ` +
        `retrying with seed window ${window} (baseSeed=${retrySeed}, need ${shortfall} more)`,
      );

      const retryConfig: ForgeConfig = {
        ...config,
        baseSeed: retrySeed,
        retainTarget: shortfall + 5,
      };
      const retryResult = await runForge(retryConfig);

      const retryCandidates: CatalogCandidate[] = retryResult.candidates.map((c) => {
        const classified = classifyCandidate(c.evaluation);
        const gap = difficultyGap(difficulty, classified);
        return {
          candidate: c,
          intendedDifficulty: difficulty,
          classifiedDifficulty: classified,
          gap,
          assignedDifficulty: difficulty,
          rejected: false,
        };
      });

      const pool = pools.get(difficulty) ?? [];
      pool.push(...retryCandidates);
      pools.set(difficulty, pool);

      applyDifficultyPolicy(pools, tierTargets);
      globalDedup(pools);

      console.log(
        `    [quota] ${difficulty}: now ${pool.filter((c) => !c.rejected).length}/${target}`,
      );
    }
  }

  for (const difficulty of DIFFICULTIES) {
    if (!tierTargets.has(difficulty)) continue;
    const active = (pools.get(difficulty) ?? []).filter((c) => !c.rejected);
    const target = tierTargets.get(difficulty) ?? 0;
    if (active.length < target) {
      console.warn(
        `    WARNING: ${difficulty} tier has ${active.length}/${target} candidates after ${maxSeedWindows} retry windows`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Phase 4b: Finalist multi-solver evaluation + Pareto curation
  // -----------------------------------------------------------------------

  console.log("\n>>> Phase 4b: Finalist evaluation + Pareto curation...");

  for (const difficulty of DIFFICULTIES) {
    if (!tierTargets.has(difficulty)) continue;
    const candidates = (pools.get(difficulty) ?? []).filter((c) => !c.rejected);
    if (candidates.length === 0) continue;

    console.log(`    [finalist] ${difficulty}: evaluating ${candidates.length} candidates...`);
    for (const cc of candidates) {
      cc.finalistEval = await evaluateFinalist(cc.candidate.puzzle);
      cc.curationObjectives = computeCurationObjectives(
        cc.candidate.evaluation,
        cc.finalistEval,
        cc.candidate.provenance.dependencyRealizationRate,
      );
    }

    const target = tierTargets.get(difficulty) ?? 0;
    if (candidates.length > target) {
      const sorted = nonDominatedSort(
        candidates.map((cc) => ({
          item: cc,
          objectives: cc.curationObjectives!,
        })),
      );
      const scored = computeNoveltyScores(sorted);
      const selected = selectByParetoNovelty(scored, target);
      const selectedSet = new Set(selected.map((s) => s.item));

      let culled = 0;
      for (const cc of candidates) {
        if (!selectedSet.has(cc)) {
          cc.rejected = true;
          culled++;
        }
      }

      const diag = diagnosePopulation(scored);
      console.log(
        `    [curation] ${difficulty}: ${diag.totalCandidates} → ${selected.length} ` +
        `(${diag.frontCount} Pareto fronts, culled ${culled})`,
      );
      if (verbose) {
        console.log(`      Front sizes: [${diag.frontSizes.join(", ")}]`);
        console.log(
          `      Novelty range: ${diag.noveltyRange.min.toFixed(3)}–${diag.noveltyRange.max.toFixed(3)} ` +
          `(avg ${diag.noveltyRange.avg.toFixed(3)})`,
        );
      }
    } else {
      console.log(`    [curation] ${difficulty}: ${candidates.length} ≤ target ${target}, keeping all`);
    }
  }

  // Within-tier ordering: sort by solution pushes ascending (progressive difficulty)
  for (const difficulty of DIFFICULTIES) {
    if (!tierTargets.has(difficulty)) continue;
    const pool = pools.get(difficulty);
    if (!pool) continue;
    pool.sort((a, b) => {
      if (a.rejected !== b.rejected) return a.rejected ? 1 : -1;
      const pa = a.candidate.evaluation.solutionPushes;
      const pb = b.candidate.evaluation.solutionPushes;
      if (pa !== pb) return pa - pb;
      return boardHash(a.candidate.puzzle.rows).localeCompare(
        boardHash(b.candidate.puzzle.rows),
      );
    });
  }

  // -----------------------------------------------------------------------
  // Phase 5: Catalog conversion + manifest
  // -----------------------------------------------------------------------

  console.log("\n>>> Phase 5: Catalog conversion + manifest...");
  const catalogEntries: PuzzleDefinition[] = [];
  const ccMap = new Map<string, CatalogCandidate>();

  for (const difficulty of DIFFICULTIES) {
    if (!tierTargets.has(difficulty)) continue;
    const candidates = (pools.get(difficulty) ?? []).filter((c) => !c.rejected);
    for (let i = 0; i < candidates.length; i++) {
      const entry = catalogCandidateToEntry(candidates[i], i);
      catalogEntries.push(entry);
      ccMap.set(entry.id, candidates[i]);
    }
  }

  console.log(`    Total catalog entries: ${catalogEntries.length}`);

  const manifest = buildManifest(catalogEntries, ccMap, tierTargets);

  // -----------------------------------------------------------------------
  // Phase 6: Benchmark comparison against handcrafted puzzles
  // -----------------------------------------------------------------------
  // Compare V2.1 generated candidates against the stable handcrafted
  // (canonical) puzzles, NOT against the mutable generated-puzzles.json.
  // This prevents circular self-comparison where the baseline is the
  // very file being overwritten.

  console.log("\n>>> Phase 6: Benchmark comparison (vs handcrafted baseline)...");
  let benchmarkReport = "(skipped — no handcrafted baseline or no V2 non-tutorial puzzles)";

  try {
    const handcraftedMeta: readonly { id: string; difficulty: Difficulty }[] =
      JSON.parse(readFileSync(HANDCRAFTED_BENCHMARK_PATH, "utf-8"));
    const handcraftedIds = new Set(
      handcraftedMeta.filter((p) => p.difficulty !== "tutorial").map((p) => p.id),
    );

    const { PUZZLES: allPuzzles } = await import("../src/catalog/puzzles.ts");
    const handcraftedPuzzles = (allPuzzles as readonly PuzzleDefinition[]).filter(
      (p) => handcraftedIds.has(p.id),
    );

    const v2Evals: PuzzleEvaluationVector[] = [];
    for (const difficulty of DIFFICULTIES) {
      if (difficulty === "tutorial") continue;
      const candidates = (pools.get(difficulty) ?? []).filter((c) => !c.rejected);
      for (const c of candidates) v2Evals.push(c.candidate.evaluation);
    }

    if (handcraftedPuzzles.length > 0 && v2Evals.length > 0) {
      const handcraftedEvals = await evaluatePuzzles(handcraftedPuzzles);
      const handcraftedSummary = summarizePopulation(handcraftedEvals);
      const v2Summary = summarizePopulation(v2Evals);
      benchmarkReport = comparisonReport(handcraftedSummary, v2Summary);
    }
  } catch {
    benchmarkReport = "(skipped — handcrafted benchmark fixture not available)";
  }

  // -----------------------------------------------------------------------
  // Invariant checks
  // -----------------------------------------------------------------------

  console.log("\n>>> Invariant checks...");
  const invariants = checkInvariants(catalogEntries, tierTargets);

  for (const error of invariants.errors) {
    console.error(`    ERROR: ${error}`);
  }
  for (const warning of invariants.warnings) {
    console.warn(`    WARNING: ${warning}`);
  }

  if (invariants.passed) {
    console.log("    All invariants passed.");
  } else {
    console.error(`    ${invariants.errors.length} invariant(s) failed.`);
  }

  // -----------------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------------

  const distribution: string[] = [
    "",
    "=".repeat(60),
    "Final Distribution",
    "=".repeat(60),
    "",
    `${"Tier".padEnd(15)} ${"Target".padStart(8)} ${"Actual".padStart(8)} ${"Status".padStart(10)}`,
    "-".repeat(45),
  ];
  for (const difficulty of DIFFICULTIES) {
    if (!tierTargets.has(difficulty)) continue;
    const count = catalogEntries.filter((e) => e.difficulty === difficulty).length;
    const target = tierTargets.get(difficulty) ?? 0;
    const status = count >= target ? "OK" : `SHORT -${target - count}`;
    distribution.push(
      `${difficulty.padEnd(15)} ${String(target).padStart(8)} ${String(count).padStart(8)} ${status.padStart(10)}`,
    );
  }
  distribution.push("-".repeat(45));
  distribution.push(
    `${"Total".padEnd(15)} ${" ".repeat(8)} ${String(catalogEntries.length).padStart(8)}`,
  );

  const samples: string[] = [
    "",
    "=".repeat(60),
    "Sample Puzzles (up to 2 per tier)",
    "=".repeat(60),
  ];
  for (const difficulty of DIFFICULTIES) {
    if (!tierTargets.has(difficulty)) continue;
    const candidates = (pools.get(difficulty) ?? []).filter((c) => !c.rejected);
    const sampleCount = Math.min(2, candidates.length);
    for (let i = 0; i < sampleCount; i++) {
      samples.push("");
      samples.push(`--- ${difficulty} sample ${i + 1} ---`);
      samples.push(forgeCandidateToAscii(candidates[i].candidate));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("FULL REPORT");
  console.log("=".repeat(60));

  for (const report of tierReports) {
    console.log(report);
  }

  console.log(benchmarkReport);
  console.log(distribution.join("\n"));
  console.log(samples.join("\n"));

  // -----------------------------------------------------------------------
  // Phase 7: Atomic write
  // -----------------------------------------------------------------------

  if (!invariants.passed) {
    console.error("\nCATALOG INVARIANT FAILED — aborting write.");
    process.exit(1);
  }

  const catalogJson = JSON.stringify(catalogEntries, null, 2) + "\n";
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";

  if (dryRun) {
    console.log(`\n[DRY RUN] Would write ${catalogEntries.length} puzzles to generated-puzzles.json`);
    console.log(`[DRY RUN] Would write manifest with ${manifest.puzzles.length} entries`);
    for (const w of invariants.warnings) {
      console.warn(`[DRY RUN] ${w}`);
    }
  } else {
    writeFileSync(CATALOG_PATH, catalogJson);
    writeFileSync(MANIFEST_PATH, manifestJson);
    console.log(`\nWrote ${catalogEntries.length} puzzles to ${CATALOG_PATH}`);
    console.log(`Wrote manifest to ${MANIFEST_PATH}`);
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
