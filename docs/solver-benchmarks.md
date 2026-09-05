# Solver benchmarks

The V2 harness measures production solver paths and controlled exact-search
feature variants. Its JSON is evidence, not a substitute for replay and proof.

## Quick start

Run a small production smoke capture:

```text
npm.cmd run benchmark:solver:v2 -- --fixture=ultra-tiny --profile=sokomind-fast --runs=1 --warmup=0
```

Run the full configured matrix with five isolated samples per pair:

```text
npm.cmd run benchmark:solver:v2 -- --runs=5 --warmup=0 --save=tests/fixtures/solver-v2/baseline-v3-YYYYMMDD.json
```

The default matrix is large. It includes every eligible fixture/profile pair
and may take hours on proof-heavy fixtures.

## Production profiles

| Profile | Production path | Deterministic | Eligibility |
|---|---|---:|---|
| `sokomind-fast` | Node Sokomind adapter, fast mode | Yes for benchmark | All fixtures |
| `sokomind-quality` | Node Sokomind adapter, harvest + rewrite | Yes for benchmark | All fixtures |
| `sokomind-optimal-astar` | Node Sokomind adapter + A* proof | Yes | Classic-eligible |
| `sokomind-optimal-ida` | Node Sokomind adapter + IDA* proof | Yes | Classic-eligible |
| `classic-astar` | Exact move A* adapter | Yes | Classic-eligible |
| `classic-ida-star` | Exact move IDA* adapter | Yes | Classic-eligible |

Classic eligibility is at most eight boxes and at most 96 floor cells. The
frozen corpus currently has 43 fixtures, 37 of which are classic-eligible. The
complete matrix contains 234 eligible fixture/profile pairs.

Every request receives the same immutable limits object recorded in its sample.
Classic proof profiles use 60 seconds, 500,000 expanded states, 5,000,000
generated states, and 512 MiB. General Sokomind profiles use 180 seconds,
500,000 expanded states, 5,000,000 generated states, and 768 MiB.

## Methodology

Each timed sample runs in a new child process. This provides clean process
memory boundaries and cold-start measurements. A preflight requested with
`--warmup=N` also runs in a disposable process; the artifact labels it
`untimed-cold-preflight` and does not claim that it warms a later V8 isolate.

For each fixture/profile group the harness retains:

- every raw sample;
- minimum, median, maximum, and median absolute deviation for elapsed time;
- before/after RSS and `process.resourceUsage().maxRSS` peak RSS;
- solver metrics and all counters;
- replay result, proof bounds, and known-optimum comparison;
- exact limits and mode settings;
- solver, corpus, tuning, board, Git commit, and dirty-worktree identity.

Deterministic samples must agree on status, solution/proof outcome, expanded
states, and generated states. A disagreement rejects the group rather than
silently selecting a median record. Milliseconds are descriptive across
machines; they are not a correctness gate.

## Controlled feature A/B runs

Use `--compare-feature` with exact profiles:

```text
npm.cmd run benchmark:solver:v2 -- --fixture=inter-rooms --profile=classic-astar --profile=classic-ida-star --compare-feature=patternDatabase --runs=5 --warmup=0
```

Accepted names are:

- `incrementalAssignment`
- `linearConflict`
- `interactionBoost`
- `patternDatabase`
- `forcedPushMacros`
- `piCorralPruning`
- `patternDeadlockPruning`
- `deadlockTablePruning`
- `goalCommitmentPruning`
- `tunnelMacros`

The harness creates a matched control and `without:<feature>` variant. Every
other feature, board, solver, limit, and deterministic setting stays identical.
It refuses Sokomind discovery profiles for this mode because those profiles do
not expose the exact-kernel vector directly.

A pair is valid only when both sides replay and prove the expected optimum and
the disabled side reports zero exercise for the selected mechanism. A benefit
classification additionally requires a nonzero control-side exercise counter.
Results are classified as improvement, regression, mixed, no effect,
inconclusive/not exercised, or invalid correctness. Expanded/generated deltas
are deterministic; timing uses the sample median. Median elapsed and peak RSS
receive explicit qualification thresholds. A material regression in either is
a resource veto: it prevents an apparent state-count reduction from being
accepted as an uncomplicated improvement, and conflicting directions are
reported as mixed evidence.

