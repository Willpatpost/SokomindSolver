import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import { ESLint } from "eslint";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

describe("eslint ignores", () => {
  it("skips gitignored scratch and report directories but not sources", async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    for (const path of [
      "tmp/probe.ts",
      "test-results/probe.ts",
      "playwright-report/probe.js",
      "review-catalog/probe.ts",
      "results/probe.ts",
    ]) {
      assert.equal(await eslint.isPathIgnored(path), true, path);
    }
    for (const path of ["src/App.tsx", "tests/unit/eslint-ignores.test.ts", "scripts/lib/catalog-promotion.ts"]) {
      assert.equal(await eslint.isPathIgnored(path), false, path);
    }
  });
});
