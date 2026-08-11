# SokomindSolver Audit Issues

Repository: `Willpatpost/SokomindSolver`  
Re-audit date: 2026-08-10  
Current branch reviewed: `main`  
Previous audit baseline: commit `5ee1be4`  
New fix commits reviewed:

- `6315459` — concurrent proof correctness, IDA* transposition safety, execution identity
- `050e263` — preprocessing cancellation and CI consolidation
- `0e4c71d` — proof completion semantics, Infinity leak fix, full result validation in tests
- `c75c197` — ESM cycle fix, improved preprocessing cancellation ordering, async builder tests

This document supersedes the previous version of `SokomindSolver_Audit_Issues.md`.

It records the latest repository re-audit after the P0–P3 fixes were pushed.

The audit specifically re-checked:

- concurrent proof worker serialization;
- proof completion semantics;
- exhausted-partition lower-bound aggregation;
- Classic IDA* TT safety;
- default IDA* transposition behavior;
- repeated worker execution identity and cumulative telemetry;
- preprocessing cancellation;
- CI consolidation;
- adjacent proof and cancellation regressions introduced or exposed by the fixes.

---

# Executive Summary

The repository is meaningfully better after the latest fixes.

Several important items can now be considered closed:

- concurrent proof partitions are serialized per worker;
- the Classic IDA* adapter explicitly uses contour-scoped transposition tables;
- IDA* persistence is now opt-in rather than the default;
- repeated phase execution IDs are now unique and cumulative telemetry is preserved;
- PR CI duplication is substantially reduced;
- PDB preprocessing is now genuinely asynchronous and cancellation-aware.

However, **P0–P3 are not fully closed yet**.

The remaining highest-risk area is still the **parallel proof pipeline**.

The most important current issues are:

1. A bounded/limit-hit exact search can still be converted into `proof/solution`, after which the coordinator unconditionally marks that partition as exhausted.
2. Exhausted partitions are internally represented as `Infinity` in the global lower-bound calculation, and that `Infinity` can leak directly into a public `SolverProof`.
3. Concurrent-proof tests do not validate the final result with the repository's real result/proof validator, which allowed the `Infinity` bug to pass.
4. Deadlock-table cancellation is still only coarse-grained.
5. The new async cancellation implementation introduced an unnecessary ESM dependency cycle.
6. The Grand Hall cancellation scenario that motivated the P2 work is still skipped on CI.

Current status:

| Area | Verdict |
|---|---|
| P0: one partition active per proof worker | **Fixed** |
| P0: incomplete partition cannot become optimal | **Fixed** (`0e4c71d`) |
| P1: exhausted-partition lower-bound aggregation | **Fixed** (`0e4c71d`) |
| P1: Classic IDA* safe TT | **Fixed** |
| P1: TT persistence safe by default | **Fixed** |
| P1: repeated execution IDs / cumulative telemetry | **Fixed** |
| P2: cancellable PDB preprocessing | **Fixed** (`c75c197`) |
| P2: cancellable deadlock preprocessing | **Fixed** (`c75c197`) |
| P3: duplicated PR CI | **Fixed** (lint:docs added to push-to-main path) |
| Concurrent proof tests bypass full result validation | **Fixed** (`0e4c71d`) |
| Async cancellation introduced ESM dependency cycle | **Fixed** (`c75c197`) |

---

# 1. P0 — Concurrent Proof Worker Serialization

**Previous severity:** Critical / High  
**Current status:** Fixed

## Previous problem

The concurrent proof coordinator assigned several proof partitions to the same worker and posted all of their start commands immediately.

A single worker could therefore have:

```text
P0
P2
P4
```

all in flight at once.

That was unsafe because the proof worker keeps module-level mutable state:

```ts
let abortController: AbortController | null = null;
let pendingUpperBound: number | undefined;
let activePrefixCost = 0;
```

Multiple asynchronous searches could therefore overwrite each other's:

- abort controller;
- local upper-bound state;
- prefix cost.

This could corrupt:

