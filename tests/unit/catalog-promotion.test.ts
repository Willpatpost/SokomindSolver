import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { DIFFICULTIES } from "../../src/core/model.ts";
import type { PuzzleDefinition } from "../../src/core/model.ts";
import type { ReviewCatalog, GeneratedPuzzleManifest } from "../../src/features/generator/v2/catalog-manifest-types.ts";
import { runForge, DEFAULT_FORGE_CONFIG } from "../../src/features/generator/v2/puzzle-forge.ts";
import { createGeneratedPuzzleId } from "../../src/features/generator/v2/puzzle-identity.ts";
import { buildReviewPack, buildReviewCatalog } from "../../src/features/generator/v2/review-catalog.ts";
import { DEFAULT_RELEASE_GATE_CONFIG } from "../../src/features/generator/v2/release-gate.ts";
import { computeV4Profile } from "../../src/features/generator/v2/difficulty-model.ts";
import { catalogContentHash, verifyPromotionBundle, installPromotionBundle, type PromotionBundle } from "../../scripts/lib/catalog-promotion.ts";
import { emptyHumanReview, reviewDigest, type HumanGeneratorReview } from "../../scripts/lib/generator-playtest.ts";

const root = mkdtempSync(join(tmpdir(), "sokomind-promotion-test-"));
after(() => {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(root.includes("sokomind-promotion-test-"));
  rmSync(root, { recursive: true, force: true });
});

const onePuzzleConfig = { ...DEFAULT_RELEASE_GATE_CONFIG, minTotalPuzzles: 1,
  tierQuotas: { beginner: { min: 1, target: 1 } },
  minDistinctTopologies: 1, minDistinctModes: 1, minDistinctBoxCounts: 1 };

const fixture = (async () => {
  const result = await runForge({ ...DEFAULT_FORGE_CONFIG, batchSize: 3, retainTarget: 3,
    families: ["linear", "hub"], boxCounts: [3], difficulties: ["beginner"],
    modes: ["plain", "motif", "composed"], baseSeed: 20002 });
  assert.ok(result.candidates.length > 0, "must exercise a real qualified generator candidate");
  const candidate = result.candidates[0];
  const puzzle = { ...candidate.puzzle, title: "Beginner 1", id: createGeneratedPuzzleId(candidate.provenance.seed, candidate.puzzle.rows) };
  const measured = computeV4Profile(candidate.evaluation);
  const profile = { ...measured, classification: "beginner" as const };
  const pack = buildReviewPack({ ...candidate, puzzle }, "beginner", "beginner", 0, undefined, profile);
  const review = buildReviewCatalog(new Map([["beginner", { target: 1, packs: [pack] }]]));
  const manifest = { schemaVersion: 1, generatorVersion: review.generatorVersion, catalogHash: catalogContentHash([puzzle]),
    tierQuotas: Object.fromEntries(DIFFICULTIES.map((tier) => [tier, { target: tier === "beginner" ? 1 : 0, actual: tier === "beginner" ? 1 : 0 }])),
    puzzles: [{ ...pack, title: puzzle.title }],
  };
  const reviewText = JSON.stringify(review);
  const pending = emptyHumanReview(review, reviewText);
  const humanReview: HumanGeneratorReview = {
    ...pending,
    reviewer: "Promotion test fixture",
    reviewedAt: "2026-09-04T00:00:00.000Z",
    puzzles: pending.puzzles.map((item) => ({
      ...item,
      decision: "approve",
      enjoyable: true,
      excessiveWalking: false,
      shortcutFound: false,
      tierFit: "appropriate",
    })),
  };
  return {
    catalog: JSON.stringify([puzzle]),
    manifest: JSON.stringify(manifest),
    review: reviewText,
    humanReview: JSON.stringify(humanReview),
  };
})();

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type BundleParts = {
  catalog: Mutable<PuzzleDefinition[]>;
  manifest: Mutable<GeneratedPuzzleManifest>;
  review: Mutable<ReviewCatalog>;
  humanReview: Mutable<HumanGeneratorReview>;
};
function mutate<K extends keyof BundleParts>(bundle: PromotionBundle, file: K, change: (value: BundleParts[K]) => void): PromotionBundle {
  const value = JSON.parse(bundle[file]) as BundleParts[K];
  change(value);
  return { ...bundle, [file]: JSON.stringify(value) };
}

