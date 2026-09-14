# Sokomind project and solver audit — 2026-09-13

Audited commit: `1967150091b6e6ca1fc2cb5ce9946192d2e73fdf`. Windows, Node v24.14.0, npm 11.9.0. The tracked working tree was clean and no production files were changed. Reproductions, logs, and this report are under `tmp/`.

**The first priority is restoring trustworthy optimality certification.** Production A* can certify a nine-move route when an independent exhaustive oracle finds seven moves. The next priorities are effective experiment configuration and enforceable shared budgets. Once those are fixed, improve which box schedules discovery retains; simply raising heuristic weights cannot recover discarded schedules.

The implementation has useful safeguards: independent core replay, exact-search oracle tests, versioned proof storage, shared worker accounting, generated-source checks, and substantial browser/CI coverage. Those safeguards did not catch the competing-frontier case below. Passing replay establishes legal execution, not minimality.

The former audit roadmap has been consolidated into `docs/plans/solver.md`, `docs/solver-status.md`, and `docs/solver-benchmarks.md`. Their constraints informed this review; current source and fresh measurements take precedence over historical results.

## Confirmed findings

### 1. P1 — Forced A* successors can produce a false optimality certificate

**Location:** `src/solver/search/exact-move-astar.ts:835-860`, `:903-908`, `:1058-1077`.

A forced successor goes into `forcedNextIndex` and is expanded ahead of the priority queue. Its `g+h` then becomes the reported lower bound; encountering its goal immediately certifies the route without first excluding cheaper nodes still in the heap.

Counterexample, in native puzzle notation:

```text
OOOOOOO
OO    O
O    RO
O  XSXO
O   OSO
OOOOOOO
```

| Execution | Moves / pushes | Result |
| --- | ---: | --- |
| Public classic A*, production defaults | 9 / 2 | Claims proven optimal, bounds 9/9 |
| A*, only forced-push macros disabled | 7 / 2 | Correct result |
| IDA*, production defaults | 7 / 2 | Correct result |
| Independent primitive-move BFS oracle | 7 / 2 | Exhaustive result; 109 states in base orientation |

The false result passes core replay, structural result validation, and proof-envelope checks. It leaves six nodes in the frontier. Base, horizontal mirror, and 180-degree rotation reproduce the defect. Supplying an 11-move valid incumbent also produces the false nine-move certificate, making this relevant to Sokomind's A* proof stage.

**Fix:** enqueue forced successors through the same global priority queue. If retaining a shortcut, every goal, bound and ceiling exit must account for the global minimum; enqueueing is the simpler fix. Add competing-frontier oracle cases, symmetry variants, a nonoptimal incumbent, and cutoffs during forced chains.

Bump A* and Sokomind solver versions and invalidate affected persisted certificates. `src/shared/optimal-cache.ts:15` owns the proof revision; records omit the proof algorithm, so current cached certificates cannot be selectively retained by algorithm. A new optimal-storage key also isolates corrected storage from old tabs. An A*-only fix does not itself invalidate independently searched IDA* contours.

Evidence: [exact findings](exact-findings.md), [orientation results](exact-forced-variants.jsonl), [incumbent results](exact-forced-incumbent.jsonl). Reproduce with `node --experimental-strip-types tmp/audit-forced-variants.ts`.

### 2. P1 — The P1 benchmark driver does not activate its treatments

**Location:** `scripts/slurm-p1-benchmark.sh:49-60`; `scripts/solver-v2-benchmark-lib.ts:382-383,450-460`.

The shell driver sets `SOKOMIND_TUNING_JSON` and invokes V2. V2 constructs `createNodeSolverAdapter()` without tuning and fingerprints defaults. Only the older benchmark script parses this variable.

The three advertised treatments—walk weight 0.05, keeper-arrival mode 1, and intermediate quota 2—each resolve to actual values of zero and the identical fingerprint `f9eec8cceb9a3ff1`. Thus runs produced through this driver compare defaults against defaults. The documented negative P1 quality conclusions need separate evidence of treatment activation before they can guide acceptance or rejection.

**Fix:** pass validated tuning into each child and adapter, record effective settings and distinct treatment identities, and require a treatment-specific exercise counter before interpreting results. Reject ignored/invalid overrides before launching the matrix. Restrict discovery experiments to relevant profiles. Re-run small activation witnesses before the full corpus.

Current benchmark documentation also drifts from code: Sokomind profiles are nondeterministic and use a 4 GiB estimated-memory allowance, while the guide describes deterministic profiles and 768 MiB. Record the configuration actually executed.

