# Grand Hall: isolated repair and public quality results

## Repair publication fix — September 9, 2026

The public pipeline now retains **520 moves / 242 pushes** under the unchanged
45-second / 200,000-expanded / 2,000,000-generated / 2-GiB request limits.
The earlier 793/270 result below is the pre-fix baseline.

An offline phase trace identified a delivery bug: discovery consumed 1,333
expanded states and local rewrite consumed 34,000, leaving 164,667 for repair.
The rescheduler found progressively shorter verified routes, but its forced
progress message at the shared state limit caused the coordinator to terminate
it before the terminal result arrived. The public adapter therefore kept 793
moves even though repair had reached 520 moves within its allocation.

Repair now publishes each complete improvement. The coordinator independently
replays it while the request remains within limits, retains only its best
publication, and keeps searching. A later cutoff preserves that verified route.
No extra states or time are granted, and candidates arriving at the limit remain
ineligible. This changes result delivery, not search order, pruning, or proof.

| Controlled Node run | Moves | Pushes | Expanded | Generated | Peak estimated bytes | Elapsed ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before publication | 793 | 270 | 200,000 | 746,911 | 123,457,142 | 14,343.8 |
| Publish verified incumbents | 520 | 242 | 200,000 | 746,911 | 123,457,142 | 14,457.9 |
| Earlier 10,000-state local-window ablation | 805 | 270 | 200,000 | 326,438 | 66,407,542 | 8,649.0 |

These are single-run descriptive Node timings, not evidence of a speedup. The
window-cap ablation was rejected; production allocation remains unchanged.
Raw [baseline](quality-budget-baseline.json),
[publication run](quality-budget-published-incumbent.json), and
[window-cap control](quality-budget-window-10000.json) preserve phase evidence.
The 503/236 isolated result still uses a different incumbent and repair budget.

The public browser gate is tightened to **550 moves / 245 pushes**. All three
strategic worker cases passed three times each in Chromium, Firefox, and WebKit
(27 tests), including the tighter public gate and isolated 503/236 assertion.
Browser test durations include setup and concurrent validation load; they are
not controlled timing distributions. Reproduce
phase diagnostics without a saved input route using:

```sh
npm run diagnose:quality-budget -- --fixture=huge --output=quality-budget.json
npm run diagnose:quality-budget -- --fixture=huge --window-cap=10000 --output=quality-budget-control.json
```

The optional window cap is an offline proportional reduction of local-window
shares; it does not change production defaults. Trace files include paths and
request limits for replay and investigation.

Validation also passed all 2,371 unit tests and all three coverage gates,
33 frozen-optimum cases and the parallel-proof regression, the multi-puzzle and
Huge orientation/rewrite guardrails, typecheck, lint, build/static checks, and
generated-source/documentation checks. The full application browser suite was
not rerun for this focused worker change.

## P0 baseline milestone — September 9, 2026

The isolated rescheduling worker repairs the saved production rewrite incumbent
to **503 moves / 236 pushes**. The public quality adapter, starting from the board
alone under its current test limits, returns **793 moves / 270 pushes**. These are
different experiments; neither result is a global optimality proof or evidence
for a three-second end-to-end solve.

| Path | Moves | Pushes | Input and evidence |
| --- | ---: | ---: | --- |
| Reviewed fast discovery | 893 | 278 | Board; deterministic Huge guardrail |
| Historical full local rewrite | 789 | 270 | Discovery incumbent; Huge rewrite guardrail |
| Human reference | 626 | 248 | Supplied route; historical comparison only |
| Current isolated rescheduler | 503 | 236 | Saved 789-move rewrite; fresh Chromium engine worker |
| Current public quality adapter | 793 | 270 | Board alone; three serial Chromium runs |

The browser cases live in `tests/e2e/strategic-analyzer.spec.ts`. The isolated
case reads the `rewrite` action log from `grand-hall-route-diagnosis.json`, uses
300,000 expanded states, 2,000,000 generated states, and 25,000 ms of repair time,
with the default two rounds. It does not set an explicit memory limit. Each of
the three fresh-worker runs reproduced 503/236 and passed canonical replay.

The public case starts from `PUZZLE_BY_ID.huge` through `solver.worker`, using
`sokomind-solver` quality mode, one incumbent, no harvesting, and deterministic
execution. Its request limits are 45,000 ms, 200,000 expanded states, 2,000,000
generated states, and 2 GiB estimated memory. All three runs reported 200,000
expanded states, 746,911 generated states, and 123,457,142 peak estimated bytes.
Elapsed times were 14,457.8, 14,437.8, and 15,162.2 ms (median 14,457.8 ms),
measured locally on Windows in Chromium; these are descriptive observations.
See [raw public samples](grand-hall-public-quality-2026-09-09.json) for source
hashes, environment, limits, and complete metrics.

