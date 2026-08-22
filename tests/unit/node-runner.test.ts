import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

const PROJECT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SOLVE_SCRIPT = join(PROJECT_ROOT, "scripts/solve-sokomind.ts");

function runSolver(
  args: string[],
  timeoutMs = 30_000,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", SOLVE_SCRIPT, ...args],
    {
      cwd: PROJECT_ROOT,
      timeout: timeoutMs,
      encoding: "utf-8",
      env: { ...process.env, SOKOMIND_TIMING_SCALE: "2" },
    },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// JSONL output format
// ---------------------------------------------------------------------------

describe("solve-sokomind CLI JSONL output", () => {
  it("outputs valid JSON for a simple puzzle", () => {
    const { stdout, status } = runSolver(["--puzzle=beginner-three"]);
    assert.equal(status, 0);

    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 1, "exactly one JSONL line");

    const record = JSON.parse(lines[0]);
    assert.equal(record.schemaVersion, 3);
    assert.equal(record.puzzleId, "beginner-three");
    assert.ok(Array.isArray(record.rows));
    assert.ok(record.rows.length > 0);
  });

  it("includes all required output fields", () => {
    const { stdout, status } = runSolver(["--puzzle=beginner-three"]);
    assert.equal(status, 0);

    const record = JSON.parse(stdout.trim());
    const requiredFields = [
      "schemaVersion",
      "puzzleId",
      "rows",
      "solution",
      "verified",
      "verificationDetail",
      "lowerBound",
      "upperBound",
      "gap",
      "proofStatus",
      "proofAlgorithm",
      "expandedStates",
      "generatedStates",
      "peakFrontierSize",
      "counters",
      "perLaneCounters",
      "memory",
      "elapsedMs",
      "configuration",
    ];

    for (const field of requiredFields) {
      assert.ok(
        field in record,
        `missing required field: ${field}`,
      );
    }

    // Configuration sub-fields
    const configFields = [
      "mode",
      "parallelism",
      "deterministic",
      "proofAlgorithm",
      "solverVersion",
      "gitCommit",
      "tuningFingerprint",
    ];

    for (const field of configFields) {
      assert.ok(
        field in record.configuration,
        `missing configuration field: ${field}`,
      );
    }
  });

  it("solution is verified for solved puzzles", () => {
    const { stdout, status } = runSolver(["--puzzle=beginner-three"]);
    assert.equal(status, 0);

    const record = JSON.parse(stdout.trim());
    assert.equal(record.verified, true);
    assert.ok(record.solution !== null);
    assert.ok(record.solution.moves > 0);
    assert.ok(record.solution.pushes > 0);
    assert.ok(Array.isArray(record.solution.steps));
  });

  it("solverVersion matches metadata", () => {
    const { stdout, status } = runSolver(["--puzzle=beginner-three"]);
    assert.equal(status, 0);

    const record = JSON.parse(stdout.trim());
    assert.equal(record.configuration.solverVersion, "1.1.0");
  });

  it("mode reflects CLI argument", () => {
    const { stdout, status } = runSolver([
      "--puzzle=beginner-three",
      "--mode=fast",
    ]);
    assert.equal(status, 0);

    const record = JSON.parse(stdout.trim());
    assert.equal(record.configuration.mode, "fast");
  });

  it("respects --timeout-ms", () => {
    const { stdout, status } = runSolver([
      "--puzzle=beginner-three",
      "--timeout-ms=30000",
    ]);
    assert.equal(status, 0);

    const record = JSON.parse(stdout.trim());
    assert.ok(record.elapsedMs < 30000);
  });
});

describe("Node engine worker progress bridge", () => {
  it("relays classic-engine progress before the final result", async () => {
    const workerPath = join(
      PROJECT_ROOT,
      "src/solver/implementations/sokomind-engine.node-worker.ts",
    );
    const worker = new Worker(workerPath, {
      execArgv: ["--experimental-strip-types"],
    });
    const messages: Array<Record<string, unknown>> = [];
    try {
      const result = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Node engine worker timed out")),
            10_000,
          );
          worker.on("message", (value: unknown) => {
            const message = value as Record<string, unknown>;
            messages.push(message);
            if (message.type !== "done") return;
            clearTimeout(timer);
            resolve(message);
          });
          worker.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          worker.postMessage({
            mode: "search",
            payload: {
              algorithm: "plan-macro-beam",
              planCanonicalOrientation: false,
              state: {
                rows: [
                  "OOOOOOOOO",
                  "O R     O",
                  "O X X X O",
                  "O S S S O",
                  "O       O",
                  "OOOOOOOOO",
                ],
                robot: [1, 2],
                boxes: [["2,2", "X"], ["2,4", "X"], ["2,6", "X"]],
              },
              maxDepth: 20,
              maxVisited: 1_000,
              maxGenerated: 4_000,
              planBeamWidth: 32,
              maxPlanSegments: 12,
            },
          });
        },
      );

      assert.equal(result.status, "solved");
      assert.ok(messages.some(({ type }) => type === "progress"));
      assert.notEqual(result.error, "postMessage is not defined");
    } finally {
      await worker.terminate();
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("solve-sokomind CLI error handling", () => {
  it("exits with code 1 for unknown puzzle", () => {
    const { status, stderr } = runSolver(["--puzzle=nonexistent-puzzle-xyz"]);
    assert.equal(status, 1);
    assert.ok(stderr.includes("Unknown puzzle"));
  });

  it("exits with code 1 when no puzzle specified and no stdin", () => {
    const { status, stderr } = runSolver([]);
    assert.ok(status !== 0);
    assert.ok(
      stderr.includes("No puzzle specified") || stderr.includes("--puzzle"),
    );
  });
});
