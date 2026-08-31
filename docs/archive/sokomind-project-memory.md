# Sokomind Project Memory

**Status:** Historical provenance and implementation journal

**Last reconciled:** 2026-08-14
**Primary repository:** `Willpatpost/SokomindSolver`  

Current contracts, paths, versions, storage keys, routes, and validation commands
are authoritative in [`PROJECT-REFERENCE.md`](../PROJECT-REFERENCE.md). Historical
cluster paths and sprint plans below explain prior work only.

---

## 1. Purpose

This file preserves repository provenance and the chronological Solver V2
journal. It is useful background, but it is intentionally not a live task list.

Treat this document as history, not as a replacement for the current source
tree, tests, or `docs/PROJECT-REFERENCE.md`.

> Trust executable tests and verified current code paths over prior model statements.

---

## 2. Repository provenance

The current repository history is intentionally unusual.

1. The current codebase originated from `Willpatpost/Sokomind5`.
2. The project was downloaded as a ZIP.
3. On ODU Waterfield, the extracted directory was renamed because several older Sokomind iterations already existed locally.
4. The active local directory is:

   ```text
   /home/wpost003/alphaevolve/practice/Sokomind/Sokomind3
   ```

5. The name `Sokomind3` is incidental. It contains the newer code copied from Sokomind5 over an older local directory.
6. A new GitHub repository was then created from this imported codebase:

   ```text
   Willpatpost/SokomindSolver
   ```

7. `Willpatpost/SokomindSolver` is now the canonical active repository.
8. `Willpatpost/Sokomind5` is the source repository, not the active development target.
9. The initial SokomindSolver commit bundled the imported codebase and the initial Solver V2/Sprint 0 work. There is no meaningful Git parent containing the same imported codebase without Sprint 0.
10. Do not move current work back to Sokomind5 or rewrite Git history to manufacture a pre-Sprint-0 parent.

---

## 3. Archived pre-remediation snapshot

The bullets in this section describe the original Waterfield/Sprint 0 state.
They are retained to explain later decisions and are not current instructions.

- Canonical repository: `Willpatpost/SokomindSolver`
- Active checkout: `/home/wpost003/alphaevolve/practice/Sokomind/Sokomind3`
- Solver V2 Sprint 0: correction/finalization pass in progress
- Solver V2 Sprint 1: not started
- Production solver implementation must remain untouched during Sprint 0
- SLURM `cpu-2` jobs are pending with `Reason=Priority`
- Login-node elapsed time is nonrepresentative for strict performance gating
- Grand Hall timing waiver is provisional
- The favorite 17-box puzzle is the same puzzle as `HUGE` / Grand Hall

Preferred canonical benchmark identity:

```text
v2-17box-handdesigned
```

Suggested aliases:

```text
huge
grand-hall
```

---

## 4. Sokomind rules

### Board symbols

- `O` — wall
- `R` — robot
- uppercase dedicated letters — typed boxes
- lowercase letters — matching typed goals
- `X` — generic box
- `S` — generic goal

Reserved uppercase symbols that are not dedicated typed boxes:

- `O`
- `R`
- `S`
- `X`

The parser accepts dedicated typed boxes from uppercase `A-Z` excluding reserved symbols.

### Matching rules

- A typed box may enter only its matching typed goal.
- A typed box may not enter a different typed goal or generic goal `S`.
- Generic box `X` may enter only generic goal `S`.
- Generic box `X` may not enter typed goals.
- Repeated labels are supported.
- Same-label boxes are interchangeable for canonical state identity.

### Core transition authority

The real game transition is authoritative:

```ts
stepSnapshot(board, snapshot, direction)
```

Any exact test oracle must use the real core transition behavior unless a dense replacement has first been exhaustively proven equivalent.

---

## 5. Favorite 17-box / Grand Hall puzzle

The user's favorite 17-box hand-designed puzzle is the same puzzle as Grand Hall / `HUGE`.