function mutateReview(bundle: PromotionBundle, change: (value: BundleParts["review"]) => void): PromotionBundle {
  const changed = mutate(bundle, "review", change);
  return mutate(changed, "humanReview", (value) => {
    value.reviewSha256 = reviewDigest(changed.review);
  });
}

test("promotion independently replays a real generated mixed-box puzzle", async () => {
  const checked = verifyPromotionBundle(await fixture, onePuzzleConfig);
  assert.equal(checked.passed, true, checked.errors.join("\n"));
  assert.equal(checked.replayed, 1);
  assert.equal(checked.puzzleCount, 1);
});

test("malformed or incomplete promotion bundles fail closed", async () => {
  const bundle = await fixture;
  for (const patch of [{ catalog: "null" }, { catalog: "[null]" }, { catalog: "[]" }, { manifest: "{}" },
    { review: "null" }, { catalog: "{" }]) {
    assert.equal(verifyPromotionBundle({ ...bundle, ...patch }, onePuzzleConfig).passed, false);
  }
  const extraManifest = mutate(bundle, "manifest", (value) => value.puzzles.push(value.puzzles[0]));
  assert.equal(verifyPromotionBundle(extraManifest, onePuzzleConfig).passed, false);
});

test("promotion requires an approved human review bound to the exact review catalog", async () => {
  const bundle = await fixture;
  const missing = { ...bundle, humanReview: undefined } as unknown as PromotionBundle;
  assert.equal(verifyPromotionBundle(missing, onePuzzleConfig).passed, false);

  const stale = mutate(bundle, "humanReview", (value) => {
    value.reviewSha256 = "stale";
  });
  assert.ok(verifyPromotionBundle(stale, onePuzzleConfig).errors.some((error) =>
    error.includes("Human review")));

  const rejected = mutate(bundle, "humanReview", (value) => {
    value.puzzles[0].decision = "reject";
  });
  assert.ok(verifyPromotionBundle(rejected, onePuzzleConfig).errors.some((error) =>
    error.includes("playtesting is incomplete")));
});

test("promotion refuses missing, invalid and unsolved witnesses even with passing cached gates", async () => {
  const bundle = await fixture;
  for (const steps of [undefined, [], [{ kind: "walk", direction: "north" }], [{ kind: "walk", direction: "left" }]]) {
    const bad = mutateReview(bundle, (value) => {
      const pack = value.tierSummaries.beginner.candidates[0];
      pack.solutionSteps = steps as typeof pack.solutionSteps;
    });
    const checked = verifyPromotionBundle(bad, onePuzzleConfig);
    assert.equal(checked.passed, false);
    assert.ok(checked.errors.some((error) => /witness|replay/iu.test(error)), checked.errors.join("\n"));
  }
});

test("promotion detects forged story measurements and missing construction/typing intent", async () => {
  const bundle = await fixture;
  const forged = mutateReview(bundle, (value) => { value.tierSummaries.beginner.candidates[0].storyQuality!.measurements.boxes[0].pushes++; });
  assert.ok(verifyPromotionBundle(forged, onePuzzleConfig).errors.some((error) => error.includes("fresh story verification")));
  const missingTyping = mutateReview(bundle, (value) => { delete value.tierSummaries.beginner.candidates[0].storyAwareTypingPlan; });
  assert.ok(verifyPromotionBundle(missingTyping, onePuzzleConfig).errors.some((error) => error.includes("fresh story verification")));
});

