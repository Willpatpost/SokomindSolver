import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ChildProcessTimeoutError,
  runPerformanceTestModule,
  runProcessWithHardTimeout,
} from "../support/child-process-gate.ts";

describe("child-process performance gate", () => {
  it("captures a successful child process", () => {
    const result = runProcessWithHardTimeout(
      process.execPath,
      ["-e", "process.stdout.write('ready')"],
      { timeoutMs: 2_000 },
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "ready");
    assert.equal(result.stderr, "");
  });

  it("terminates synchronous code that never yields before the deadline", () => {
    const started = performance.now();
    assert.throws(
      () =>
        runProcessWithHardTimeout(
          process.execPath,
          ["-e", "const end=Date.now()+5000;while(Date.now()<end){}"],
          { timeoutMs: 100 },
        ),
      (error: unknown) => {
        assert.ok(error instanceof ChildProcessTimeoutError);
        assert.equal(error.timeoutMs, 100);
        return true;
      },
    );
    assert.ok(
      performance.now() - started < 2_000,
      "the busy child should be forcibly terminated instead of running to completion",
    );
  });

  it("loads a node:test module directly in the killable child process", () => {
    const result = runPerformanceTestModule(
      new URL("../fixtures/performance-child-smoke.test.mjs", import.meta.url),
      2_000,
    );

    assert.match(result.stdout, /isolated-performance-child-ran/u);
    assert.match(result.stdout, /isolated-performance-child-mode=direct/u);
  });
});
