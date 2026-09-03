import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { TIER_CONFIGS } from "./lib/generator-tier-config.ts";
import { curateForgeCandidates, type ForgeCandidate } from "../src/features/generator/v2/puzzle-forge.ts";
import { buildCanonicalSolutionTrace } from "../src/features/generator/v2/solution-trace.ts";
import { analyzePassiveSolutionStory } from "../src/features/generator/v2/passive-story-analysis.ts";
import { assessCandidateQuality } from "../src/features/generator/v2/story-quality-policy.ts";
import { buildFinalReviewCatalog, formatReviewSummary } from "../src/features/generator/v2/review-catalog.ts";
import { checkReleaseGate } from "../src/features/generator/v2/release-gate.ts";
import { ForgeWorkerPool } from "../src/features/generator/v2/forge-pool.ts";
import { DEFAULT_V4_POLICY } from "../src/features/generator/v2/solver-bottleneck.ts";
import type { FinalistEvaluationV4 } from "../src/features/generator/v2/finalist-evaluator.ts";
import type { Difficulty } from "../src/core/model.ts";
import { STRICT_STORY_DIVERSITY_POLICY } from "../src/features/generator/v2/story-diversity.ts";
import { emptyHumanReview, renderGeneratorPlaytest } from "./lib/generator-playtest.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} requires a value`);
  return v;
}
const inputs = flag("--runs")?.split(",").map(p => resolve(p));
if (!inputs?.length) throw new Error("--runs requires comma-separated run directories or result files");
const target = Number(flag("--target") ?? 5);
const workers = Number(flag("--workers") ?? 8);
if (!Number.isSafeInteger(target) || target < 1 || target > 1000 || !Number.isSafeInteger(workers) || workers < 1 || workers > 64) throw new Error("Invalid target or workers");
const output = resolve(flag("--output") ?? `review-catalog/review-${Date.now()}`);
mkdirSync(resolve(output, ".."), { recursive: true }); mkdirSync(output);
const save = (name: string, data: unknown) => writeFileSync(join(output, name), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
const abort = new AbortController(); process.once("SIGINT", () => abort.abort());

async function main(): Promise<void> {
  const unique = new Map<string, ForgeCandidate>();
  const recoveredFrom: string[] = [];
  for (const input of inputs!) {
    const files = statSync(input).isDirectory() ? readdirSync(input).filter(n => n.endsWith("-result.json") ||
      (process.argv.includes("--recover-checkpoints") && n.endsWith("-events.jsonl"))).sort().map(n => join(input, n)) : [input];
    for (const file of files) {
      const candidates: ForgeCandidate[] = file.endsWith(".jsonl")
        ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).flatMap(line => {
          const event = JSON.parse(line); return event.candidate ? [event.candidate] : [];
        }) : (JSON.parse(readFileSync(file, "utf8")).candidates ?? []);
      if (file.endsWith(".jsonl")) recoveredFrom.push(file);
      for (const c of candidates) {
        abort.signal.throwIfAborted();
        const grid = c.puzzle.rows.map(row => [...row]);
        const replay = buildCanonicalSolutionTrace(grid, c.solutionSteps ?? [], { requireSolved: true });
        if (!replay.ok) throw new Error(`Invalid replay in ${file}: ${c.puzzle.id}`);
        const story = analyzePassiveSolutionStory(grid, replay.trace);
        const quality = assessCandidateQuality({ puzzle: c.puzzle, evaluation: c.evaluation, trace: replay.trace,
          passiveStory: story, typing: c.storyAwareTyping, construction: c.mechanismConstruction,
          constructionRequired: c.provenance.mode === "mechanism" });
        if (!quality.passed) throw new Error(`Current quality policy rejected ${c.puzzle.id}: ${quality.reasons.join("; ")}`);
        const key = JSON.stringify(c.puzzle.rows);
        const prior = unique.get(key);
        // Prefer a completed finalist over the same candidate's earlier checkpoint.
        if (!prior?.finalistEvaluation) unique.set(key, { ...c, passiveStory: story, qualityProfile: quality });
      }
    }
  }
  const selected = new Map<Difficulty, readonly ForgeCandidate[]>();
  const selections = [];
  for (const {difficulty} of TIER_CONFIGS) {
    const pool = [...unique.values()].filter(c => c.puzzle.difficulty === difficulty).sort((a, b) => a.puzzle.id.localeCompare(b.puzzle.id));
    const result = curateForgeCandidates(pool, target, undefined, STRICT_STORY_DIVERSITY_POLICY);
    selected.set(difficulty, result.candidates);
    selections.push({ tier: difficulty, available: pool.length, seeds: new Set(pool.map(c => c.provenance.seed)).size, ...result.report });
    console.log(`${difficulty}: ${result.candidates.length}/${target} selected from ${pool.length}`);
  }
  save("selection.json", selections);
  const pool = new ForgeWorkerPool(undefined, undefined, workers, abort.signal);
  try {
    for (const [tier, candidates] of selected) {
      selected.set(tier, await pool.map(candidates, async c => {
        if (c.finalistEvaluation && "witnessValid" in c.finalistEvaluation && c.finalistEvaluation.witnessValid) return c;
        const result = await pool.submit<{ finalist: FinalistEvaluationV4 }>({ kind: "finalist",
          policy: { ...DEFAULT_V4_POLICY, proofMaxBoxes: 0 }, payload: { puzzle: c.puzzle,
            witnessSteps: c.solutionSteps, evaluation: c.evaluation, dependencyRealizationRate: c.provenance.dependencyRealizationRate } });
        if (!result.finalist.witnessValid) throw new Error(`Finalist replay rejected ${c.puzzle.id}`);
        return { ...c, finalistEvaluation: result.finalist };
      }));
      console.log(`${tier}: finalist verification complete`);
      save(`${tier}-candidates.json`, selected.get(tier));
    }
  } finally { await pool.close(); }
  const catalog = buildFinalReviewCatalog(TIER_CONFIGS.map(t => ({ difficulty: t.difficulty, target })), selected,
    { curationReports: Object.fromEntries(selections.map(s => [s.tier, s])) });
  save("review-catalog.json", catalog);
  const human = emptyHumanReview(catalog, readFileSync(join(output, "review-catalog.json"), "utf8"));
  save("human-review.json", human);
  writeFileSync(join(output, "playtest.html"), renderGeneratorPlaytest(catalog, human, flag("--app-url") ?? "http://localhost:5173/"), { flag: "wx" });
  const verdict = checkReleaseGate(catalog); save("release-verdict.json", verdict);
  save("review-status.json", { humanApproval: "pending", productionPromoted: false, inputs, recoveredFrom,
    note: "Recovered candidates were independently rechecked and finalized. Unfinished tasks are not treated as successes or failures." });
  writeFileSync(join(output, "review-summary.txt"), formatReviewSummary(catalog), { flag: "wx" });
  console.log(`Review: ${output}; automated release gate: ${verdict.passed ? "passed" : "failed"}; human approval: pending`);
}
main().catch(error => { console.error(error); process.exitCode = abort.signal.aborted ? 130 : 1; });
