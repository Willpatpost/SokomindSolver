# Sokomind Consolidated Project Audit — August 11, 2026

**Status:** Remediated through August 14 — all 44 recorded findings are closed
in this working tree

**Original audit base:** `19cdf79` (`main`)

**Follow-up remediation base:** `abc8ab7` (`main`)

**Audit and remediation dates:** 2026-08-11 through 2026-08-14

**Scope:** Architecture, game core, catalog, persistence, editor, solver and
proof systems, workers, PWA behavior, accessibility, tests, CI, documentation,
security, and dependencies.

This is the authoritative audit record. It replaces the older audit trackers
listed at the end of the file. It retains the former gaps, their risk, the
implemented fix, and the regression evidence; it does not present fixed or
obsolete claims as outstanding work. Future product and engineering ideas are
kept in [`AUG11IMPROVEMENTS.MD`](AUG11IMPROVEMENTS.MD).

## Executive verdict

The release-blocking false-optimality defect and every P1–P3 finding discovered
in the August 11 audit and August 14 follow-up have been remediated. IDA* now uses sound contour-local
exact-state best-`g` dominance, checkpoint and worker inputs are treated as
untrusted, proof phases share run-wide resources, and cached proofs from the
unsafe schema are invalidated.

Product-state fixes add date-indexed daily participation, non-destructive
shared-editor previews, IndexedDB resume discovery, visible/retryable
persistence failures, correct achievement deltas, bounded imports, and scoped
draft quarantine. The follow-up added true repeat-completion activity, named
draft documents, progress-only reset, honest mutation outcomes, narrow-screen
contracts, selector continuity, and explicit offline recovery. Architectural
and test controls now enforce source layers,
browser-safe worker closures, route behavior coverage, and repository-wide
Markdown links and anchors.

No backend, account system, analytics, advertising, or third-party telemetry is
present. The audit found no known dependency vulnerability.

## Current project map

```text
index.html
  -> src/main.tsx
     -> catalog URLs, reset coordination, service worker
     -> ErrorBoundary -> ExperienceProvider -> App
        -> RouterProvider -> AppShell
           -> Home / Selector / Play / Editor / Stats

Persistence
  -> localStorage preferences, progress, favorites, ratings, editor draft
  -> IndexedDB mirrored sessions and optimal records
  -> persistence-health reporting and retry callbacks

Solver UI
  -> SolverWorkerClient
  -> outer solver worker / host / registry
  -> Classic DFS, Greedy, exact A*, exact IDA*
  -> Sokomind discovery / rewrite / exact proof workers
  -> strict result validation and independent core replay
```

## Resolution index

