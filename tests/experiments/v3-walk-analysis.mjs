/**
 * Analyze walk structure of a saved solution path.
 * Shows where the biggest walk overheads are and which push sequences
 * have the most room for improvement.
 *
 * Usage: node --experimental-strip-types tests/experiments/v3-walk-analysis.mjs [path-file]
 * Default path file: /tmp/v3-baseline-path.json
 */
import { readFileSync } from "node:fs";
import { PUZZLE_BY_ID } from "../../src/catalog/puzzles.ts";
import { createSession } from "../../src/core/index.ts";
import { solutionFromLegacyPath, toLegacyState } from "../../src/solver/implementations/sokomind-solver.ts";
import { verifySolverSolution } from "../../src/solver/verification.ts";

globalThis.postMessage = () => {};

const pathFile = process.argv[2] || "/tmp/v3-baseline-path.json";
console.log(`Loading path from: ${pathFile}`);

const huge = PUZZLE_BY_ID.huge;
const session = createSession(huge);
const request = {
  board: session.board,
  snapshot: session.snapshot,
  objective: { kind: "moves" },
};

const path = JSON.parse(readFileSync(pathFile, "utf-8"));
const sol = solutionFromLegacyPath(request, path);
const valid = verifySolverSolution(request, sol).valid;
console.log(`Solution: m=${sol.moves} p=${sol.pushes} w=${sol.moves - sol.pushes} | valid=${valid}`);

// Analyze walk segments between pushes
const pushDirs = ["u", "d", "l", "r"];
const segments = [];
let walkCount = 0;
let segStart = 0;

for (let i = 0; i < path.length; i++) {
  if (pushDirs.includes(path[i])) {
    segments.push({
      pushIndex: segments.length,
      moveIndex: i,
      walksBefore: walkCount,
      direction: path[i],
    });
    walkCount = 0;
    segStart = i + 1;
  } else {
    walkCount++;
  }
}

console.log(`\nTotal pushes: ${segments.length}`);
console.log(`Total walks: ${sol.moves - sol.pushes}`);
console.log(`Avg walks/push: ${((sol.moves - sol.pushes) / segments.length).toFixed(2)}`);

// Walk distribution
const walkHisto = {};
for (const seg of segments) {
  const bucket = seg.walksBefore;
  walkHisto[bucket] = (walkHisto[bucket] || 0) + 1;
}
console.log("\n=== Walk Distribution (walks before each push) ===");
const buckets = Object.keys(walkHisto).map(Number).sort((a, b) => a - b);
for (const b of buckets) {
  console.log(`  ${String(b).padStart(3)} walks: ${walkHisto[b]} pushes`);
}

// Top 20 highest-overhead windows (size 8, 16, 32)
for (const windowSize of [4, 8, 16, 32]) {
  console.log(`\n=== Top 10 windows of ${windowSize} pushes (by walk overhead) ===`);
  const windows = [];
  for (let i = 0; i + windowSize <= segments.length; i++) {
    const start = segments[i];
    const end = i + windowSize < segments.length
      ? segments[i + windowSize]
      : { moveIndex: path.length };
    const totalMoves = end.moveIndex - start.moveIndex + start.walksBefore;
    const totalWalks = totalMoves - windowSize;
    const overhead = totalWalks;
    const avgWalk = totalWalks / windowSize;
    windows.push({ startPush: i, totalMoves: end.moveIndex - start.moveIndex, walks: totalWalks, avgWalk });
  }
  windows.sort((a, b) => b.walks - a.walks);
  for (const w of windows.slice(0, 10)) {
    console.log(`  push ${String(w.startPush).padStart(3)}-${String(w.startPush + windowSize).padStart(3)}: ${w.totalMoves} moves (${w.walks} walks, avg ${w.avgWalk.toFixed(1)}/push)`);
  }
}

// Overall walk overhead by solution thirds
const third = Math.ceil(segments.length / 3);
for (let t = 0; t < 3; t++) {
  const start = t * third;
  const end = Math.min((t + 1) * third, segments.length);
  const startIdx = segments[start].moveIndex - segments[start].walksBefore;
  const endIdx = end < segments.length ? segments[end].moveIndex - segments[end].walksBefore : path.length;
  let walks = 0;
  for (let i = start; i < end; i++) {
    walks += segments[i].walksBefore;
  }
  const pushes = end - start;
  console.log(`\nThird ${t + 1} (pushes ${start}-${end}): ${pushes} pushes, ${walks} walks, avg ${(walks / pushes).toFixed(2)}/push`);
}
