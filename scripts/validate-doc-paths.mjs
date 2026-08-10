#!/usr/bin/env node

/**
 * Scans Markdown documentation for backticked source-path references
 * (e.g. `src/solver/foo.ts`) and checks that each referenced file exists.
 *
 * Usage:
 *   node scripts/validate-doc-paths.mjs          # reports stale paths
 *   node scripts/validate-doc-paths.mjs --ci      # exits 1 if any stale
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS_DIR = join(ROOT, "docs");
const CI_MODE = process.argv.includes("--ci");

// Match backticked strings that look like relative file paths.
// Captures paths starting with src/, tests/, scripts/, or docs/ and
// containing at least one file extension (.ts, .tsx, .js, .mjs, .json, .md, etc.).
const PATH_RE = /`((?:src|tests|scripts|docs)\/[^`\s]+?\.\w+)`/g;

// Paths known to be examples or patterns, not real files.
const IGNORE = new Set([
  // Placeholder examples in docs
]);

async function collectMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

async function fileExists(path) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function validateFile(filePath) {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const issues = [];

  for (let i = 0; i < lines.length; i++) {
    let match;
    PATH_RE.lastIndex = 0;
    while ((match = PATH_RE.exec(lines[i])) !== null) {
      const refPath = match[1];
      if (IGNORE.has(refPath)) continue;
      const absPath = join(ROOT, refPath);
      if (!(await fileExists(absPath))) {
        issues.push({
          file: filePath.replace(ROOT + "/", ""),
          line: i + 1,
          path: refPath,
        });
      }
    }
  }
  return issues;
}

async function main() {
  const mdFiles = await collectMarkdownFiles(DOCS_DIR);
  const allIssues = [];

  for (const file of mdFiles.sort()) {
    const issues = await validateFile(file);
    allIssues.push(...issues);
  }

  if (allIssues.length === 0) {
    console.log(`Checked ${mdFiles.length} docs — all referenced paths exist.`);
    process.exit(0);
  }

  console.log(`Found ${allIssues.length} stale path reference(s):\n`);
  for (const { file, line, path } of allIssues) {
    console.log(`  ${file}:${line}  \`${path}\` not found`);
  }
  console.log();

  if (CI_MODE) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
