# Grand Hall: long-range rescheduling reaches 647 moves

The new engine command independently repairs the production 789-move incumbent
to **647 moves / 242 pushes / 405 walking moves**. That saves 142 moves over
rewrite, or 246 over discovery. It uses neither the human reference nor a
reference-derived push order. Node and fresh Chromium/WebKit workers replay the
647-move result successfully.

This reaches the move-count objective for repair of an existing solution. It
does not establish three-second end-to-end search or successful pre-search
planning. The quality-pipeline integration described below now invokes this
command automatically after the first local rewrites.

## Public quality pipeline milestone — September 8, 2026

Grand Hall now reaches **647 moves through the real solver adapter and public
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

Quality and optimal modes now reschedule the best replay-verified incumbent when
at least one box has a unique label and the configured minimum route length and
remaining budgets permit improvement. Fast mode keeps its first-solution behavior.
Interchangeable-only puzzles retain their existing local refinement policy.

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
usage. Restriction to unique-label roles and the complete-incumbent requirement
remain in place.

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

The engine uses the largest observed push detour to choose its first unique-label
role, then alphabetical sweeps. It does not name Grand Hall or H. Current automatic
selection excludes interchangeable groups with multiple boxes of the same label.
Extending the repair space to joint roles/assignments remains future work.

## Measured improvement chain

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
- Chromium and WebKit worker tests reproduce 647 moves and 242 pushes.
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
