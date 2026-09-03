import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, totalmem } from "node:os";
import { runForge, type ForgeConfig, type ForgeRunResult } from "../src/features/generator/v2/puzzle-forge.ts";
import { DEFAULT_V4_POLICY } from "../src/features/generator/v2/solver-bottleneck.ts";
import { replayWitness } from "../src/features/generator/v2/generation-evidence.ts";
import { TIER_CONFIGS, CATALOG_FINALIST_POLICIES } from "./lib/generator-tier-config.ts";
import { createHash } from "node:crypto";
import { STRICT_STORY_DIVERSITY_POLICY } from "../src/features/generator/v2/story-diversity.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function integer(name: string, fallback: number, max: number): number {
  const value = Number(flag(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be in [1, ${max}]`);
  return value;
}
const attempts = integer("--attempts", 64, 10000);
const repeats = integer("--repeats", 3, 20);
const workers = (flag("--workers")?.split(",").map(Number) ??
  [...new Set([1, 4, 8, 12, Math.max(1, availableParallelism() - 1)].filter((n) => n <= availableParallelism()))]);
if (workers.length === 0 || workers.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 64)) throw new Error("--workers requires a comma-separated list in [1, 64]");
const fixture = JSON.parse(readFileSync(new URL("../tests/fixtures/generator/generated-quality-samples.json", import.meta.url), "utf8"));
const tier = flag("--tier");
const preset = TIER_CONFIGS.find(t => t.difficulty === tier);
if (tier && !preset) throw new Error("Unknown catalog tier");
const evaluation = flag("--evaluation") ?? "balanced";
if (evaluation !== "balanced" && evaluation !== "deep") throw new Error("--evaluation must be balanced or deep");
const seedOffset = Number(flag("--seed-offset") ?? 0);
if (!Number.isSafeInteger(seedOffset) || seedOffset < 0 || seedOffset > 1000000000) throw new Error("Invalid seed offset");
const base = preset?.config ?? { ...fixture.config, baseSeed: 310000, boxCounts: [3] };
const config: ForgeConfig = { ...base, batchSize: attempts, retainTarget: attempts,
  baseSeed: base.baseSeed + seedOffset, reverseCandidatesPerBlueprint: integer("--reverse-candidates", 4, 32),
  reuseEvidence: !process.argv.includes("--no-evidence-cache"), goalPlacementAttempts: 3,
  ...(preset ? { witnessFirst: true, participationSearch: true, scalableRecipes: true,
    storyDiversityPolicy: STRICT_STORY_DIVERSITY_POLICY,
    funnelBudgets: base.funnelBudgets ? { ...base.funnelBudgets, rawAttemptBudget: attempts,
      finalistRetain: attempts, deepRetain: attempts, catalogQuota: attempts } : undefined } : {}),
  v4EvaluatorPolicy: preset ? CATALOG_FINALIST_POLICIES[evaluation] : { ...DEFAULT_V4_POLICY, proofMaxBoxes: 0 } };
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());

function signature(result: ForgeRunResult): string {
  return JSON.stringify({ retained: result.candidates.map((c) => ({ id: c.puzzle.id, rows: c.puzzle.rows, steps: c.solutionSteps,
    quality: c.qualityProfile, classification: c.puzzle.difficulty })), rejections: result.rejections });
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};

async function main(): Promise<void> {
  console.log(`CPU: ${cpus()[0]?.model.trim()} | ${availableParallelism()} available threads | ${(totalmem() / 2 ** 30).toFixed(1)} GiB`);
  console.log(`Fixed ${tier ?? "Beginner calibration"} workload: ${attempts} seeds, ${config.reverseCandidatesPerBlueprint} reverse candidates, ${repeats} repeats. Includes quality and finalist gates.`);
  // Warm the host and validate the frozen positive sample before comparing speeds.
  const warm = await runForge({ ...fixture.config, baseSeed: 310049, boxCounts: [3] }, { workers: 1, signal: abort.signal });
  if (warm.candidates.length !== 1) throw new Error("Positive calibration sample failed");
  let baseline: string | undefined;
  const measurements = [];
  for (const count of workers) {
    const runs = [];
    for (let repeat = 0; repeat < repeats; repeat++) {
      let last = 0;
      const result = await runForge(config, { workers: count, signal: abort.signal, onProgress: (p) => {
        if (p.elapsedMs - last < 5000) return;
        last = p.elapsedMs;
        console.log(`  ${count} workers, run ${repeat + 1}: ${p.phase}, ${p.pool.active} active, ${p.qualified} qualified`);
      } });
      for (const c of result.candidates) if (!c.solutionSteps || !replayWitness(c.puzzle, c.solutionSteps)) throw new Error(`Invalid witness: ${c.puzzle.id}`);
      const current = signature(result);
      baseline ??= current;
      const reference = JSON.parse(baseline), actual = JSON.parse(current);
      const canonical = (entries: { id: string }[]) => JSON.stringify([...entries].sort((a, b) => a.id.localeCompare(b.id)));
      const comparison = { sameCandidateContent: canonical(reference.retained) === canonical(actual.retained),
        sameOrder: JSON.stringify(reference.retained.map((c: { id: string }) => c.id)) === JSON.stringify(actual.retained.map((c: { id: string }) => c.id)),
        sameRejections: JSON.stringify(reference.rejections) === JSON.stringify(actual.rejections) };
      runs.push({ elapsedMs: result.elapsedMs, qualified: result.totalValid, retained: result.totalRetained,
        identicalResults: current === baseline, comparison, signatureSha256: createHash("sha256").update(current).digest("hex"),
        evidence: actual, performance: result.performance!, rejections: result.rejectionCounts });
      console.log(`  ${count} workers, run ${repeat + 1}: ${(result.elapsedMs / 1000).toFixed(2)}s, ${result.totalValid} qualified, ${result.totalRetained} retained, matching=${current === baseline}`);
      if (current !== baseline) console.log(`    Equivalence diagnostics: ${JSON.stringify(comparison)}`);
    }
    measurements.push({ workers: count, medianMs: median(runs.map((r) => r.elapsedMs)),
      qualifiedPerMinute: median(runs.map((r) => r.qualified * 60000 / r.elapsedMs)),
      averageBusyCores: median(runs.map((r) => r.performance.averageBusyCores)),
      peakRssMb: Math.max(...runs.map((r) => r.performance.pool.peakRssMb)),
      identicalResults: runs.every((r) => r.identicalResults), runs });
  }
  const eligible = measurements.filter((m) => m.identicalResults && m.qualifiedPerMinute > 0);
  eligible.sort((a, b) => b.qualifiedPerMinute - a.qualifiedPerMinute);
  const recommendedWorkers = measurements.every(m => m.identicalResults) ? eligible[0]?.workers : undefined;
  console.table(measurements.map((m) => ({ workers: m.workers, medianMs: m.medianMs,
    qualifiedPerMinute: m.qualifiedPerMinute, averageBusyCores: m.averageBusyCores,
    peakRssMb: m.peakRssMb, identicalResults: m.identicalResults })));
  console.log(recommendedWorkers ? `Recommended for this workload: --workers ${recommendedWorkers}` : "No positive, equivalent results: no concurrency recommendation.");
  const output = flag("--output");
  if (output) writeFileSync(output, JSON.stringify({ cpu: cpus()[0]?.model.trim(), config, repeats, measurements,
    recommendedWorkers, limitation: `Only this ${tier ?? "Beginner calibration"} workload was tested; other tiers, seeds, and budgets can scale differently.` }, null, 2) + "\n", { flag: "wx" });
  if (measurements.some((m) => !m.identicalResults)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = abort.signal.aborted ? 130 : 1; });
