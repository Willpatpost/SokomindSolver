import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const TIMING_SCALE = Math.max(1, Number(process.env.SOKOMIND_TIMING_SCALE) || 1);

function run(script: string, args: string[], tuning?: string) {
  const env = {...process.env};
  delete env.SOKOMIND_TUNING_JSON;
  if (tuning !== undefined) env.SOKOMIND_TUNING_JSON = tuning;
  return spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
    cwd: root, env, encoding: "utf8", timeout: 30_000 * TIMING_SCALE, windowsHide: true,
  });
}

test("V2 isolates explicit control and treatment tuning and refuses invalid experiments before launch", () => {
  const args = ["--fixture=ultra-tiny", "--profile=sokomind-fast", "--runs=1", "--warmup=0"];
  const captures = [
    {label: "control", tuning: '{"firstPushWalkWeight":0}', weight: 0},
    {label: "treatment", tuning: '{"firstPushWalkWeight":0.05}', weight: 0.05},
  ].map(({label, tuning, weight}) => {
    const child = run("scripts/benchmark-solver-v2.ts", [...args, `--tuning-label=${label}`], tuning);
    assert.equal(child.status, 0, child.stderr);
    const capture = JSON.parse(child.stdout);
    assert.equal(capture.promotableBaseline, false);
    assert.equal(capture.tuningExperiment.label, label);
    assert.equal(capture.tuningExperiment.mechanismExercise, "not-assessed");
    const sample = capture.results[0].samples[0];
    assert.equal(sample.configuration.sokomindTuning.firstPushWalkWeight, weight);
    assert.equal(sample.configuration.tuningFingerprint, capture.tuningFingerprint);
    assert.match(sample.runIdentity, new RegExp(`:tuning:${label}:`));
    assert.equal(sample.verified, true);
    return capture;
  });
  assert.notEqual(captures[0].tuningFingerprint, captures[1].tuningFingerprint);
  for (const tuning of ['{"firstPushWalkWeight":0}', '{"unknown":1}', "["]) {
    const child = run("scripts/benchmark-solver-v2.ts", [...args, "--tuning-label=treatment"], tuning);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.doesNotMatch(child.stderr, /Benchmark methodology:/);
  }
});

test("schedule trace CLI obtains a replayed quality incumbent and complete repair diagnostics", () => {
  const child = run("scripts/diagnose-schedule-trace.ts", ["--fixture=ultra-tiny"]);
  assert.equal(child.status, 0, child.stderr);
  const marker = "JSON output:\n";
  const report = JSON.parse(child.stdout.slice(child.stdout.indexOf(marker) + marker.length));
  assert.equal(report.mode, "quality");
  assert.equal(report.replayVerified, true);
  assert.equal(report.incumbentMoves, 1);
  assert.equal(report.rescheduledMoves, 1);
  assert.equal(report.scheduleTrace.length, 1);
  assert.equal(report.scheduleTrace[0].original.pushCount, 1);
  assert.equal(report.scheduleTrace[0].repaired.pushCount, 1);
  assert.equal(report.boxRescheduling.originalMoves, 1);
  assert.equal(report.boxRescheduling.finalMoves, 1);
});