| ID | Former priority | Area | Resolution |
|---|---|---|---|
| AUD-001 | P0 | Solver | Closed — sound IDA* dominance and optimal-cache v5 |
| AUD-002 | P1 | Checkpoints | Closed — exact-state checkpoint v2 and incumbent replay |
| AUD-003 | P1 | Resources | Closed — one remaining-budget ledger and merged telemetry |
| AUD-004 | P1 | Protocol | Closed — deep validation, identity binding, and replay |
| AUD-005 | P1 | Progress | Closed — schema-v2 date-indexed daily participation |
| AUD-006 | P1 | Editor | Closed — read-only shared preview and explicit import |
| AUD-007 | P2 | Workers | Closed — deadlines, watchdogs, and complete cleanup |
| AUD-008 | P2 | Browser | Closed — browser-neutral checkpoint digest and closure gate |
| AUD-009 | P2 | Persistence | Closed — IndexedDB resume discovery and reconciliation |
| AUD-010 | P2 | Persistence | Closed — reported failures and exact-payload retry |
| AUD-011 | P2 | Achievements | Closed — old/new snapshot delta and deduplication |
| AUD-012 | P2 | Accessibility | Closed — native text shortcut ownership preserved |
| AUD-013 | P2 | Imports | Closed — shared bounded parser and accurate merge counts |
| AUD-014 | P2 | Recovery | Closed — deep draft validation and scoped quarantine |
| AUD-015 | P3 | Errors | Closed — correct symbolic code/message serialization |
| AUD-016 | P3 | Tests | Closed — route behavior matrix and stronger all-source floor |
| AUD-017 | P3 | Architecture | Closed — AST-aware layer and worker-closure enforcement |
| AUD-018 | P3 | Architecture | Closed — neutral solver UI types and cycle gate |
| AUD-019 | P3 | Documentation | Closed — recursive link/anchor/path validation and reconciled docs |
| AUD-020 | P2 | Editor persistence | Closed — latest draft flushes on page exit/reload |
| AUD-021 | P0 | Solver pruning | Closed — unsafe goal-depth macro removed and proof cache invalidated |
| AUD-022 | P1 | Solver regression gates | Closed — independent inter-rooms oracle and complete frozen-optimum manifest |
| AUD-023 | P1 | Rewrite resources | Closed — disjoint expanded/generated/time allocations per lane |
| AUD-024 | P1 | Benchmarks | Closed — production adapter harness, exact limits, raw samples, immutable artifacts |
| AUD-025 | P1 | Proof mechanisms | Closed — five unproven or dominated scaffolds removed |
| AUD-026 | P2 | Efficiency evidence | Closed — exact feature toggles, exercise counters, and controlled A/B runs |
| AUD-027 | P2 | Audio defaults | Closed — fresh profiles enable effects and music at 50% |
| AUD-028 | P2 | Light theme | Closed — hue-dependent box and goal variables resolve on each piece |
| AUD-029 | P3 | Move trail | Closed — six-step opacity and size decay is explicit and testable |
| AUD-030 | P2 | Animation | Closed — clean-target adjacent-only FLIP animation |
| AUD-031 | P0 | A* proof cutoff | Closed — active-node lower bounds survive every resource cutoff |
| AUD-032 | P1 | Sequential proof limits | Closed — derived limits are clamped integer remainders |
| AUD-033 | P0 | Parallel proof | Closed — numeric caps cannot masquerade as replayable incumbents |
| AUD-034 | P1 | Preprocessing resources | Closed — time, memory, cancellation, and telemetry cover preprocessing |
| AUD-035 | P2 | Parallel telemetry | Closed — work is summed and memory peaks use an explicit conservative policy |
| AUD-036 | P2 | Benchmark decisions | Closed — elapsed/RSS vetoes and clean median-five promotion rules |
| AUD-037 | P1 | Progress reset | Closed — Stats resets progress ownership only |
| AUD-038 | P1 | Mutation feedback | Closed — dialogs await and report durable import/reset outcomes |
| AUD-039 | P1 | Editor durability | Closed — pending edits flush on every route/page exit except explicit discard |
| AUD-040 | P2 | Activity statistics | Closed — repeat completions and DST-safe local calendar ordinals |
| AUD-041 | P2 | Narrow UI/a11y | Closed — 320-pixel layout, selected states, unique labels, semantic links |
| AUD-042 | P2 | Navigation/recovery | Closed — selector continuity, offline/lazy retry, safe update placement |
| AUD-043 | P2 | Editor documents | Closed — bounded named drafts, migration, CRUD, and safe share import |
| AUD-044 | P2 | Engineering controls | Closed — executable gates, CI ownership, dependency policy, portable HPC, living reference |

## Detailed findings and implemented fixes

### AUD-001 — False move-optimal certificate from IDA*

**Former gap:** A repeated exact state could reuse an absolute root-relative
backed `f` value from a more expensive path. That value was unsafe for the new
`g`, allowing a legal 13-move route to be certified when the exact optimum was
11 moves.

**Fix:** IDA* now stores collision-checked exact state plus the lowest `g` seen
in the current contour. It prunes only when the prior `g` is no greater than the
current one, clears proof-pruning state between contours, and no longer backs
path-dependent `f` values into the transposition table. Optimal-cache schema v5
invalidates all v1–v4 proof records, including records affected by the later
goal-depth macro finding.

**Evidence:** the original two-box counterexample returns 11 moves / 4 pushes
under exact A*, contour-scoped IDA*, and the compatibility persistent mode. A
deterministic generated tiny-board sweep compares all modes with an independent
step-level exact oracle and validates every finite proof bound.

### AUD-002 — Checkpoint identity omitted the start snapshot

**Former gap:** checkpoints were keyed by board geometry but not the request's
robot and label-aware box positions, so one state could restore another state's
incumbent.

**Fix:** checkpoint schema v2 fingerprints geometry, objective, solver/tuning
context, robot position, and label-aware boxes. Parsing deeply validates the
record. A restored solution must have `cost === moves` and independently replay
to solved on the current request before it can affect search.

**Evidence:** same-geometry/different-state and altered-incumbent fixtures are
rejected; valid same-state resume remains deterministic.

### AUD-003 — Proof phases reset budgets and lost telemetry

**Former gap:** discovery, sequential proof, and each concurrent partition
could receive fresh full limits, while returned metrics omitted earlier work.

**Fix:** elapsed, expanded, and generated discovery usage is subtracted before
proof. Sequential proof receives only the remainder. Concurrent proof divides
finite state, generated-state, and memory allowances across partitions and
uses one coordinator deadline. Terminal metrics merge discovery plus every
proof partition, including current and peak memory.

