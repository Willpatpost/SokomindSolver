# Sokomind Consolidated Project Audit — August 11, 2026

**Status:** Remediated — all 20 recorded findings are closed in this working tree
**Base revision:** `89bc98d` (`main`)
**Audit and remediation date:** 2026-08-11
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
in the August 11 audit have been remediated. IDA* now uses sound contour-local
exact-state best-`g` dominance, checkpoint and worker inputs are treated as
untrusted, proof phases share run-wide resources, and cached proofs from the
unsafe schema are invalidated.

Product-state fixes add date-indexed daily participation, non-destructive
shared-editor previews, IndexedDB resume discovery, visible/retryable
persistence failures, correct achievement deltas, bounded imports, and scoped
draft quarantine. Architectural and test controls now enforce source layers,
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
| AUD-001 | P0 | Solver | Closed — sound IDA* dominance and optimal-cache v4 |
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

## Detailed findings and implemented fixes

### AUD-001 — False move-optimal certificate from IDA*

**Former gap:** A repeated exact state could reuse an absolute root-relative
backed `f` value from a more expensive path. That value was unsafe for the new
`g`, allowing a legal 13-move route to be certified when the exact optimum was
11 moves.

**Fix:** IDA* now stores collision-checked exact state plus the lowest `g` seen
in the current contour. It prunes only when the prior `g` is no greater than the
current one, clears proof-pruning state between contours, and no longer backs
path-dependent `f` values into the transposition table. Optimal-cache schema v4
invalidates all v1–v3 proof records.

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

## Validation evidence

| Check | Result |
|---|---|
| TypeScript | Passed |
| ESLint | Passed |
| Generated solver freshness | Passed |
| Generated catalog freshness | Passed |
| Unit suite | 1,359 passed, 0 failed |
| All-source typed coverage gate | Passed above 65% lines/statements (60% floor) |
| Focused typed and generated-engine coverage | Passed |
| Critical route behavior matrix | Passed for Home, Selector, Play, Editor, Stats |
| Markdown links, anchors, and paths | Passed |
| Production build and static artifact | Passed; 9 static checks |
| Chromium desktop browser matrix | 56 passed |
| Mobile Chrome editor regression | Passed |
| WebKit editor matrix | 8 passed, 1 expected clipboard skip |
| Mobile Safari editor regression | Passed |
| Dependency advisory audit | 0 vulnerabilities |
| Grand Hall performance guard | Passed base, mirrored, rotated, and rewrite cases in 44.2 s total |

The remaining cross-browser and long-running solver performance commands remain
normal release gates and should be recorded whenever this working tree is
released.

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