```ts
[
  "OOOOOOOOOOOOOOO",
  "OaSS   S   SSbO",
  "OSCS  OOO  SDSO",
  "OX X  OOO  X XO",
  "O     OOO     O",
  "OOOO   X   OOOO",
  "O      O      O",
  "O G hOOOOOH g O",
  "O      O      O",
  "OOO         OOO",
  "OOO   X X   OOO",
  "OOOOOOOROOOOOOO",
  "O B X X X X A O",
  "O Sc       dS O",
  "OOOOOOOOOOOOOOO"
]
```

Former deterministic Grand Hall regression result (retained as historical
context; see `PROJECT-REFERENCE.md` for the current guardrail):

- Moves: `1066`
- Pushes: `322`
- Visited states: `1616`
- Generated states: `9329`
- Retained states: `3077`
- Peak frontier: `330`

These values describe the deterministic search regression and are separate from whether a full benchmark child process completed under its outer timeout.

---

## 6. Solver structure

### Production adapter

Primary adapter:

```text
sokomind-solver
```

Known metadata:

- Version `1.1.0`
- Objective: moves
- Quality: bounded
- Web-worker based
- Supports typed, generic, and partial states
- Nondeterministic because portfolio lanes can race
- Returns `optimality: "unknown"`

It aims for the best replay-verified route found within limits. It is not currently a move-optimal proof solver.

### Production portfolio

The production solver orchestrates:

1. Structural analysis / prepared board
2. Plan-macro beam
3. Ultimate direct portfolio
4. Optional bidirectional lanes
5. Bounded solution rewriting
6. Classic fallback
7. Replay verification

Known algorithms include:

- push A*
- weighted push A*
- push Greedy
- push beam
- push beam restarts
- bounded push DFS
- push IDA*
- FESS
- plan-macro beam
- bridge A*
- solution-window rewrite
- ultimate portfolio

The rewrite pipeline includes push permutation, bridge A*, and move-window rewriting. Accepted candidates are replay-verified.

### Classic solvers

Classic implementations include DFS, Greedy, A*, and IDA*.

Relevant files:

```text
src/solver/search/compiled-board.ts
src/solver/search/assignment.ts
src/solver/search/heuristic.ts
src/solver/search/model.ts
src/solver/search/reachability.ts
src/solver/search/priority-queue.ts
src/solver/search/engine.ts
src/solver/search/ida-star.ts
src/solver/search/deadlocks.ts
```

---

## 7. Important solver findings

### A* identity is not mathematically exact

Classic A* uses a double 32-bit Zobrist-derived string as its sole equality key.

It is highly collision-resistant, but not collision-free. A collision could merge distinct states and invalidate an absolute `optimality: "proven"` claim.

Planned fix:

- Add an exact collision-free state codec.
- Use exact BigInt state equality for A*.
- Keep Zobrist only as an optional accelerator or for non-proof search.

### IDA* identity is already collision-free

IDA* uses an exact canonical box signature plus robot state.

Sprint 1 should not migrate IDA* identity merely for consistency.

### A* does not currently use the walk lower bound

Current classic A* priority is:

```text
moves + push assignment lower bound
```

It does not currently call `minimumWalkToFirstPush()`.

Adding a walk lower bound to A* is a new heuristic enhancement, not a correction to current A* behavior.

### IDA* does use the walk lower bound

IDA* currently combines assignment with a first-push walk estimate.

The helper excludes boxes already on matching goals. That can make the bound inadmissible because an unfinished puzzle may have an optimal route whose first push moves a currently correct box.

Planned correction:

- Consider all boxes, including boxes on matching goals.
- Require valid, unoccupied support and destination cells.
- Respect normalized typed-goal compatibility.
- Use a cheap Manhattan lower bound without another BFS.
- Return zero if no candidate can be safely identified rather than claiming deadlock.

### A* reopening exists

A* can reopen a state when a lower-cost path is found.

This is important because the combined heuristic may be admissible but inconsistent.

Correctness depends on:

- admissibility
- stale-node suppression
- reopening
- exact state identity

### Redundant A* child flood

Classic A* computes a child keeper flood whose result is unused in the A* branch.

This optimization is deferred to Sprint 2 so Sprint 1 remains correctness-focused.

### Proof-safe pruning

Only sound pruning rules may be used in proof paths.

Known conservative families include:

- static typed dead cells
- fully blocked 2×2 deadlocks
- freeze deadlocks
- closed diagonal proofs
- proof-safe pattern databases
- exact sealed corral proofs
- proven commitments

Ordering and topology heuristics must not silently become proof pruning.

---

## 8. Production engine notes

Production engine source files are in:

```text
src/solver/implementations/sokomind-engine/source/
```

Source order:

```text
state.js
memo.js
metrics.js
topology.js
board.js
heuristic.js
deadlock.js
analysis.js
push-generation.js
solver-search.js
```

They are concatenated by:

```text
scripts/prepare-sokomind-engine.mjs
```

Generated bundle:

```text
src/solver/implementations/sokomind-engine/engine.generated.js
```

Never edit `engine.generated.js` directly.

The production engine contains dense cells, typed tokens, same-label symmetry, packed identities, occupancy bitsets, rooms, tunnels, articulation points, doorway flow, support dependencies, goal access, commitments, local room/corral search, multiple deadlock families, pattern databases, reverse pulls, macros, multiple search algorithms, bidirectional search, rewriting, and extensive counters.

---

## 9. Solver V2 target architecture

The V2 plan preserves the production discovery portfolio and adds a separate exact proof layer.

Target modes:

```ts
type SokomindMode =
  | "fast"
  | "quality"
  | "optimal";
```

Planned request options:

```ts
interface SokomindRequestOptions {
  readonly mode: "fast" | "quality" | "optimal";
  readonly proofAlgorithm: "auto" | "astar" | "ida-star";
  readonly deterministic: boolean;
  readonly maximumIncumbents: number;
  readonly harvestElapsedMs: number;
  readonly proofParallelism: number;
  readonly idaReachabilitySnapshots: "all" | "periodic" | "none";
  readonly idaSnapshotPeriod: number;
}
```

Planned proof types include bounded, optimal, and unsolvable proof outcomes with lower and upper bounds and algorithm identification.

Later protocol work must update contracts, validation, exact-key allowlists, worker protocol, progress phases, worker host/client, and replay verification paths.

The validation layer rejects unknown fields, so contract and validation updates must be coordinated.

---

## 10. Exact-state codec plan

Planned file:

```text
src/solver/search/exact-state.ts
```

Token:

```text
token = labelId * cellCount + cellId
```

The codec must support:

- zero boxes
- one-cell boards
- up to 30 boxes
- typed and generic labels
- repeated labels
- same-label interchangeability
- exact round-trip decoding for tests
- validation of unknown labels, invalid cells, duplicate cells, malformed identities, and box-count mismatches

Label IDs must be deterministic and based on sorted normalized goal labels.

A* uses exact BigInt identity.

DFS and Greedy may retain string Zobrist keys because they do not claim proof optimality.

IDA* also uses collision-free exact BigInt identity for proof search.

---

## 11. Exact oracle

The independent move-level oracle is implemented in:

```text
tests/support/exact-solver-oracle.ts
```

The oracle:

- use `stepSnapshot()` for all transitions
- handle already-solved roots
- return exact move and push values
- returns `null` move/push values for an unsolvable state
- use exact canonical deduplication
- avoid duplicate authoritative implementations

Current API shape:

```ts
export interface OracleResult {
  readonly exactMoves: number | null;
  readonly exactPushes: number | null;
  readonly statesExplored: number;
}

export function exactRemainingMoves(
  board: CompiledSearchBoard,
  initialRobot: number,
  initialBoxes: readonly DenseBox[],
): OracleResult;
```

It is test-only and deliberately independent of solver heuristics, deadlock
detectors, and compiled neighbor traversal.

---

## 12. Solver V2 implementation status

The original Sprint 0–14 sequence has been implemented and then audited. It
is no longer an active task checklist. Current behavior is authoritative in
`docs/solver-v2-progress.md`, benchmark methodology is authoritative in
`docs/solver-v2-benchmarks.md`, and the original proposal remains in
`docs/solver-v2-spec.md` as design history.

The August 11 audit established these important deviations from that proposal:

- IDA* uses contour-local exact-state best-`g` dominance and never reuses an
  absolute backed `f` as a transposition bound.
- Unsafe goal-depth macro pruning is disabled and affected proof-cache schemas
  are invalidated.
