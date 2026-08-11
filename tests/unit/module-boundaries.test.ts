import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";

const SOURCE_ROOT = resolve(import.meta.dirname, "../../src");
const SEARCH_DIR = resolve(SOURCE_ROOT, "solver/search");
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

function sourceFiles(directory = SOURCE_ROOT): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) && !path.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

function importSpecifiers(filename: string): string[] {
  const source = ts.createSourceFile(
    filename,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports: string[] = [];
  const addLiteral = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) imports.push(node.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      addLiteral(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addLiteral(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function resolveSourceImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/src/")) {
    base = resolve(SOURCE_ROOT, specifier.slice("@/src/".length));
  } else if (specifier.startsWith(".")) {
    base = resolve(dirname(from), specifier);
  } else {
    return null;
  }
  const withoutExtension = base.replace(/\.(?:js|jsx|ts|tsx)$/u, "");
  const candidates = [
    base,
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    resolve(withoutExtension, "index.ts"),
    resolve(withoutExtension, "index.tsx"),
  ];
  return candidates.find((candidate) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  }) ?? null;
}

function layerOf(filename: string): string {
  return relative(SOURCE_ROOT, filename).split(/[\\/]/u)[0];
}

describe("AST-aware source module boundaries", () => {
  it("enforces documented layer edges for static, side-effect, and dynamic imports", () => {
    const allowed: Readonly<Record<string, ReadonlySet<string>>> = {
      core: new Set(["core"]),
      catalog: new Set(["catalog", "core"]),
      router: new Set(["router", "catalog", "core"]),
      shared: new Set(["shared", "core"]),
      solver: new Set(["solver", "core"]),
      features: new Set(["features", "shared", "router", "catalog", "solver", "core"]),
    };
    const violations: string[] = [];
    for (const filename of sourceFiles()) {
      const fromLayer = layerOf(filename);
      const allowedTargets = allowed[fromLayer];
      if (!allowedTargets) continue;
      for (const specifier of importSpecifiers(filename)) {
        const target = resolveSourceImport(filename, specifier);
        if (!target) continue;
        const targetLayer = layerOf(target);
        if (!allowedTargets.has(targetLayer)) {
          violations.push(
            `${relative(SOURCE_ROOT, filename)} -> ${specifier} (${targetLayer})`,
          );
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it("keeps feature dependency graphs acyclic", () => {
    const featureRoot = resolve(SOURCE_ROOT, "features");
    const files = sourceFiles(featureRoot);
    const fileSet = new Set(files);
    const edges = new Map(files.map((filename) => [
      filename,
      importSpecifiers(filename)
        .map((specifier) => resolveSourceImport(filename, specifier))
        .filter((target): target is string => Boolean(target && fileSet.has(target))),
    ]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];
    const cycles: string[] = [];
    const visit = (filename: string) => {
      if (visiting.has(filename)) {
        const start = path.indexOf(filename);
        cycles.push(path.slice(start).concat(filename)
          .map((part) => relative(featureRoot, part)).join(" -> "));
        return;
      }
      if (visited.has(filename)) return;
      visiting.add(filename);
      path.push(filename);
      for (const target of edges.get(filename) ?? []) visit(target);
      path.pop();
      visiting.delete(filename);
      visited.add(filename);
    };
    for (const filename of files) visit(filename);
    assert.deepEqual([...new Set(cycles)], []);
  });
});

describe("low-level solver search boundaries", () => {
  it("keeps scheduling independent from algorithms and builders independent from engine", () => {
    const engineForbidden = new Set(["./engine.ts", "./engine"]);
    for (const builder of ["pattern-database.ts", "deadlock-tables.ts"]) {
      assert.equal(
        importSpecifiers(resolve(SEARCH_DIR, builder)).some((source) => engineForbidden.has(source)),
        false,
      );
    }
    const algorithmModules = new Set([
      "./engine.ts", "./engine", "./ida-star.ts", "./ida-star",
      "./exact-move-astar.ts", "./exact-move-astar", "./heuristic.ts", "./heuristic",
      "./pattern-database.ts", "./pattern-database", "./deadlock-tables.ts", "./deadlock-tables",
      "./goal-partitioning.ts", "./goal-partitioning",
    ]);
    assert.equal(
      importSpecifiers(resolve(SEARCH_DIR, "scheduling.ts"))
        .some((source) => algorithmModules.has(source)),
      false,
    );
  });
});

describe("browser worker dependency closures", () => {
  it("contain no Node built-in imports", () => {
    const entries = [
      resolve(SOURCE_ROOT, "solver/solver.worker.ts"),
      resolve(SOURCE_ROOT, "solver/implementations/sokomind-proof-worker.ts"),
      resolve(SOURCE_ROOT, "solver/implementations/sokomind-engine/sokomind-engine.worker.ts"),
    ];
    const visited = new Set<string>();
    const nodeImports: string[] = [];
    const visit = (filename: string) => {
      if (visited.has(filename)) return;
      visited.add(filename);
      for (const specifier of importSpecifiers(filename)) {
        if (NODE_BUILTINS.has(specifier)) {
          nodeImports.push(`${relative(SOURCE_ROOT, filename)} -> ${specifier}`);
          continue;
        }
        const target = resolveSourceImport(filename, specifier);
        if (target) visit(target);
      }
    };
    for (const entry of entries) visit(entry);
    assert.deepEqual(nodeImports, []);
  });
});
