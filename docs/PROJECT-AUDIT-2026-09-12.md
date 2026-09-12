# Project audit - September 12, 2026

Audited commit: `0ceff3e0ecde18d295eeb06f6bac8da22197ca18` on a clean working
tree. Environment: Windows, Node 24.14.0, npm 11.9.0. CI selects Node 22.
This audit adds documentation and evidence; production code is unchanged.

The project has strong separation between the immutable game core, solver
workers, persistence, and React presentation. The build and correctness gates
run in this audit passed, but three reproduced defects remain: an incorrect DFS state key,
continued acceptance of obsolete optimality records, and inconsistent proof
metadata crossing the worker boundary. Fix the two P1 findings before treating
the current solver behavior and saved optimality labels as reliable.

The current [project reference](PROJECT-REFERENCE.md),
[solver plan](plans/solver.md), and [maintenance plan](plans/maintenance.md)
provided orientation. The former solver audit was retired during documentation
consolidation; executable source and fresh results take precedence over it.

## Implementation follow-up

All four findings have been addressed in the working tree: conservative BFS fallback
with a public DFS regression; proof-cache schema 7 with a separate storage key and
proof revision; bidirectional proof/result consistency validation with worker-client
regressions; and roadmap implementation/promotion status reconciliation. The findings
and measurements below preserve the original audited commit. Post-fix validation is
recorded separately when the implementation checks complete.

## Findings

### F1 - P1: Reachability shortcut makes DFS exhaust a solvable puzzle

**Locations:** `src/solver/search/reachability.ts`, lines 224-247;
`src/solver/search/engine.ts`, lines 871-891. The same helper also supplies
forced-push and tunnel successor keys in the classic engine.

`incrementalCanonicalCell()` assumes a previously reachable neighbor remains
connected if it has any other free neighbor. That is not a connectivity test:
an entire multi-cell region can be disconnected while every adjacent cell still
has another free neighbor. The function then returns the old minimum reachable
cell even when the keeper cannot reach it. Using this value in a transposition
key merges distinct keeper regions and can discard the only solvable branch.

Reproduced through `runClassicSearch(..., { strategy: "dfs" })`, without a
resource cutoff:

```text
OOOOOOO
O O   O
O     O
O  RXOO
OSSX  O
O O   O
OOOOOOO
```

| Configuration | Observed result |
|---|---|
| Current DFS | `unsolved`, reason `exhausted`; 3 expanded, 7 generated |
| Same DFS with the shortcut forced to return `null` | Solved in 31 moves; independently replayed |
| Current exact A* | Solved in 23 moves; independently replayed |

The 31-move control route is `LDRDRRULULUURRDLULDRDLLULDRRRDL`.
The control changed only the helper in the reproduction process, restoring its
prototype afterward; no source file was changed.

A separate minimal connectivity fixture returned dense cell **0** from the
shortcut versus **2** from full BFS, and `isReachable(0)` was false. The existing
"exhaustive" helper test at `tests/unit/reachability.test.ts`, lines 550-616,
enumerates placements on a wall-free 4-by-4 grid, which misses this case.

**Fix:** use full BFS whenever connectivity preservation has not been proved.
A degree-based guess must not determine state identity. Add the frozen public
DFS counterexample and differential cases with walls, multiple boxes, and
disconnected regions. The helper is used by DFS/Greedy; the public exact A*/IDA*
engines retain exact keeper identity and do not call it.

### F2 - P1: Old false optimality certificates survive the PI-corral fix

**Locations:** `src/shared/optimal-cache.ts`, lines 74-94 and 217-232;
`src/shared/storage.ts`, line 12.

The PI-corral correction in commit `2729067` bumped solver/checkpoint versions,
but did not invalidate the persisted optimality cache. The current cache still
accepts schema **6**, the schema used before that correction. Each record stores
only move/push counts under a puzzle ID and board fingerprint; it cannot identify
the solver or proof revision that produced the claim. Both localStorage loading
and IndexedDB hydration normalize these records as current.