**Evidence:** focused tests spend budgets in discovery before entering proof,
assert reduced proof limits, and verify aggregate counters rather than
phase-local replacements.

### AUD-004 — Nested proof messages were too shallowly validated

**Former gap:** non-finite/negative bounds and shallow solution records could
cross the nested worker boundary and influence an optimal result.

**Fix:** protocol guards require finite non-negative safe costs, complete
solutions, complete metrics, and cost consistency. Messages are bound to the
worker's active partition/execution, bounds must remain monotonic, and every
candidate is replayed against the original request before adoption. Malformed
or mismatched identities fail the worker; completed duplicate/stale terminal
messages are ignored and cannot affect a new partition.

**Evidence:** malformed bounds/solutions, wrong identities, replay-invalid
candidates, and cost mismatches cannot produce a public solved/proven result.

### AUD-005 — Daily streaks used lifetime puzzle completion

**Former gap:** a puzzle solved years earlier counted as completed on any date
when that puzzle was assigned as the daily challenge.

**Fix:** progress schema v2 adds a local-date participation ledger containing
the assigned puzzle. Schema v1 migrates safely with an empty ledger. A solve is
recorded only when the puzzle matches that local date's assignment. Daily
selection uses a DST-safe local calendar ordinal; Home refreshes at local
midnight and when a suspended tab becomes visible.

**Evidence:** historical bests do not clear today, repeated one-puzzle
assignments are recorded on separate dates, and rollover tests cover local-date
transitions without 24-hour duration arithmetic.

### AUD-006 — Shared editor URLs overwrote the saved draft

**Former gap:** opening a valid share URL loaded it into the autosaved editor
state and replaced the only local draft without an explicit decision.

**Fix:** shared URLs open as disabled, read-only previews with autosave
suppressed. The page names the preserved draft and requires **Import into
editor** before navigating to the ordinary editable route and saving the shared
puzzle.

**Evidence:** desktop and mobile browser flows explicitly import shares; a new
browser regression confirms that opening/leaving a preview preserves the draft
byte-for-byte until import.

### AUD-007 — Concurrent proof could hang or leak workers

**Former gap:** the coordinator lacked a hard remaining-time timer and silence
watchdog, ignored malformed/message-error paths, and could leak an early worker
when later construction failed.

**Fix:** lifecycle ownership begins during construction and finishes through a
single cleanup path. The coordinator registers `error` and `messageerror`,
fails malformed active messages, enforces one deadline and bounded silence
watchdog, and removes workers, listeners, timers, and abort handlers on every
exit.

**Evidence:** silence, message-error, malformed-message, abort, and partial
factory-failure tests all terminate and assert worker cleanup.

### AUD-008 — Browser checkpoint code imported `node:crypto`

**Former gap:** enabling checkpoint callbacks in a browser worker would reach a
Vite-externalized Node built-in.

**Fix:** checkpoint identity uses a deterministic portable 64-bit FNV-1a
digest. The module boundary suite computes browser worker dependency closures
and rejects Node built-ins.

### AUD-009 — IndexedDB-only sessions were undiscoverable from Home

**Former gap:** a session mirror could succeed only in IndexedDB, while Home's
Continue target read only the localStorage pointer.

**Fix:** Home begins with the synchronous local pointer and performs a bounded
IndexedDB pointer lookup. The resolver validates puzzle availability and
reconciles both tiers by newest valid generation/timestamp before upgrading the
Continue target.

**Evidence:** an IndexedDB-only session is discoverable and the newest valid
tier wins.

### AUD-010 — Preference and draft write failures were silent

**Former gap:** favorites, ratings, and editor drafts optimistically updated
while ignoring storage failure and never activating global persistence health.

**Fix:** every owned key reports failure through the shared health store.
Favorites, ratings, and editor draft saves register retry callbacks carrying
the exact failed serialized payload. The global warning displays an unsaved
state and offers **Retry saving now**.

**Evidence:** fault-injection tests cover reporting, exact-payload retry,
successful recovery, and health clearing for each persistence family.

### AUD-011 — Achievement toasts compared stale progress

**Former gap:** both pre- and post-solve achievement sets were computed from
the same closed-over progress object.

**Fix:** `recordSolvedSession` returns explicit immutable before/after
snapshots. The controller derives newly unlocked IDs from those values through
a pure helper and suppresses IDs already emitted.

**Evidence:** the first solve that crosses a threshold emits the achievement
exactly once.

### AUD-012 — Editor shortcuts overrode native text undo

**Former gap:** the window Cmd/Ctrl+Z/Y listener always prevented default,
including title, hint, and import fields.

**Fix:** global editor commands ignore input, textarea, select, and editable
content targets and are disabled during a shared preview. Grid-focused undo and
redo remain available for both Ctrl and Meta modifier variants.