- pruning bounds;
- cancellation;
- partition ownership;
- progress.

## Current implementation

The coordinator now creates a queue for each proof worker.

Only the first partition for a worker is dispatched initially.

The next partition is dispatched only after the current partition finishes.

Conceptually:

```text
Worker 0 → P0
Worker 1 → P1

P0 finishes
Worker 0 → P2

P1 finishes
Worker 1 → P3
```

instead of:

```text
Worker 0 → P0, P2, P4 simultaneously
```

## Verdict

**Fixed.**

The old shared-state cross-talk scenario is no longer present under normal coordinator operation.

---

# 2. P0 — Proof Completion Semantics Are Still Not Fully Correct

**Severity:** Critical / High  
**Current status:** Still open

This is now the most important remaining correctness issue.

## Root problem

The proof worker creates a synthetic incumbent:

```ts
const incumbent: ExactIncumbent = {
  solution: {
    steps: [],
    moves: initialUpperBound,
    pushes: 0,
    objective: { kind: "moves" },
    objectiveScore: initialUpperBound,
    optimality: "unknown",
  },
  cost: initialUpperBound,
};
```

This object is effectively being used as a cost sentinel.

It is not a real local Sokoban solution.

The worker then runs either exact A* or IDA* with that incumbent.

After the search returns, the worker currently does:

```ts
if (result.status === "solved") {
  const fullSolution = prependSolution(command, result.solution);

  postResult({
    type: "proof/solution",
    partitionId,
    solution: fullSolution,
    totalCost: fullSolution.moves,
  });
}
```

The important mistake is:

```text
status === solved
```

is being treated as equivalent to:

```text
partition proved / exhausted
```

Those are not equivalent.

## Why this matters

Exact A* can return:

```text
status = solved
proof.kind = bounded
```

when:

- an incumbent exists;
- a search limit is reached;
- optimality has not been proved.

IDA* behaves similarly.

Therefore this sequence is possible:

```text
partition search starts
        ↓
search hits state/time/memory limit
        ↓
exact solver has incumbent
        ↓
returns:
status = solved
proof.kind = bounded
        ↓
proof worker emits:
proof/solution
        ↓
coordinator receives proof/solution
        ↓
coordinator does:
tracker.completed = true
tracker.exhausted = true
```

The coordinator therefore still treats an incomplete partition as exhausted.

## Current coordinator behavior

On:

```text
proof/solution
```

the coordinator currently marks:

```ts
tracker.completed = true;
tracker.exhausted = true;
tracker.lowerBound = result.totalCost;
```

unconditionally.

That is too strong.

A solution event means:

```text
this partition produced an incumbent
```

not:

```text
this partition has no better solution remaining
```

## Correct protocol model

These should be separate events.

### `proof/solution`

Meaning:

```text
The partition found a valid solution / improved incumbent.
```

This should update:

- global best solution;
- global upper bound.

It should **not** automatically complete the partition.

### `proof/partition-complete`

Meaning:

```text
The partition search has terminated.
```

This should carry enough information to distinguish:

```text
proved/exhausted
bounded/limit-hit
failed
cancelled
```

## Recommended fix

After exact A*/IDA* returns:

### If a real improved solution exists

Emit:

```text
proof/solution
```

as a nonterminal incumbent update.

Then separately emit:

```text
proof/partition-complete
```

with the actual proof status.

For example:

```text
proof.kind === "optimal"
    → exhausted/proved

proof.kind === "bounded"
    → completed task, exhausted = false

status === unsolved && reason === exhausted
    → exhausted = true

status === unsolved && reason === limit-reached
    → exhausted = false
```

## Stronger protocol design

Instead of overloading `exhausted`, consider an explicit terminal reason:

```ts
type PartitionTermination =
  | "exhausted"
  | "bound-dominated"
  | "limit-reached"
  | "cancelled"
  | "failed";
```

The coordinator can then derive proof semantics from explicit state instead of reconstructing them from loosely coupled booleans.

## Recommended regression test

Create a partition search where:

```text
initial upper bound = 20
search hits maxExpandedStates
search has incumbent
exact solver returns solved + bounded
```

Assert:

```text
partition is NOT exhausted
global proof is bounded
solution.optimality !== proven
```

## Priority

**P0.**

---

# 3. P1 — `Infinity` Can Leak Into Public Solver Proofs

**Severity:** High  
**Status:** New regression introduced by the exhausted-partition fix

The new exhausted-partition aggregation logic is conceptually better internally, but its public proof conversion is incorrect.

## Current internal logic

The coordinator now uses:

```ts
function partitionLowerBound(t: PartitionTracker): number {
  if (t.failed) return 0;
  if (t.exhausted && !t.completed) return t.lowerBound;
  if (t.exhausted) return Infinity;
  return t.lowerBound;
}
```

The idea is valid:

```text
an exhausted no-solution partition should no longer constrain the unresolved minimum
```

Conceptually, it contributes:

```text
+Infinity
```

to the unresolved search frontier.

## Problem

The coordinator later computes:

```ts
const globalLower = Math.min(
  ...trackers.map((t) => partitionLowerBound(t)),
);
```

and copies that value directly into the public proof:

```ts
const proof: SolverProof = {
  objective: { kind: "moves" },
  kind: provedOptimal ? "optimal" : "bounded",
  lowerBound: globalLower,
  upperBound: bestCost,
  gap: bestCost - Math.min(globalLower, bestCost),
  algorithm: proofAlgorithmLabel,
};
```

## All-exhausted case

Suppose every partition is exhausted.

Then:

```text
partition A → Infinity
partition B → Infinity
partition C → Infinity
```

Therefore:

```text
globalLower = Infinity
```

The coordinator can return:

```ts
{
  kind: "optimal",
  lowerBound: Infinity,
  upperBound: 10,
  gap: 0,
}
```

That violates the repository's own proof contract.

The proof validator requires:

```text
optimal lowerBound is finite
optimal upperBound is finite
lowerBound === upperBound
gap === 0
```

## Bound-greater-than-incumbent case

There is another version.

Suppose:

```text
globalLower = 15
bestCost = 10
```

Mathematically that proves the incumbent optimal.

But the public proof should be normalized to:

```text
lowerBound = 10
upperBound = 10
gap = 0
```

not:

```text
lowerBound = 15
upperBound = 10
gap = 0
```

The latter violates:

```text
lowerBound <= upperBound
```

and:

```text
optimal lowerBound === upperBound
```

## Why this becomes a runtime failure

The normal solver worker host performs:

```ts
assertValidSolverResult(result);
```

before publishing a result.

Therefore a parallel proof that succeeds internally can be turned into a solver error because the final proof object is invalid.

## Recommended fix

Keep `Infinity` only as an **internal sentinel**.

At the public proof boundary:

```ts
if (provedOptimal || globalLower >= bestCost) {
  return {
    ...
    proof: {
      objective: { kind: "moves" },
      kind: "optimal",
      lowerBound: bestCost,
      upperBound: bestCost,
      gap: 0,
      algorithm: proofAlgorithmLabel,
    },
  };
}
```

For bounded output:

```text
lowerBound must be finite
lowerBound <= bestCost
```

Use something conceptually like:

```ts
const reportedLower = Number.isFinite(globalLower)
  ? Math.min(globalLower, bestCost)
  : 0;
```

although the exact fallback should reflect the strongest valid known finite lower bound.

## Recommended tests

### All exhausted

```text
all partitions exhausted
bestCost = 10
```

Require:

```text
kind = optimal
lowerBound = 10
upperBound = 10
gap = 0
```

### Bound dominates incumbent

```text
global unresolved LB = 15
bestCost = 10
```

Require the exact same normalized proof:

```text
LB = UB = 10
```

### Full validation

Run:

```ts
assertValidSolverResult(result);
```

on every coordinator result.

## Priority

**P0 / P1.**

Easy to fix, but directly affects proof validity.

---

# 4. P1 — Classic IDA* Transposition Safety