- Five disconnected local-room, local-corral, doorway, and registry scaffolds
  were removed because they lacked proof, unique utility, or both.
- Exact-search optimizations have internal feature controls and exercise
  counters; an optimization is not called beneficial without controlled A/B
  evidence.
- The production, exact, rewrite, worker, and checkpoint paths share enforced
  run-wide limits and replay validation.

---

## 13. August 11 audited state

Solver V2 is represented by:

```text
CLAUDE.md
docs/solver-v2-spec.md
docs/solver-v2-progress.md
docs/solver-v2-benchmarks.md
scripts/benchmark-solver-v2.ts
tests/fixtures/solver-v2/benchmark-corpus.ts
tests/fixtures/solver-v2/baseline-v0.json
```

Current validation evidence:

- TypeScript, ESLint, generated-source checks, production build, documentation
  validation, and all nine static-delivery checks pass.
- The unit suite passes 1,381 tests.
- All 25 frozen known-optimum fixtures match exact A*; `expert-tetris` remains
  a performance warning because its proof needs an extended run.
- The independent `inter-rooms` oracle and both exact kernels agree at 28
  moves / 7 pushes, including the all-features-off and individual-off matrix.
- Grand Hall base, mirrored, rotated, and rewrite performance guards pass with
  stable route and state counters.
- The schema-3 benchmark harness records exact limits, identity, raw samples,
  replay/proof acceptance, RSS, and immutable artifact provenance. Historical
  `baseline-v0.json` remains evidence only and is not a current baseline.

---

## 14. Benchmark requirements

Every benchmark fixture should be an immutable row snapshot or resolve to one.

Every result should include fixture group, board hash, dimensions, floor count, box count, solver and version, full configuration and limits, status, optional proof/optimality fields, metrics, elapsed time, counters, and verification state.

Important rules:

- Construct metadata before launching a child process.
- Preserve attempted configuration on timeout/error paths.
- Record parent-side elapsed time for child timeouts.
- Do not mark an unverified solution as solved.
- Do not use nondeterministic portfolio timing or exact state counts as strict cross-machine correctness gates.
- Deterministic route/state-count regressions may use exact gates.

---

## 15. Historical Waterfield HPC context

This section records the August 4 cluster snapshot. Re-query SLURM before using
node, partition, priority, or availability claims operationally.

### Intended login-node use

Use the login node for:

- editing
- Git operations
- lightweight unit tests
- typechecking
- linting
- small exact-oracle tests
- metadata generation
- job submission and monitoring

Avoid repeated sustained solver workloads there.

### Current SLURM state

Recent `sinfo` showed a degraded `cpu-2` partition with failed, down, powered-down idle, and allocated nodes.

Submitted job:

```text
JobId=25206
Partition=cpu-2
State=PENDING
Reason=Priority
Priority=1
```

Meaning:

- SLURM accepted the job.
- It is waiting due to priority.
- This is not proof that provisioning failed.

A request error was discovered:

```text
ReqTRES=cpu=2,mem=1M,node=1
```

The job requested one megabyte of memory.

Use explicit memory requests, such as `--mem=1G` for a shell canary and several gigabytes for solver runs.

### Canary workflow

Use a shell-only canary first:

- `cpu-2`
- one node
- one task
- one CPU
- 1 GB memory
- five minutes
- no Node, npm, repository, `crun`, or solver

Inspect:

```bash
squeue -p cpu-2
sprio -j <job-id> -l
squeue --start -j <job-id>
scontrol show job <job-id>
sinfo -R
sacct -j <job-id> --format=JobID,JobName,Partition,State,ExitCode,Elapsed,AllocCPUS,ReqMem,NodeList
```

If it runs, create a second environment canary and discover the actual Node module:

```bash
module avail
module spider node
```

Waterfield application execution may require `crun`.

### Temporary policy if SLURM remains unavailable

- Continue Sprint 0 metadata corrections on the login node.
- Run only lightweight correctness/build work there.
- Do not use login-node elapsed time as a strict performance gate.
- Record the huge timing criterion as a waiver with evidence when appropriate.
- Preserve deterministic route, move, push, state-count, and replay evidence.
- Defer dedicated-node timing capture.
- Do not let infrastructure indefinitely block Sprint 1 after Sprint 0 metadata is fixed.