**Evidence:** browser coverage distinguishes native title-field undo from
global grid undo.

### AUD-013 — Stats import was unbounded and misreported changes

**Former gap:** Stats parsed arbitrary file sizes and counted unchanged/worse
known records as updated.

**Fix:** Stats and Progress dialog share one parser with a 1 MiB byte limit, a
10,000-record limit, deep validation, and parse-before-commit semantics. Merge
reporting distinguishes added, improved, unchanged, rejected, and invalid
records; MIME and extension are hints, not trust boundaries.

**Evidence:** unit tests cover pre-read byte rejection, record limits, malformed
data, catalog rejection, and every merge category.

### AUD-014 — Editor draft deserialization was shallow

**Former gap:** malformed dimensions, difficulty, rows, or nested cells could
reach rendering and trigger a whole-app recovery prompt.

**Fix:** draft parsing now validates 3–20 integer dimensions, exact row count
and width, allowed symbols, and bounded metadata. An invalid draft is copied to
the dedicated recovery key before the active key is removed. The editor offers
download or deletion of only the quarantined draft.

**Evidence:** deep parser fixtures plus browser download/delete recovery keep
unrelated progress and preferences intact.

### AUD-015 — Monotonicity errors reversed code and message

**Former gap:** `SolverWorkerRuntimeError` call sites passed prose as the code
and the symbolic constant as the user-facing message.

**Fix:** argument order is corrected for all monotonicity checks.

**Evidence:** worker-host tests assert serialized
`ERR_SOLVER_MONOTONICITY` and the corresponding explanatory message.

### AUD-016 — Coverage gates did not protect page behavior

**Former gap:** the all-source gate allowed 58% line/statement coverage while
the high focused percentage omitted unimported TSX; browser behavior was not
represented in the coverage contract.

**Fix:** the all-source line/statement floor is raised to 60%. More
importantly, `tests/critical-route-behaviors.json` is a required, executable
matrix covering Home, Selector, Play, Editor, and Stats. Every audited P1/P2 UI
path has a named unit or browser regression, and a unit gate prevents matrix
entries from drifting away from their test source.

### AUD-017 — Boundary enforcement was narrower than documented layers

**Former gap:** regular-expression checks covered only a few solver imports and
missed export, type-only, side-effect, `require`, and dynamic imports.

**Fix:** the boundary test uses the TypeScript AST for all import forms. It
encodes allowed core/catalog/router/shared/solver/feature edges, rejects feature
cycles, retains low-level solver constraints, and audits browser worker
dependency closures. The adapter contract now permits composition adapters to
coordinate nested workers while prohibiting worker globals in algorithm
kernels.

### AUD-018 — Solver UI hooks retained type-only cycles

**Former gap:** extracted worker/progress/log hooks imported their shared types
back from `useSolverController`.

**Fix:** `solver-ui-types.ts` is the neutral type owner; the controller and all
child hooks depend on it. The feature graph cycle gate protects the result.

### AUD-019 — Documentation checks missed real drift

**Former gap:** the checker scanned only selected backticked paths in direct
`docs/` children, missing ordinary Markdown links, anchors, root files, nested
files, and uppercase `.MD` documents.

**Fix:** validation is recursive and case-insensitive across root and docs
Markdown. It parses ordinary relative links and headings/anchors as well as
backticked repository paths. Architecture, persistence, testing, and solver
integration documents now match provider/router ownership, persistence schema,
nested workers, proof budgets, checkpoint v2, and sound IDA* behavior.

### AUD-020 — Debounced editor changes could be lost on immediate reload

**Discovered during remediation:** an editable draft changed immediately before
reload could be lost because the one-second autosave timer had not fired. This
became visible in the mobile editor reload/playtest regression.

**Fix:** the editor retains refs to the latest state and current autosave
ownership and synchronously flushes an editable draft on `pagehide`. Read-only
shared previews remain excluded, so the fix does not reintroduce AUD-006.

**Evidence:** the mobile browser test edits and resizes an imported draft,
reloads immediately, and then successfully starts its preserved playtest.

### AUD-021 — Goal-depth macro pruning could discard an optimal route

**Discovered during the Solver V2 audit:** the goal-room macro treated a local
depth order as a proof obligation even when the global puzzle allowed a
different legal packing order. That made the prune unsuitable for an exact
move-optimal search and could contaminate cached proof results.

**Fix:** goal-macro analysis and pruning were removed from both exact A* and
IDA*. The classic solver versions were advanced to 2.1.0 and optimal-cache
schema v5 rejects every earlier proof record.

**Evidence:** the inter-rooms counterexample and every classic-eligible frozen
known-optimum fixture are replayed against their expected move/push totals.