The public regression now requires at most **800 moves / 270 pushes**, observed
rescheduling progress, independent replay, unknown optimality, and compliance
with state/generated/estimated-memory limits. It attaches the complete result
and request limits to the Playwright report. The quality ceiling deliberately
protects the measured integrated result rather than requiring the isolated 503
result. Exhaustion of the public state budget remains a follow-up investigation.

After the comment corrections and engine regeneration, all three strategic
browser cases passed in Chromium, Firefox, and WebKit, including the strengthened
public quality gate and exact isolated 503/236 assertion. Firefox required a run
outside the local sandbox after its sandboxed browser launch stalled. The full
application browser suite was not part of this focused validation.

## Current rescheduling contract

Every physical box is eligible, including boxes in repeated-label groups.
`rescheduleBoxIndices` can restrict the selected physical indices. Each repair
preserves the other boxes' push order and identity, as well as the selected box's
incumbent final cell. Repeated-label eligibility does not introduce joint-box
repair or free goal reassignment. Route-length and remaining-budget checks still
govern automatic refinement. The largest observed push detour is tried first,
followed by label-ordered sweeps through the eligible boxes.

## Historical unique-label milestone — September 8, 2026

The remainder of this section records the earlier unique-label-only experiment.
Its 647-move results and timings are historical evidence, not current expectations.

The original engine command independently repaired the production 789-move incumbent
to **647 moves / 242 pushes / 405 walking moves**. That saves 142 moves over
rewrite, or 246 over discovery. It uses neither the human reference nor a
reference-derived push order. Node and fresh Chromium/WebKit workers replay the
647-move result successfully.

This reaches the move-count objective for repair of an existing solution. It
does not establish three-second end-to-end search or successful pre-search
planning. The quality-pipeline integration described below now invokes this
command automatically after the first local rewrites.

## Historical public quality pipeline milestone — September 8, 2026

Grand Hall reached **647 moves through the real solver adapter and public
Chromium/WebKit solver workers, starting from the board alone**. The saved
789-move route is no longer needed as a test input for this integration. The
existing standalone repair evidence below remains useful for isolating its cost.

| Real adapter case | Shared quality state budget | Final moves | Pushes |
| --- | ---: | ---: | ---: |
| Grand Hall | 50,000 | 709 | 250 |
| Grand Hall | 300,000 | 647 | 242 |
| Grand Hall mirrored | 300,000 | 647 | 242 |
| Grand Hall rotated | 300,000 | 647 | 240 |

The harness uses a 2 GiB memory ceiling, one incumbent, no harvesting, a 20-second
quality time budget, and a 30-second total request deadline. Discovery and proof
share the total request limits. The browser integration tests use the public
worker with a 200,000-state total request ceiling and reproduce 647/242.
These are quality acceptance runs, not evidence for the three-second target.
The existing exact proof phase can continue after rescheduling has found its
route; total request durations here are about 30 seconds.

At this historical milestone, automatic repair required a unique-label box.
That eligibility restriction has since been removed, as described above.
Fast mode retains its first-solution behavior.

An integration trial exposed a budget allocation problem: larger budgets let
the first local rewrite consume the entire quality deadline. Eligible puzzles
now cap each first local pass at 50,000 states and reserve the final quarter of
the available quality time for rescheduling. Expanded states, generated states,
and elapsed time are charged to the existing shared envelope. No extra global
budget is added. Work/time/memory cutoffs or worker failures preserve the best
previously verified solution; cancellation terminates the worker.

The engine also reports progress and retained-state estimates while repairing,
and bounds estimated memory for occupancy/distance tables and search nodes.
Memory estimates are conservative accounting, not measurements of exact JS heap
usage. A complete incumbent remains required; unique-label-only eligibility was
a restriction of this historical experiment.

Seven additional catalog puzzles completed with replay-valid results in the
integration corpus. Small routes use a zero minimum-length threshold in that
harness to exercise the repair selection. Their final results also include local
rewrites and exact proof, so their gains must not all be attributed to rescheduling.
See [adapter runs and limits](quality-rescheduling-huge.json) and
[broader corpus](quality-rescheduling-corpus.json).

## What changed

