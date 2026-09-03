import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { ForgeWorkerPool } from "../../src/features/generator/v2/forge-pool.ts";

const fixture = new URL("../fixtures/forge-pool.worker.mjs", import.meta.url);
test("pool reuses workers, bounds its queue, preserves task order, and joins every worker", async () => {
  const pool = new ForgeWorkerPool(fixture, undefined, 2);
  try {
    const run = () => pool.map(Array.from({ length: 12 }, (_, value) => value), (value) =>
      pool.submit<{ value: number; threadId: number }>({ value, delay: value % 2 ? 1 : 12 }, "fixture"));
    const first = await run(), second = await run();
    assert.deepEqual(first.map((r) => r.value), Array.from({ length: 12 }, (_, i) => i));
    assert.deepEqual(new Set(first.map((r) => r.threadId)), new Set(second.map((r) => r.threadId)));
    assert.equal(pool.snapshot().peakActive, 2);
    assert.ok(pool.snapshot().peakQueued <= pool.maxQueued);
    assert.equal(pool.snapshot().completed, 24);
  } finally { await pool.close(); }
  assert.equal(pool.snapshot().workers, 0);
  await assert.rejects(pool.submit({}), /closed/);
});

for (const mode of ["exit", "throw", "bad-index"]) test(`pool fails and cleans up after ${mode}`, async () => {
  const pool = new ForgeWorkerPool(fixture, undefined, 2);
  try {
    await assert.rejects(pool.map([mode, "normal"], (current) => pool.submit({ mode: current, delay: 50 })),
      /exited unexpectedly|fixture failure|Invalid forge/);
  } finally { await pool.close(); }
  assert.equal(pool.snapshot().workers, 0);
});

test("pool cancellation terminates active and queued tasks", async () => {
  const abort = new AbortController();
  const pool = new ForgeWorkerPool(fixture, undefined, 2, abort.signal);
  const running = pool.map([1, 2, 3, 4], (value) => pool.submit({ value, delay: 5000 }));
  const timer = setTimeout(() => abort.abort(), 20);
  try { await assert.rejects(running, /cancelled/); }
  finally { clearTimeout(timer); await pool.close(); }
  assert.equal(pool.snapshot().workers, 0);
});

test("a single worker exiting without a response rejects its own outstanding task", async () => {
  const pool = new ForgeWorkerPool(fixture, undefined, 1);
  try { await assert.rejects(pool.submit({ mode: "exit" }), /exited unexpectedly/); }
  finally { await pool.close(); }
});

test("one-shot pool lets a real Node process exit after its final result", async () => {
  const source = `import {runWorkerPool} from ${JSON.stringify(new URL("../../src/features/generator/v2/forge-pool.ts", import.meta.url).href)};
    const result=await runWorkerPool(new URL(${JSON.stringify(fixture.href)}),[{value:1},{value:2}],undefined,2);
    console.log(result.length);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source]);
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += String(data); });
  child.stderr.on("data", (data) => { stderr += String(data); });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    assert.equal(code, 0, stderr || "Child did not exit naturally; possible worker leak");
    assert.equal(stdout.trim(), "2");
  } finally { clearTimeout(timer); }
});