The September 4, 2026 `inter-rooms` PDB smoke results were replay-valid and
proven on both sides, with identical work: A* expanded 312 and generated 1,433
states, while IDA* expanded 2,831 and generated 12,738. In one five-run cold
capture, the PDB-on/PDB-off medians were 196/185 ms for A* and 902/892 ms for
IDA*. PDB construction retained 56,698 extra estimated bytes. Both
fixture/algorithm pairs classify as no effect for PDB; this partial, dirty-tree
smoke capture does not justify an efficiency claim.

The deterministic tunnel-macro prototype also produced no state-count change
on the original four-fixture sample:

| Fixture | Visited before | Visited after | Generated before | Generated after |
| --- | ---: | ---: | ---: | ---: |
| `beginner-three` | 13 | 13 | 30 | 30 |
| `classic-1` | 46 | 46 | 177 | 177 |
| `box-7x7` | 44 | 44 | 437 | 437 |
| `expert-maze` | 381 | 381 | 1,715 | 1,715 |

The result justified preserving the additive implementation for corridor-heavy
coverage, but it did not establish a performance win.

## Historical Grand Hall discovery experiments

These deterministic captures explain the structural reserve and guard policy
retained by the discovery engine. All listed solutions replayed successfully.
Elapsed time is descriptive for the development machine and not a portable
gate.

| Case | Moves | Pushes | Visited | Generated | Retained | Peak frontier |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Former fast baseline | 1,066 | 322 | 1,616 | 9,329 | 3,077 | 330 |
| Current first found | 893 | 278 | 1,329 | 8,425 | 2,538 | 291 |
| After quality rewrite | 789 | 270 | 29,000 | 108,722 | 29,000 | 1 |

Base, mirrored, and 180-degree-rotated Grand Hall produced the same 893/278
route metrics and counters. Direct Node runs took about 5.3-7.2 seconds by
orientation. The rewrite is not part of fast mode.

| Experiment | Result | Decision |
| --- | --- | --- |
| Original branch policy plus stranded hard guard | 1,066 / 322 | Baseline |
| Distinct-box reserve only | 1,020 / 288, more generated work | Incomplete alone |
| Guard relaxation only | Cutoff at 5,043 visited / 30,659 generated | Reject alone |
| Reserve plus guard relaxation | 893 / 278, less search than baseline | Retain together |
| One enabling handoff per box | Cutoff at 54,942 generated | Revert |
| Persistent agenda-resumption slot | 1,121 / 322 | Revert |
| Macro alternate-approach reserve | Cutoff at 27.5 s | Revert |
| Move-aware macro arrival diversity | Cutoff at 20.6 s | Revert |
| Temporary-goal penalty | 918 / 278, more search | Revert |
| Remove temporary goals from milestone identity | Cutoff at 5,025 visited / 39,580 generated | Revert |

The retained structural predicate uses topology and branch pressure rather than
puzzle identity or dimensions. Representative generalization results were:

| Puzzle | Before moves / pushes | After moves / pushes |
| --- | ---: | ---: |
| `gen-expert-057` | 109 / 24 | 87 / 24 |
| `gen-master-090` | 90 / 28 | 86 / 28 |
| `gen-expert-335` | 341 / 95 | 195 / 43 |

Across a reviewed 15-puzzle room-bearing structural corpus, the combined policy
produced four wins, eight ties, and three losses while reducing aggregate moves,
pushes, and generated states. Large room and packing boards remain the principal
regression class.

## September 5 flagship solver audit

The product target is a replay-valid Grand Hall solution of at most 650 moves
within 3 seconds in the browser. The reported browser baseline is 893 moves in
4.3 seconds. A subsequently supplied human route was strictly replayed in
626 moves / 248 pushes. It is a verified upper bound, not an established optimum.
The target requires 243 fewer moves (27.2%) and 30.2% less elapsed time relative
to that reported baseline. No experiment below achieved the target.

### Measurement boundary

Local measurements used Node 24.14.0 on Windows with an AMD Ryzen 7 9800X3D.
Each timed case ran in a fresh process, sequentially. These timings do not
establish browser performance. All reported successful routes passed independent
core replay. Production source and tuning were not changed by this audit.

The production V2 fast adapter returned 893 moves / 278 pushes in all three
samples: 5,592, 5,614, and 5,477 ms (median 5,592 ms). Reproduce with:

```text
npm.cmd run benchmark:solver:v2 -- --fixture=huge --profile=sokomind-fast --runs=3 --warmup=0
```

Isolated kernel experiments used the Grand Hall performance gate's structural
payload, including `planSolutionComparisonBudget: 0`, beam width 32, six box
branches, and targeted macro effort 64. Except for the repeated permutation
case and paired traversal experiment below, these are single samples and cannot
establish reliable timing improvements.

| Experiment | Moves | Pushes | Kernel time | Outcome |
| --- | ---: | ---: | ---: | --- |
| Fast control | 893 | 278 | 5.315 s | Replay valid |
| `planMoveWeight: 0.02` | 885 | 278 | 5.419 s | Small quality gain |
| `planMoveWeight: 0.05` | 889 | 278 | 5.107 s | Small quality gain |
| `planMoveWeight: 0.1` | 1,072 | 298 | 10.592 s | Worse quality and time |
| Beam width 16 | — | — | 12.043 s | Cutoff |
| Targeted and sequence macro effort 32 | — | — | 16.943 s | Cutoff |
| Canonicalize incumbent only | 893 | 278 | 0.093 s additional | No improvement |
| Permutation rewrite and final canonicalization | 833 | 274 | 0.703 / 0.695 s additional | Repeatable quality gain |
| Full reviewed rewrite | 789 | 270 | 7.226 s additional | 29,000 visited; no move-window gain |

Rewrite cases start from the same saved 893-move incumbent. The permutation
case uses 10,000 visited states, windows of 8/16/32 pushes, and a 1,500-state
per-window cap, with push-bridge and move-bridge budgets zero. It reports eight
permutation improvements; final canonicalization can also remove pushes.
The full rewrite uses the executable Grand Hall guardrail's settings. Its
4,000-state move-window probe found no improvement. Simply normalizing walks
does not improve the original route: scheduling and box trajectories matter.

### Search-quality constraints

The structural planner is intentionally incomplete, and several mechanisms
favor pushes over the user's move objective:

- `scoreCandidate` adds pushes at full weight and total moves at only 0.005.
  Two hundred additional moves therefore contribute the same score increment
  as one push, before the other structural terms.
- First-push ranking does not include keeper walking cost. Targeted macro
  priority and endpoint ranking also favor push count; changing the outer
  weight alone does not change these decisions.
- `planArrivalDominates` prefers fewer pushes even when that arrival took more
  moves. The default region identity also merges keeper positions. This is
  useful for bounded push discovery but can discard better move solutions.
- When long macro endpoints exist, only the first two selected first pushes
  retain their ordinary one-push alternative. Useful intermediate handoffs can
  disappear before the outer beam has a chance to compare them.
- Fast mode accepts the first solution. The current full rewrite mostly
  repairs small fixed-endpoint windows rather than reconsidering an entire
  room-transfer agenda.

Relevant owners are `solver-search.js`, `push-generation.js`, and
`heuristic.js` under `src/solver/implementations/sokomind-engine/source/`.
Earlier globally enabled arrival-diversity experiments already regressed this
board; do not repeat them without a narrower hypothesis and bounded budget.

### Verified human reference

`tests/fixtures/solver-v2/grand-hall-reference.json` preserves the supplied
626-move route, its provenance, and board revision `puzzle-v1:9ead120a`.
`tests/unit/grand-hall-reference.test.ts` checks strict replay, exact move/push
counts, and mirrored/rotated equivalents. It is intentionally separate from the
known-optima map and is not a production route lookup.

| Route metric | Fast solver | Human reference | Reduction |
| --- | ---: | ---: | ---: |
| Moves | 893 | 626 | 267 |
| Pushes | 278 | 248 | 30 |
| Walks | 615 | 378 | 237 |
| Switches between pushed boxes | 37 | 33 | 4 |
| Box-work phases revisiting a box | 21 | 17 | 4 |
| Cross-zone pushes | 32 | 28 | 4 |

Walking accounts for 88.8% of the move-count gap. The reference does not merely
avoid all detours: it has five measured reversal episodes versus three and
seven measured assignment misdirections versus five. These observational
signals must not become blanket penalties against strategic staging.