**Previous severity:** Critical  
**Current status:** Fixed

The Classic IDA* adapter now explicitly passes:

```ts
persistTransposition: false
```

That means the move-optimal Classic IDA* path no longer relies on the unproven persistent TT behavior.

## Default behavior also fixed

The core IDA* implementation now uses:

```ts
const persistTT = options?.persistTransposition === true;
```

Therefore persistence is now opt-in.

The safe default is:

```text
clear transposition table each contour
```

## Why this is the right design

Proof-producing callers cannot accidentally enable the path-dependent backed-`f` persistence optimization merely by omitting an option.

Persistent TT remains available for:

```text
bounded
experimental
first-found
non-proof
```

use cases that explicitly choose it.

## Verdict

**Fixed.**

This issue can now be considered closed for proof-producing search paths.

---

# 5. P1 — Repeated Phase Execution Identity

**Previous severity:** High  
**Current status:** Fixed

The previous version introduced:

```ts
WorkerExecutionRegistry.uniqueId()
```

but did not actually use it in `runPhase()`.

That is now corrected.

## Current implementation

`runPhase()` now does:

```ts
const executionId = run.registry.uniqueId(plan.id);
```

and consistently uses that unique execution ID for:

- registry registration;
- telemetry updates;
- active worker map keys;
- cleanup;
- worker completion.

Logical plan identity remains:

```text
direct-portfolio
prepare-board
bidirectional-forward
...
```

while execution identity can become:

```text
direct-portfolio
direct-portfolio-1
direct-portfolio-2
```

## Why this fixes the bug

Repeated discovery/harvest phases can no longer overwrite previous telemetry records in the registry.

Cumulative metrics can therefore preserve:

```text
execution 1 + execution 2 + execution 3
```

rather than only the most recent execution.

This protects cumulative:

- expanded-state accounting;
- generated-state accounting;
- remaining global budgets.

## Recommended regression test

Still worth adding:

```text
run 1 expanded = 100
run 2 expanded = 200

aggregate = 300
```

and verify remaining limits subtract the full 300.

## Verdict

**Fixed.**

---

# 6. P2 — PDB Cancellation

**Previous severity:** Medium-High  
**Current status:** Mostly fixed

This is a substantial improvement.

## New async implementation

The PDB builder now has:

```ts
buildPatternDatabaseAsync(...)
```

and periodically performs:

```ts
throwIfSolverCancelled(signal);
await delayForEventLoop();
```

after a configurable number of BFS iterations.

The current interval is:

```text
4096 BFS states
```

A*/IDA* now construct the evaluator through:

```ts
PdbHeuristicEvaluator.createAsync(...)
```

instead of the fully synchronous constructor.

## What is now fixed

The browser worker can actually process cancellation messages during PDB construction.

This directly addresses the original architectural problem where one large PDB BFS could monopolize the worker until completion.

## Remaining responsiveness issue

The check currently occurs **before** the yield:

```ts
throwIfSolverCancelled(signal);
await delayForEventLoop();
```

Suppose:

```text
signal not aborted
check passes
        ↓
await delayForEventLoop()
        ↓
cancel message is processed
signal becomes aborted
        ↓
function resumes
        ↓
another 4096 BFS iterations execute
        ↓
next cancellation check
```

Therefore the cancellation can be delayed by one additional chunk.

## Better ordering

Prefer:

```ts
throwIfSolverCancelled(signal);
await delayForEventLoop();
throwIfSolverCancelled(signal);
```

or at minimum:

```ts
await delayForEventLoop();
throwIfSolverCancelled(signal);
```

depending on the desired work-slice structure.

Also perform an immediate cancellation check at function entry.

## Work-slice improvement

A fixed iteration interval is simple, but CPU cost per BFS state can vary.

An elapsed-time slice can be more predictable:

```text
work for ~5–10 ms
yield
check cancellation
continue
```

This is not required for correctness, but would give more stable responsiveness.

## Verdict

**Mostly fixed.**

---