Reproduction: load a pre-fix-shaped Grand Hall record with **713 moves / 248
pushes**, schema 6, and the current fingerprint `puzzle-v1:9ead120a`. It is
accepted, and `isOptimal(..., 713)` returns true. The repository's human reference
route replays successfully in **626 moves**, disproving the cached claim. This
uses a constructed historical-format record, not inspection of anyone's actual
browser storage. Git history confirms the schema predates the PI-corral fix and
has not changed since it.

**Fix:** invalidate the affected cache schema in both storage tiers and retain
a proof revision/fingerprint with future records. Cover migration from schema 6,
IDB hydration, stale-tab merges, and normal progress preservation. A board
fingerprint alone does not invalidate a proof after a solver correctness fix.

### F3 - P2: Contradictory proof claims pass validation and replay

**Locations:** `src/solver/proof.ts`, lines 87-94;
`src/solver/validation.ts`, lines 205-221;
`src/solver/worker-client.ts`, lines 377-385.

The result validator permits `solution.optimality: "proven"` with no proof.
The bounded-proof branch also fails to require unknown optimality, so a result
can simultaneously claim a positive proof gap and proven optimality. Replay
checks legality and counters, but cannot establish minimality.

On this board, `RR` solves in two moves, while `DURR` is a legal four-move route:

```text
OOOOOO
OR XSO
O    O
OOOOOO
```

Both of these injected worker results were accepted by the real
`SolverWorkerClient` and resolved with four moves and `optimality: "proven"`:

- A four-move solution without proof metadata.
- That solution with a bounded proof: lower bound 2, upper bound 4, gap 2.

The dialog's save-optimal control gates on the accepted optimality flag and an
empty initial action log (`src/features/solver/SolverDialog.tsx`, lines 57-59),
so this boundary can expose the false claim for persistence. The reproduction
injects a malformed result; the passing stock solver tests do not demonstrate
that a current built-in solver emits this particular contradictory payload.

**Fix:** enforce consistency in both directions: bounded proof implies unknown
optimality, and a proven result requires the accepted completed-proof contract.
If compatibility requires supporting legacy proof-less internal callers,
normalize their results before the public boundary instead of trusting an
unqualified flag. Add worker-client regressions, not just shape-check tests.

### F4 - P3: The active solver plan marks implemented work as not started

**Location:** `docs/plans/solver.md`, lines 36-40.

The P2 list describes the rescheduling predictor and route-diagnosis CLI as not
started. The predictor exists in `src/solver/implementations/sokomind-reschedule-predictor.ts`
and is called by `src/solver/implementations/sokomind-harvest.ts`; the diagnosis
command is registered in `package.json` and implemented in
`scripts/diagnose-solver-route.ts`. Several P1 controls also exist behind default-off
tuning values. Passing documentation lint verifies references, not these statuses.

**Fix:** distinguish implemented controls, completed experiments, and production
promotion. Preserve benchmark requirements for default-off experiments. This
avoids using the active roadmap to repeat already delivered implementation work.

## Validation evidence

| Check | Result |
|---|---|
| Generated engine and catalog freshness | Passed as unit-test prerequisites |
| TypeScript typecheck | Passed |
| ESLint | Passed |
| Documentation/reference checks | Passed before audit additions; rechecked at delivery |
| Unit suite | 2,349 passed, 0 failures |
| Production build | Passed |
| Static delivery/CSP/bundle gates | 9 passed |
| Frozen known-optimum gate | 33 passed |
| Two-worker exact-proof gate | 1 passed |
| Representative multi-puzzle gate | 4 passed |
| Grand Hall performance/replay gate | Passed in base, mirrored, and rotated orientations |
| Focused browser suite | 39 passed in 32.5 seconds |
| Live npm advisory audit | 0 known vulnerabilities reported |
| All-source typed coverage | Passed: 73.57% lines/statements, 86.17% branches, 91.72% functions |
| Additional seeded exact-search differential | 500 boards, both A* and IDA*, 0 mismatches against the core-step oracle |

