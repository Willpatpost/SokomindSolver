import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DIFFICULTIES, DIRECTIONS, type PuzzleDefinition } from "../../src/core/model.ts";
import { validatePuzzle } from "../../src/core/puzzle.ts";
import { boardHash, symmetryHash } from "../../src/features/generator/v2/puzzle-identity.ts";
import { checkReleaseGate, checkReviewManifestBinding, type ReleaseGateConfig } from "../../src/features/generator/v2/release-gate.ts";
import type { ReviewCatalog } from "../../src/features/generator/v2/catalog-manifest-types.ts";
import { buildCanonicalSolutionTrace } from "../../src/features/generator/v2/solution-trace.ts";
import { analyzePassiveSolutionStory, summarizePassiveStory } from "../../src/features/generator/v2/passive-story-analysis.ts";
import { assessStoryQuality } from "../../src/features/generator/v2/story-quality-policy.ts";
import { classifyDifficultyByBoxCount } from "../../src/features/generator/v2/difficulty-model.ts";
import { isBoxChar, isGenericBoxChar, isTypedBoxChar } from "../../src/features/generator/v2/tile-semantics.ts";

export interface PromotionBundle {
  readonly catalog: string;
  readonly manifest: string;
  readonly review: string;
}

export interface PromotionVerification {
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly puzzleCount: number;
  readonly replayed: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function catalogContentHash(entries: readonly PuzzleDefinition[]): string {
  return boardHash(entries.map((entry) => entry.rows.join("\n")).join("\n\n").split("\n"));
}

/** Independent replay is mandatory even if the serialized release report passed. */
export function verifyPromotionBundle(bundle: PromotionBundle, config?: ReleaseGateConfig): PromotionVerification {
  const errors: string[] = [];
  const warnings: string[] = [];
  let catalog: unknown;
  let manifest: unknown;
  let review: unknown;
  try {
    catalog = JSON.parse(bundle.catalog);
    manifest = JSON.parse(bundle.manifest);
    review = JSON.parse(bundle.review);
  } catch {
    return { passed: false, errors: ["Promotion bundle contains invalid JSON"], warnings, puzzleCount: 0, replayed: 0 };
  }
  const verdict = checkReleaseGate(review, config);
  errors.push(...verdict.errors);
  warnings.push(...verdict.warnings);
  errors.push(...checkReviewManifestBinding(review, manifest));
  if (!Array.isArray(catalog) || catalog.length === 0) errors.push("Promotion catalog must be a non-empty array");
  if (!record(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.puzzles)) {
    errors.push("Promotion manifest must have schemaVersion 1 and a puzzles array");
  }
  if (errors.length > 0) return { passed: false, errors, warnings, puzzleCount: Array.isArray(catalog) ? catalog.length : 0, replayed: 0 };

  // Shape and release checks above have validated review pack metadata.
  const reviewCatalog = review as ReviewCatalog;
  const packs = Object.values(reviewCatalog.tierSummaries).flatMap((tier) => tier.candidates);
  const packsById = new Map(packs.map((pack) => [pack.id, pack]));
  const entries = catalog as PuzzleDefinition[];
  const rawManifest = manifest as Record<string, unknown>;
  const manifestEntries = rawManifest.puzzles as Record<string, unknown>[];
  if (manifestEntries.length !== entries.length || new Set(manifestEntries.map((entry) => entry.id)).size !== manifestEntries.length) {
    errors.push("Manifest must contain exactly one entry per catalog puzzle");
  }
  if (rawManifest.generatorVersion !== reviewCatalog.generatorVersion) errors.push("Manifest/review generator versions differ");
  const ids = new Set<string>();
  let replayed = 0;
  for (const entry of entries) {
    try {
      if (!record(entry) || typeof entry.id !== "string" || !entry.id.startsWith("gen-v2-") ||
        typeof entry.title !== "string" || !Array.isArray(entry.rows) || entry.rows.length === 0 ||
        !entry.rows.every((row) => typeof row === "string") || !Number.isInteger(entry.boxes)) {
        errors.push("Malformed generated catalog entry");
        continue;
      }
      if (ids.has(entry.id)) errors.push(`Duplicate catalog id: ${entry.id}`);
      ids.add(entry.id);
      const validation = validatePuzzle(entry);
      if (!validation.valid) {
        errors.push(`${entry.id}: ${validation.errors.map((error) => error.message).join("; ")}`);
        continue;
      }
      const pack = packsById.get(entry.id);
      const mp = manifestEntries.find((item) => item.id === entry.id);
      if (!pack || !mp) { errors.push(`${entry.id}: missing review/manifest entry`); continue; }
      if (!isDeepStrictEqual(entry.rows, pack.rows)) errors.push(`${entry.id}: production rows differ from exact reviewed rows`);
      const hash = boardHash(entry.rows);
      const tiles = entry.rows.join("").split("");
      const boxCount = tiles.filter(isBoxChar).length;
      if (entry.boxes !== boxCount || boxCount !== pack.boxCount || boxCount !== mp.boxCount ||
        tiles.filter(isGenericBoxChar).length !== pack.genericBoxCount || tiles.filter(isTypedBoxChar).length !== pack.typedBoxCount) {
        errors.push(`${entry.id}: actual box counts do not match review/manifest`);
      }
      if (entry.difficulty !== classifyDifficultyByBoxCount(boxCount) || entry.difficulty !== pack.classifiedDifficulty || entry.difficulty !== mp.difficulty) {
        errors.push(`${entry.id}: difficulty does not match actual box count`);
      }
      if (mp.title !== entry.title || pack.boardHash !== hash || mp.boardHash !== hash || mp.symmetryHash !== symmetryHash(entry.rows)) {
        errors.push(`${entry.id}: catalog identity does not match review/manifest`);
      }
      if (!Array.isArray(pack.solutionSteps) || pack.solutionSteps.length === 0 || pack.solutionSteps.some((step) =>
        !record(step) || !["walk", "push"].includes(step.kind as string) || !(DIRECTIONS as readonly unknown[]).includes(step.direction))) {
        errors.push(`${entry.id}: missing or malformed evaluated solution witness`);
        continue;
      }
      const grid = entry.rows.map((row) => [...row]);
      const result = buildCanonicalSolutionTrace(grid, pack.solutionSteps, { puzzleId: entry.id, requireSolved: true });
      if (!result.ok) { errors.push(`${entry.id}: replay failed: ${result.error.message}`); continue; }
      replayed++;
      const trace = result.trace;
      if (trace.steps.length !== pack.solutionMoves || trace.pushes.length !== pack.solutionPushes ||
        mp.solutionMoves !== trace.steps.length || mp.solutionPushes !== trace.pushes.length) errors.push(`${entry.id}: solution counts differ from replay`);
      const passive = analyzePassiveSolutionStory(grid, trace);
      const quality = assessStoryQuality({
        puzzle: entry, trace, passiveStory: passive, construction: pack.mechanismConstructionPlan,
        constructionRequired: pack.mode === "mechanism", typing: pack.storyAwareTypingPlan,
      });
      if (!quality.passed) errors.push(`${entry.id}: replay quality failed: ${quality.violations.map((violation) => violation.message).join("; ")}`);
      if (!isDeepStrictEqual(quality.measurements, pack.storyQuality?.measurements)) errors.push(`${entry.id}: replayed story measurements differ from recorded quality evidence`);
      if (!isDeepStrictEqual(summarizePassiveStory(passive), pack.passiveStory)) errors.push(`${entry.id}: replayed story summary differs from review`);
      // JSON review files omit optional undefined fields; compare JSON semantics.
      const serializedPassive = JSON.parse(JSON.stringify({ ...passive, puzzleId: "" })) as unknown;
      if (!pack.storyEvidence || !isDeepStrictEqual(serializedPassive, { ...pack.storyEvidence, puzzleId: "" })) {
        errors.push(`${entry.id}: replayed story landmarks differ from review`);
      }
      if (pack.counterfactualStory && pack.counterfactualStory.boardHash !== hash) {
        errors.push(`${entry.id}: counterfactual evidence boardHash does not match puzzle`);
      }
      if (pack.storyQuality && pack.storyQuality.measurements.boardHash !== hash) {
        errors.push(`${entry.id}: recorded story quality boardHash does not match puzzle`);
      }
      if (pack.storyQuality && !isDeepStrictEqual(pack.storyQuality.measurements.families, quality.measurements.families)) {
        errors.push(`${entry.id}: recorded story families differ from replayed families`);
      }
      if (pack.storyQuality && pack.storyQuality.measurements.constructionRealized !== quality.measurements.constructionRealized) {
        errors.push(`${entry.id}: recorded construction realization differs from replayed`);
      }
      if (pack.storyQuality && pack.storyQuality.passed !== quality.passed) {
        errors.push(`${entry.id}: recorded story quality verdict differs from replayed verdict`);
      }
    } catch (error) {
      errors.push(`${record(entry) ? entry.id : "entry"}: malformed replay evidence (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (ids.size !== packs.length || packs.some((pack) => !ids.has(pack.id))) errors.push("Catalog and review must contain exactly the same ids");
  try {
    if (rawManifest.catalogHash !== catalogContentHash(entries)) errors.push("Manifest catalogHash does not match catalog contents");
  } catch { errors.push("Cannot compute catalog identity from malformed rows"); }
  if (!record(rawManifest.tierQuotas)) errors.push("Manifest tierQuotas is missing");
  else for (const tier of DIFFICULTIES) {
    const quota = rawManifest.tierQuotas[tier];
    const actual = entries.filter((entry) => record(entry) && entry.difficulty === tier).length;
    const target = reviewCatalog.tierSummaries[tier]?.target ?? 0;
    if (!record(quota) || quota.actual !== actual || quota.target !== target) errors.push(`Manifest ${tier} quota does not match catalog/review`);
  }
  return { passed: errors.length === 0, errors, warnings, puzzleCount: entries.length, replayed };
}

export function readPromotionBundle(sourceDirectory: string): PromotionBundle {
  return {
    catalog: readFileSync(join(sourceDirectory, "generated-puzzles.json"), "utf8"),
    manifest: readFileSync(join(sourceDirectory, "generated-puzzles.manifest.json"), "utf8"),
    review: readFileSync(join(sourceDirectory, "review-catalog.json"), "utf8"),
  };
}

/** Back up both files, install validated in-memory bytes, roll back on any error.
 * The two renames are not a filesystem-wide atomic transaction; backups also
 * support recovery after process/machine interruption between them.
 */
export function installPromotionBundle(
  bundle: PromotionBundle,
  catalogDirectory: string,
  backupRoot: string,
  options: { readonly dryRun?: boolean; readonly config?: ReleaseGateConfig;
    readonly replaceFile?: typeof renameSync } = {},
): { verification: PromotionVerification; backupDirectory?: string; installed: boolean } {
  const verification = verifyPromotionBundle(bundle, options.config);
  if (!verification.passed || options.dryRun) return { verification, installed: false };
  const targetDirectory = resolve(catalogDirectory);
  const backupDirectory = join(resolve(backupRoot), `promotion-${Date.now()}-${randomUUID()}`);
  const targets = ["generated-puzzles.json", "generated-puzzles.manifest.json"].map((name, i) => ({
    name, target: join(targetDirectory, name), bytes: i === 0 ? bundle.catalog : bundle.manifest,
    staged: join(targetDirectory, `.${name}.${randomUUID()}.staged`), existed: existsSync(join(targetDirectory, name)),
  }));
  // Only the two named files inside the resolved target directory may be replaced.
  if (targets.some((item) => dirname(item.target) !== targetDirectory)) throw new Error("Invalid promotion target");
  mkdirSync(backupDirectory, { recursive: true });
  for (const item of targets) if (item.existed) copyFileSync(item.target, join(backupDirectory, item.name));
  writeFileSync(join(backupDirectory, "transaction.json"), JSON.stringify({
    status: "prepared", targetDirectory, targets: targets.map(({ name, existed }) => ({ name, existed })),
  }, null, 2) + "\n", { flag: "wx" });
  const installed: typeof targets = [];
  try {
    for (const item of targets) writeFileSync(item.staged, item.bytes, { flag: "wx" });
    for (const item of targets) {
      (options.replaceFile ?? renameSync)(item.staged, item.target);
      installed.push(item);
    }
    writeFileSync(join(backupDirectory, "completed.json"), JSON.stringify({ status: "installed", verification }, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const item of installed.reverse()) {
      try {
        if (item.existed) copyFileSync(join(backupDirectory, item.name), item.target);
        else if (existsSync(item.target)) unlinkSync(item.target);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    throw new Error(`Promotion failed; ${rollbackErrors.length ? `rollback incomplete (${rollbackErrors.length} errors), recover from backup` : "previous files restored"}. Backup: ${backupDirectory}`,
      { cause: error });
  } finally {
    for (const item of targets) if (existsSync(item.staged)) unlinkSync(item.staged);
  }
  return { verification, backupDirectory, installed: true };
}