### AUD-022 — Frozen fixtures did not form a complete optimum gate

**Former gap:** a few regular hand-picked boards stood in for the complete
classic-eligible corpus, and the inter-rooms failure was absent. A regression
could therefore pass while changing a known optimum elsewhere.

**Fix:** the repository now owns a 25-fixture move/push optimum manifest and a
dedicated independent step-oracle regression for inter-rooms. Both exact
engines must return its 28-move / 7-push proof with matching lower and upper
bounds.

**Evidence:** all 25 eligible frozen fixtures matched their known optima and
replayed successfully. `expert-tetris` remained correct at 38 moves / 19
pushes but took about 150 seconds in the audit environment, so its performance
is tracked as an improvement opportunity rather than a correctness failure.

### AUD-023 — Parallel rewrite lanes each received the full budget

**Former gap:** concurrent incumbent rewrites shared state and time fields in
name only. Each lane could receive the complete allowance, and generated-state
work inside bridge and permutation searches was not consistently charged.

**Fix:** one deterministic allocator divides finite elapsed, expanded, and
generated ceilings into disjoint shares, including zero-share lanes when the
budget is smaller than the worker count. Every rewrite window reports and
enforces generated work, and generated source was rebuilt from its canonical
engine source.

**Evidence:** allocator tests prove that lane shares sum exactly to the parent
budget and engine tests exhaust a deliberately small generated-state ceiling.

### AUD-024 — The V2 benchmark bypassed production behavior

**Former gap:** Sokomind benchmarks invoked the generated kernel directly,
classic requests omitted their recorded limits, warm-ups occurred in discarded
processes, child output was weakly identified, variance was discarded, peak
memory was mislabeled, and saved artifacts could be overwritten.

**Fix:** the schema-v3 harness uses the production Node solver adapter and six
explicit production profiles. Requests carry the exact recorded limits;
samples retain raw timings and min/median/max/MAD summaries; RSS fields separate
before, after, and peak observations; child exit and identity are strict;
artifacts carry repository/corpus/tuning/feature fingerprints and are immutable
unless `--force` is explicit. `--warmup=0` is preserved, and untimed isolated
preflights are described honestly rather than as JIT warm-up.

**Evidence:** unit tests cover parsing, corpus/profile coverage, request
identity, deterministic drift, and baseline promotion. A production
`sokomind-fast` ultra-tiny smoke run completed through the adapter.

### AUD-025 — Five proof mechanisms were disconnected and uncertified

**Former gap:** local-room lower-bound/deadlock, local-corral lower-bound/deadlock,
and doorway-crossing mechanisms existed behind a registry but were never part
of production proof search. Their tests established non-negativity or
registration rather than proof soundness and unique benefit.

**Fix:** the five mechanisms, dead registry, exports, caches, and misleading
tests were removed. Local-room selection did not account for every compatible
global box exchange, local-corral bounds lacked a closed-boundary proof, the
corral deadlock was dominated by active PI-corral pruning, and the doorway
bound was dominated by typed assignment.

**Evidence:** the active proof barrel now exposes only mechanisms used by the
search kernels and protected by exact-oracle tests. Future candidates must
prove admissibility or deadlock implication and demonstrate unique exercised
benefit before integration.

### AUD-026 — Solver efficiency claims lacked controlled feature ablation

**Former gap:** V2 documentation listed algorithms as improvements without a
way to disable one mechanism while holding all other search conditions fixed.
Counters also could not show whether the feature had actually executed.

**Fix:** exact A* and IDA* resolve a validated, fingerprinted nine-feature
vector. Disabled features skip preprocessing as well as evaluation, and each
feature exposes exercise telemetry. The benchmark CLI can pair an exact control
with `without:<feature>` under identical board, limits, version, algorithm, and
remaining features. Non-default IDA* vectors are rejected when checkpointing
is requested so an exhausted contour cannot cross configurations.

**Evidence:** both exact engines prove the inter-rooms optimum with every
individual feature disabled and with all features disabled. Pattern-database
A/B produced identical work on both sides: A* expanded 312 / generated 1,433
states and IDA* expanded 2,705 / generated 12,640. Both are correctly
classified as **no effect** rather than improvements.

### AUD-027 — Fresh profiles started with audio disabled and uneven gain

**Requested UX correction:** sound effects and music were opt-in, with effects
at 72% and music at 28%.

**Fix:** fresh or malformed preference records enable both channels at 50%.
The schema remains version 1 so a returning user's explicit mute and volume
choices are not overwritten. Web Audio still waits for a browser-approved
input gesture.

**Evidence:** unit and browser tests assert the fresh settings and then mute,
reload, and confirm that the explicit choice persists.

