import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_DIR = resolve(REPO_ROOT, ".github/workflows");
const NPM_RUN_PATTERN = /\bnpm\s+(?:run|run-script)\s+([^\s"'`&|;]+)/gu;

const packageScripts = (
  JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  }
).scripts ?? {};

function npmRunTargets(text: string): string[] {
  return [...text.matchAll(NPM_RUN_PATTERN)].map((match) => match[1]);
}

describe("npm script references", () => {
  it("every npm run in .github/workflows names a script in package.json", () => {
    const workflowFiles = readdirSync(WORKFLOW_DIR).filter((name) =>
      /\.ya?ml$/u.test(name)
    );
    assert.ok(workflowFiles.length > 0, "expected at least one workflow file");

    const references: string[] = [];
    const missing: string[] = [];
    for (const name of workflowFiles) {
      const lines = readFileSync(resolve(WORKFLOW_DIR, name), "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const script of npmRunTargets(line)) {
          references.push(script);
          if (!(script in packageScripts)) {
            missing.push(`${name}:${index + 1} npm run ${script}`);
          }
        }
      });
    }

    assert.ok(references.length > 0, "expected workflows to call npm run");
    assert.deepEqual(missing, [], "workflows call npm scripts missing from package.json");
  });

  it("every npm run inside package.json scripts names an existing script", () => {
    const missing = Object.entries(packageScripts).flatMap(([name, command]) =>
      npmRunTargets(command)
        .filter((script) => !(script in packageScripts))
        .map((script) => `${name} -> npm run ${script}`)
    );
    assert.deepEqual(missing, []);
  });
});
