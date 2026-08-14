#!/usr/bin/env node

/** Validate local Markdown links, anchors, and backticked repository paths. */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CI_MODE = process.argv.includes("--ci");
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const PATH_RE = /`((?:(?:src|tests|scripts|docs|public|\.github)\/[\w./@+-]+|(?:README\.md|package\.json|tsconfig\.json|vite\.config\.ts|playwright\.config\.ts)))`/gu;
const LINK_RE = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^)]*["'])?\)/gu;
const NPM_COMMAND_RE = /\bnpm(?:\.cmd)?\s+run\s+([\w:-]+)/gu;
const MOJIBAKE_RE = /\u00c3|\u00c2|\u00e2(?:\u0080|\u20ac)/u;
const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const packageScripts = new Set(Object.keys(packageJson.scripts ?? {}));

async function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectMarkdownFiles(path));
    else if (entry.isFile() && /\.md$/iu.test(entry.name)) files.push(path);
  }
  return files;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function markdownSlug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-");
}

async function headingsFor(file, cache) {
  if (cache.has(file)) return cache.get(file);
  const headings = new Set();
  const duplicates = new Map();
  const content = await readFile(file, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    const match = /^(?: {0,3})#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!match) continue;
    const base = markdownSlug(match[1]);
    const duplicate = duplicates.get(base) ?? 0;
    duplicates.set(base, duplicate + 1);
    headings.add(duplicate === 0 ? base : `${base}-${duplicate}`);
  }
  cache.set(file, headings);
  return headings;
}

function lineNumberAt(content, offset) {
  return content.slice(0, offset).split("\n").length;
}

async function validateFile(file, headingCache) {
  const content = await readFile(file, "utf8");
  const issues = [];
  const report = (offset, path, reason) => issues.push({
    file: relative(ROOT, file),
    line: lineNumberAt(content, offset),
    path,
    reason,
  });

  for (const match of content.matchAll(PATH_RE)) {
    const target = resolve(ROOT, match[1]);
    if (!await exists(target)) report(match.index, match[1], "path not found");
  }

  for (const match of content.matchAll(NPM_COMMAND_RE)) {
    if (!packageScripts.has(match[1])) {
      report(match.index, match[1], "npm script not found in package.json");
    }
  }

  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (MOJIBAKE_RE.test(line)) {
      issues.push({
        file: relative(ROOT, file),
        line: index + 1,
        path: line.trim().slice(0, 80),
        reason: "probable mojibake encoding",
      });
    }
  }

  for (const match of content.matchAll(LINK_RE)) {
    const raw = match[1].replace(/^<|>$/gu, "");
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(raw)) continue;
    const [encodedPath, encodedAnchor] = raw.split("#", 2);
    let linkPath;
    let anchor;
    try {
      linkPath = decodeURIComponent(encodedPath);
      anchor = encodedAnchor === undefined ? undefined : decodeURIComponent(encodedAnchor);
    } catch {
      report(match.index, raw, "invalid URL encoding");
      continue;
    }
    const target = linkPath
      ? resolve(dirname(file), linkPath.split(/[?]/u, 1)[0])
      : file;
    if (!await exists(target)) {
      report(match.index, raw, "link target not found");
      continue;
    }
    if (anchor !== undefined && anchor !== "" && /\.md$/iu.test(target)) {
      const headings = await headingsFor(target, headingCache);
      if (!headings.has(anchor.toLowerCase())) {
        report(match.index, raw, "heading anchor not found");
      }
    }
  }
  return issues;
}

async function main() {
  const mdFiles = (await collectMarkdownFiles(ROOT)).sort();
  const headingCache = new Map();
  const allIssues = [];
  for (const file of mdFiles) {
    allIssues.push(...await validateFile(file, headingCache));
  }

  if (allIssues.length === 0) {
    console.log(`Checked ${mdFiles.length} Markdown files — links, anchors, paths, npm commands, and encoding are valid.`);
    return;
  }
  console.log(`Found ${allIssues.length} documentation reference issue(s):\n`);
  for (const { file, line, path, reason } of allIssues) {
    console.log(`  ${file}:${line}  ${path} — ${reason}`);
  }
  if (CI_MODE) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