# 7. P2 — Deadlock-Table Cancellation Is Still Coarse-Grained

**Severity:** Medium  
**Current status:** Partially fixed

The new async deadlock-table builder does yield, but only at region boundaries.

## Current structure

Approximately:

```text
for each region
    check cancellation
    yield

    for boxCount
        enumerate cell combinations
            for label
                run isDeadlockedBFS(...)
```

The nested work inside a region remains synchronous.

## Why this matters

`isDeadlockedBFS()` can explore up to:

```text
5000 states
```

for one configuration.

One region can include:

- several box counts;
- many combinations;
- several labels;
- many BFS calls.

Therefore one region can still execute a significant amount of CPU work before the event loop gets another chance to process cancellation.

## Same check-before-yield issue

The async deadlock builder also does:

```ts
throwIfSolverCancelled(signal);
await delayForEventLoop();
```

If cancellation arrives during the yield, the entire next region can run before the next cancellation check.

## Recommended fix

Make the deadlock-table inner search cooperatively interruptible.

Potential designs:

### Option A — async BFS

Pass:

```text
AbortSignal
yield controller
```

into `isDeadlockedBFS()`.

Periodically:

```text
check cancellation
yield
```

inside the BFS loop.

### Option B — shared work budget

Use a cooperative work counter across:

```text
region enumeration
combination enumeration
BFS states
```

For example:

```text
after N operations
    await yield
    check signal
```

### Option C — elapsed CPU slice

Process work until:

```text
~5–10 ms elapsed
```

then yield.

This is probably the most responsive approach.

## Verdict

**Partially fixed.**

The original worst-case synchronous behavior is reduced, but cancellation is still not guaranteed to be prompt inside one expensive region.

---

# 8. P2 — Cancellation Testing Is Still Incomplete

**Severity:** Medium  
**Category:** Regression protection

The latest cancellation commit changed several production files but did not add dedicated tests for the new asynchronous builders.

## Current PDB tests

The existing PDB tests still exercise:

```ts
buildPatternDatabase(...)
```

the synchronous version.

They do not directly test:

```ts
buildPatternDatabaseAsync(...)
```

## Current deadlock tests

Likewise, deadlock tests primarily exercise:

```ts
buildDeadlockTables(...)
```

rather than:

```ts
buildDeadlockTablesAsync(...)
```

## Grand Hall cancellation test

The browser test:

```text
cancels a running Grand Hall A* search
```

is still skipped when:

```text
CI = true
```

This test was originally skipped because preprocessing/search could saturate the worker and make cancellation unreliable.

The P2 changes were specifically intended to improve that behavior.

Leaving the test permanently skipped means the exact behavior being fixed is not continuously verified.

## Recommended tests

### Async PDB equivalence

```text
sync result == async result
```

on representative boards.

### Async deadlock equivalence

```text
sync deadlock lookup == async deadlock lookup
```

when allowed to complete.

### Pre-aborted signal

Create an already-aborted signal.

Assert:

```text
async builder exits immediately
```

### Mid-PDB cancellation

Use a sufficiently large PDB.

Abort during the BFS.

Require prompt cancellation.

### Mid-deadlock cancellation

Use a board that produces enough table work.

Abort during construction.

Require prompt cancellation.

### Browser-level replacement

Either:

- re-enable the Grand Hall cancellation test on CI; or
- add a smaller deterministic stress board that reliably remains in preprocessing long enough to test cancellation without destabilizing the runner.

## Priority

**P2.**

---

# 9. NEW MEDIUM ISSUE — Async Cancellation Introduced an ESM Dependency Cycle

**Severity:** Medium  
**Category:** Module architecture / maintainability

The new async preprocessing implementation imports:

```ts
delayForEventLoop
```

from:

```text
search/engine.ts
```

inside:

```text
pattern-database.ts
```

and:

```text
deadlock-tables.ts
```

## Dependency cycle

The relevant chain is:

```text
pattern-database.ts
        ↓
engine.ts
        ↓
heuristic.ts
        ↓
pattern-database.ts
```