Evidence: [discovery probe](discovery-wiring.ts), [resolved settings](discovery-wiring.json).

### 3. P1 — Quality mode overrides explicit experimental opt-outs

**Location:** `src/solver/implementations/sokomind-solver.ts:400-413`.

On a structural puzzle, nondeterministic Quality with explicit `strategicAnalysisMs:0` and `strategicPlanExecution:false` is rewritten to 500 ms of strategic analysis and execution enabled. The reproduction observes an analysis payload with `maxMs:500` and `inferenceWork:2048`.

This violates the option contract and the documented requirement to keep the experiment disabled until its promotion gates pass. It also prevents a straightforward Quality control run and makes the benchmark's recorded pre-resolution options misleading.

**Fix:** honor zero/false, keep experimental promotion separate from mode selection, and include resolved options in diagnostics and samples. Any automatic policy should have an explicit option and its own acceptance evidence. Do not attribute a Quality improvement or regression to this feature without a matched comparison.

Evidence: [integration reproductions](integration-repros.ts), [independently rerun results](integration-verified.jsonl).

### 4. P1 — Bidirectional workers overspend generated-state budgets

**Location:** `src/solver/implementations/sokomind-plans.ts:281-318`; `src/solver/implementations/sokomind-engine/source/solver-search.js:4054-4105`.

The bidirectional plans divide expanded work but do not pass generated-state shares. Their kernel increments generated work without checking that ceiling; the coordinator learns the count after a batch or terminal message.

On a small one-box room, the raw lane generates 21 states with a requested ceiling of one and reports `cutoff:false`. The real public Node adapter generates 21 states under a request-wide allowance of three, then returns `limit-reached`. Exact overspend can vary with worker scheduling; exceeding the allowance is the defect.

**Fix:** distribute disjoint integer generated-state shares to each lane and check before every successor. Cover zero shares, remainders, concurrent exhaustion and real workers. Keep coordinator checks as a backstop. Budget-matched optimization results are unreliable until this is enforced.

Evidence: [integration results](integration-verified.jsonl).

### 5. P2 — Forced A* expansion bypasses estimated-memory enforcement

**Location:** `src/solver/search/exact-move-astar.ts:729,1058-1077`.

The forced path retains children without the memory checks used by normal successors. The initial arena allocation also follows the preparation-time memory check without accounting for the next allocation.

On `['OOOOOOOOOO','ORX    S O','OOOOOOOOOO']`, a 20,000-byte estimate limit still allows default A* to solve five pushes at an estimated 171,248 bytes. Disabling forced macros returns `limit-reached`, although the already allocated root chunk also exceeds the allowance.

**Fix:** account for the next arena capacity before root/child allocation and centralize retention checks across ordinary, forced and tunnel paths. Preserve verified incumbents with bounded metadata on cutoff. This is an estimated-memory contract violation, not a measured RSS claim.

Evidence: [memory results](exact-forced-memory.jsonl). Reproduce with `node --experimental-strip-types tmp/audit-forced-memory.ts`.

### 6. P2 — Cached aggregate memory omits newly registered workers

**Location:** `src/solver/implementations/sokomind-phase-runner.ts:501,603`; `src/solver/implementations/sokomind-run-state.ts:79-84`.

Registration reserves a 16 MiB worker estimate but does not invalidate the aggregate cached by the initial limit check. The subsequent startup check still sees zero until telemetry arrives.

A silent worker receives a command under a one-byte memory ceiling, runs until a 40 ms elapsed cutoff, and reports peak estimated memory zero. The existing memory test passes only after waiting for the 120-second silence watchdog; this audit measured 120,011 ms for that single test in the 129,275 ms unit suite. Its final-status assertions miss the delayed enforcement.

**Fix:** centralize versioning for every registry and resource-ledger mutation, or remove the cache until profiling justifies it. Test that an over-budget worker receives no command and that reservations are visible immediately. Inspect record-batch retention and phase release too; equivalent invalidation gaps exist there but were not separately reproduced in this audit.

Evidence: [integration results](integration-verified.jsonl), [unit log](npm-test.log).

### 7. P2 — Intermediate retention misses the main targeted-macro path

**Location:** `src/solver/implementations/sokomind-engine/source/solver-search.js:1966-1984`; `source/push-generation.js:466-668`.

