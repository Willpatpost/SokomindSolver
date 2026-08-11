#!/usr/bin/env node

/** Validate local Markdown links, anchors, and backticked repository paths. */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS_DIR = join(ROOT, "docs");
const CI_MODE = process.argv.includes("--ci");
const PATH_RE = /`((?:src|tests|scripts|docs)\/[\w./@+-]+\.[A-Za-z0-9]+)`/gu;
const LINK_RE = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^)]*["'])?\)/gu;

async function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
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
  const rootFiles = (await readdir(ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.md$/iu.test(entry.name))
    .map((entry) => join(ROOT, entry.name));
  const mdFiles = [...rootFiles, ...await collectMarkdownFiles(DOCS_DIR)].sort();
  const headingCache = new Map();
  const allIssues = [];
  for (const file of mdFiles) {
    allIssues.push(...await validateFile(file, headingCache));
  }

  if (allIssues.length === 0) {
    console.log(`Checked ${mdFiles.length} Markdown files — all local links, anchors, and paths resolve.`);
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
