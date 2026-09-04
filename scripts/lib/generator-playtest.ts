import { createHash } from "node:crypto";
import type { ReviewCatalog, ReviewCandidatePack } from "../../src/features/generator/v2/catalog-manifest-types.ts";
import { encodePuzzleUrl, decodeCustomPuzzle } from "../../src/features/editor/editor-serialization.ts";
import { checkReleaseGate, DEFAULT_RELEASE_GATE_CONFIG, type ReleaseGateConfig } from "../../src/features/generator/v2/release-gate.ts";
import { storyDiversityLimits, STRICT_STORY_DIVERSITY_POLICY } from "../../src/features/generator/v2/story-diversity.ts";
import { buildCanonicalSolutionTrace } from "../../src/features/generator/v2/solution-trace.ts";
import { analyzePassiveSolutionStory } from "../../src/features/generator/v2/passive-story-analysis.ts";
import { assessStoryQuality } from "../../src/features/generator/v2/story-quality-policy.ts";

export interface HumanPuzzleReview {
  id: string;
  boardHash: string;
  decision: "pending" | "approve" | "reject";
  enjoyable: boolean | null;
  excessiveWalking: boolean | null;
  shortcutFound: boolean | null;
  tierFit: "unreviewed" | "easier" | "appropriate" | "harder";
  notes: string;
}
export interface HumanGeneratorReview {
  schemaVersion: 1;
  reviewSha256: string;
  reviewer: string;
  reviewedAt: string | null;
  puzzles: HumanPuzzleReview[];
}
const packs = (catalog: ReviewCatalog): ReviewCandidatePack[] => Object.values(catalog.tierSummaries).flatMap(t => t.candidates);
export const reviewDigest = (text: string): string => createHash("sha256").update(text).digest("hex");
export function emptyHumanReview(catalog: ReviewCatalog, text: string): HumanGeneratorReview {
  return { schemaVersion: 1, reviewSha256: reviewDigest(text), reviewer: "", reviewedAt: null,
    puzzles: packs(catalog).map(p => ({ id: p.id, boardHash: p.boardHash, decision: "pending",
      enjoyable: null, excessiveWalking: null, shortcutFound: null, tierFit: "unreviewed", notes: "" })) };
}
const puzzleFor = (p: ReviewCandidatePack) => ({ id: p.id, title: `${p.difficulty} ${p.seed}`,
  difficulty: p.difficulty, boxes: p.boxCount, rows: p.rows ?? [] });