Instead of choosing a box's next push, the restricted search chooses every move
of that box across the remaining schedule. The other boxes' pushes retain their
relative order and identity. Each state contains the next fixed push index, the
free box's position, and the keeper position. Successors either push the free box
or execute the next fixed push, with exact shortest keeper travel priced in.

A* uses two admissible lower bounds: remaining fixed pushes plus relaxed pushes
for the free box, and the keeper travel imposed by the fixed push sequence when
the free box is removed. The maximum is used because those costs can overlap.
The first improved goal popped is optimal within this restricted push sequence;
successive one-box optimizations are not globally optimal Sokoban search.

The historical engine used the largest observed push detour to choose its first
unique-label role, then alphabetical sweeps. It did not name Grand Hall or H.
Current eligibility also includes repeated-label boxes. Extending the repair
space to joint roles/assignments remains future work.

## Historical measured improvement chain

| Step | Moves |
| --- | ---: |
| Production discovery | 893 |
| Production window rewrite | 789 |
| Reschedule H globally | 725 |
| First sweep: A, B, C, D, G, H | 709, 701, 689, 681, 665, 651 |
| Second sweep: A | 647 |
| Remaining second-sweep roles | No further improvement in their restricted spaces |

Rescheduling H alone in discovery gives 771 moves. Doing the H-only repair on
mirrored and rotated rewritten incumbents gives the same 725-move result.
The independent prototype and engine agree on the full 647-move chain.

The engine's measured Node repair call was approximately 511 ms, including
its validation and the external replay check. The CLI experiment's 19 isolated
processes took approximately 3.9 seconds including independent controls and
startup overhead. Neither measurement includes producing the original incumbent.
Browser tests verify correctness; their test durations are not acceptance timing
distributions for the complete solve pipeline.

## Continuation calibration

At production checkpoints before pushes 7 and 44, preserving the original box
order produced identical visited counts and failures to fresh structural search:
3,384 and 4,857 states respectively. Preserving root doorway tasks changed the
early run to 4,543 states but still exhausted its frontier. Disabling the goal
access or egress guard individually also failed. These runs used a 6,000-state
cap and a generous 120-second allowance; the recorded failures were frontier
exhaustion, not time exhaustion.

The actual adapter continuation plan was also exercised in isolated processes
with 6,000 and 60,000 requested expansions. All four runs exceeded the external
30-second process limit. Their internal completion/counters are unavailable,
so these are inconclusive evaluations, not infeasibility evidence. We do not
use them to rank whole-puzzle strategies. Restricted rescheduling supplies a
tractable, independently verified experiment on the transport hypothesis instead.

## Validation and limits

- An independent primitive-move BFS oracle agrees on small restricted repairs.
- Every accepted engine candidate is replayed and checked against the unchanged
  other-box push sequence; the terminal result passes the existing verifier.
- Zero and small work/time budgets retain a verified incumbent.
- Illegal/incomplete incumbents cannot produce a claimed solution.
- Historical Chromium and WebKit worker tests reproduced 647 moves and 242 pushes.
- Existing production discovery and rewrite regressions remain 893 and 789.

The new command needs no human route but does need a complete incumbent. This is
evidence for long-horizon transport and staging optimization, not evidence that
the analyzer can already produce such schedules from a board alone. Next steps
are using the same costed schedule constraints with analyzer-generated partial
skeletons, with broader assignment/joint-role coverage evaluated independently.
Keep incomplete-skeleton feasibility separate from the proven restricted repair.

## Reproduction

```sh
node scripts/benchmark-box-rescheduling.mjs
node --experimental-strip-types scripts/benchmark-quality-rescheduling.ts --only=huge
node --experimental-strip-types scripts/benchmark-quality-rescheduling.ts --only=corpus
node --experimental-strip-types --test tests/unit/box-rescheduling.test.ts
node scripts/run-browser-tests.mjs tests/e2e/strategic-analyzer.spec.ts --project=chromium --project=webkit
```

Build first for browser tests. The engine command is:

```js
search({algorithm: "solution-box-reschedule", state, solutionPath,
  maxVisited: 300000, maxGenerated: 2000000, rescheduleMaxMs: 10000});
```

- [647-move action log](grand-hall-rescheduled-solution.txt)
- [Prototype controls, lineage, timing, and repair chain](grand-hall-rescheduling-summary.json)
- [Engine result and per-attempt counters](grand-hall-engine-rescheduling.json)
- [Root-context calibration](grand-hall-continuation-calibration.json)
- [Guard ablations](grand-hall-continuation-guards.json)
- [Adapter continuation process limits](grand-hall-adapter-continuation.json)
