import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

interface BehaviorEntry {
  readonly route: string;
  readonly behavior: string;
  readonly testFile: string;
  readonly testName: string;
}

const root = resolve(import.meta.dirname, "../..");
const matrix = JSON.parse(readFileSync(
  resolve(root, "tests/critical-route-behaviors.json"),
  "utf8",
)) as BehaviorEntry[];

function declaredTestNames(fileName: string, sourceText: string): ReadonlySet<string> {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const isExecutableTest =
        (ts.isIdentifier(callee) && (callee.text === "test" || callee.text === "it")) ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          (callee.expression.text === "test" || callee.expression.text === "it") &&
          callee.name.text === "only");
      const name = node.arguments[0];
      if (
        isExecutableTest &&
        (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
      ) {
        names.add(name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

test("route-matrix discovery rejects skipped, todo, and suite-only declarations", () => {
  const names = declaredTestNames("fixture.ts", `
    test("direct", () => {});
    it.only("focused", () => {});
    test.skip("skipped", () => {});
    test.todo("todo");
    test.describe("suite", () => {});
    test.beforeEach("hook", () => {});
  `);
  assert.deepEqual([...names], ["direct", "focused"]);
});

test("critical route behavior matrix references executable regression tests", () => {
  const requiredRoutes = new Set(["home", "selector", "play", "editor", "stats"]);
  const coveredRoutes = new Set<string>();
  const identities = new Set<string>();
  for (const entry of matrix) {
    assert.ok(entry.behavior.trim());
    assert.ok(!identities.has(`${entry.testFile}\0${entry.testName}`));
    identities.add(`${entry.testFile}\0${entry.testName}`);
    const source = readFileSync(resolve(root, entry.testFile), "utf8");
    assert.ok(
      declaredTestNames(entry.testFile, source).has(entry.testName),
      `${entry.testFile} no longer declares test "${entry.testName}"`,
    );
    coveredRoutes.add(entry.route);
  }
  assert.deepEqual(coveredRoutes, requiredRoutes);
});
