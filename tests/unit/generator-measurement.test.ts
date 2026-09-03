import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { TIER_CONFIGS } from "../../scripts/lib/generator-tier-config.ts";
import { runForge, type ForgeCheckpoint } from "../../src/features/generator/v2/puzzle-forge.ts";
import { replayWitness } from "../../src/features/generator/v2/generation-evidence.ts";

test("measurement shares the catalog tier contracts", () => {
  assert.deepEqual(TIER_CONFIGS.map(t => t.difficulty), ["beginner", "intermediate", "advanced", "expert", "master"]);
  assert.deepEqual(TIER_CONFIGS.map(t => t.config.boxCounts[0]), [3, 7, 10, 14, 18]);
  for (const t of TIER_CONFIGS) {
    assert.ok(t.config.gates.minPushesPerBox >= 1);
    assert.equal(t.config.gates.minCrossTypeInteractions, 1);
  }
});

test("checkpoint observers preserve outcomes and expose legal qualified candidates before curation", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/generator/generated-quality-samples.json", import.meta.url), "utf8"));
  const config = { ...fixture.config, baseSeed: 310049, boxCounts: [3], reverseCandidatesPerBlueprint: 2 };
  const events: ForgeCheckpoint[] = [];
  const measured = await runForge(config, { workers: 2, onCheckpoint: c => events.push(c) });
  const control = await runForge(config, { workers: 2 });
  assert.deepEqual(measured.rejections, control.rejections);
  assert.deepEqual(measured.candidates.map(c => c.puzzle.rows), control.candidates.map(c => c.puzzle.rows));
  assert.equal(events.filter(c => c.stage === "blueprint").length, measured.totalAttempted);
  assert.equal(events.filter(c => c.stage === "complete" && c.ok).length, measured.totalValid);
  assert.ok(events.some(c => c.candidate));
  for (const event of events) {
    assert.ok(event.queueAndTaskMs >= 0);
    if (event.candidate) assert.ok(replayWitness(event.candidate.puzzle, event.candidate.solutionSteps!));
    if (!event.ok) assert.ok(event.reason);
  }
});