### AUD-028 — Typed pieces lost their colors in light mode

**Former gap:** box and goal color variables were declared on the board but
depended on `--piece-hue`, which existed only on descendant pieces. CSS custom
properties resolved the dependency at the wrong element, invalidating the
background and leaving light-theme pieces white.

**Fix:** every hue-dependent box variable is declared on `.box`, and every
hue-dependent goal variable on `.goal`; dark and high-contrast overrides target
the same owning elements.

**Evidence:** the browser regression requires non-empty, pairwise-distinct
computed backgrounds for A, B, and C boxes and storage goals in forced light
mode.

### AUD-029 — Move-trail age did not affect opacity or size

**Former gap:** all six trail dots used the same inset and full opacity because
an ancestor variable referenced child-only `--trail-age`; the typed
multiplication was also not portable CSS.

**Fix:** the trail component assigns explicit clamped opacity and scale values
for ages zero through five, and the pseudo-element applies both directly.

**Evidence:** a six-position browser route requires opacity and transform scale
to decrease strictly at every age.

### AUD-030 — Rapid movement accumulated transformed FLIP geometry

**Former gap:** a new movement measured the keeper while the prior WAAPI
transform was active, then cancelled the animation and saved the contaminated
rectangle. Rapid input could compound translations and make the keeper appear
to fly across the board.

**Fix:** each layout pass cancels first, measures clean grid geometry, and
compares logical positions. The transform is derived from the logical cell
delta and current cell pitch, so surrounding page reflow cannot add another
axis. FLIP runs only for a one-cell Manhattan move on the same puzzle; reset and
multi-step changes snap. Identity-guarded finish and cancel handlers release
the animation reference.

**Evidence:** rapid-input browser coverage inspects the keeper keyframes,
rejects any diagonal or longer-than-one-cell translation, then verifies the
settled slot is centered on its declared grid cell with no active animation.

### AUD-031 — A* cutoff could omit the active subtree from its proof bound

**Former gap:** A* removed the minimum-`f` node from the heap before expanding
it. If a resource limit fired during that expansion, finalization looked only
at the remaining heap and could overstate the lower bound by forgetting the
still-unresolved active subtree.

**Fix:** the active node's `f` remains the terminal lower-bound candidate until
its expansion completes. Limit and cancellation paths preserve that value and
return a bounded incumbent unless the full open-subtree invariant proves the
incumbent.

**Evidence:** focused tests cut off before and during expansion and require
finite, ordered bounds without a false optimal certificate.

### AUD-032 — Sequential proof received fractional protocol limits

**Former gap:** discovery elapsed time is fractional, so subtracting it from an
integer request timeout produced an invalid non-integer `maxElapsedMs` for the
exact proof request.

**Fix:** every derived elapsed, expanded, and generated remainder is floored,
clamped at zero, and treated as exhausted before launch when no positive share
remains. Time spent choosing and compiling the proof is subtracted again from
the launch allowance.

**Evidence:** the production sequential inter-rooms command no longer fails
request validation and proves the 28-move / 7-push optimum.

### AUD-033 — A parallel numeric cap was treated as a solution incumbent

**Former gap:** a partition's numeric exclusive upper bound could enter an
exact kernel through the route-carrying incumbent interface. The coordinator
could then report the discovery route under bounds established for a different
cost, producing a bounded 29-move result where direct exact A* proved 28.

**Fix:** exact A* and IDA* now distinguish a replay-validated `incumbent` from
an `upperBound` that carries no route. A numeric cap can prune and prove that a
partition contains no cheaper solution, but it cannot create a public solved
result. Workers emit a solution only after reconstructing and replaying one.

**Evidence:** the production two-worker Node adapter deterministically returns
the replay-valid, proven 28-move / 7-push inter-rooms route with equal bounds.

### AUD-034 — Exact preprocessing was outside resource enforcement

**Former gap:** pattern-database and deadlock-table construction occurred before
ordinary search checks, so a tiny elapsed or memory limit could be exceeded
without timely termination and terminal counters omitted retained tables.

**Fix:** both exact kernels pass one preprocessing budget through heuristic,
PDB, pattern, and deadlock-table construction. It checks cancellation,
deadline, and retained memory during construction; limit exits are terminal and
include preprocessing memory and feature telemetry.

**Evidence:** one-millisecond and constrained-memory regressions terminate
without entering unbounded search, while successful runs retain the relevant
construction and memory counters.

### AUD-035 — Parallel telemetry mixed additive work with sequential peaks

**Former gap:** summing every partition's retained-state and memory peak could
claim that sequential partitions occupied memory simultaneously, while taking
one maximum could hide work performed across partitions.

