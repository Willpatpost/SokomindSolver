import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const E2E_DIR = resolve(REPO_ROOT, "tests/e2e");
const WAIT_FOR_TIMEOUT_PATTERN = /\bwaitForTimeout\(\s*([^)]*?)\s*\)/gu;

// Fixed sleeps that cannot be replaced by page.clock or a web-first assertion,
// keyed as "<spec file> waitForTimeout(<argument>)".
const REAL_TIME_WAITS = new Set([
  // A late solver result arrives as a worker message, not on a page timer.
  "solver-lab.spec.ts waitForTimeout(250)",
]);

describe("browser test hygiene", () => {
  it("CI fails runs where a test only passes on retry", () => {
    const config = readFileSync(resolve(REPO_ROOT, "playwright.config.ts"), "utf8");
    assert.match(config, /^\s*failOnFlakyTests:\s*Boolean\(process\.env\.CI\),$/mu);
  });

  it("browser specs use no fixed sleeps outside the allowlist", () => {
    const specFiles = readdirSync(E2E_DIR).filter((name) => name.endsWith(".spec.ts"));
    assert.ok(specFiles.length > 0, "expected browser spec files");

    const found = new Set<string>();
    const unexpected: string[] = [];
    for (const name of specFiles) {
      const lines = readFileSync(resolve(E2E_DIR, name), "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const [, argument] of line.matchAll(WAIT_FOR_TIMEOUT_PATTERN)) {
          // A zero-delay wait only yields to the page's task queue.
          if (Number(argument.replaceAll("_", "")) === 0) continue;
          const key = `${name} waitForTimeout(${argument})`;
          found.add(key);
          if (!REAL_TIME_WAITS.has(key)) {
            unexpected.push(`${name}:${index + 1} waitForTimeout(${argument})`);
          }
        }
      });
    }

    assert.deepEqual(
      unexpected,
      [],
      "use page.clock or a web-first assertion instead of a fixed sleep",
    );
    const stale = [...REAL_TIME_WAITS].filter((key) => !found.has(key));
    assert.deepEqual(stale, [], "remove allowlist entries that no longer match a spec");
  });
});
