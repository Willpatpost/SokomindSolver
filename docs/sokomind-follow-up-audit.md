# Sokomind follow-up audit

This is the historical issue list gathered while porting and strengthening
Sokomind Solver. Resolved items remain documented so their regressions stay
visible. [`AUDIT-TRACKER.md`](../AUDIT-TRACKER.md) is the authoritative active
status and records the acceptance evidence for the current audit.

## Resolved in this pass

Push-count, combined, and push tie-break objectives were removed from the
public contract. A* and IDA* now optimize the same scalar move cost. Classic
A* keys every state with the exact keeper cell; only algorithms whose objective
does not depend on keeper walking may use reachable-region canonicalization.
The optimal cache migrated to schema v3; legacy records are discarded because
they predate that correctness fix and cannot prove a minimum move count.

The adapter no longer estimates memory from cumulative generated states or a
historical heap peak. It now tracks current and peak worker memory separately,
including retained/frontier states, caches, compact arenas, bidirectional
records, prepared geometry, and coordinator records. Regression tests cover
falling live memory and million-state generation without false exhaustion.

The solver dialog saves a proven record only from an empty action log, session
cloning preserves collection metadata, and lowercase `x` is rejected instead
of being normalized into a generic goal.

The editor now has readable scroll-contained cells, all 22 legal typed labels,
accessible drag/keyboard painting, robust Base64URL sharing, and an isolated
playtest with keyboard, swipe, D-pad, undo, restart, counters, and solved
feedback.

## Resolved in the current audit

### IDA* memory limits

The earlier implementation estimated only its transposition table, ignored
geometry, heuristic caches, stack, and buffers, and reported zero estimated
bytes at completion. IDA* now rejects a budget below static allocation,
enforces conservative dynamic growth estimates, and reports non-zero current,
peak, and per-category telemetry.

The outer solver worker is now created only when the solver dialog opens and is
disposed when it closes. Registration, discovery, and worker execution share
one capability validator for target, objective, labeled/generic boxes, and
partial-state support.

## Solver and worker risks

- Classic browser adapters have a termination watchdog, and blocking
  performance fixtures run in killable child processes. New synchronous solver
  entry points must preserve one of those independently enforceable boundaries.
- Hint requests remain hard-coded to `classic-astar`, but startup/result
  watchdogs, fatal worker-event handling, and synchronous ownership
  cancellation prevent them from silently overlapping the full solver.
- The editor playtest is deliberately isolated from saved sessions and the
  full solver dialog. Solver-testing a custom draft would need an explicit
  adapter bridge rather than reusing play-page persistence.
- The bidirectional lane retains every published record until its bounded phase
  ends. Frontier and state budgets cap it, but a compact parent arena would use
  less memory.
- This is a bounded anytime port, not the complete legacy director.
  Checkpoint/landmark bridge coordination would broaden coverage when exact
  forward/reverse meetings are sparse; a persistent exact lane would be needed
  before claiming eventual completeness for every solvable puzzle.
- Large structural boards reserve up to 25 seconds, but no more than 70% of a
  finite remaining run, for the low-memory structural lane before discovery.
  This keeps Grand Hall under the current aggregate memory ceiling, but a
  structural miss still starts the other lanes later than the legacy
  memory-heavier race.
- Legacy progress is batched, so state-limit termination can observe a small
  reporting overshoot, but over-limit candidates are rejected. Chromium's
  process-wide heap sample includes unrelated application memory. The adapter
  uses live engine-owned estimates and records the process sample only when it
  can identify a trustworthy injected isolate source.
- Hard discovery cases still create substantial allocation churn even when
  their live retained set is bounded. The isolated corpus benchmark has
  observed high process RSS on the typed master rooms; reducing successor
  generation and compacting legacy beam nodes remain performance priorities.

## Remaining repository and documentation debt

- The active tracker retains open work for catalog sharding, bounded large-list
  rendering, shared solver-run arbitration, and incremental generated-engine
  modularization.
- All-source, focused typed-source, generated-engine, and bundle gates now
  block regressions. The Grand Hall benchmark is a blocking CI gate and its
  synchronous work is isolated behind a hard process deadline.
- Service-worker revisions, reload-fetched shell resources, cache validation,
  scope-safe pruning, real waiting-worker activation, and offline lifecycle
  tests are in place. Route-critical assets are installed for offline refresh;
  optional Progress/Solver dialogs and both solver workers remain runtime-loaded.

## Catalog/test coverage

- Current catalog: 2,194 puzzles, 15 typed.
- The 2,162 imported puzzles are currently untyped.
- The port adds mixed typed/generic, partial-state, cancellation, memory,
  compact bidirectional-key, production Chrome, and Grand Hall orientation
  coverage.
- Future pruning work should add exhaustive tiny-state and seeded typed
  differential tests before introducing any new hard rejection.