test("promotion binds exact catalog bytes semantically to manifest and review", async () => {
  const bundle = await fixture;
  const changes = [
    mutate(bundle, "catalog", (value) => { value[0].boxes++; }),
    mutate(bundle, "catalog", (value) => { value[0].difficulty = "master"; }),
    mutate(bundle, "catalog", (value) => { value[0].title = "Not reviewed"; }),
    mutate(bundle, "catalog", (value) => { value[0].rows.unshift("O".repeat(value[0].rows[0].length)); }),
    mutate(bundle, "manifest", (value) => { value.catalogHash = "wrong"; }),
    mutate(bundle, "manifest", (value) => { value.tierQuotas.beginner.actual++; }),
    mutate(bundle, "manifest", (value) => { value.puzzles[0].solutionMoves++; }),
  ];
  for (const changed of changes) assert.equal(verifyPromotionBundle(changed, onePuzzleConfig).passed, false);
});

test("valid dry-run promotion writes neither catalog nor backups", async () => {
  const target = join(root, "dry-run");
  const backups = join(root, "dry-backups");
  const result = installPromotionBundle(await fixture, target, backups, { dryRun: true, config: onePuzzleConfig });
  assert.equal(result.verification.passed, true);
  assert.equal(result.installed, false);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(backups), false);
});

test("successful installation preserves both previous files in a recovery backup", async () => {
  const target = join(root, "installed");
  mkdirSync(target);
  writeFileSync(join(target, "generated-puzzles.json"), "old catalog");
  writeFileSync(join(target, "generated-puzzles.manifest.json"), "old manifest");
  const bundle = await fixture;
  const result = installPromotionBundle(bundle, target, join(root, "backups"), { config: onePuzzleConfig });
  assert.equal(result.installed, true);
  assert.equal(readFileSync(join(target, "generated-puzzles.json"), "utf8"), bundle.catalog);
  assert.equal(readFileSync(join(target, "generated-puzzles.manifest.json"), "utf8"), bundle.manifest);
  assert.equal(readFileSync(join(target, "generated-puzzles.human-review.json"), "utf8"), bundle.humanReview);
  assert.equal(readFileSync(join(result.backupDirectory!, "generated-puzzles.json"), "utf8"), "old catalog");
  assert.equal(readFileSync(join(result.backupDirectory!, "generated-puzzles.manifest.json"), "utf8"), "old manifest");
  assert.ok(existsSync(join(result.backupDirectory!, "completed.json")));
  const completed = JSON.parse(readFileSync(join(result.backupDirectory!, "completed.json"), "utf8"));
  assert.equal(completed.verification.humanReview.reviewer, "Promotion test fixture");
  assert.equal(readdirSync(target).some((name) => name.endsWith(".staged")), false);
});

test("failure replacing the second file rolls the first back", async () => {
  const target = join(root, "rollback");
  mkdirSync(target);
  writeFileSync(join(target, "generated-puzzles.json"), "previous catalog");
  writeFileSync(join(target, "generated-puzzles.manifest.json"), "previous manifest");
  let replacements = 0;
  const bundle = await fixture;
  assert.throws(() => installPromotionBundle(bundle, target, join(root, "rollback-backups"), {
    config: onePuzzleConfig, replaceFile: (from, to) => {
      if (++replacements === 2) throw new Error("simulated disk failure");
      renameSync(from, to);
    },
  }), /previous files restored/);
  assert.equal(readFileSync(join(target, "generated-puzzles.json"), "utf8"), "previous catalog");
  assert.equal(readFileSync(join(target, "generated-puzzles.manifest.json"), "utf8"), "previous manifest");
  assert.equal(readdirSync(target).some((name) => name.endsWith(".staged")), false);
});

test("a failing release gate never starts a promotion transaction", async () => {
  const target = join(root, "blocked");
  const backups = join(root, "blocked-backups");
  const result = installPromotionBundle(await fixture, target, backups);
  assert.equal(result.installed, false, "one beginner cannot fill a complete release");
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(backups), false);
});

test("generation CLI validates budgets and unknown presets before doing work", () => {
  for (const args of [["--attempts", "0"], ["--attempts", "NaN"], ["--quality", "unknown"], ["--target"], ["--max-seed-windows", "-1"]]) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/generate-v2-catalog.ts", "--dry-run", ...args], {
      cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 5000,
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.includes("[forge]"), false);
  }
});