---

## 16. Claude Code operating rules

Claude should receive prescriptive, sprint-scoped instructions.

1. Read root `CLAUDE.md`, `docs/solver-v2-spec.md`, `docs/solver-v2-progress.md`, this file, and relevant integration/benchmark docs.
2. Verify repository root, branch, working tree, latest commit, and sprint scope.
3. Implement only one sprint.
4. Do not begin the next sprint automatically.
5. Use read-only review subagents where useful.
6. Do not silently redesign architecture.
7. Never:
   - weaken a timeout or test
   - exclude a failing fixture
   - edit the generated engine directly
   - claim proof without completed proof
   - use weighted/beam search as proof
   - equate push-optimality with move-optimality
   - rely on hash-only equality for mathematical proof
8. Run required commands and report exact outcomes.
9. Use one focused commit per reviewed sprint or correction.
10. Distinguish PASS, FAIL, and WAIVED WITH EVIDENCE.

---

## 17. Trust and review protocol

Trust evidence, not a model globally.

Evidence hierarchy:

1. Executable tests using the real game engine
2. Exact current code path
3. Formal invariant or correctness argument
4. Reproducible benchmark evidence
5. Model recommendation
6. Model confidence or eloquence

For exact-search changes, ask:

1. Can two distinct states compare equal?
2. Can a proof heuristic exceed true remaining moves?
3. Can a lower-cost path be suppressed?
4. Can incomplete search report `proven`?
5. Can the oracle disagree with `stepSnapshot()`?
6. Can a route bypass replay verification?
7. Are timeouts being treated as proof?
8. Are ordering heuristics being used as proof pruning?

---

## 18. Legacy Sokomind history

The project has multiple earlier iterations, including older local folders and earlier Python/browser-oriented work.

Retain these principles:

- Older implementations are historical background.
- They are not authoritative for the current TypeScript Solver V2 architecture.
- Useful algorithms, puzzle data, and lessons may be ported only after verification against current typed rules and the real core engine.
- Do not copy ordinary Sokoban assumptions into typed Sokomind without validation.
- Do not infer authority from an older folder name.

The complete details of older Python/browser implementations are not fully reconstructed here. Add them when their source or design notes are reviewed.

---

## 19. Archived Sprint 0 next actions

This checklist is preserved as historical input. The implemented and audited
state is summarized in Section 12 and the current project reference.

1. Finish Sprint 0 corrections:
   - provenance documentation
   - benchmark schema upgrade
   - limit preservation
   - board hashes and immutable identity
   - fixture grouping
   - canonical 17-box identity
   - corrected baseline

2. Diagnose SLURM with a properly sized shell-only `cpu-2` canary.

3. Avoid repeated full large-solver runs on the login node.

4. Rerun lightweight Sprint 0 verification.

5. Create one focused Sprint 0 corrective commit.

6. Produce a final Sprint 0 report.

7. Begin Sprint 1 only after explicit review and approval.

---

## 20. Archived Sprint 1 start criteria

These criteria governed the original staged proposal and no longer gate current
development.

Sprint 1 may begin when:

- provenance is documented
- all benchmark paths preserve limits
- immutable board identity is recorded
- the 17-box fixture is canonically identifiable
- required non-timing checks pass
- huge timing passes or is formally waived with evidence
- no production solver implementation changed during Sprint 0
- the working tree is clean
- a focused Sprint 0 correction commit exists
- the user explicitly authorizes Sprint 1

Sprint 1 must not modify the production `sokomind-solver` adapter or generated engine.

---

## 21. Maintenance rule

Do not add current status or mutable constants here. Update
`docs/PROJECT-REFERENCE.md` through its source generator instead. Amend this
historical journal only when repository provenance needs correction.

Historically, this document tracked:

- canonical repository or local path
- sprint status
- benchmark schema
- canonical fixture names
- deterministic regression values
- exact-search correctness findings
- Waterfield execution policy
- major architecture decisions
- completed sprint commits

Do not let this file silently become stale.