Therefore a new module cycle exists:

```text
pattern-database → engine → heuristic → pattern-database
```

## Why this may work today

ES modules support cyclic graphs, and the specific bindings currently appear to be accessed after initialization rather than eagerly during module setup.

Therefore this may not immediately crash.

## Why it should still be removed

`delayForEventLoop()` is a generic scheduling utility.

A low-level PDB module should not need to import a full search engine module merely to yield.

This creates unnecessary coupling and increases the risk of future:

- temporal-dead-zone initialization errors;
- accidental eager execution;
- bundler complications;
- harder dependency reasoning.

## Recommended fix

Move the helper into a dependency-neutral module.

For example:

```text
src/solver/yield.ts
```

or:

```text
src/solver/search/scheduling.ts
```

That module should contain only generic scheduling functions such as:

```ts
export function delayForEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
```

Then:

```text
engine
exact A*
IDA*
pattern database
deadlock tables
```

can all depend on that utility.

The utility should depend on none of the search algorithm modules.

## Priority

**P2 / P3.**

---

# 10. P3 — CI Duplication

**Previous severity:** Low-Medium  
**Current status:** Substantially fixed

The Pages workflow now skips several duplicated steps on pull requests.

## Dedicated PR Validation workflow

Continues to run:

```text
typecheck
lint
doc validation
unit tests
coverage
oracle correctness
optimality proof tests
build
multi-puzzle regression
```

## Pages workflow on PR

No longer repeats:

```text
lint
npm test
coverage
solver:multi
```

It keeps the areas it uniquely needs:

```text
dependency audit
build
browser/accessibility tests
Grand Hall performance
```

## Why this is better

The workflows now have much clearer responsibilities.

The previous duplication complaint is mostly resolved.

## Small remaining duplication

Both workflows still perform a build on PR.

That is understandable because the Pages/browser workflow needs its own local:

```text
dist/
```

unless workflows start sharing artifacts.

Not worth optimizing unless CI time becomes a real problem.

## Small consistency gap

The Pages workflow describes itself as the only gate for direct main-branch pushes/workflow dispatch.

However:

```text
lint:docs
```

exists only in the PR Validation workflow.

That means a direct push to main can theoretically bypass documentation path validation.

This is low severity.

Recommended:

```text
run lint:docs in the push-to-main path
```

or include it under the existing lint step.

## Verdict

**P3 substantially resolved.**

---

# 11. NEW TESTING GAP — Concurrent Proof Tests Do Not Validate Real SolverResult Contracts

**Severity:** High for regression detection  
**Category:** Testing

This explains why the new `Infinity` proof bug escaped.

## Current test fixtures

The concurrent proof unit tests create mock solutions conceptually like:

```ts
{
  steps: [],
  moves: 10,
  pushes: 5,
  ...
}
```

These are convenient coordinator fixtures, but they are not valid `SolverSolution`s under the repository's normal validation rules.

The real validator requires:

```text
moves === steps.length
pushes === number of push steps
objectiveScore === calculated score
```

## Consequence

The tests cannot simply run:

```ts
assertValidSolverResult(result);
```

on every result without first fixing the mock solution fixtures.

Instead, many tests currently assert only selected properties:

```text
status
proof.kind
solution.optimality
gap
```

## Why `Infinity` passed

For the all-exhausted test, the result can satisfy:

```text
proof.kind === optimal
proof.gap === 0
```

while still containing:

```text
proof.lowerBound === Infinity
```

The test passes because it never checks the full proof contract.

## Recommended fix

Create valid synthetic solutions.

For example, if a mock solution has 3 moves:

```ts
steps: [
  { direction: "...", kind: "walk" },
  { direction: "...", kind: "push" },
  { direction: "...", kind: "walk" },
],
moves: 3,
pushes: 1,
objectiveScore: 3,
```

Then add:

```ts
assertValidSolverResult(result);
```

to every coordinator success test.

Where appropriate, also run replay verification if the request and steps represent a real board solution.

## Recommended invariant