The additional differential used seed `0x23891af`, 6-by-6 boards with internal
walls, and alternating generic/repeated-label and distinct typed boxes. Of 500
boards, 31 were solvable; the independent oracle explored 58,266 states in total.
Both exact engines matched the minimum move count or unsolvable outcome, and
every returned route passed canonical replay. This finite sample adds coverage;
it does not establish a universal proof of the implementations.

Reachability itself had 98.53% measured line coverage despite F1. This is a
semantic test gap, not a reason to use the coverage percentage as a correctness
certificate. React presentation relies substantially on browser tests, whose
coverage is not included in these Node coverage percentages.

The focused browser run covered desktop Chromium, mobile Chrome editor layout,
and Chromium service-worker behavior: solver discovery/playback/cancellation,
editor recovery and sharing, cross-tab persistence and reset, IDB hydration,
replay history, route focus, and offline update/cache isolation. It was not the
complete browser matrix; Firefox and WebKit were not rerun in this audit.

Grand Hall discovery retained the reviewed **893 moves / 278 pushes**,
**1,329 visited**, **8,425 generated**, **2,538 retained**, and **291 peak frontier**
in all three orientations. The separate quality rewrite returned **789 moves /
270 pushes**. The full gate took approximately **21.3 seconds**. These are
bounded, replay-verified results, not optimality claims or fresh tuning wins.

The first sandboxed advisory request failed. A subsequent authorized live
registry request succeeded, so the dependency result above is a fresh audit
response. No dependency upgrades or automated fixes were applied.

Local commands and detailed logs are in the ignored directory
`test-results/project-audit-2026-09-12`. The primary reproduction runs with:

```powershell
node --experimental-strip-types test-results/project-audit-2026-09-12/reproduce.mjs
```

The [frozen audit evidence](benchmarks/project-audit-2026-09-12.json) retains the
counterexample boards, the legal control route, and observed results independently
of those temporary logs.

## Architecture and scope assessment

- **Core and boundaries:** immutable transitions, canonical action logs,
  independently replayed solver outputs, and AST-enforced module boundaries
  provide a sound base. The new reachability shortcut demonstrates why a search
  optimization needs adversarial semantic tests in addition to type safety.
- **Persistence and offline use:** reset generations, fenced IDB transactions,
  bounded imports, and build-specific offline manifests are substantive
  safeguards. The selected browser recovery cases passed. Proof provenance is
  the specific persistence weakness reproduced here.
- **Security and delivery:** only React/React DOM are direct runtime packages.
  The application has no runtime server or account/database boundary. The
  reviewed input paths validate imported puzzle/progress data; static tests
  passed CSP and relative-asset checks. A source search found no direct dynamic
  code execution or raw HTML insertion sinks. This is a scoped review and
  advisory check, not a claim that all security defects are excluded.
- **Maintainability:** exact A*, IDA*, the classic engine, and generator
  orchestration remain the densest responsibilities. Split them only when a
  behaviorally distinct boundary warrants it; file size alone is insufficient.
  The generated engine remained reproducible, and generator/catalog source was
  not changed during this audit.

This review inspected architecture, recent solver changes, proof/checkpoint and
worker boundaries, persisted data, imports/sharing, CI, static delivery, and
representative browser behavior. It did not exhaustively prove every heuristic,
rerun the extended slow optimum fixture, or conduct a new generator-quality
qualification. The focused and generated-engine coverage gates were not rerun.

## Recommended order

1. Restore sound state identity and retain the F1 public DFS regression.
2. Invalidate obsolete proof caches and version future proof provenance.
3. Tighten result/proof consistency at the worker boundary.
4. Reconcile roadmap statuses with implemented and default-off capabilities.

Keep route quality, performance, replay legality, and exact proof as separate
acceptance criteria throughout those changes.
