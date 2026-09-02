import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStoryDiversityProfile, storyLayoutKeys, storyDiversityDistance, selectStoryDiverse,
  summarizeStoryDiversity, checkStoryDiversityForRelease, type StoryDiversityProfile,
} from "../../src/features/generator/v2/story-diversity.ts";
import { assessStoryQuality } from "../../src/features/generator/v2/story-quality-policy.ts";
import { summarizePassiveStory } from "../../src/features/generator/v2/passive-story-analysis.ts";
import { nonDominatedSort, computeNoveltyScores } from "../../src/features/generator/v2/curation.ts";
import { buildReviewPack, buildReviewCatalog, formatReviewSummary } from "../../src/features/generator/v2/review-catalog.ts";
import { checkReleaseGate } from "../../src/features/generator/v2/release-gate.ts";
import { curateForgeCandidates, buildV4Fingerprint, type ForgeCandidate } from "../../src/features/generator/v2/puzzle-forge.ts";
import { evaluatePuzzleWithSteps } from "../../src/features/generator/v2/puzzle-evaluator.ts";
import { typedStoryInput } from "../support/story-quality.ts";
import { SHARED_PACKING_STORY } from "../fixtures/generator/story-quality-fixtures.ts";

const input = typedStoryInput(SHARED_PACKING_STORY);
const quality = assessStoryQuality(input);
const summary = summarizePassiveStory(input.passiveStory!);
const profile = buildStoryDiversityProfile(input.puzzle.rows, quality, summary)!;

function variant(id: string, overrides: Partial<StoryDiversityProfile> = {}) {
  const p = { ...profile, layoutKey: id, visualKey: id, ...overrides };
  return { item: id, id, profile: p, rank: 0 };
}

test("layout identity ignores labels, class assignment, framing and all eight symmetries", () => {
  const rows = input.puzzle.rows;
  const keys = storyLayoutKeys(rows);
  const recolored = rows.map((row) => row.replace(/[A-Z]/gu, (tile) =>
    tile === "O" || tile === "R" || tile === "S" ? tile : "B").replace(/[a-z]/gu, "b"));
  assert.deepEqual(storyLayoutKeys(recolored), keys);
  let rotated = [...rows];
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(storyLayoutKeys(rotated), keys);
    assert.deepEqual(storyLayoutKeys(rotated.map((row) => [...row].reverse().join(""))), keys);
    rotated = Array.from({ length: rotated[0].length }, (_, c) => [...rotated].reverse().map((row) => row[c]).join(""));
  }
  const framed = ["O".repeat(rows[0].length + 2), ...rows.map((row) => `O${row}O`), "O".repeat(rows[0].length + 2)];
  assert.deepEqual(storyLayoutKeys(framed), keys);
  const movedBox = rows.map((row) => row.replace(" X", "X "));
  assert.equal(storyLayoutKeys(movedBox).visualKey, keys.visualKey);
  assert.notEqual(storyLayoutKeys(movedBox).layoutKey, keys.layoutKey);
});

test("real mixed packing produces a bound, reproducible story identity", () => {
  assert.ok(profile);
  assert.ok(profile.families.includes("ordered-packing"));
  assert.deepEqual(buildStoryDiversityProfile(input.puzzle.rows, quality, summary), profile);
  assert.deepEqual(checkStoryDiversityForRelease(profile, input.puzzle.rows, quality, summary), []);
  assert.equal(buildStoryDiversityProfile(input.puzzle.rows, { ...quality, passed: false }, summary), undefined);
  assert.equal(buildStoryDiversityProfile(input.puzzle.rows, undefined, summary), undefined);
  const hugePushCounts = { ...quality, measurements: { ...quality.measurements,
    boxes: quality.measurements.boxes.map((box) => ({ ...box, pushes: 9999 })) } };
  assert.deepEqual(buildStoryDiversityProfile(input.puzzle.rows, hugePushCounts, summary), profile);
  assert.equal(storyDiversityDistance(profile, { ...profile, storySignature: "cosmetic change" }), 0);
});

test("same-layout clones never refill quotas, even below target or with relaxed shares", () => {
  for (const target of [1, 3, 20]) {
    const entries = [variant("a"), variant("b", { layoutKey: "a" }), variant("c", { layoutKey: "a" })];
    const result = selectStoryDiverse(entries, target, { maxStoryShare: 1, maxVisualShare: 1 });
    assert.deepEqual(result.selected.map((entry) => entry.id), ["a"]);
    assert.equal(result.report.shortfall, target - 1);
    assert.equal(result.report.decisions.filter((entry) => entry.reason === "layout-clone").length, 2);
  }
});