Every proof orchestration test that returns a public `SolverResult` should prove:

```text
the result is valid according to the same validator used in production
```

not merely:

```text
the field I expected has the expected value
```

## Priority

**P1.**

---

# Regression Assessment

## Confirmed successful fixes

The latest commits successfully address:

### Concurrent worker overlap

One active partition per worker is now enforced.

### Classic IDA* TT safety

Proof-capable Classic IDA* now explicitly disables persistent cross-contour TT.

### Default TT behavior

Persistence is opt-in.

### Repeated execution identity

`uniqueId()` is now integrated into `runPhase()`.

### PR CI duplication

Most redundant pull-request work has been removed.

### PDB cancellation architecture

The PDB constructor now has a genuinely asynchronous path used by A*/IDA*.

---

## New regressions or newly exposed issues

### `Infinity` public proof leak

This was introduced by the new exhausted-partition lower-bound model.

### ESM dependency cycle

This was introduced by importing a generic yield helper from `engine.ts`.

### Proof completion remains semantically unsafe

The coordinator logic was improved, but the worker-to-coordinator protocol still conflates:

```text
solver returned solved
```

with:

```text
partition proved
```

This appears to be a deeper pre-existing protocol design weakness exposed by the new audit.

---

# Updated Priority Order

## P0

### 1. Separate `proof/solution` from partition completion

A solution discovery must not automatically mean:

```text
tracker.exhausted = true
```

Use a separate terminal completion message reflecting:

```text
optimal
bounded
exhausted
limit-reached
failed
cancelled
```

### 2. Normalize public optimal proofs

Never return:

```text
Infinity
```

or:

```text
lowerBound > upperBound
```

in a public `SolverProof`.

When optimality is established:

```text
lowerBound = bestCost
upperBound = bestCost
gap = 0
```

---

## P1

### 3. Add full result validation to concurrent-proof tests

Use valid mock solutions and run:

```ts
assertValidSolverResult(result);
```

for all relevant test cases.

### 4. Add explicit bounded-solution partition test

Force:

```text
exact search returns solved + bounded
```

and verify the coordinator does not mark that partition exhausted/proven.

---

## P2

### 5. Finish deadlock-table cancellation

Add cancellation/yield checkpoints inside heavy combinatorial/BFS work.

### 6. Check cancellation after event-loop yields

Avoid performing a full new work chunk after a cancel message has already been processed.

### 7. Add async builder cancellation/equivalence tests

Test the code paths actually used by A*/IDA*.

### 8. Re-enable or replace the skipped CI cancellation test

The behavior fixed by P2 should have a continuous regression gate.

### 9. Move `delayForEventLoop()` to a neutral module

Remove the:

```text
pattern-database → engine → heuristic → pattern-database
```

cycle.

---

## P3

### 10. Add documentation validation to direct-push CI

Optional but simple.

---

# Recommended New Tests

## 1. Bounded Partition Must Not Become Exhausted

Force a partition search to terminate because of:

```text
maxExpandedStates
```

while an incumbent exists.

Expected inner result:

```text
status = solved
proof.kind = bounded
```

Expected coordinator state:

```text
completed = true
exhausted = false
```

Expected global result:

```text
proof.kind = bounded
solution.optimality = unknown
```

---

## 2. All Exhausted Proof Must Be Fully Valid

Make every partition exhaust.

Require:

```text
status = solved
proof.kind = optimal
lowerBound = bestCost
upperBound = bestCost
gap = 0
solution.optimality = proven
```

Then:

```ts
assertValidSolverResult(result);
```

must pass.

---

## 3. Dominating Lower Bound Must Normalize to Incumbent

Example:

```text
bestCost = 10
unresolved lowerBound = 15
```

Require public proof:

```text
LB = 10
UB = 10
gap = 0
```

not:

```text
LB = 15
UB = 10
```

---

## 4. Every Coordinator Fixture Must Produce a Valid SolverResult

Refactor mock solutions so that:

```text
moves == steps.length
pushes == push-step count
objectiveScore == moves
```

