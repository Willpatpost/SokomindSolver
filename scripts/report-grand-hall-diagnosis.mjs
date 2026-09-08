import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {PUZZLE_BY_ID} from "../src/catalog/puzzles.ts";
import {createSession, stepSnapshot} from "../src/core/index.ts";
import {solutionFromLegacyPath} from "../src/solver/implementations/sokomind-solver.ts";
import {verifySolverSolution} from "../src/solver/verification.ts";
const diagnosis = JSON.parse(readFileSync("docs/benchmarks/grand-hall-route-diagnosis.json", "utf8"));
const probes = JSON.parse(readFileSync("docs/benchmarks/grand-hall-decision-probes.json", "utf8"));
assert.equal(diagnosis.engineSha256, probes.engineSha256);
const session = createSession(PUZZLE_BY_ID.huge);
const request = {board: session.board, snapshot: session.snapshot, objective: {kind: "moves"}};
const names = {U: "Up", D: "Down", L: "Left", R: "Right"};
const identity = snapshot => JSON.stringify([snapshot.robot,
  snapshot.boxes.map(b => [b.label,b.position.row,b.position.column]).sort()]);
function replay(snapshot, codes) {
  for (const code of codes) {
    const transition = stepSnapshot(request.board, snapshot, names[code].toLowerCase());
    assert.ok(transition.moved); snapshot = transition.snapshot;
  }
  return snapshot;
}
const production = diagnosis.routes.find(r => r.name === "discovery");
const matched = new Map(); let snapshot = request.snapshot;
matched.set(identity(snapshot), 0);
for (let i = 0; i < production.actionLog.length; i++) {
  snapshot = replay(snapshot, production.actionLog[i]);
  matched.set(identity(snapshot), i + 1);
}
const controls = probes.results.map(sample => {
  const prefix = sample.prefixActionLog + sample.decisionActionLog;
  const snapshot = replay(request.snapshot, prefix), offset = matched.get(identity(snapshot));
  let knownMoves;
  if (offset !== undefined) {
    const codes = prefix + production.actionLog.slice(offset);
    const solution = solutionFromLegacyPath(request, [...codes].map(code => names[code]));
    assert.ok(solution && verifySolverSolution(request, solution).valid); knownMoves = solution.moves;
  }
  return {...sample, knownMoves};
});
const table = controls.map(s => `| ${s.beforeProductionPush} | ${s.decision} | ${s.totalMoves ?? s.status} | ${s.knownMoves ?? "—"} |`).join("\n");
writeFileSync("docs/benchmarks/grand-hall-diagnosis.md", `# Grand Hall: diagnosis before further solver changes

## Findings

All three baseline routes were freshly generated or loaded and independently
replayed. Discovery is 893 moves / 278 pushes / 615 walking; rewrite is
789 / 270 / 519; the supplied reference is 626 / 248 / 378. These are isolated
production regression-kernel results, not new browser portfolio measurements.

The 267-move discovery gap decomposes exactly into 30 pushes and 237 walks.
The rewrite gap is 163 moves: 22 pushes and 141 walks. Production and rewrite
already take shortest keeper paths between their fixed pushes. Their walking
gap therefore needs different box positions, push directions, or task ordering;
optimizing keeper pathfinding alone cannot remove it.

The reference contains two unnecessary walking moves. Its shortest-walk
realization replays in **624 moves / 248 pushes**, preserving its push sequence.
That is a better offline witness, not a new solver-discovered result. Neither
624 nor 626 is proven optimal. The original fixture remains unchanged.

## Ranked divergence hypotheses

1. **Premature H commitment and subsequent transport.** Discovery fills H at
   push 44 (move 198), un-fills it at push 204 (move 689), and fills it again at
   push 269 (move 864). H takes 46 pushes; reference H takes 14. The reference
   leaves H untouched until push 205, stages it at (5,5), transports G at pushes
   232–245, and commits H last. Discovery moves H away to (9,8), transports G at
   pushes 246–263, then returns H. These are measured events. The hypothesis is
   that anticipating G's transit and choosing a cheaper staging lifetime avoids
   much of this transport. We have NOT shown a 32-push saving from changing H
   alone in the production state: other boxes and keeper access also differ.
2. **Keeper positioning across tasks.** Walking attributed to H is 95 versus
   15, A 51 versus 25, C 63 versus 34, G 42 versus 22, and generic X 300 versus
   226. Attribution is to the next pushed label, not causal blame. Compare
   whole transport/staging episodes with their entry and exit keeper positions,
   rather than adding another small penalty to local push distance.
3. **Overvaluing fewer pushes or fewer temporary placements.** The reference
   spends 12 more pushes on B and 6 more on D, yet is much shorter overall.
   It un-fills four goals, versus one in discovery and two in rewrite. Rewrite
   uses 50 contiguous box runs versus discovery's 38 and still saves 104 moves.
   A blanket penalty on pushes, unfilled goals, or switching boxes can prefer
   the worse route. This evidence challenges those surrogate objectives; it
   does not identify their appropriate replacement weights.

H accounts for 32 more pushes and 80 more attributed walks (112 moves) in
discovery. That is a disjoint accounting subtotal, NOT an independently
recoverable saving. Other labels offset some push differences. Static
articulation-gate crossing counts are 58 in every route, so that coarse count
alone also fails to explain the gap. Coordinate pairs here are zero-based.

## Same-state decision probes

Checkpoints are taken immediately after production pushes 6 and 43. Each trial
starts from the same board and keeper position within its checkpoint group.
The legal H pushes are enumerated from that board; no reference suffix or goal
ordering is supplied to search. Independent continuations use the recorded
production search settings with maxVisited=6000 and a 30-second cooperative
search allowance. Prefix and forced-choice moves count in the reported total.
These are single-run diagnostic trials, without rewrite.

| Before production push | Trial | Independently generated total moves or cutoff | Replay-verified saved-production completion |
| --- | --- | ---: | ---: |
${table}

The rightmost column is a separate witness, never fed into these searches. It
is included only where replay proves the trial endpoint matches a production
state, including keeper position and interchangeable-box occupancy. Several
unconstrained or production-choice restarts cut off despite that known witness.
The two solved alternatives cost 1190 and 956 moves. Neither improves 893.

**No tested one-push intervention establishes a quality improvement.** A restart
discards search history and may change root analysis, canonical box order, and
beam selection. Which of those causes the failures is not yet isolated. These
cutoffs are not evidence of infeasibility or proof against delayed commitment.

## Next actionable experiment

Calibrate the continuation evaluator on these known-solvable checkpoints before
using it to rank strategies. Compare fresh restart with the established
checkpoint/root-context path under matched work budgets, retaining known suffixes
solely as solvability witnesses. Record what context changes behavior. Then test
the full H staging/G transit/H commitment episode from a common checkpoint,
including clearance and keeper entry/exit cost, rather than a lone next push.
Do not promote a new heuristic until an independently generated continuation
shows the proposed capability reduces total route cost.

## Reproduction and evidence

Run from the repository root:

\`\`\`sh
node --experimental-strip-types scripts/diagnose-grand-hall.mjs
node --experimental-strip-types scripts/probe-grand-hall-decisions.mjs
node --experimental-strip-types scripts/report-grand-hall-diagnosis.mjs
\`\`\`

- [Accounting and largest walks](grand-hall-route-accounting.md)
- [Full routes, push traces, box trajectories, goal events, and gate crossings](grand-hall-route-diagnosis.json)
- [Same-state trials with replayable prefixes and generated solutions](grand-hall-decision-probes.json)

JSON artifacts record configuration, engine/script hashes, environment, and
timings. The reporting script also independently replays the saved-production
completion witnesses. No production solver code was changed for this diagnosis.
`);
console.log(table);