`macroIntermediateQuota` reaches untargeted expansion only. Targeted expansion, used for assignment and doorway objectives, has no handling for it. With quota eight, Grand Hall's first layer makes eight targeted calls, zero untargeted calls, and retains zero tagged intermediates. Its one-layer work is 1 expanded / 18 generated.

Furthermore, `intermediateOf` is written by untargeted expansion but not propagated into the beam child or otherwise consumed. The documentation's claimed beam-dedup integration is not implemented.

**Fix:** add an explicitly bounded targeted-handoff experiment and track intermediate generation, return, transposition survival and final beam retention separately. First demonstrate it on a purpose-built witness. Recover useful stops before changing outer weights or widening the whole beam.

Evidence: [discovery findings](discovery-findings.md), [operation counts](discovery-wiring.json).

### 8. P2 — The schedule-trace command rejects its own route

**Location:** `scripts/diagnose-schedule-trace.ts:79-96,102-113`.

The script converts directions to `U/D/L/R`, while the legacy rescheduler requires `Up/Down/Left/Right`. Running it on `ultra-tiny` finds a one-move solution then fails with `Rescheduling produced no path`. It also announces Quality but supplies no mode, selecting Fast by default.

**Fix:** use the shared route conversion, set/report the intended mode, and add a tiny CLI smoke check through this actual boundary. This command is intended to support the next partial-scheduling experiment, so repair it before collecting evidence.

Evidence: [failure log](schedule-trace.log). Reproduce with `node --experimental-strip-types scripts/diagnose-schedule-trace.ts --fixture=ultra-tiny`.

## Where solver improvement should focus

### Fresh route-quality evidence

The regression kernel retains the reviewed counters on Grand Hall in base, mirror and 180-degree rotation: 893 moves / 278 pushes, 1,329 expanded / 8,425 generated. Base discovery took 4.633 seconds; the three orientation samples ranged from 4.633 to 5.148 seconds. Local rewrite returned 789 / 270 in another 7.692 seconds. These are single gate samples, not a cross-machine benchmark or isolated analysis/search split.

Independent route accounting gives:

| Route | Moves | Pushes | Walking | Excess walking for its fixed push sequence |
| --- | ---: | ---: | ---: | ---: |
| Regression discovery | 893 | 278 | 615 | 0 |
| Local rewrite | 789 | 270 | 519 | 0 |
| Supplied diagnostic reference | 626 | 248 | 378 | 2 |

**237 of the 267 extra discovery moves are walking: 88.8% of the gap.** Yet discovery's walks are already shortest for its chosen push sequence. The improvement must change box positions, task ordering or keeper arrivals. Box H contributes 46 pushes / 95 preceding walks in discovery versus 14 / 15 in the reference. That identifies a useful staging diagnostic, not independent savings that can simply be subtracted. Reference routes remain offline witnesses and never enter runtime configuration.

A separate fresh-process public-adapter smoke sample used the current V2 production configuration with only the total time ceiling shortened to 30 seconds: six-worker configured cap, 500,000 expanded states, 5,000,000 generated states, 4 GiB estimated-memory allowance, nondeterministic execution.

| Mode | Moves / pushes | Elapsed | Optimality | Replay |
| --- | ---: | ---: | --- | --- |
| Fast | 893 / 278 | 4.953 s | unknown | valid |
| Quality | 515 / 236 | 30.002 s | unknown | valid |

Quality recorded an initial 952-move incumbent and a final 515-move incumbent after refinement. Its bounded proof reports lower 0 / upper 515; no optimality claim follows. The 515 result is a single timed sample with the automatic strategic override described above, not an accepted improvement over a matched control. Peak process RSS was about 1.75 GiB. It does not meet the distinct goal of independently discovering a route within three seconds after analysis, and it must not be compared to older lower-memory runs as if budgets were identical.

Evidence: [route accounting](route-accounting.md), [raw accounting](route-accounting.json), [Fast sample](sokomind-fast-sample.json), [Quality sample](sokomind-quality-sample.json), [Huge gate](huge.log).

### Recommended implementation order