/** This gate only reports readiness. It cannot approve puzzles or promote files. */
export function checkHumanGeneratorReview(catalogText: string, input: unknown, releaseConfig?: ReleaseGateConfig): { ready: boolean; errors: string[] } {
  const catalog = JSON.parse(catalogText) as ReviewCatalog;
  const verdict = checkReleaseGate(catalog, releaseConfig);
  const errors = [...verdict.errors];
  if (!verdict.passed) return { ready: false, errors };
  const r = input as HumanGeneratorReview | null;
  if (!r || r.schemaVersion !== 1 || r.reviewSha256 !== reviewDigest(catalogText) || !Array.isArray(r.puzzles)) {
    return { ready: false, errors: [...errors, "Human review is missing, malformed, or bound to a different catalog."] };
  }
  if (typeof r.reviewer !== "string" || !r.reviewer.trim() || !r.reviewedAt || !Number.isFinite(Date.parse(r.reviewedAt))) {
    errors.push("A named reviewer and review date are required.");
  }
  const requiredTiers = Object.entries(
    (releaseConfig ?? DEFAULT_RELEASE_GATE_CONFIG).tierQuotas,
  ).filter(([, quota]) => (quota?.target ?? 0) > 0).map(([tier]) => tier);
  for (const tier of requiredTiers) {
    const t = catalog.tierSummaries[tier];
    if (!t || t.target < 1 || t.actual < t.target) { errors.push(`${tier}: target is not filled.`); continue; }
    const limits = storyDiversityLimits(t.target, STRICT_STORY_DIVERSITY_POLICY);
    if (Object.values(t.storyDiversity?.storyCounts ?? {}).some(n => n > limits.storyLimit) ||
      Object.values(t.storyDiversity?.visualCounts ?? {}).some(n => n > limits.visualLimit)) errors.push(`${tier}: strict diversity limits exceeded.`);
  }
  const all = packs(catalog);
  if (r.puzzles.length !== all.length || new Set(r.puzzles.map(p => p?.id)).size !== all.length) errors.push("Human review must cover each selected puzzle exactly once.");
  for (const p of all) {
    const human = r.puzzles.find(h => h?.id === p.id);
    if (!human || human.boardHash !== p.boardHash || human.decision !== "approve" || human.enjoyable !== true ||
      human.excessiveWalking !== false || human.shortcutFound !== false || human.tierFit !== "appropriate" || typeof human.notes !== "string") {
      errors.push(`${p.id}: playtesting is incomplete or requires revision.`);
    }
    const grid = (p.rows ?? []).map(row => [...row]);
    let replay: ReturnType<typeof buildCanonicalSolutionTrace>;
    try {
      replay = buildCanonicalSolutionTrace(grid, p.solutionSteps ?? [], { requireSolved: true });
    } catch {
      errors.push(`${p.id}: fresh replay failed.`);
      continue;
    }
    if (!replay.ok) { errors.push(`${p.id}: fresh replay failed.`); continue; }
    const story = analyzePassiveSolutionStory(grid, replay.trace);
    const quality = assessStoryQuality({ puzzle: puzzleFor(p), trace: replay.trace, passiveStory: story,
      construction: p.mechanismConstructionPlan, constructionRequired: p.mode === "mechanism", typing: p.storyAwareTypingPlan });
    if (!quality.passed || JSON.stringify(quality.measurements) !== JSON.stringify(p.storyQuality?.measurements)) errors.push(`${p.id}: fresh story verification failed.`);
  }
  return { ready: errors.length === 0, errors };
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/gu, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
export function renderGeneratorPlaytest(catalog: ReviewCatalog, review: HumanGeneratorReview, appUrl: string): string {
  const base = new URL(appUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("--app-url must be an HTTP(S) app URL without credentials");
  base.hash = "";
  const options = (values: string[]) => values.map(v => `<option>${v}</option>`).join("");
  const cards = packs(catalog).map((p, i) => {
    const puzzle = puzzleFor(p), hash = encodePuzzleUrl(puzzle);
    if (!decodeCustomPuzzle(hash)) throw new Error(`Puzzle cannot round-trip through the editor: ${p.id}`);
    return `<article data-index="${i}"><h2>${escapeHtml(p.difficulty)} · seed ${p.seed}</h2>
<p>${p.boxCount} boxes · ${escapeHtml(p.family)} · ${escapeHtml(p.mode)}</p>
<a href="${escapeHtml(base.href + hash)}" target="_blank" rel="noopener">Open puzzle in app</a>
<details><summary>Board preview</summary><pre>${escapeHtml(p.rows!.join("\n"))}</pre></details>
<label>Decision <select data-field="decision">${options(["pending", "approve", "reject"])}</select></label>
<label>Enjoyable? <select data-field="enjoyable">${options(["unreviewed", "yes", "no"])}</select></label>
<label>Excessive walking? <select data-field="excessiveWalking">${options(["unreviewed", "yes", "no"])}</select></label>
<label>Unintended shortcut? <select data-field="shortcutFound">${options(["unreviewed", "yes", "no"])}</select></label>
<label>Tier fit <select data-field="tierFit">${options(["unreviewed", "easier", "appropriate", "harder"])}</select></label>
<label>Notes <textarea data-field="notes" rows="3"></textarea></label></article>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Generator playtest review</title><style>body{max-width:1000px;margin:32px auto;padding:0 20px;background:#111925;color:#edf2f9;font:16px system-ui;line-height:1.5}a{color:#82d4c9}article{border:1px solid #405167;border-radius:12px;padding:24px;margin:24px 0}label{display:block;margin:12px 0}input,select,textarea,button{font:inherit;padding:8px;border-radius:5px}textarea{display:block;width:90%}pre{overflow:auto}button{cursor:pointer}header{border-bottom:1px solid #405167;padding-bottom:24px}</style>
<header><h1>Generator playtest review</h1><p>Local review only. Nothing here publishes or changes the production catalog.</p>
<p>Start the app with <code>npm.cmd run dev -- --port 5173</code>. Open a puzzle, then choose Play shared puzzle. Your saved editor draft stays unchanged. Try solving before inspecting its saved witness. Check whether the intended interactions are understandable and whether another route bypasses them.</p>
<p>Export feedback before closing or reloading; this page does not save it automatically. A shortfall or a rejected puzzle blocks readiness.</p>
<label>Reviewer <input id="reviewer" autocomplete="name"></label><button id="export" type="button">Export feedback JSON</button><p id="status" role="status"></p></header>${cards}
<script>const review=${JSON.stringify(review).replace(/</gu, "\\u003c")};
document.getElementById('export').addEventListener('click',()=>{
review.reviewer=document.getElementById('reviewer').value.trim();review.reviewedAt=new Date().toISOString();
document.querySelectorAll('article').forEach(card=>{const p=review.puzzles[Number(card.dataset.index)];card.querySelectorAll('[data-field]').forEach(el=>{const key=el.dataset.field;p[key]=['enjoyable','excessiveWalking','shortcutFound'].includes(key)?(el.value==='unreviewed'?null:el.value==='yes'):el.value;});});
const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([JSON.stringify(review,null,2)+'\\n'],{type:'application/json'}));link.download='human-review.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);document.getElementById('status').textContent='Feedback exported. No catalog was promoted.';
});</script></html>`;
}
