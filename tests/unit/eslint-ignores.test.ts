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

  it("lints the engine sources and checks their shared scope on the bundle", async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const rules = async (code: string, filePath: string) => {
      const [result] = await eslint.lintText(code, { filePath });
      return result.messages.map((message) => message.ruleId).sort();
    };

    // A source file may use names declared in another source file.
    const source = "src/solver/implementations/sokomind-engine/source/probe.js";
    assert.deepEqual(await rules("function probe(a) { return a == 1 ? cellId(a) : null; }\n", source), ["eqeqeq"]);

    const bundle = "src/solver/implementations/sokomind-engine/engine.generated.js";
    assert.deepEqual(
      await rules(
        "const SokomindProbe = {};\nfunction probe() { return missing; }\nfunction unused() {}\nexport { probe };\n",
        bundle,
      ),
      ["no-undef", "no-unused-vars"],
    );
    // The bundle is a module, so a name declared in two source files does not parse.
    const [duplicate] = await eslint.lintText("function probe() {}\nfunction probe() {}\nexport { probe };\n", {
      filePath: bundle,
    });
    assert.equal(duplicate.messages[0]?.fatal, true);
  });
});