test("story and visual concentration limits operate independently", () => {
  const sameStory = Array.from({ length: 5 }, (_, i) => variant(`${i}`));
  const selection = selectStoryDiverse(sameStory, 5);
  // Backfill pass relaxes story caps when there is a shortfall, filling all 5
  assert.equal(selection.selected.length, 5);
  assert.equal(selection.report.shortfall, 0);
  const sameVisual = sameStory.map((entry, i) => ({ ...entry,
    profile: { ...entry.profile, visualKey: "shared", storySignature: `${i}` } }));
  const visualSelection = selectStoryDiverse(sameVisual, 5);
  // Backfill relaxes visual caps too
  assert.equal(visualSelection.selected.length, 5);
  assert.equal(visualSelection.report.shortfall, 0);
});

test("selection seeks new stories before variants and is stable across pool order", () => {
  const a = variant("a");
  const b = variant("b");
  const c = variant("c", { families: ["gate-traffic"], storySignature: "gate", pacing: "linear" });
  const entries = [a, b, c];
  const select = (pool: typeof entries) => selectStoryDiverse(pool, 2, { maxStoryShare: 1, maxVisualShare: 1 });
  assert.deepEqual(select(entries).selected.map((entry) => entry.id), ["a", "c"]);
  assert.deepEqual(select([...entries].reverse()), select(entries));
  assert.ok(storyDiversityDistance(a.profile, c.profile) > storyDiversityDistance(a.profile, b.profile));
  assert.equal(storyDiversityDistance(c.profile, a.profile), storyDiversityDistance(a.profile, c.profile));
});

test("missing evidence, zero targets and invalid policies are explicit", () => {
  const result = selectStoryDiverse([{ id: "missing", item: 0, rank: 0 }], 3);
  assert.equal(result.report.decisions[0].reason, "missing-story-evidence");
  assert.equal(result.report.shortfall, 3);
  assert.equal(selectStoryDiverse([variant("a")], 0).selected.length, 0);
  assert.equal(selectStoryDiverse([], 5).report.shortfall, 5);
  assert.throws(() => selectStoryDiverse([], -1), /target/);
  assert.throws(() => selectStoryDiverse([], 5, { maxStoryShare: NaN, maxVisualShare: 1 }), /shares/);
});

test("metadata limits apply after clone removal, not to an earlier tentative selection", () => {
  const entries = [variant("a"), variant("b", { layoutKey: "a" }), variant("c"), variant("d")];
  const result = selectStoryDiverse(entries, 3, { maxStoryShare: 1, maxVisualShare: 1 },
    (_entry, selected) => selected.length < 2);
  assert.deepEqual(result.selected.map((entry) => entry.id), ["a", "c"]);
  assert.equal(result.report.decisions.find((decision) => decision.id === "b")?.reason, "layout-clone");
  assert.equal(result.report.decisions.find((decision) => decision.id === "d")?.reason, "metadata-cap");
  assert.equal(result.report.considered, result.report.decisions.length);
});

test("coverage and closest-neighbor explanations identify clones and missing families", () => {
  const a = variant("a");
  const b = variant("b", { layoutKey: "a", visualKey: "a" });
  const c = variant("c", { families: ["gate-traffic"], storySignature: "gate" });
  const report = summarizeStoryDiversity([a, b, c, { id: "missing" }]);
  assert.equal(report.measured, 3);
  assert.deepEqual(report.cloneGroups, [["a", "b"]]);
  assert.deepEqual(report.missingEvidenceIds, ["missing"]);
  assert.equal(report.nearestNeighbors.a[0].id, "b");
  assert.equal(report.nearestNeighbors.a[0].distance, 0);
  assert.ok(report.nearestNeighbors.a[0].reasons.some((reason) => reason.includes("same layout")));
  assert.equal(report.familyCounts["gate-traffic"], a.profile.families.includes("gate-traffic") ? 3 : 1);
  assert.deepEqual(summarizeStoryDiversity([]).nearestNeighbors, {});
});