The largest per-box discrepancy is typed box H, initially at row 7, column 10
(zero-based): the solver pushes it 46 times versus 14 in the reference. Walking
immediately preceding its pushes totals 95 versus 15. The generic box initially
at row 12, column 4 takes 36 pushes versus 19, with 91 versus 56 preceding walks.
These are useful diagnostic targets, not independently recoverable savings:
box work interacts, and the reference spends more pushes on some other boxes.
For example, typed B takes 34 pushes in the reference versus 22 in the solver.

The next quality experiment should trace H's staging and the room-transfer
agenda, then determine which reference handoffs are absent from generated
macros or lost at pruning/beam selection. Increasing move weight alone cannot
recover a route that was never retained. The 650-move target allows just 24
extra moves over this verified reference; its runtime feasibility remains open.

### CPU and allocation findings

A separate CPU-profiled fast run returned the same route and counters. It
reported 1,329 visited states but 356,609 macro intermediate states, 187,561
reachability calls, 8,975 full macro expansions, and zero cheap macro expansions.
The adaptive cheap path is restricted to forced macros on boards with at most
four boxes, so it does not reduce Grand Hall's 17-box workload.

The sampled self-time leaders included sealed-corral detection (11.2%),
reachability (6.2%), garbage collection (6.0%), and `floorNeighbors` (6.0%).
Nested timings reported approximately 1.12 s in doorway scheduling, 0.50 s in
reachability, 0.51 s in dynamic deadlocks, and 0.46 s in heuristics. These
measurements overlap and must not be added together. Parsing and graph
compilation together took only about 35 ms in that capture.

A temporary copy of the generated engine replaced only the `crossingAccessible`
loop in `doorwayScheduleState`: traverse `board.dense.neighbors` and map cell IDs
through `board.dense.keys` instead of calling `floorNeighbors` for every queue
entry. Three alternating cold-process control/prototype pairs measured:

| Pair | Control | Dense doorway traversal |
| --- | ---: | ---: |
| 1 | 5,447 ms | 4,804 ms |
| 2 | 5,365 ms | 4,644 ms |
| 3 | 5,262 ms | 4,708 ms |

Median time improved 12.2%. Every run retained 893 moves / 278 pushes and
1,329 visited / 8,425 generated, with successful replay. This is a promising
prototype at the time of the audit. The subsequent analysis upgrade below
integrates the approach in the source modules. Browser benefit and memory
benefit remain unmeasured.

### Integrated pre-search analysis upgrade

The prepared board now compiles ordered room cells, dense membership masks,
doorway IDs, and staging IDs once. Search reuses that geometry for its existing
doorway checks. Prepared seeds carry the geometry across worker boundaries;
older seeds compile it on hydration. The structural beam's scoring and hard
pruning policies are unchanged.

Analysis now also exposes a bounded advisory `transportPlan`, described in
[Solver integration](solver-integration.md). This records full allowed goal
domains, mandatory per-box transfers, initial push move costs, shared-doorway
blockers, and up to four relaxed parking candidates per box. Parking guidance
does not yet affect production search ordering and is not a safety proof.

Three alternating cold-process comparisons against the pre-upgrade engine
measured 5,370/5,335/5,283 ms before and 4,898/4,567/4,770 ms after. Median
kernel time improved **10.6%**, from 5,335 to 4,770 ms. All six routes replayed
at 893 moves / 278 pushes with identical visited/generated counters. These
kernel timings exclude the separate analysis worker and do not establish
browser performance or a route-quality improvement.

Three fresh production V2 fast-adapter samples, including board analysis and
worker execution, measured 4,831/4,890/4,883 ms (median 4,883 ms), all returning
the same verified 893/278 solution. The earlier pre-upgrade production median
was 5,592 ms; these non-interleaved samples are supporting evidence, while the
paired kernel comparison is the controlled speed measurement.

The executable Grand Hall gate also passed base, mirrored, and rotated cases
with exact reviewed counters, including the unchanged 789-move quality rewrite.
Differential traversal tests compare every state of the 626-move human route,
empty and fully occupied boards, and fresh/current/older prepared-board forms.

### Tuning objective defect

