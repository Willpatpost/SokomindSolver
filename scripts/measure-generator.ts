import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { cpus, availableParallelism } from "node:os";
import { execFileSync } from "node:child_process";
import { TIER_CONFIGS, CATALOG_FINALIST_POLICIES } from "./lib/generator-tier-config.ts";
import { runForge, type ForgeCheckpoint, type ForgeProgress } from "../src/features/generator/v2/puzzle-forge.ts";
import { replayWitness } from "../src/features/generator/v2/generation-evidence.ts";
import { STRICT_STORY_DIVERSITY_POLICY } from "../src/features/generator/v2/story-diversity.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function integer(name: string, fallback: number, min = 1, max = 10000): number {
  const value = Number(flag(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const attempts = integer("--attempts", 32);
const workers = integer("--workers", 8, 1, 64);
const seconds = integer("--seconds", 60, 1, 86400);
const repeats = integer("--repeats", 1, 1, 20);
const seedOffset = integer("--seed-offset", 0, 0, 1000000000);
const variants = integer("--reverse-candidates", 4, 1, 32);
const evaluation = flag("--evaluation") ?? "balanced";
if (evaluation !== "balanced" && evaluation !== "deep") throw new Error("--evaluation must be balanced or deep");
const finalistPolicy = CATALOG_FINALIST_POLICIES[evaluation];
const selected = flag("--tier")?.split(",") ?? TIER_CONFIGS.map(t => t.difficulty);
if (selected.some(t => !TIER_CONFIGS.some(c => c.difficulty === t))) throw new Error("Unknown tier; generated tiers are Beginner through Master");
const output = resolve(flag("--output") ?? `review-catalog/measure-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
// Atomic exclusive directory creation: never append to somebody else's run.
mkdirSync(resolve(output, ".."), { recursive: true });
mkdirSync(output);
const save = (name: string, value: unknown) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const interruption = new AbortController();
process.once("SIGINT", () => interruption.abort());

async function main(): Promise<void> {
  save("environment.json", { schemaVersion: 1, cpu: cpus()[0]?.model, threads: availableParallelism(), node: process.version,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    worktree: execFileSync("git", ["status", "--short"], { encoding: "utf8" }),
    attempts, workers, seconds, repeats, seedOffset, variants, selected });
  const summaries = [];
  for (const { difficulty, config: base } of TIER_CONFIGS.filter(t => selected.includes(t.difficulty))) {
    for (let repeat = 0; repeat < repeats && !interruption.signal.aborted; repeat++) {
      const config = { ...base, batchSize: attempts, retainTarget: attempts, baseSeed: base.baseSeed + seedOffset,
        reverseCandidatesPerBlueprint: variants, reuseEvidence: true, goalPlacementAttempts: 3,
        witnessFirst: !process.argv.includes("--legacy-evaluation"),
        participationSearch: !process.argv.includes("--legacy-search"),
        scalableRecipes: !process.argv.includes("--legacy-recipes"),
        storyDiversityPolicy: STRICT_STORY_DIVERSITY_POLICY,
        v4EvaluatorPolicy: finalistPolicy,
        funnelBudgets: base.funnelBudgets ? { ...base.funnelBudgets, rawAttemptBudget: attempts, catalogQuota: attempts,
          deepRetain: attempts, finalistRetain: attempts } : undefined };
      const id = `${difficulty}-${repeat}`;
      save(`${id}-config.json`, config);
      const eventsFile = join(output, `${id}-events.jsonl`);
      writeFileSync(eventsFile, "", { flag: "wx" });
      const controller = new AbortController();
      const stop = () => controller.abort();
      interruption.signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, seconds * 1000);
      const start = performance.now();
      const cpu = process.cpuUsage();
      let progress: ForgeProgress | undefined;
      let firstQualifiedMs: number | undefined;
      let lastPrint = 0;
      const counts: Record<string, number> = {};
      const checkpoints: ForgeCheckpoint[] = [];
      let status = "complete", error: string | undefined, retained: number | undefined;
      try {
        const result = await runForge(config, { workers, signal: controller.signal,
          onProgress: p => {
            progress = p;
            if (p.elapsedMs - lastPrint >= 10000) {
              lastPrint = p.elapsedMs;
              console.log(`${id}: ${p.phase}, ${p.qualified} qualified, ${p.pool.active} active`);
            }
          },
          onCheckpoint: c => {
            if (c.candidate && !replayWitness(c.candidate.puzzle, c.candidate.solutionSteps ?? [])) throw new Error("Invalid checkpoint witness");
            if (c.stage === "complete" && c.ok) firstQualifiedMs ??= performance.now() - start;
            const key = `${c.stage}/${c.mode}/${c.ok ? "passed" : c.reason}`;
            counts[key] = (counts[key] ?? 0) + 1;
            appendFileSync(eventsFile, JSON.stringify(c) + "\n");
            checkpoints.push({ ...c, candidate: undefined });
          } });
        retained = result.totalRetained;
        save(`${id}-result.json`, result);
      } catch (cause) {
        status = controller.signal.aborted ? (interruption.signal.aborted ? "cancelled" : "time-limit") : "error";
        error = String(cause);
        if (status === "error") process.exitCode = 1;
      } finally {
        clearTimeout(timer);
        interruption.signal.removeEventListener("abort", stop);
      }
      const used = process.cpuUsage(cpu), elapsedMs = performance.now() - start;
      const completed = checkpoints.filter(c => c.stage === "complete");
      const qualified = completed.filter(c => c.ok).length;
      const summary = { id, status, error, elapsedMs, firstQualifiedMs, retained, qualified,
        completedQualifications: completed.length, counts, averageBusyCores: (used.user + used.system) / 1000 / elapsedMs,
        qualifiedPerMinute: qualified * 60000 / elapsedMs, progress,
        limitation: status === "complete" ? "Qualification is not release or human approval." : "Incomplete run; unfinished candidates have no outcome and retained yield is unknown." };
      summaries.push(summary); save(`${id}-summary.json`, summary);
      console.log(JSON.stringify(summary));
    }
  }
  save("summary.json", summaries);
  console.log(`Reports: ${output}`);
  if (interruption.signal.aborted) process.exitCode = 130;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
