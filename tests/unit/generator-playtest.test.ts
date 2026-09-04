import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { emptyHumanReview, renderGeneratorPlaytest, checkHumanGeneratorReview } from "../../scripts/lib/generator-playtest.ts";
import { buildFinalReviewCatalog } from "../../src/features/generator/v2/review-catalog.ts";
import { buildCanonicalSolutionTrace } from "../../src/features/generator/v2/solution-trace.ts";
import { analyzePassiveSolutionStory } from "../../src/features/generator/v2/passive-story-analysis.ts";
import { assessCandidateQuality } from "../../src/features/generator/v2/story-quality-policy.ts";
import { DEFAULT_RELEASE_GATE_CONFIG } from "../../src/features/generator/v2/release-gate.ts";
import { decodeCustomPuzzle } from "../../src/features/editor/editor-serialization.ts";
import type { ForgeCandidate } from "../../src/features/generator/v2/puzzle-forge.ts";
import type { Direction } from "../../src/core/model.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/generator/generated-tier-samples.json", import.meta.url), "utf8"));
const directions: Record<string, Direction> = { u: "up", d: "down", l: "left", r: "right" };
const candidates: ForgeCandidate[] = fixture.samples.map((s: typeof fixture.samples[number]) => {
  const steps = [...s.witness as string].map(ch => ({ kind: ch === ch.toUpperCase() ? "push" as const : "walk" as const, direction: directions[ch.toLowerCase()] }));
  const grid = s.puzzle.rows.map((row: string) => [...row]);
  const replay = buildCanonicalSolutionTrace(grid, steps, { requireSolved: true });
  assert.ok(replay.ok);
  const story = analyzePassiveSolutionStory(grid, replay.trace);
  const quality = assessCandidateQuality({ puzzle: s.puzzle, evaluation: s.evaluation, trace: replay.trace, passiveStory: story, typing: s.typing });
  assert.ok(quality.passed);
  return { puzzle: s.puzzle, evaluation: s.evaluation, solutionSteps: steps, passiveStory: story,
    storyAwareTyping: s.typing, qualityProfile: quality, provenance: { seed: s.seed, family: s.family, mode: s.mode,
      difficulty: s.puzzle.difficulty, boxCount: s.puzzle.boxes, tightened: true, cellsRemoved: 0, typingMode: "hybrid",
      genericBoxCount: quality.story!.measurements.genericBoxCount, typedBoxCount: quality.story!.measurements.typedBoxCount } };
});
const catalog = structuredClone(buildFinalReviewCatalog(candidates.map(c => ({ difficulty: c.puzzle.difficulty, target: 1 })),
  new Map(candidates.map(c => [c.puzzle.difficulty, [c]]))));
for (const [tier, summary] of Object.entries(catalog.tierSummaries)) {
  for (const pack of summary.candidates) {
    Object.assign(pack, {
      classifiedDifficulty: tier,
      difficultyGap: 0,
      v4Classification: tier,
    });
  }
}
const text = JSON.stringify(catalog), empty = emptyHumanReview(catalog, text);
const fixtureGate = { ...DEFAULT_RELEASE_GATE_CONFIG, minTotalPuzzles: 5, minDistinctModes: 1, maxModeConcentration: 1,
  tierQuotas: Object.fromEntries(candidates.map(c => [c.puzzle.difficulty, { min: 1, target: 1 }])) };
// Synthetic reviewer decisions exercise the gate, never used as real playtest approval.
const approved = { ...empty, reviewer: "Test fixture only", reviewedAt: "2026-09-03T00:00:00Z",
  puzzles: empty.puzzles.map(p => ({ ...p, decision: "approve" as const, enjoyable: true, excessiveWalking: false,
    shortcutFound: false, tierFit: "appropriate" as const })) };

test("playtest reports start unapproved and round-trip every tier into the real editor", () => {
  assert.ok(empty.puzzles.every(p => p.decision === "pending" && p.enjoyable === null));
  const html = renderGeneratorPlaytest(catalog, empty, "http://localhost:5173/");
  const links = [...html.matchAll(/href="http:\/\/localhost:5173\/(#custom=[^"]+)"/gu)];
  assert.equal(links.length, 5);
  links.forEach((m, i) => assert.deepEqual(decodeCustomPuzzle(m[1])?.rows, candidates[i].puzzle.rows));
  assert.ok(html.includes("does not save it automatically"));
  assert.throws(() => renderGeneratorPlaytest(catalog, empty, "javascript:alert(1)"), /HTTP/);
});

test("human readiness requires exact binding, actual decisions and fresh story replay", () => {
  assert.equal(checkHumanGeneratorReview(text, empty, fixtureGate).ready, false);
  const valid = checkHumanGeneratorReview(text, approved, fixtureGate);
  assert.equal(valid.ready, true, valid.errors.join("\n"));
  for (const patch of [{ reviewer: "" }, { reviewSha256: "stale" }, { puzzles: [] },
    { puzzles: approved.puzzles.map((p, i) => i === 0 ? { ...p, shortcutFound: true } : p) },
    { puzzles: approved.puzzles.map((p, i) => i === 0 ? { ...p, decision: "pending" } : p) }]) {
    assert.equal(checkHumanGeneratorReview(text, { ...approved, ...patch }, fixtureGate).ready, false);
  }
  const changed = structuredClone(catalog);
  const first = changed.tierSummaries.beginner.candidates[0];
  Object.assign(first, { solutionSteps: first.solutionSteps!.slice(0, -1) });
  const changedText = JSON.stringify(changed);
  const result = checkHumanGeneratorReview(changedText, { ...approved,
    reviewSha256: emptyHumanReview(changed, changedText).reviewSha256 }, fixtureGate);
  assert.equal(result.ready, false);
  assert.ok(result.errors.some(e => e.includes("replay")), result.errors.join("\n"));
});