**Fix:** expanded/generated and event counters remain additive. Retained
structures and frontier/memory peaks take the maximum across sequential
partitions assigned to one worker, then conservatively sum those maxima across
concurrent workers. Elapsed time is coordinator wall time, not a sum of worker
durations.

**Evidence:** coordinator tests exercise multiple partitions per worker and
assert the documented additive/max/sum policy separately.

### AUD-036 — Benchmark acceptance ignored time, RSS, and capture provenance

**Former gap:** an apparent state-count win could be labelled an improvement
despite a material median-time or peak-RSS regression, and a partial, one-run,
dirty-worktree capture could be mistaken for a promotion baseline.

**Fix:** controlled comparisons now qualify median elapsed time and peak RSS,
apply either as a resource veto, and classify conflicting signals as mixed.
`promotableBaseline` additionally requires the complete matrix, accepted
deterministic groups, at least five timed samples, a known commit, and a clean
worktree.

**Evidence:** unit comparisons cover apparent node wins vetoed by elapsed/RSS
regressions and every promotion prerequisite. Raw samples remain in schema 3.

### AUD-037 — Stats reset owned unrelated application data

**Former gap:** the Statistics danger-zone action called the full recovery
reset, deleting preferences, favorites, ratings, drafts, sessions, timers, and
solver records despite describing a progress reset.

**Fix:** Stats now advances only the progress synchronization generation and
writes empty progress. Full-data recovery remains a separate error-boundary
operation with its own ownership and language.

**Evidence:** unit and browser tests seed every owned local/session key, reset
progress, and require byte-for-byte preservation outside the progress record.

### AUD-038 — Import/reset dialogs announced success before durable writes

**Former gap:** the Progress dialog treated callbacks as fire-and-forget and
closed or announced success even when storage rejected the write.

**Fix:** callbacks return the typed persistence outcome. The dialog awaits the
operation, disables competing mutations, preserves visible progress on
failure, and reports quota, security, or availability causes without a false
success message.

**Evidence:** browser fault injection rejects both import and reset writes and
confirms that the displayed and stored record set does not change.

### AUD-039 — Sub-second editor changes could vanish on SPA navigation

**Former gap:** the one-second autosave timer was cleared during route unmount,
and only `pagehide` flushed the newest state. Fast in-app navigation could lose
the last edits.

**Fix:** the editor keeps the newest state in a layout-synchronized ref and
flushes pending data during both page exit and effect cleanup. An explicit
discard pauses the timer and suppresses that one flush; cancelling discard
resumes it.

**Evidence:** rapid keyboard, mobile, Escape, Back, and hash-navigation tests
cover save, cancel, and explicit-discard outcomes.

### AUD-040 — Statistics represented best-record dates, not play activity

**Former gap:** a repeat completion that did not improve the personal best was
invisible, and heat-map day stepping assumed every local day lasted 24 hours.

**Fix:** progress schema 2 now carries a bounded local-date activity ledger of
distinct completed puzzles. Every solve records activity independently of the
best route. Heat maps and streak adjacency use UTC ordinals of local calendar
tuples, and stored date keys must round-trip to real calendar dates.

**Evidence:** repeat/worse solves appear on their actual days; DST-boundary and
impossible-date regressions neither skip nor invent activity.

### AUD-041 — Narrow layouts and control semantics had avoidable failures

**Former gap:** at 320 pixels Home settings could be covered, Play actions and
Help/Share clipped, completion feedback lacked selected state, random actions
shared names, and mobile navigation used scripted buttons instead of links.

**Fix:** compact layouts wrap and reserve safe areas, Play adds a touch cue,
completion choices expose `aria-pressed`, random labels include difficulty,
and mobile navigation uses canonical links. Solver technical controls move
under an Advanced disclosure while remaining keyboard-accessible.

**Evidence:** a dedicated 320 x 568 Playwright project, semantic assertions,
and representative axe scans cover the corrected surfaces.

### AUD-042 — Route continuity and recoverable loading were incomplete

**Former gap:** returning from Play lost selector page/filter/scroll/focus,
update notices could cover header actions, and offline shard or lazy-module
failures offered little recovery guidance.

**Fix:** the router retains the exact selector return hash and SPA-session list
context, restores the originating row, and offers a recent-puzzle continuation.
The update notice respects bottom safe areas; network state is explicit; puzzle
shards, workers, and lazy screens expose retry-oriented failure paths.

**Evidence:** browser routes restore query, page, focus, and scroll, exercise
offline-to-online state, retry a failed shard, and keep every narrow action in
the viewport.

### AUD-043 — One editor draft was still a product-level data-loss bottleneck