test("Pareto sorting retains both structural and story fingerprints for novelty", () => {
  const objectives = { interaction: 1, dependency: 1, decisionQuality: 1, structuralRichness: 1,
    solverChallenge: 1, novelty: 0, tedium: 0 };
  const sorted = nonDominatedSort([
    { item: "a", objectives, structuralFingerprint: "hub|plain|none|none", storyDiversity: profile },
    { item: "b", objectives, structuralFingerprint: "loop|plain|none|none", storyDiversity: variant("b", { families: ["gate-traffic"] }).profile },
  ]);
  assert.equal(sorted[0].structuralFingerprint, "hub|plain|none|none");
  assert.equal(sorted[0].storyDiversity, profile);
  assert.ok(computeNoveltyScores(sorted)[0].noveltyScore > 0.5);
});

test("release fingerprint verification fails closed for missing, stale and malformed evidence", () => {
  assert.ok(checkStoryDiversityForRelease(undefined, input.puzzle.rows, quality, summary).length);
  assert.ok(checkStoryDiversityForRelease(profile, undefined, quality, summary).length);
  assert.ok(checkStoryDiversityForRelease({ ...profile, layoutKey: "forged" }, input.puzzle.rows, quality, summary).length);
  assert.ok(checkStoryDiversityForRelease(profile, input.puzzle.rows, quality, { ...summary, solutionPhases: NaN }).length);
  assert.ok(checkStoryDiversityForRelease(profile, ["OOOO", "O  O", "OOOO"], quality, summary).length);
});

test("real review packs expose evidence, participation, phases and neighbors; release rechecks identities", async () => {
  const evaluated = await evaluatePuzzleWithSteps(input.puzzle);
  const candidate: ForgeCandidate = {
    puzzle: input.puzzle, evaluation: evaluated.vector, passiveStory: input.passiveStory!,
    provenance: { seed: 42, family: "hub", boxCount: 3, mode: "plain", difficulty: "beginner", tightened: false,
      cellsRemoved: 0, typingMode: "hybrid", genericBoxCount: quality.measurements.genericBoxCount,
      typedBoxCount: quality.measurements.typedBoxCount },
    qualityProfile: { passed: true, reasons: [], story: quality, purposefulGeometry: 1, interactionQuality: 1,
      causalDepth: 1, decisionQuality: 1, mechanismIntegrity: 1, elegance: 1, tedium: 0 },
  };
  const cloned = { ...candidate, puzzle: { ...candidate.puzzle, id: "clone" } };
  const curated = curateForgeCandidates([candidate, cloned], 5);
  assert.equal(curated.candidates.length, 1);
  assert.ok(curated.report.decisions.some((decision) => decision.reason === "layout-clone"));
  assert.equal(curateForgeCandidates([{ ...candidate, qualityProfile: undefined }], 5).candidates.length, 0);
  const pack = buildReviewPack(candidate, "beginner", "beginner", 0);
  const other = buildReviewPack(cloned, "beginner", "beginner", 0);
  const catalog = buildReviewCatalog(new Map([["beginner", { target: 5, packs: [pack, other] }]]), {
    curationReports: { beginner: curated.report },
  });
  assert.equal(catalog.schemaVersion, 2);
  assert.deepEqual(pack.rows, input.puzzle.rows);
  assert.deepEqual(pack.storyDiversity, profile);
  assert.equal(pack.storyEvidence, input.passiveStory);
  const text = formatReviewSummary(catalog);
  for (const expected of ["CATALOG STORY COVERAGE", "LAYOUT CLONES", "Closest neighbor", "Box participation",
    "Phase timeline", "Human review checklist", "layout-clone", "shortfall 4"]) assert.ok(text.includes(expected), expected);
  assert.ok(checkReleaseGate(catalog).errors.some((error) => error.includes("Label-insensitive layout clones")));
  const forged = { ...pack, storyDiversity: { ...profile, storySignature: "fake" } };
  const forgedCatalog = buildReviewCatalog(new Map([["beginner", { target: 1, packs: [forged] }]]));
  assert.ok(checkReleaseGate(forgedCatalog).errors.some((error) => error.includes("inconsistent story diversity")));
  const parts = buildV4Fingerprint({ ...candidate, provenance: { ...candidate.provenance,
    motifType: "gatekeeper", mechanismTypes: ["packing-chain"] } }).split("|");
  assert.equal(parts[2], "gatekeeper");
  assert.equal(parts[3], "packing-chain");
  assert.equal(parts[4], "beginner");
});