The older `scripts/benchmark-sokomind-solver.ts` fitness uses
`movesBudget = boxes * floor * 0.3`. Grand Hall's 17 boxes and 127 floor cells
produce 647.7, so both 893 and 650 moves score zero. Its elapsed multiplier is
also one whenever the run finishes within the timeout. This metric cannot
reward most of the requested quality improvement or any successful-run speedup.
The V2 harness reports raw timing and route quality separately and does not
depend on that scalar fitness.

### Recommended implementation sequence

1. **Use the verified quality reference and establish deadline measurements.**
   Compare the saved 626-move route's box transfers, parking locations, room
   revisits, keeper walks, and arrival sides against 893/833/789.
   Record best verified moves at 0.5/1/2/3/5 seconds, including worker startup and
   verification. Replace the older fitness with explicit solve-rate, moves,
   deadline, and memory comparisons before using it for automated tuning.
2. **Recover CPU time without changing the search.** Integrate the measured
   doorway traversal prototype first. Then investigate allocation-free corral
   component/boundary traversal and bounded reuse of corral analysis keyed by
   full labeled occupancy and keeper region. Preserve existing deadlock rules
   and deterministic neighbor order; profile allocation as well as CPU time.
3. **Add a bounded cheap improvement stage.** Trial the measured permutation
   rewrite after first solution under the remaining global deadline. Reuse
   prepared board data where practical. Return the best verified incumbent when
   time expires; do not assume the current full rewrite fits a 3-second budget.
4. **Make a separate discovery lane optimize moves throughout.** Trial
   move-cost single-box macro search with keeper approach distance, preserve
   useful exit sides, and retain a small minimum-moves reserve at structural
   milestones. Make transposition dominance consistent with that lane's move
   objective. Keep the reliable structural lane while measuring whether the
   extra work pays for itself; do not enable broad Pareto expansion by default.
5. **Optimize longer schedules around a verified incumbent.** Search a bounded
   neighborhood of box configurations across room-transfer milestones, allowing
   limited parking changes and reordered box work. Rank candidate regions by
   avoidable travel and expected gain rather than merely trying windows in
   chronological order. JSoko's documented
   [vicinity optimizer](https://jsokoapplet.sourceforge.io/help/help/help/how-the-optimizer-works.html)
   is a useful precedent for incumbent-centered neighborhood search; it does
   not establish a 3-second guarantee for this typed puzzle.

Proving 626 optimal is a separate project. The immediate product goal is finding
a short, verified solution quickly, using 626 as a verified upper bound.
Acceptance should cover Grand Hall base/mirror/rotation and
the structural room/packing corpus, measured in a fixed browser environment
with both cold and warm workers, repeated timing samples, and memory tracking.
Do not ship a Grand Hall-specific cached route as evidence of better search.

## Schema 3

Top-level fields include environment identity, methodology, profile definitions,
corpus/tuning fingerprints, partial/full coverage, promotability, raw result
groups, and optional A/B comparisons.

`promotableBaseline` is true only when:

- the full 43-fixture/default-profile matrix was requested;
- every eligible pair is present exactly once as a sample group;
- all groups are deterministic and accepted;
- at least five timed samples were captured per group;
- Git resolved a full commit identity and the worktree was clean; and
- the run is not a feature-ablation capture.

Partial smoke runs remain useful evidence but cannot be mislabeled as full
baselines.

## Artifact policy

`tests/fixtures/solver-v2/baseline-v0.json` is a historical schema-2 artifact.
It covers only the older subset and older solver versions. Keep it immutable.

Use a new versioned filename for each reviewed capture. Existing files are not
overwritten unless the operator deliberately passes `--force`:

```text
npm.cmd run benchmark:solver:v2 -- --save=tests/fixtures/solver-v2/baseline-v3-YYYYMMDD.json
```

The SLURM wrapper includes the job ID and UTC timestamp in its output filename.

## Memory smoke test

The separate classic A* memory runner now consumes the flat corpus correctly:

```text
npm.cmd run benchmark:solver:memory -- --fixture=ultra-tiny
```

It is a focused diagnostic, not the schema-3 baseline format. Prefer the V2
harness when comparing production profiles or feature vectors.

## Exit behavior

- Exit 0: every requested deterministic sample group was accepted.
- Exit 1: argument, child protocol, or artifact-write failure.
- Exit 2: the capture completed, but one or more sample groups failed
  correctness or consistency acceptance.

JSON is emitted even for rejected completed captures so the failure remains
inspectable.
