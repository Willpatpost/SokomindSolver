import assert from "node:assert/strict";
import test from "node:test";

import {
  DiagnosticCollector,
  formatDiagnosticReport,
} from "../../src/features/generator/v2/generator-diagnostics.ts";

test("DiagnosticCollector tracks pipeline funnel counts", () => {
  const c = new DiagnosticCollector();
  c.recordAttempt();
  c.recordAttempt();
  c.recordAttempt();
  c.recordBlueprintSuccess();
  c.recordBlueprintSuccess();
  c.recordMechanismPlanSuccess();
  c.recordGoalPlacementSuccess();
  c.recordReverseSearchSuccess();
  c.recordPuzzleValidationSuccess();
  c.recordInitialSolveSuccess();
  c.recordGatePassed();
  c.recordCurated();

  const report = c.build();
  assert.equal(report.funnel.attempted, 3);
  assert.equal(report.funnel.blueprintSucceeded, 2);
  assert.equal(report.funnel.mechanismPlanSucceeded, 1);
  assert.equal(report.funnel.goalPlacementSucceeded, 1);
  assert.equal(report.funnel.reverseSearchSucceeded, 1);
  assert.equal(report.funnel.puzzleValidationSucceeded, 1);
  assert.equal(report.funnel.initialSolveSucceeded, 1);
  assert.equal(report.funnel.gatePassed, 1);
  assert.equal(report.funnel.curated, 1);
  assert.equal(report.funnel.finalistPassed, 0);
  assert.equal(report.funnel.qualityPassed, 0);
  assert.equal(report.funnel.difficultyPassed, 0);
});

test("DiagnosticCollector tracks box scale mismatches", () => {
  const c = new DiagnosticCollector();

  c.recordBoxScale({
    requestedBoxes: 3,
    actualBoxes: 3,
    goalCount: 3,
    genericBoxes: 3,
    typedBoxes: 0,
    difference: 0,
  });

  c.recordBoxScale({
    requestedBoxes: 4,
    actualBoxes: 3,
    goalCount: 3,
    genericBoxes: 2,
    typedBoxes: 1,
    difference: -1,
  });

  c.recordBoxScale({
    requestedBoxes: 5,
    actualBoxes: 4,
    goalCount: 4,
    genericBoxes: 4,
    typedBoxes: 0,
    difference: -1,
  });

  const report = c.build();
  assert.equal(report.boxScaleIssues.length, 3);
  assert.equal(report.boxScaleMismatchCount, 2);
});

test("DiagnosticCollector builds rejection breakdown", () => {
  const c = new DiagnosticCollector();

  c.recordRejection({
    reason: "blueprint-failed",
    tier: "advanced",
    family: "linear",
    mode: "plain",
    requestedBoxCount: 3,
  });

  c.recordRejection({
    reason: "blueprint-failed",
    tier: "expert",
    family: "linear",
    mode: "plain",
    requestedBoxCount: 4,
  });

  c.recordRejection({
    reason: "gate-pushes",
    tier: "advanced",
    family: "branch",
    mode: "motif",
    requestedBoxCount: 3,
  });

  const report = c.build();
  const rb = report.rejectionBreakdown;

  assert.equal(rb.byReason["blueprint-failed"], 2);
  assert.equal(rb.byReason["gate-pushes"], 1);
  assert.equal(rb.byTier["advanced"], 2);
  assert.equal(rb.byTier["expert"], 1);
  assert.equal(rb.byFamily["linear"], 2);
  assert.equal(rb.byFamily["branch"], 1);
  assert.equal(rb.byMode["plain"], 2);
  assert.equal(rb.byMode["motif"], 1);
  assert.equal(rb.byRequestedBoxCount[3], 2);
  assert.equal(rb.byRequestedBoxCount[4], 1);
});

test("DiagnosticCollector records restart diagnostics", () => {
  const c = new DiagnosticCollector();

  c.recordRestartDiagnostics({
    restartIndex: 0,
    expanded: 500,
    maxDepth: 12,
    archiveOffers: 30,
    archiveAccepts: 10,
    transpositionHits: 50,
    firstLayerGenerated: 20,
    firstLayerRejected: 5,
  });

  c.recordRestartDiagnostics({
    restartIndex: 1,
    expanded: 100,
    maxDepth: 4,
    archiveOffers: 5,
    archiveAccepts: 1,
    transpositionHits: 200,
    firstLayerGenerated: 20,
    firstLayerRejected: 18,
  });

  const report = c.build();
  assert.equal(report.restartDiagnostics.length, 2);
  assert.equal(report.restartDiagnostics[0].expanded, 500);
  assert.equal(report.restartDiagnostics[1].expanded, 100);
  assert.equal(report.restartDiagnostics[1].transpositionHits, 200);
});

test("formatDiagnosticReport produces human-readable output", () => {
  const c = new DiagnosticCollector();
  c.recordAttempt();
  c.recordAttempt();
  c.recordBlueprintSuccess();
  c.recordGatePassed();
  c.recordCurated();
  c.recordRejection({
    reason: "blueprint-failed",
    tier: "advanced",
    family: "linear",
    mode: "plain",
    requestedBoxCount: 3,
  });
  c.recordBoxScale({
    requestedBoxes: 3,
    actualBoxes: 2,
    goalCount: 2,
    genericBoxes: 2,
    typedBoxes: 0,
    difference: -1,
  });

  const report = c.build();
  const text = formatDiagnosticReport(report);

  assert.ok(text.includes("Generator Diagnostic Report"));
  assert.ok(text.includes("attempted"));
  assert.ok(text.includes("Box scale mismatches: 1"));
  assert.ok(text.includes("blueprint-failed"));
  assert.ok(text.includes("Rejections by tier"));
});

test("empty collector produces zeroed report", () => {
  const c = new DiagnosticCollector();
  const report = c.build();

  assert.equal(report.funnel.attempted, 0);
  assert.equal(report.funnel.curated, 0);
  assert.equal(report.boxScaleIssues.length, 0);
  assert.equal(report.boxScaleMismatchCount, 0);
  assert.equal(report.restartDiagnostics.length, 0);
  assert.deepEqual(report.rejectionBreakdown.byReason, {});
});
