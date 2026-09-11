# Sokomind project audit

Audited September 11, 2026, at commit `2b6ff7ae0e0cbf19092db205c2a165ce3ad4a2e9`.
Environment: Windows, Node 24.14.0, npm 11.9.0. The repository started and finished clean; application source was not changed.

The project has strong separation of game rules, solver execution, persistence, and presentation, backed by extensive executable checks. Two reproducible correctness issues remain: macro search paths bypass resource limits, and a particular progress conflict causes endless cross-tab reconciliation. Both are P2 issues to fix in normal development. No critical security issue was identified in the reviewed surfaces; this is a scoped source audit, not a guarantee that the entire application is defect-free.

## Confirmed findings

### 1. P2 — Apply resource limits to macro successors

Locations: [forced-push node retention](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/solver/search/engine.ts:733), [tunnel generation](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/solver/search/engine.ts:957), and [tunnel node retention](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/solver/search/engine.ts:1026).

The ordinary successor path checks memory after heuristic evaluation and checks projected retained memory before appending a node. The forced-push path evaluates and retains a child, then continues directly through `forcedNextIndex`, bypassing those checks. Tunnel successors also increment generated-state counts and retain nodes without the equivalent admission checks.

Reproduced with this one-box board:

```text
OOOOOOOOOOOOOOOO
ORX           SO
OOOOOOOOOOOOOOOO
```

Both DFS and Greedy returned a solved 12-move route with `maxMemoryBytes: 3340`, while their own terminal estimate was **13,424 bytes**. This compares the engine's estimate with its configured limit; it is not a process-RSS measurement.

A separate tunnel fixture returned `generatedStates: 8` with `maxGeneratedStates: 7`:

```text
OOOOOOOOO
OR  OOOOO
O X    SO
O   OOOOO
OOOOOOOOO
```

This affects the registered DFS and Greedy solvers and can affect the default solver's Greedy compatibility fallback. The registered exact A* solver uses a separate kernel, so these reproductions do not establish a defect in that kernel.

Recommended fix: share successor admission and accounting between ordinary, forced, and tunnel paths. Enforce generated-state limits before each increment, account for heuristic-cache growth, and check projected memory before retaining a macro successor. Add budget tests that actually exercise each macro path, including a goal reached at the budget boundary.

### 2. P2 — Complete the progress-record tie-breaker

Locations: [canonicalRecord](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/shared/progress-sync.ts:109), [record equality](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/shared/progress-sync.ts:175), and [reconciliation](C:/Users/Willp/Code/GitHub/Sokomind/SokomindSolver/src/shared/progress-sync.ts:295).

`canonicalRecord` orders records by moves, completion timestamp, and pushes, then keeps the first record when those fields tie. `sameProgress` also compares `elapsedMs`. Consequently, two otherwise identical persisted or imported records with different elapsed times have no deterministic winner: each tab keeps its own value and requests another write.

Reproduction used two same-generation snapshots containing 10 moves, 3 pushes, the same completion timestamp, and elapsed times of 1,000 and 2,000 ms. Four alternating reconciliation rounds produced revisions **2/3, 4/5, 6/7, 8/9**. Both tabs requested persistence on every round. The mounted play hook publishes those reconciliation results in response to storage events, creating repeated synchronous storage writes and React updates until one participant closes or its conflicting record changes.

Recommended fix: define an explicit deterministic tie-breaker for elapsed time, including missing values. Ensure record selection is commutative over every field used by equality. Add tests for swapped merge order, elapsed-only differences, missing elapsed values, and eventual quiescence after alternating events.

## Architecture and maintenance assessment

- **Domain boundary:** immutable game transitions in `src/core` provide one authority for parsing, movement, undo, and replay. Solver candidates and saved attempts are replayed through that core.
- **Execution boundary:** typed solver contracts, request/result validation, worker isolation, cancellation, and separate exact-search kernels make the solver easier to validate independently of React.
- **Persistence:** centralized storage ownership, bounded imports, IndexedDB fallback, revision-aware replay storage, and reset-generation fencing address meaningful recovery and cross-tab failure cases. The convergence defect above is a narrow gap in that design.
- **Delivery:** the app has no runtime server or database, only React/React DOM as direct production dependencies, lazy routes, catalog shards, a production CSP, and manifest-bound offline caches. CI uses pinned action commits and dedicated static, browser, coverage, and solver gates.
- **Main maintenance pressure:** solver complexity is distributed across typed search kernels and a generated JavaScript engine of roughly 13,000 nonempty lines. The duplicated successor bookkeeping in the first finding illustrates the risk. Consolidating budget enforcement is a more focused next step than a broad solver rewrite. Continue editing engine source and regenerating artifacts through the existing scripts.

## Verification performed

| Check | Result |
|---|---|
| `npm.cmd run lint` | Passed |
| `npm.cmd run lint:docs` | Passed; 33 Markdown files checked and generated reference current |
| `npm.cmd test` | 2,428 unit tests passed, TypeScript/build passed, 9 static tests passed |
| Chromium and service-worker browser projects, two workers | 105 tests passed, including accessibility, persistence, cancellation, offline loading, and updates |
| `npm.cmd run test:solver:proof-regressions` | 33 known-optimum tests and 1 parallel-proof test passed |
| `npm.cmd run test:solver:huge` | Passed; replay verified base, mirrored, and rotated boards |
| `npm.cmd audit --json` | Live advisory response: zero known vulnerabilities across 218 reported dependencies |
| Targeted audit reproductions | Confirmed both findings and the separate tunnel counter overflow |

Grand Hall's three discovery orientations each returned **893 moves / 278 pushes**, with identical **1,329 visited / 8,425 generated** counters. The rewrite check returned **789 moves / 270 pushes**. Total fixture time was about 22 seconds on this workstation. These are current local guardrail results, not optimality claims or a controlled performance comparison.

The initial sandboxed advisory request failed; a subsequent permitted network query succeeded. The zero-vulnerability result refers to that successful live response, not the failed request or older audit notes.

Fresh coverage measurement, Firefox/WebKit/mobile browser projects, extended known-optimum fixtures, and the complete generator/performance qualification matrix were not run. Source review sampled the major boundaries and relevant implementations; it did not inspect every line or prove every search heuristic.

## Reproduce the findings

The accompanying [audit-reproductions.mjs](C:/Users/Willp/.codex/visualizations/2026/09/11/01a090b5-5328-7343-b8c2-25b5abec7c4b/audit-reproductions.mjs) imports the repository's actual implementation, uses in-memory fixtures, and prints the observed counters and reconciliation decisions. It does not write browser storage or alter project files.

Run from the project directory:

```powershell
node --experimental-strip-types C:/Users/Willp/.codex/visualizations/2026/09/11/01a090b5-5328-7343-b8c2-25b5abec7c4b/audit-reproductions.mjs
```