1. **Repair proof and resource contracts.** Fix finding 1 first, invalidate affected certificates, then fix shared generated/memory enforcement and explicit configuration. Extend tiny oracle coverage around competing branches and feature combinations; do not rely on a larger known-optimum list alone.
2. **Repair experiment observability.** Fix V2 tuning, effective-option fingerprints, the schedule CLI, and activation/retention counters. Keep a deterministic kernel control alongside repeated production-adapter samples. Report analysis, discovery, harvest, rewrite, rescheduling and proof separately, including success fraction and all sample outcomes.
3. **Recover useful targeted handoffs at fixed width.** Retain one or two candidate stops that release an obligation or improve access to the next box's support square. Use the existing recoverability observer to identify where a witnessed handoff disappears. Confirm replay, exercise and final-beam survival before a corpus experiment. Broader branching has already failed and is not the proposed intervention.
4. **Build a separate costed partial-schedule experiment.** Reuse the repair model's exact keeper-travel reasoning (`source/box-rescheduling.js:40-78`), but explicitly search feasibility for unresolved tasks. Future occupancy masks from a complete incumbent cannot be assumed for an unfinished schedule. Carry actual board/keeper state, scoped release obligations and compatible box-goal alternatives; rank using accumulated moves and a safe optimistic remainder. Preserve a complementary keeper arrival at fixed capacity. Current strategic export collapses to one candidate per first task (`source/strategic-planning.js:347-350`), discarding later alternatives. Test that retention separately from the previously rejected broad execution policies.
5. **Reduce allocation in measured hot paths.** Add numeric reachability distances for scoring; reconstruct move arrays only when a path is needed. Then profile dense component/corral scratch reuse. Preserve deadlock decisions, ordered box identity and exact counters. Treat joint two-box repair or assignment-aware repeated-label repair as subsequent experiments if single-box diagnostics demonstrate an interaction bottleneck.

For route-quality promotion require matched budgets, replay-valid moves, nonzero mechanism exercise, broader-corpus generalization, and repeated browser success/latency measurements. For a behavior-preserving speed change require unchanged routes and counters plus repeated isolated timing/RSS evidence. No proposed change in this audit has yet demonstrated a speed or quality improvement.

### Fresh performance evidence

A single CPU-profiled regression discovery run returned the same 893 / 278 route and counters. It processed 356,609 macro intermediate states and made 187,561 reachability calls, with 48,686 cache hits, despite only 1,329 outer expansions. Outer expanded-state counts alone hide substantial work.

Process-wide sampled self-time leaders included sealed-corral detection 12.46%, reachability 7.32%, garbage collection 6.73%, targeted macro expansion 4.12%, and inaccessible-component discovery 4.09%. Profile percentages include startup and are descriptive, not a measured optimization benefit. Instrumented doorway, heuristic, reachability and deadlock times overlap and must not be summed.

Source owners: `source/analysis.js:658,1996,2145` and `source/solver-search.js:165-184`. In a separate first-layer keeper-aware probe, 17 approach profiles allocate 671 path arrays and copy 7,594 move entries just to obtain distances. A numeric distance accessor is therefore a concrete allocation-reduction candidate; additional distance-cache storage must be included in memory accounting. For corral work, reuse dense occupancy/component buffers while preserving every rejection decision; do not disable a correctness check to obtain a speedup.

Evidence: [profile summary](profile-summary.json), [engine counters](profile-discovery.json), [CPU profile](discovery.cpuprofile), [keeper probe](discovery-wiring.json).

## Validation and scope limits

| Check | Fresh result |
| --- | --- |
| `npm.cmd test` | 2,353 unit tests passed; generated engine/catalog checks, typecheck, build and nine static tests passed |
| `npm.cmd run lint:docs` | Passed, including generated project-reference check |
| Source lint, excluding `test-results/**` and audit `tmp/**` | Passed |
| Unfiltered `npm.cmd run lint` | Initially failed on 18 undefined-global errors in pre-existing ignored audit scratch files under `test-results/project-audit-2026-09-12`; no production-source failures in the source-only check |
| Live `npm.cmd audit --json` | Zero reported vulnerabilities; initial restricted-network attempt failed, permitted live retry succeeded |
| Known-optimum executable gate | 33 checks passed |
| Parallel proof | One check passed |
| Representative solver gate | Four checks passed |
| Grand Hall gate | Passed exact counters and replay in all three orientations, plus base rewrite |
| Chromium solver and Node/browser determinism | 10 tests passed with final runner exit 0 |
| New audit reproductions | Confirmed false proof, memory issues, generated overspend, option override, treatment no-op, targeted omission and broken CLI |

No full browser matrix, extended slow optimum gate, coverage rerun, full 43-fixture performance matrix, or repeated browser performance study was performed. This is a focused solver audit with surrounding build/integration checks, not a claim to exhaustive correctness or a complete security review. Existing passing tests do not negate the new counterexamples.

Production files remain unchanged. Detailed sub-audits: [exact](exact-findings.md), [discovery](discovery-findings.md), [integration](integration-findings.md).