**Former gap:** even after shared previews became non-destructive, the device
still had one editable document and no way to create, duplicate, rename,
switch, or delete drafts safely.

**Fix:** the existing key now stores a deeply validated schema-v2 collection of
up to 25 named drafts with one active ID and last-saved timestamps. The legacy
single payload migrates in place. CRUD operations commit storage before
changing visible state, and shared imports create a new destination while
preserving the prior active document.

**Evidence:** round-trip, migration, limit, storage-failure, CRUD, reload, and
shared-import regressions cover the store and UI.

### AUD-044 — Assurance workflows and documentation could drift silently

**Former gap:** route coverage accepted skipped/todo names, CI duplicated the
same suite across jobs, major dependency upgrades were blanket-ignored, cluster
scripts embedded one machine layout, Markdown checks missed root links and npm
commands, and important constants were copied among narrative documents.

**Fix:** the route matrix accepts only direct executable tests; workflows have
explicit non-overlapping owners; standard and parallel proof gates run in CI
with the extended optimum scheduled separately; Dependabot surfaces majors as
individual reviews; SLURM scripts derive the checkout and accept environment
overrides; documentation validation covers root/docs links, anchors, paths,
commands, and encoding. [`PROJECT-REFERENCE.md`](../PROJECT-REFERENCE.md) maps
important APIs and generates volatile facts directly from source.

**Evidence:** synthetic skip/todo rejection, workflow/package commands, shell
syntax, and the source-reference freshness check are executable repository
gates.

## Validation evidence

| Check | Result |
|---|---|
| TypeScript | Passed |
| ESLint | Passed |
| Generated solver freshness | Passed |
| Generated catalog freshness | Passed |
| Unit suite | 1,305 passed, 0 failed |
| All-source typed coverage gate | Passed |
| Focused typed coverage | Passed: 92.87% lines, 87.62% branches, 94.02% functions |
| Generated-engine coverage | Passed: 51.66% lines, 72.10% branches, 64.85% functions |
| Critical route behavior matrix | Passed for Home, Selector, Play, Editor, Stats |
| Markdown links, anchors, and paths | Passed |
| Production build and static artifact | Passed; 9 static checks; 351,971 / 353,000 aggregate gzip bytes |
| Chromium desktop browser matrix | 59 passed |
| WebKit UI regression matrix | Passed the 6 app and 5 visual-layout checks |
| Mobile Chrome editor regression | Passed |
| WebKit editor matrix | 8 passed, 1 expected clipboard skip |
| Mobile Safari editor regression | Passed |
| Dependency advisory audit | 0 vulnerabilities |
| Frozen exact-optimum manifest | Passed all 25 eligible fixtures at their known move/push optima |
| Controlled PDB A/B | A* and IDA* both replayed and proved the 28 / 7 inter-rooms optimum on both sides |
| V2 production and memory smoke profiles | Passed with schema-3 output and enforced limits |
| Grand Hall performance guard | Passed base, mirrored, rotated, and rewrite cases in 45.2 s total |

Firefox could not start on this Windows host because its software compositor
failed before page startup. The Firefox matrix and the full multi-profile V2
baseline capture remain normal CI/release gates; the failure was environmental,
not a page assertion.

## Security, privacy, PWA, and accessibility assessment

No critical security or privacy defect was found. Positive controls include:

- no runtime backend, analytics, advertising, or third-party telemetry;
- a same-origin production CSP with objects disabled;
- production source maps disabled;
- bounded, deeply validated custom-share and progress-import payloads;
- revisioned service-worker manifests with SHA-256 shell validation;
- scope-safe cache cleanup and preservation of the last good shell;
- SHA-pinned GitHub Actions with narrow permissions;
- route focus management, live announcements, skip navigation, reduced-motion
  support, native dialogs, and representative axe coverage.

The editor shortcut accessibility defect is closed by editable-target ownership
and browser regression tests.

## Residual risk and future work

There are no outstanding findings in this audit. Exact-search changes must
continue to pass independent oracle and replay checks; cache/checkpoint schema
changes must remain fail-closed; and route behavior entries must stay linked to
executable tests. Optional product, UX, efficiency, content, accessibility, and
maintainability work belongs in
[`AUG11IMPROVEMENTS.MD`](AUG11IMPROVEMENTS.MD), not in this closed-issue ledger.

## Consolidation record

This file replaces these superseded trackers:

- REMAINING-AUDIT-ITEMS.md
- docs/COMPLETE-PROJECT-ANALYSIS.md
- docs/SokomindSolver_Audit_Issues.md
- docs/sokomind-follow-up-audit.md
- docs/solver-v2-audit-report.md

Solver specifications, implementation history, benchmarks, operational
guidance, and project context remain separate because they are not active audit
trackers.