Then validate every result.

---

## 5. Async PDB Equivalence

For representative boards:

```text
buildPatternDatabase(...)
```

and:

```text
await buildPatternDatabaseAsync(...)
```

must produce identical lookup values.

---

## 6. Async PDB Mid-Build Cancellation

Abort during a large PDB BFS.

Require prompt `SolverCancelledError`.

---

## 7. Async Deadlock Equivalence

Compare sync and async deadlock-table lookup behavior.

---

## 8. Async Deadlock Mid-Build Cancellation

Abort inside a heavy region.

Require cancellation before the entire region/table build completes.

---

## 9. Cancellation Immediately After Yield

Construct a test where the abort occurs while:

```text
delayForEventLoop()
```

is pending.

Verify no additional full work chunk runs before the cancellation is observed.

---

## 10. Dependency-Cycle Guard

Optional architectural test/lint:

```text
low-level search utility modules must not import engine.ts
```

This can be enforced with:

- ESLint import rules;
- a dependency graph tool;
- a simple architecture test.

---

# Updated Engineering Invariant Matrix

| Component | Invariant |
|---|---|
| Proof worker scheduling | At most one active partition per worker |
| Proof solution event | Finding an incumbent does not imply partition proof completion |
| Partition completion | Only exhausted or valid bound-dominated partitions count as proved |
| Public optimal proof | `LB = UB = incumbent` and both are finite |
| Exhausted partition | Removed from unresolved minimum internally without leaking `Infinity` publicly |
| Failed partition | Blocks optimality unless otherwise resolved |
| Classic IDA* | Proof-producing runs use contour-scoped TT |
| IDA* default | Persistent TT requires explicit opt-in |
| Worker registry | Every execution has a unique lifetime ID |
| Repeated phases | Previous telemetry cannot disappear |
| PDB preprocessing | Cancellation can be observed during construction |
| Deadlock preprocessing | Heavy inner BFS/combinatorial work must yield/check |
| Event-loop yield | Cancellation is checked after control returns |
| Module layering | Low-level heuristic/PDB modules do not depend upward on search-engine modules |
| Coordinator tests | Returned public results pass the production result validator |
| CI | Direct merge/main paths retain correctness gates |

---

# Updated Overall Assessment

The repository remains architecturally strong.

The latest fixes improved several important correctness boundaries.

The strongest improvements are:

- worker serialization;
- TT safety;
- execution identity;
- PDB cancellation;
- CI separation.

The current highest-risk subsystem remains:

```text
parallel proof worker protocol
        ↓
solution-vs-completion semantics
        ↓
partition proof state
        ↓
global lower-bound aggregation
        ↓
public SolverProof normalization
```

The key lesson from this audit pass is that **proof events need stronger semantics**.

The system should explicitly distinguish:

```text
found a solution
proved a partition
terminated because of a limit
failed
cancelled
```

rather than inferring those states from:

```text
status === solved
```

and an `exhausted` boolean.

Once that protocol is made explicit and all coordinator tests validate the full public `SolverResult`, the parallel proof architecture will be significantly more robust.

---

# Final Verdict

The latest P0–P3 fixes were productive and several issues are now genuinely closed.

## Fully fixed

- one active proof partition per worker;
- Classic IDA* contour-scoped TT;
- safe IDA* default;
- repeated worker execution identity;
- cumulative telemetry overwrite issue;
- most CI duplication.

## Mostly fixed

- PDB cancellation.

## Still open

- bounded solution results can still masquerade as exhausted proof partitions;
- exhausted-partition internal `Infinity` can leak into invalid public proofs;
- deadlock-table cancellation is still coarse;
- async cancellation lacks direct regression tests;
- Grand Hall cancellation remains skipped in CI;
- proof coordinator tests do not validate full production result contracts;
- generic event-loop yielding introduced an avoidable module dependency cycle.

The next fix cycle should focus narrowly on:

```text
proof protocol semantics
+
public proof normalization
+
validation-backed proof tests
```

before adding more solver optimizations.
