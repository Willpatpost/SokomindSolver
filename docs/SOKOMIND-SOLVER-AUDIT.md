# SokomindSolver Technical Audit and Flagship Solver Roadmap

> **Repository:** `https://github.com/Willpatpost/SokomindSolver`  
> **Reviewed branch:** `main`  
> **Audit snapshot:** commit `07411a8c109e7c82c3956fea126f33b5c81d1b09`  
> **Audit date:** September 9, 2026  
> **Primary audience:** maintainers, Codex, and future solver-development agents  
> **Status:** engineering audit and roadmap; not a claim of optimality or a replacement for executable tests

## Implementation progress — September 9, 2026

The audit below retains its original snapshot. Completed P0 work is tracked here:

- **P0.1:** Rescheduling docs and source comments now describe physical-box
  eligibility, including repeated labels, and preserve historical unique-label
  measurements as historical evidence.
- **P0.2:** The public Grand Hall browser regression now requires at most
  800 moves / 270 pushes, canonical replay, observed rescheduling, and shared
  state/generated/estimated-memory limits. Three serial Chromium measurements
  returned 793/270; the strengthened test also passed in Firefox and WebKit.
- **P0.3:** [Current milestone evidence](benchmarks/grand-hall-rescheduling.md)
  separates the 503/236 isolated repair from the 793/270 public result and records
  request limits, raw samples, source hashes, and descriptive timings.

Validation: 2,367 unit tests, typecheck, lint, documentation checks, production
build/static checks, the Huge orientation/rewrite guardrail, and the three
strategic-analyzer browser cases in Chromium, Firefox, and WebKit passed.
The complete application browser suite and coverage gates were not rerun for
this P0 pass. Search behavior is unchanged; engine edits correct comments only.

### Follow-up: preserve repair improvements at budget cutoff

The budget investigation found that the rescheduler had a 520/242 route before
the shared 200,000-state cutoff, but the coordinator stopped the worker before
its terminal message and retained the earlier 793/270 route. Repair now publishes
complete improvements during execution; the coordinator independently replays
and retains its best publication while continuing within the original limits.
Candidates arriving at the limit are still rejected, and cancellation semantics
are unchanged. No allocation, pruning, or proof policy changed.

The controlled Node comparison improves **793/270 to 520/242** with identical
200,000 expanded states, 746,911 generated states, and 123,457,142 peak estimated
bytes. The public browser gate is now **550 moves / 245 pushes**. Three repetitions
of all three strategic browser cases passed in each of Chromium, Firefox, and
WebKit (27 tests). See [phase evidence and reproduction](benchmarks/grand-hall-rescheduling.md)
and the new `diagnose:quality-budget` script for the baseline and rejected
local-window allocation ablation.

Follow-up validation passed: all 2,371 unit tests and all three coverage gates,
33 frozen-optimum cases plus the parallel-proof regression, multi-puzzle and
Huge guardrails, the 27 focused browser runs, typecheck, lint, build/static
checks, generated-engine consistency, and documentation validation. The full
application browser suite was not rerun.

### Follow-up: offline structural route recoverability

`diagnose:planner-route` now observes first-push ranking/selection, returned macro
endpoints, outer pruning, and beam retention without supplying the reference to
the solver. The reviewed 503/236 Grand Hall route loses its opening push at
first-push selection: rank 21 of 27, with eight pushes selected and none moving
that box. The observed and control searches have identical routes and deterministic
work; the planner's own 893/278 route passes a full positive-control trace.
See [route recoverability evidence and limitations](benchmarks/planner-route-recoverability.md).

Validation passed all 2,377 unit tests and all three coverage gates, typecheck,
lint, generated-engine/documentation checks, build/static checks, Huge and
multi-puzzle guardrails, 33 frozen-optimum cases and parallel proof, and all nine
focused strategic worker browser cases across Chromium, Firefox, and WebKit.
The complete application browser suite was not rerun.

### Follow-up: reject simple branch widening

A five-fixture sweep of branch allowances 6, 8, 10, 12, and 16 found no route
improvement. Grand Hall worsens from 893/278 to 1,116/292 at eight; ten and twelve
exhaust the bounded frontier, and sixteen exhausts the 60,000 generated-state
budget without a solution. The sixteen-branch root selection represents the
reference's opening box but still excludes its required direction. The later
trace is capped, so it provides no complete later-search classification.
See [branch-diversity evidence and reproduction](benchmarks/planner-branch-diversity.md).

Production defaults remain unchanged. The offline diagnostic now accepts a
branch allowance and can trace an external reference when its control is unsolved.
All 2,377 unit tests, typecheck, lint, and documentation checks passed for this
follow-up; browser and performance guardrails were not rerun.

Next: evaluate fixed-width direction diversity or walk-to-support ordering,
including a disabled control and broader-corpus checks. Distinct-box coverage
alone does not preserve useful directions, and selecting the reference opening
has not been shown to recover the improved route.

---

### Resource-policy follow-up beyond the original roadmap

Inspection confirmed that quality-mode whole-box rescheduling still inherited
20k/35k memory-class work caps despite its existing retained-memory guard and
the coordinator's live shared-memory checks. Quality rescheduling now uses its
allocated work budget and those memory checks independently. Window/optimal-mode
allocations, fast mode, replay, deadlines, generated limits, and cutoff handling
are unchanged. No constants were simply raised.

Public Grand Hall measurements at 384/768/1536 MiB improve 713/248 to 673/242,
693/248 to 573/248, and retain 520/242 respectively. Overall estimated peaks stay
69.86/83.04/117.74 MiB; the benefit is additional productive work, not substantially
greater simultaneous memory use. See [full results, stop sequences, and safety
analysis](benchmarks/quality-memory-policy.md).

The lower-memory before and after runs expose a pre-existing proof-label
inconsistency: they claim optimality despite shorter verified routes. This work
preserves exact-proof behavior as requested and records the anomaly explicitly.
Investigating those proof claims is a correctness priority separate from further
planner/resource-policy experiments.

Validation passed 2,385 unit tests and all three coverage gates, typecheck,
lint, documentation/generated checks, build/static checks, 33 frozen-optimum
cases and parallel proof, multi-puzzle/Huge guardrails, and nine focused browser
worker cases across Chromium, Firefox, and WebKit. Full application browser
coverage was not rerun.

### Proof-claim correction

The lower-memory anomaly was traced to PI-corral hard pruning: its detector
incorrectly classifies Grand Hall's replay-solvable root as deadlocked. That
eliminated the entire search and turned an arbitrary incumbent into an apparent
optimum. The shared exact-feature resolver now disables this rule even when
explicitly enabled. Both A* and IDA* have a regression using a verified shorter
route as a counterexample; valid exact proofs remain supported.

Sokomind 1.2.0, exact A*/IDA* 2.2.0, and IDA* checkpoint schema 3 supersede the
affected versions. Old schemas are rejected by both normal loading and direct
resume. New public runs at 384/768 MiB retain 673/242 and 573/248, now with
unknown optimality and bounded proof metadata at the elapsed cutoff. The old
claims are preserved only as explicitly invalid historical benchmark evidence.
See [corrected results](benchmarks/quality-memory-policy.md).

Correction validation passed all 2,386 unit tests and three coverage gates,
33 frozen-optimum cases and parallel proof, build/static/typecheck/lint/docs
checks, and 12 focused browser-worker tests. The 384 MiB unknown-optimality
regression passes in Chromium, Firefox, and WebKit. Full application browser
coverage was not rerun.

## 1. Purpose of this document

This document captures a full-project technical review of SokomindSolver, with special attention to the flagship **Sokomind Solver** implementation.

It is intended to be checked into the repository and used as a durable engineering brief. In particular, it is written so that Codex or another coding agent can read it before changing solver behavior and understand:

- what the project is;
- how the architecture is organized;
- how the flagship solver actually works;
- which correctness guarantees must not be weakened;
- what the current Grand Hall performance evidence shows;
- where the solver is losing route quality;
- where the solver is spending time;
- which newer results materially change earlier conclusions;
- which documentation/comments are already stale relative to current code;
- what should be improved next;
- what should **not** be changed without proof and regression evidence;
- how future improvements should be benchmarked.

This is not merely a high-level review. It should be treated as a roadmap and constraint document for future solver work.

---

# 2. Executive summary

SokomindSolver is substantially more mature than a typical Sokoban hobby project.

It is effectively three systems sharing a common domain core:

1. a polished static Sokoban/PWA application;
2. a solver experimentation and verification framework;
3. a sophisticated flagship bounded solver with structural planning, macro search, bidirectional discovery, local route rewriting, whole-box rescheduling, and optional exact proof.

The strongest part of the project is **correctness engineering**.

The most important architectural property is that the solver is **not authoritative over game legality**. Solver candidates are converted back into canonical game actions and replayed through the immutable core transition system before they can be accepted. Exact proof is also kept separate from bounded discovery quality.

The flagship solver is technically ambitious and contains several genuinely strong ideas:

- typed-box-aware planning;
- prepared board analysis;
- structural macro planning;
- guided push portfolios;
- checkpoint continuations;
- compact bidirectional frontiers;
- macro generation;
- keeper reachability analysis;
- deadlock checks;
- diversity-aware beam selection;
- bounded route rewriting;
- move-aware repair;
- whole-box transport rescheduling;
- optional A*/IDA* exact proof;
- resource-aware nested workers;
- extensive deterministic telemetry and regression gates.

However, the main flagship weakness is now clear:

> The solver is much better at **optimizing a constrained global schedule** than at **discovering a high-quality global schedule from scratch**.

This is strongly supported by Grand Hall.

The fast structural discovery path remains around:

- **893 moves**
- **278 pushes**

The historical local rewrite path produces:

- **789 moves**
- **270 pushes**

A previously supplied human reference was:

- **626 moves**
- **248 pushes**

The newer whole-box rescheduler can now transform the reviewed incumbent into:

- **503 moves**
- **236 pushes**

and that result is independently replay verified.

That is the most important solver result in the current repository.

It means the project has crossed an important threshold: the constrained optimizer is no longer merely cleaning up a poor route. It is capable of finding a route substantially better than the old human reference without using that human route as a lookup.

Therefore the next flagship research direction should **not** primarily be another round of scalar heuristic tuning.

The next major objective should be:

> Feed the long-range scheduling information exposed by successful rescheduling back into pre-solution discovery, while keeping it advisory and replay-safe rather than turning it into unsound hard pruning.

At the same time, the solver should reduce the amount of information it discards during macro/beam compression, especially keeper-arrival information and strategically important intermediate states.

The second major problem is runtime.

The flagship can produce good bounded results, but the old product target of a high-quality Grand Hall solve within roughly three seconds has not been established. Profiling shows that much of the cost is not in the number of top-level beam states but in macro intermediate expansion, reachability work, doorway scheduling, dynamic deadlock analysis, and associated allocation/GC.

Finally, the project has reached a complexity level where **documentation drift and solver-maintenance risk** deserve explicit attention. The current code allows repeated-label boxes to participate in rescheduling, while several comments and benchmark documents still describe unique-label-only eligibility.

---

# 3. Scope of the audit

The audit covered the project at four levels.

## 3.1 Application architecture

Reviewed areas include:

- React application structure;
- route composition;
- puzzle catalog organization;
- static deployment model;
- persistence;
- replay;
- editor;
- progress systems;
- Solver Lab;
- game/session core;
- browser worker isolation;
- PWA/static build behavior;
- CI and testing strategy.

## 3.2 Solver framework

Reviewed areas include:

- solver contracts;
- validation;
- verification;
- worker client/host boundaries;
- classic solver family;
- exact-search safeguards;
- resource limits;
- deterministic benchmarking;
- proof handling;
- telemetry.

## 3.3 Flagship Sokomind Solver

Reviewed areas include:

- `sokomind-solver.ts`;
- `sokomind-plans.ts`;
- `sokomind-legacy.ts`;
- tuning;
- budget tracking;
- worker registry;
- nested engine worker;
- generated legacy engine;
- structural macro beam search;
- beam selection;
- Pareto state handling;
- keeper-arrival handling;
- guided discovery;
- checkpoint continuations;
- bidirectional search;
- rewrite logic;
- whole-box rescheduling;
- Grand Hall guardrails and benchmark evidence.

## 3.4 Testing and benchmark evidence

Reviewed areas include:

- exact oracle tests;
- known optimum tests;
- proof regressions;
- multi-puzzle solver tests;
- Grand Hall performance gate;
- browser solver tests;
- rescheduling tests;
- module-boundary tests;
- coverage configuration;
- CI workflows;
- benchmark documentation.

---

# 4. Project-level assessment

## 4.1 Overall maturity

The repository is not just a puzzle UI wrapped around a solver.

It contains a substantial application architecture with:

- a pure immutable game core;
- a large puzzle catalog;
- asynchronous board sharding;
- accessibility-conscious board rendering;
- persistent progress;
- replays;
- replay comparison;
- achievements;
- guided journey features;
- editor workflows;
- hints;
- solver controls;
- Solver Lab;
- PWA behavior;
- browser tests;
- performance tests;
- benchmark tooling;
- static GitHub Pages deployment.

The solver is one subsystem of a broader application rather than the owner of the domain model.

That is a very strong architectural choice.

---

# 5. Core domain architecture

The most important design decision in the entire repository is the separation between:

- **static board geometry**;
- **dynamic game snapshot**;
- **session/history/persistence**;
- **solver output**.

The core owns game truth.

## 5.1 `ParsedBoard`

The parsed board contains immutable geometry such as:

- board rows;
- floor;
- walls;
- goals;
- labels;
- initial robot;
- initial boxes.

This geometry is independent of React, workers, persistence, audio, and solver code.

## 5.2 `GameSnapshot`

The dynamic snapshot contains:

- robot position;
- box positions and stable box identities;
- move count;
- push count;
- solved state.

This is the authoritative dynamic state consumed by the game and solver boundaries.

## 5.3 `stepSnapshot()`

`stepSnapshot()` is one of the most important correctness functions in the repository.

It performs a single move without session history.

Properties worth preserving:

- blocked movement returns a no-op transition;
- box pushes are validated against floor and occupancy;
- pushed box identity remains stable;
- successful push leaves the keeper on the box's former cell;
- move/push counters are exact;
- solved state is recomputed from canonical board goals;
- optional deadlock display logic is advisory and does not change legality.

The exact post-push keeper position matters greatly for:

- future legal pushes;
- PI-corral reasoning;
- reachability;
- move-count optimality;
- proof safety.

Any future solver optimization that canonicalizes or discards this information must be explicit about whether it is being used only in a non-optimal first-solution context.

## 5.4 Persistent undo history

Undo history is implemented as a persistent linked structure rather than repeatedly copying entire action histories.

That matters for long Sokoban routes.

It keeps:

- core updates cheap;
- replay representation canonical;
- long sessions practical.

## 5.5 Canonical action logs

The canonical `U/D/L/R` action log is shared across:

- autosave;
- replay;
- shareable links;
- solver playback;
- persistence;
- comparison tools.

This is excellent because it prevents a proliferation of semi-compatible route formats.

---

# 6. Solver verification boundary

The strongest single safety property in the solver architecture is:

> Solver output is treated as untrusted input.

`verifySolverSolution()` independently:

1. validates the request;
2. validates solution protocol shape;
3. replays every direction through `stepSnapshot()`;
4. checks that each step is legal;
5. checks whether the claimed step kind is actually walk or push;
6. counts pushes independently;
7. checks replayed move count against the declared count;
8. checks replayed push count against the declared count;
9. checks that the final state is solved.

This must remain a hard architectural boundary.

No future engine should be permitted to bypass replay because:

- its own state model is "equivalent";
- it already counted pushes;
- it uses a trusted legacy kernel;
- it has a proof object;
- it was produced by an exact search.

Even exact search should continue to be independently replayed before public acceptance.

---

# 7. Application/module architecture

The repository documents and enforces a deliberate dependency direction.

At a high level:

```text
catalog ----\
             +--> game/features --> App
core -------/

core <------ solver contracts
shared -----> features
router -----> application composition
experience -> UI only
```

Important architectural facts:

- `src/core` does not import React, storage, sound, animation, or solver code.
- `src/solver` depends on core model types but not UI state.
- feature modules consume lower-level layers.
- browser worker entry points are prevented from importing Node built-ins.
- feature dependency cycles are tested.

This is stronger than ordinary documentation because `tests/unit/module-boundaries.test.ts` parses TypeScript imports and checks the architecture.

That test should be preserved and expanded whenever new major solver modules are extracted.

---

# 8. Static/PWA architecture

The application is intentionally serverless.

There is no:

- API server;
- database;
- runtime backend;
- account system;
- server-side solver.

The GitHub Pages output is portable and built with relative asset paths.

The repository also includes:

- service worker behavior;
- offline caching;
- metadata;
- installability;
- repository-subpath-safe routing/assets;
- static artifact validation.

This matters to solver architecture because every production solve must work within browser constraints.

That is why:

- worker isolation;
- memory ceilings;
- nested worker support;
- cancellation;
- browser bundle boundaries;
- no `eval`;
- no `importScripts`;
- no server fallback

are first-class concerns.

---

# 9. Testing and CI assessment

Testing is one of the strongest parts of the project.

## 9.1 Unit coverage

The repository contains broad unit coverage for:

- core rules;
- validation;
- solver contracts;
- exact search;
- proof behavior;
- persistence;
- generated engine behavior;
- strategic analyzer behavior;
- rescheduling;
- module boundaries.

Coverage thresholds also distinguish:

- typed TypeScript/TSX source;
- focused typed source;
- generated legacy engine source.

That is useful because generated engine coverage can otherwise be hidden by strong coverage elsewhere.

## 9.2 Browser tests

Playwright coverage includes:

- application flows;
- mobile behavior;
- accessibility;
- persistence;
- service worker;
- solver determinism;
- Solver Lab;
- solver interaction;
- replay comparison;
- strategic analyzer;
- editor;
- statistics;
- layout.

The fact that solver behavior is exercised in browser workers is particularly important.

Node-only performance evidence cannot substitute for browser evidence when the actual product runs in browser workers.

## 9.3 Solver correctness gates

Important commands include:

```bash
npm run test:solver:oracle
npm run test:solver:optimal
npm run test:solver:proof-regressions
npm run test:solver:known
npm run test:solver:known:extended
npm run test:solver:parallel
npm run test:solver:multi
npm run test:solver:huge
```

These are meaningful because they test different classes of failure.

## 9.4 Benchmarks

The V2 benchmark harness records:

- solver/profile identity;
- fixture identity;
- limits;
- raw samples;
- min/median/max;
- MAD;
- RSS;
- peak RSS;
- solver metrics;
- replay result;
- proof result;
- known optimum comparison;
- commit identity;
- dirty-tree identity;
- tuning identity.

That is the correct direction for solver experimentation.

Elapsed milliseconds should remain descriptive rather than correctness proof because machine/environment variance is unavoidable.

---

# 10. Flagship solver architecture

The "Sokomind Solver" should not be thought of as one search algorithm.

It is an orchestrated portfolio.

The broad production flow is:

```text
request
  ↓
typed conversion / legacy state
  ↓
board preparation + strategic analysis
  ↓
structural plan lane
  ↓
direct / continuation / bidirectional discovery
  ↓
verified incumbent
  ↓
optional harvesting of diverse incumbents
  ↓
window / permutation / move rewrite
  ↓
whole-box rescheduling
  ↓
optional exact proof
  ↓
replay-verified result
```

Different modes may skip parts of this pipeline.

---

# 11. Solver adapter responsibilities

The flagship adapter is split into several meaningful responsibilities.

## 11.1 `sokomind-legacy.ts`

Responsible for:

- translating typed snapshots into the legacy engine representation;
- validating legacy analysis payloads;
- validating checkpoints;
- reconstructing paths;
- replaying candidate paths through core rules;
- converting accepted legacy paths to typed `SolverSolution`.

This file is a critical containment boundary.

## 11.2 `sokomind-plans.ts`

Responsible for:

- constructing immutable worker plans;
- allocating discovery resources;
- determining beam widths;
- determining structural plans;
- constructing bidirectional plans;
- constructing checkpoint continuation plans;
- constructing harvest plans;
- constructing rewrite plans;
- constructing rescheduling plans;
- dividing budgets.

This is essentially solver policy configuration.

## 11.3 `sokomind-solver.ts`

Responsible for orchestration:

- worker lifecycle;
- phase transitions;
- resource aggregation;
- progress;
- timeouts;
- watchdogs;
- worker failure handling;
- compatibility fallback;
- incumbent harvesting;
- refinement;
- proof coordination.

It should remain the public orchestration entry point rather than accumulating low-level search logic.

---

# 12. Flagship execution phases

## 12.1 Preparation

Large/structural puzzles receive a preparation phase.

This can produce:

- prepared geometry;
- topology;
- distance tables;
- structured-clone-safe board data;
- strategic analysis;
- recommendations;
- strategic-plan package.

Prepared analysis is useful because repeated worker lanes can avoid repeating expensive board setup.

The prepared data is cloned into isolated search workers and mutable worker-local caches are rehydrated privately.

This is a sound design.

## 12.2 Structural lane

A puzzle is classified as structural when it crosses configured box/floor thresholds.

The structural lane runs before the general portfolio and receives:

- a bounded head start;
- a fraction of total state budget;
- a fraction of elapsed time;
- structural macro configuration;
- beam limits;
- macro limits;
- analysis plan data.

The structural lane is intentionally incomplete.

That is acceptable because it is a bounded discovery path, not a proof engine.

## 12.3 Discovery portfolio

Discovery may include:

- direct guided search;
- forward bidirectional search;
- reverse bidirectional search;
- checkpoint continuations.

The exact lane mix depends on:

- worker count;
- memory;
- analysis recommendations;
- remaining state budget.

## 12.4 Checkpoint continuations

The structural lane can return high-value partial states/checkpoints.

The adapter can continue from these instead of restarting all discovery from the root.

This is a good idea conceptually because difficult Sokoban structure often becomes clearer after a partial evacuation/packing phase.

However, current evidence suggests these continuation lanes are not yet the source of the strongest quality gains.

## 12.5 Bidirectional lanes

The solver includes compact forward/reverse frontier modes.

Meetings are not trusted automatically.

The adapter reconstructs a candidate route from retained records and replay verifies it.

That separation must remain.

## 12.6 Fallback

If nested worker behavior is unavailable or all first-found lanes fail, a classic cooperative search can be used as a compatibility/breadth fallback.

This is reasonable.

A compatibility fallback should remain logically separate from the flagship's performance claims.

---

# 13. Fast mode versus quality mode

Fast mode is intentionally first-solution oriented.

It avoids:

- harvesting;
- expensive comparison;
- post-solution rewriting;
- proof.

On Grand Hall, the structural path returns the known reviewed 893/278 route.

Quality mode may continue beyond first solution through:

- diverse incumbent harvesting;
- local rewrite;
- whole-box rescheduling;
- optional exact proof.

This distinction is conceptually clean.

One future concern is product labeling: UI/help text should be clear that "quality" means bounded improvement, not proven global optimality.

---

# 14. Exact proof family

The repository retains classic exact A* and IDA* implementations for move-optimal proof on eligible boards.

Important proof safeguards include:

- exact keeper position where move cost requires it;
- admissible lower bounds;
- replay-valid incumbents;
- exclusive upper-bound semantics;
- proof-aware resource exits;
- contour-scoped IDA* dominance;
- bounded preprocessing;
- feature-specific correctness tests;
- versioned proof records;
- board fingerprints;
- known optimum regression fixtures.

This is excellent.

The flagship bounded solver should continue to hand verified incumbents to exact proof when requested, rather than trying to blur the distinction between bounded search and proof.

---

# 15. Deadlock and pruning discipline

The project has a healthy history of rejecting tempting but unsafe optimizations.

Examples include disabling/rejecting:

- a PI-corral implementation that inferred keeper region from the wrong position;
- same-box tunnel collapsing that could skip a necessary stop;
- aggressive pattern/deadlock abstractions that produced false positives;
- globally unsafe goal-depth pruning;
- other "obvious" hard guards that did not survive counterexamples.

This discipline matters more than raw search speed.

For future solver work:

> Any new hard prune must be treated as proof code.

That means it needs:

1. a mathematical safety argument or equivalent invariant;
2. positive tests showing it activates;
3. negative/counterexample tests showing it does not over-prune;
4. replay-valid results with and without the feature;
5. controlled benchmarks proving usefulness.

Soft ordering heuristics do not need proof of admissibility, but they should not silently become hard rejection conditions.

---

# 16. Structural planner behavior

The structural planner is currently one of the most important sources of both strength and weakness.

It reasons about:

- assignment;
- doorway flow;
- evacuation;
- packing order;
- topology;
- goal accessibility;
- staging;
- import/export flow;
- box continuation;
- macro endpoints;
- strategic task progress.

This is useful high-level reasoning.

However, the planner still behaves predominantly like a **push-centric planner** even though the public objective is **moves**.

---

# 17. The move-objective mismatch

The structural scoring logic includes a term approximately of the form:

```text
score =
    pushCost
  + planMoveWeight * totalMoves
  + weighted heuristic/structural terms
```

The default `planMoveWeight` is currently very small.

The historical audit correctly observed that large differences in keeper walking may be worth only a fraction of a push in the structural score.

This is a real issue, but it is not the deepest current issue.

The deeper issue is:

> A better move weight cannot recover a route that the candidate generator never retained.

---

# 18. Candidate-space loss is more important than scalar tuning

The structural planner:

1. generates legal first pushes;
2. ranks them;
3. reserves some distinct-box diversity;
4. expands selected pushes into macro endpoints;
5. heavily compresses candidates;
6. selects beam survivors.

Long macro endpoints are valuable for reducing depth, but they can hide strategically important intermediate states.

Current behavior may preserve ordinary one-push alternatives only for a limited subset of selected first pushes when longer endpoints exist.

This creates an information bottleneck.

A strategically useful handoff can disappear before:

- the outer beam;
- move-aware tie handling;
- future doorway reasoning;
- keeper-arrival comparison

ever gets to evaluate it.

This is likely one of the most important reasons that route quality remains weak in first-pass discovery.

---

# 19. Keeper-arrival information

Current source already contains a promising response to this problem.

The engine includes structures such as:

- push/move Pareto records;
- bounded Pareto maps;
- keeper-arrival maps;
- approach-distance information;
- approach-side information;
- move-aware transposition options.

This is exactly the right direction.

For a move objective, two states with the same box layout may have very different future value depending on:

- exact keeper location;
- accessible side of the next box;
- doorway side;
- support-square access;
- walking distance to next productive push;
- whether the keeper is trapped in a low-value region.

The solver should preserve more of this information where doing so materially improves route quality.

---

# 20. Beam diversity

The beam selector already does more than simple top-N ranking.

It includes diversity across:

- heuristic bands;
- push classes;
- milestone classes;
- structural feature classes;
- mobility/topology/evacuation/etc.

This is good.

The next step should be to add **move-meaningful diversity** rather than only structural diversity.

Candidate diversity should increasingly consider:

- keeper approach side;
- next productive box;
- doorway side;
- support-access class;
- box-work phase;
- move-over-push Pareto position;
- expected walking to next useful push.

The goal is not to explode the beam.

The goal is to spend a small diversity reserve on states that structural scoring otherwise collapses together.

---

# 21. Grand Hall as the flagship diagnostic

Grand Hall is the most useful single diagnostic fixture in the repository because it stresses:

- many boxes;
- room structure;
- transport;
- typed boxes;
- staging;
- doorway flow;
- long keeper travel;
- multi-phase planning;
- assignment;
- route rewriting.

The reviewed fast result is currently approximately:

- **893 moves**
- **278 pushes**

This is replay valid and orientation stable under the existing deterministic guardrail.

Historically, a full local rewrite improved that to:

- **789 moves**
- **270 pushes**

The supplied human reference was:

- **626 moves**
- **248 pushes**

Earlier diagnosis showed that the biggest gap between 893 and 626 was **walking**, not merely pushes.

That already suggested that the structural planner was choosing workable box schedules but producing inefficient keeper movement.

---

# 22. The most important new result: 503 / 236

The repository now contains a stronger result than the earlier audit.

The whole-box rescheduling engine can produce approximately:

- **503 moves**
- **236 pushes**

from the reviewed Grand Hall incumbent under the dedicated repair path.

The browser test independently converts the result and verifies it with the canonical solver verifier.

This result matters much more than a small beam or heuristic gain.

It proves several things.

## 22.1 The human reference is not a ceiling

The old 626/248 human route is no longer the best known bounded route represented by the project.

The engine can do better under a constrained optimization model.

## 22.2 The low-level move-cost machinery is strong

The rescheduler uses exact keeper travel in the restricted search.

That suggests the engine is capable of excellent local/global movement optimization when the box schedule is constrained enough.

## 22.3 The primary weakness is planning, not mechanics

If a constrained optimizer can transform 789 into 503, then the biggest remaining problem is not "the solver does not understand Sokoban moves."

It is that the original discovery stage chooses a much weaker global order/staging plan.

## 22.4 Long-horizon repair is more valuable than local tweaking

The leap from 789 to 503 dwarfs the gains observed from:

- small move-weight changes;
- isolated scalar tuning;
- simple path canonicalization;
- small move windows.

That should strongly influence future roadmap prioritization.

---

# 23. Whole-box rescheduling algorithm

The current rescheduler is one of the most interesting components in the project.

At a high level:

1. start from a complete replay-valid solution;
2. convert the solution into box-push events;
3. select one box to free;
4. preserve the relative push sequence of the other boxes;
5. search over all legal ways the selected box can be moved while satisfying the fixed event sequence;
6. price exact keeper travel;
7. use admissible lower bounds inside the restricted problem;
8. accept a shorter route only after verification;
9. repeat across boxes/rounds.

This is **not global Sokoban optimality**.

It is a restricted optimization problem.

But that restricted problem is powerful because it optimizes a box's entire long-range journey rather than a small local window.

---

# 24. Why rescheduling works so well

The rescheduler attacks exactly the kind of failure that a local beam planner struggles with.

Examples include:

- moving a box too early;
- moving it too far;
- staging it on the wrong side of a room;
- revisiting the same box repeatedly;
- causing unnecessary keeper crossings;
- locking in inefficient door usage;
- forcing later detours.

A local macro search may individually justify each push while still producing a poor **global box-work schedule**.

Rescheduling can reorganize one box's entire transport relative to all other fixed pushes.

That is why it can remove enormous amounts of walking and redundant work.

---

# 25. The key strategic conclusion

The best next research direction is:

> Use rescheduling results as a source of **planning knowledge**, not merely as a post-processing phase.

This does **not** mean hardcoding the final rescheduled route.

It means deriving general features from successful repair.

Examples:

- long-range box phase order;
- which boxes should be delayed;
- which boxes should cross a doorway before others;
- useful temporary staging zones;
- support-square requirements;
- keeper-side requirements;
- approximate room-transfer ordering;
- likely "work this box now / later" decisions;
- whether a box benefits from one continuous transport phase;
- when a box should temporarily move away from its target.

These should initially be soft signals.

They should not authorize hard pruning until proven safe.

---

# 26. Suggested planning feedback loop

A future research pipeline could look like:

```text
root board
  ↓
cheap structural analysis
  ↓
produce multiple partial box-agenda hypotheses
  ↓
run bounded discovery
  ↓
obtain first incumbent
  ↓
reschedule incumbent
  ↓
extract improved schedule features
  ↓
re-seed / re-rank another bounded discovery pass
  ↓
verify any improved incumbent
```

This would turn rescheduling into a teacher for discovery.

The key challenge is keeping this bounded and general.

It should not turn into puzzle-specific memorization.

---

# 27. Rescheduling eligibility changed recently

The current source behavior is broader than some documentation/comments describe.

Current code allows rescheduling whenever there is at least one box.

The rescheduler collects box indices from all label groups.

The unit suite explicitly checks that repeated-label boxes are eligible.

This means documentation that says:

- only unique-label roles are eligible;
- interchangeable-only puzzles stay on local rewrite only;
- repeated-label groups are excluded

is stale.

This should be corrected immediately.

---

# 28. Documentation drift that should be fixed

At the audit snapshot, these concepts are inconsistent across code/docs/comments:

## 28.1 Repeated-label eligibility

Current behavior:
- repeated-label boxes can be rescheduled.

Stale descriptions:
- unique labels only;
- interchangeable groups excluded.

## 28.2 Rescheduling support helper

`supportsBoxRescheduling()` now effectively means:
- state contains at least one box.

Some comments still imply:
- conditional support based on uniqueness.

## 28.3 Quality-pipeline comments

Some orchestration comments refer to preserving the old local policy for interchangeable-only puzzles.

That no longer describes current behavior.

## 28.4 Benchmark narrative

The Grand Hall rescheduling document records an earlier 647 milestone and older eligibility assumptions.

The repository now also contains the stronger 503/236 test expectation.

The benchmark narrative should clearly distinguish:

- historical milestone;
- current isolated rescheduler result;
- current end-to-end public adapter result;
- current runtime budget.

---

# 29. Runtime remains the main product-level weakness

The solver has made stronger progress on route quality than on end-to-end latency.

The old product ambition of approximately:

- ≤650 moves;
- within roughly 3 seconds in browser

should now be split into two independent goals.

## 29.1 Quality goal

The isolated constrained repair path has passed the old move-count target by a wide margin.

## 29.2 Runtime goal

The repository has not established a 503-class or 650-class result within ~3 seconds from the raw board in the public browser solver.

The current public quality-worker test allows a much larger total budget.

Therefore:

> The old combined target should no longer be described as "not solved" in a single dimension.

Quality is much closer to solved.

Latency is not.

---

# 30. Profiling observations

Earlier Grand Hall CPU profiling showed a striking shape:

- relatively few top-level visited states;
- enormous macro intermediate expansion;
- very large reachability call count;
- nontrivial GC;
- significant doorway scheduling time;
- significant deadlock time;
- significant heuristic time.

The important implication is:

> The engine is not slow merely because the beam is too wide.

A large amount of CPU is spent evaluating/constructing successors that never become retained search states.

This is a major optimization opportunity.

---

# 31. Macro expansion cost

A structural state may perform many:

- first-push analyses;
- targeted macro expansions;
- sequence macro expansions;
- intermediate guards;
- reachability floods;
- doorway schedule evaluations;
- deadlock checks;
- assignment calculations.

Only a small number of resulting endpoints survive.

This means optimization should focus on:

- cheaper rejection;
- better reuse;
- incremental analysis;
- avoiding duplicate macro work;
- cheaper reachability;
- preserving the most strategically valuable intermediate endpoints.

Simply increasing/decreasing beam width does not address this.

---

# 32. Dense doorway traversal result

One historical optimization prototype replaced repeated generic `floorNeighbors` traversal in doorway scheduling with dense precompiled neighbor arrays.

The reported deterministic result preserved:

- 893 moves;
- 278 pushes;
- visited count;
- generated count;

while improving median runtime by roughly 12% in the reported local experiment.

This is exactly the kind of optimization worth continuing:

- same search semantics;
- same route;
- same deterministic counters;
- lower per-state overhead.

Performance work should favor this category before introducing algorithmic risk.

---

# 33. Recommended runtime work

Prioritize these runtime areas:

## 33.1 Reachability reuse

Look for opportunities to:

- reuse reachable regions across sibling pushes;
- reuse support distances;
- incrementally update occupancy-dependent reachability;
- avoid materializing full path maps when only distance/reachability is needed;
- defer actual path reconstruction until candidate retention.

## 33.2 Macro cheap path

The historical adaptive cheap macro path was not meaningfully active on Grand Hall because its eligibility was too narrow.

Rather than globally lowering macro effort, consider:
- cheap screening for all candidates;
- widening only when structural uncertainty is high;
- bounded endpoint confidence;
- box-specific widening.

## 33.3 Doorway schedule memoization

Current memoization is useful.

Measure:
- hit rates;
- key construction cost;
- memory;
- redundancy between doorway schedule and structural analysis caches.

## 33.4 Incremental structural features

Expensive structural values that change locally after one push may be incrementally repairable.

Candidates include:
- assignment deltas;
- doorway flow deltas;
- local goal-access changes;
- local dynamic-deadlock neighborhoods.

## 33.5 Allocation reduction

The engine should continue moving hot-path structures toward:
- typed arrays;
- arenas;
- preallocated queues;
- compact identities;
- bounded caches.

This has already worked well in parts of the codebase.

---

# 34. Resource accounting is unusually strong

The adapter attempts to account for:

- expanded states;
- generated states;
- frontier;
- retained states;
- worker memory;
- prepared board memory;
- coordinator record memory;
- cache memory;
- compact arenas;
- browser process samples.

It also avoids summing Chromium's process-wide memory once per worker.

That is thoughtful and should be preserved.

One caution:

Estimated JS memory is necessarily approximate.

Do not treat deterministic memory estimates as exact heap measurement.

Use them as:
- safety ceilings;
- comparative metrics;
- regression indicators.

---

# 35. Worker orchestration strengths

`runPhase()` has several strong properties:

- worker lifecycle is centralized;
- message protocol is validated;
- failure and `messageerror` are handled;
- active workers are terminated on completion;
- cancellation propagates;
- watchdogs exist;
- phase deadlines exist;
- shared resource limits are checked;
- candidate paths are replayed before acceptance;
- bidirectional meetings are reconstructed centrally;
- worker telemetry is aggregated.

This is a mature orchestration layer.

Avoid putting more search logic into it.

Its job should remain:
- policy;
- lifecycle;
- accounting;
- verification coordination.

---

# 36. The biggest engineering-maintenance risk

The typed application architecture is clean.

The flagship engine internals are much harder to maintain.

There are effectively two solver ecosystems:

## 36.1 Modern typed solver stack

Under TypeScript modules:
- exact search;
- scheduling primitives;
- verification;
- contracts;
- worker orchestration;
- proof infrastructure.

## 36.2 Legacy-derived flagship kernel

Under classic-script-like JS source:
- parser;
- board analysis;
- macros;
- heuristics;
- search;
- rescheduling;
- legacy helpers.

These files share lexical scope and are concatenated into a generated engine artifact.

This is operationally controlled by:
- source preparation;
- checked-in generated output;
- generation consistency tests.

But it increases cognitive load.

---

# 37. Do not rewrite the legacy engine all at once

A wholesale conversion to TypeScript would be risky.

The engine contains many tightly coupled invariants that are currently protected by benchmark behavior.

A safer migration strategy is:

1. identify logically independent primitives;
2. extract one primitive;
3. create focused tests;
4. preserve generated behavior;
5. enforce module boundary;
6. benchmark;
7. continue.

Good extraction candidates include:

- Pareto record containers;
- keeper-arrival selection;
- heap/arena helpers;
- rescheduling algorithm;
- strategic contract evaluation;
- telemetry helpers;
- budget objects;
- beam selection.

Avoid starting with:
- core macro generation;
- deadlock kernel;
- plan search loop.

---

# 38. Current regression-gate gap

The current repository protects several important historical results.

However, the strongest new 503/236 result appears in a fresh rescheduling-worker browser test rather than as a strict **end-to-end public quality adapter** acceptance requirement.

The public quality-worker test currently accepts a much looser result threshold.

This means a future change could theoretically:

- preserve the isolated rescheduler;
- degrade orchestration/budget allocation;
- stop the public adapter from reaching 503-class routes;
- still pass the loose public quality assertion.

That is a gap.

---

# 39. P0 recommendation: add an integrated 503-class quality gate

Create a dedicated end-to-end regression fixture for the public `sokomind-solver` adapter.

The gate should:

1. start from the Grand Hall board, not a saved route;
2. use the real public worker/adapter path;
3. run quality mode;
4. verify that rescheduling actually executes;
5. require independent canonical replay;
6. record exact request limits;
7. assert a reviewed upper bound significantly stronger than 900 moves;
8. separately record time rather than making brittle machine-specific timing a correctness criterion.

The exact accepted move threshold should be chosen after stable repeated measurements.

Do not immediately require exactly 503 if:
- current integrated pipeline does not deterministically reach it;
- CI variance changes which incumbent is repaired.

Instead create tiers such as:

```text
correctness requirement: replay valid
quality requirement: <= reviewed bound
deterministic benchmark: exact counters where appropriate
timing: descriptive / scaled sanity guard
```

---

# 40. P0 recommendation: fix documentation/comments

Before further solver changes, update:

- engine README;
- Grand Hall rescheduling benchmark;
- comments around `supportsBoxRescheduling`;
- quality refinement comments;
- project reference if generated;
- solver status if eligibility is described there.

The code should be the authority.

Documentation should accurately state:

- repeated-label boxes are eligible;
- rescheduling is a restricted optimization;
- it preserves other-box event ordering for each selected repair;
- it is not a global optimality proof;
- current best reviewed isolated Grand Hall reschedule is 503/236 at the audit snapshot.

---

# 41. P1 recommendation: learn from rescheduling

This is the highest-value algorithmic direction.

Instrument rescheduling to export general schedule diagnostics such as:

- per-box phase boundaries;
- first/last push index;
- number of box-work phases;
- room transitions;
- doorway crossings;
- staging cells;
- repeated revisits;
- keeper walking before pushes;
- support-side distribution;
- push detour versus relaxed push distance;
- box-order inversions relative to original incumbent.

Then compare:
- discovery route;
- rewritten route;
- rescheduled route.

Look for recurring structural differences.

The aim is to create features that can help **before** a solution is complete.

---

# 42. P1 recommendation: preserve strategic intermediates

Do not merely increase macro endpoint count.

Instead reserve a small quota for endpoints that are valuable for different reasons.

Possible endpoint categories:

- lowest structural score;
- lowest move count;
- best keeper approach;
- different keeper side;
- different pushed box;
- doorway crossing completed;
- staging cleared;
- assignment target reached;
- strategic task advanced;
- minimal support-distance to next productive push.

This creates a principled "macro frontier" instead of one scalar ranking.

---

# 43. P1 recommendation: move-aware state identity

The engine already contains move-aware/Pareto mechanisms.

These should be evaluated more systematically.

For bounded discovery:

- push-region identity is useful for compression;
- exact keeper identity is expensive;
- completely discarding keeper arrival is harmful for move quality.

A middle ground is appropriate:
- canonical box layout;
- reachable region;
- bounded keeper-arrival representatives;
- move/push Pareto records;
- approach-side diversity.

Benchmark this as an explicit feature with:
- mechanism counters;
- Grand Hall;
- room-heavy corpus;
- corridor-heavy corpus;
- small regression boards.

---

# 44. P1 recommendation: change first-push selection using walk cost

The structural planner's first-push ranking should include keeper effort earlier.

Currently, a candidate can rank well structurally even when the keeper must traverse a large distance to perform it.

A better first-push priority could include:

```text
structural improvement
+ estimated future push benefit
+ exact current walk-to-support
+ keeper-side quality after push
```

The walk component does not need to dominate.

It needs to prevent obviously expensive box switches from appearing nearly free.

---

# 45. P1 recommendation: reduce box switching

Historical diagnosis showed that inefficient box-work phases contribute to excess walking.

A useful soft feature is "box continuation opportunity."

Reward:
- continuing productive work on the same box when safe and useful.

But do not make this a hard rule.

Sokoban often requires strategic switching.

A better signal could estimate:

```text
walk cost to continue current box
vs
walk cost to switch box
vs
expected structural progress
```

This can be incorporated into beam diversity or soft scoring.

---

# 46. P1 recommendation: doorway/room-transfer agenda

Grand Hall strongly suggests the solver needs a better long-range room agenda.

The structural analyzer already knows about:

- rooms;
- gates;
- imports;
- exports;
- packing;
- staging;
- doorway conflicts.

The next step is to represent more explicit agenda hypotheses such as:

```text
phase 1: evacuate boxes X/Y
phase 2: clear staging
phase 3: import target boxes
phase 4: pack deep goals
```

These should be:
- reversible;
- advisory;
- scored;
- branchable.

Do not treat a single inferred agenda as truth.

Maintain several hypotheses.

---

# 47. P1 recommendation: strategic hypothesis portfolio

Instead of only varying random seeds / beam profiles, diversify by **planning hypothesis**.

Possible portfolio lanes:

- minimal box switching;
- doorway-first;
- deepest-goal packing;
- transport continuity;
- move-aware keeper approach;
- assignment-diverse;
- rescheduling-informed agenda.

Each lane can remain bounded.

This may produce more meaningful incumbent diversity than merely different seed perturbations.

---

# 48. P2 recommendation: adaptive rescheduling eligibility

Now that effectively every puzzle can enter rescheduling, reserving a fixed portion of quality budget may not always be optimal.

Create a cheap rescheduling-value predictor.

Potential features:

- incumbent length;
- box count;
- floor count;
- push count;
- walk/push ratio;
- maximum per-box push detour;
- number of box switches;
- number of repeated box phases;
- current local rewrite gain;
- available memory;
- estimated occupancy-table size;
- remaining time.

Then choose:
- skip;
- one box;
- one round;
- full rescheduling.

This should improve small-puzzle efficiency.

---

# 49. P2 recommendation: adaptive rewrite allocation

The project already changes rewrite budget by board class.

Extend that logic using incumbent diagnostics.

Example:

- high walk/push ratio → more move/reschedule budget;
- high push detour → more rescheduling;
- many local permutation gains → more permutation window budget;
- corridor-heavy → more push windows;
- small compact puzzle → more local exact windows.

Keep this policy in `sokomind-plans.ts`, not scattered through the engine.

---

# 50. P2 recommendation: telemetry for planning loss

Add explicit counters that answer:

- how many first pushes were generated;
- how many distinct boxes were available;
- how many were selected;
- how many one-push alternatives were discarded because longer macros existed;
- how many keeper-arrival variants were pruned;
- how many candidates were removed by push-only dominance;
- how many candidates were removed by beam compression;
- how many rescheduled improvements correspond to decisions never represented in discovery.

This is essential for diagnosing "route not found" versus "route ranked too low."

---

# 51. P2 recommendation: schedule-difference analyzer

Create a development script that compares two routes and reports:

```text
moves
pushes
walks
box switches
box phase count
doorway crossings
per-box pushes
per-box pre-push walking
per-box first/last push
goal assignment
room transitions
reversal episodes
support-side patterns
```

The repository already has pieces of this analysis in benchmark evidence.

Make it a reusable tool.

It will be especially useful for:
- discovery vs rewrite;
- rewrite vs reschedule;
- reschedule vs human;
- tuning regressions.

---

# 52. P2 recommendation: benchmark rescheduling on a broader corpus

The current Grand Hall success is compelling but should not dominate general policy.

Build a representative repair corpus with:

- repeated labels;
- unique labels;
- interchangeable boxes;
- corridors;
- open rooms;
- multi-room boards;
- small boards;
- large boards;
- typed goals;
- packing-heavy layouts.

Measure:

- route gain;
- runtime;
- states;
- memory;
- frequency of no-op repair;
- cases where local rewrite is better use of budget.

---

# 53. P3 recommendation: scalar tuning

Scalar tuning is still useful, but it should be a later step.

The current tuning surface includes weights for:

- plan moves;
- heuristic;
- cost;
- packing;
- mobility;
- topology;
- evacuation;
- dependency;
- room behavior;
- doorway flow;
- relevance;
- beam size;
- branch count;
- plan depth/slack;
- macro limits;
- time allocation;
- rewrite sizing.

Automated tuning should continue to be restricted to **soft ordering parameters**.

Do not expose:
- legality;
- hard deadlock logic;
- replay validation;
- proof bounds;
- memory safety.

The tuning layer is correctly separated for this reason.

---

# 54. Areas that should not be "optimized" casually

## 54.1 Exact keeper position in move-optimal search

Do not canonicalize keeper position away in exact move-optimal search.

## 54.2 Replay verification

Do not remove independent replay from terminal results.

## 54.3 Deadlock hard prunes

Do not turn a heuristic deadlock suspicion into a hard prune without proof.

## 54.4 Tunnel macros

Do not replace legal single pushes with tunnel macros unless safety is fully proven.

Additive macros are safer.

## 54.5 Upper bounds

A numeric bound is not a public solution.

Only a complete replay-valid incumbent can be returned as solved.

## 54.6 Proof identity

Do not allow stale proof records to cross:
- board revisions;
- solver revisions;
- feature-vector revisions.

## 54.7 Worker limits

Do not let parallel workers each independently spend the entire nominal global budget.

Budget division must remain coordinated.

---

# 55. Concrete P0 task list for Codex

## Task P0.1 — Documentation consistency

Search for phrases like:

```text
unique-label
unique label
interchangeable-only
repeated-label
rescheduling eligibility
supportsBoxRescheduling
```

Update all stale text.

Acceptance criteria:

- code and docs agree;
- generated project reference updated if needed;
- doc validation passes;
- unit tests pass.

Suggested commands:

```bash
npm run lint:docs
npm run test:unit
```

---

## Task P0.2 — Integrated quality regression

Add a public-adapter quality regression for Grand Hall.

Acceptance criteria:

- starts from `PUZZLE_BY_ID.huge`;
- invokes `sokomind-solver`;
- quality mode;
- no saved final route;
- replay verified;
- rescheduling progress observed;
- final bound stronger than current loose 900-move browser assertion;
- deterministic enough for CI;
- timing scaled or descriptive.

Suggested commands:

```bash
npm run build
npm run test:browser:dist
npm run test:solver:huge
```

---

## Task P0.3 — Record current quality milestone

Add/update benchmark evidence documenting:

```text
discovery: 893 / 278
local rewrite: 789 / 270
human reference: 626 / 248
current reviewed reschedule: 503 / 236
```

Clearly label:
- exact source;
- limits;
- whether path starts from board or incumbent;
- whether browser/Node;
- whether public adapter or isolated engine;
- whether result is proven optimal.

---

# 56. Concrete P1 task list for Codex

## Task P1.1 — Macro intermediate retention experiment

Implement a feature flag that reserves a small number of ordinary push/intermediate states based on move-aware criteria.

Do not globally retain everything.

Candidate reserve dimensions:

- shortest moves;
- distinct keeper side;
- distinct box;
- strategic task advancement.

Acceptance criteria:

- replay correctness unchanged;
- no exact proof changes;
- mechanism counter proves it activates;
- Grand Hall route quality measured;
- multi-puzzle regression measured;
- no material memory explosion.

---

## Task P1.2 — Keeper-arrival beam experiment

Use the existing keeper-arrival structures as an explicit controlled feature.

Measure:
- extra retained states;
- Grand Hall moves;
- generated states;
- wall-clock;
- memory;
- room-heavy corpus outcome.

The experiment is promising only if the improvement comes from retained arrival diversity, not just a much larger effective beam.

---

## Task P1.3 — First-push walk cost

Add exact walk-to-support information to first-push ordering.

This should be a soft ordering term.

Acceptance criteria:

- no legality/pruning changes;
- counter or diagnostics show changed ordering;
- deterministic benchmark;
- route-quality comparison;
- runtime comparison.

---

## Task P1.4 — Reschedule-derived schedule trace

Extend repair telemetry to produce a compact optional development trace.

Do not include this in normal browser runs unless diagnostics are enabled.

Trace should include:
- box index/label;
- original first/last push;
- repaired first/last push;
- original pushes;
- repaired pushes;
- original pre-push walking;
- repaired pre-push walking;
- room transitions;
- phase count.

Use this to identify generalizable planning features.

---

# 57. Concrete P2 task list for Codex

## Task P2.1 — Reschedule-value predictor

Implement pure planning helper in typed code.

Input:
- board;
- incumbent summary;
- remaining budget.

Output:
- skip / light / full repair recommendation.

Keep engine unchanged initially.

Benchmark policy before making it default.

---

## Task P2.2 — Route diagnosis script

Create a proposed `diagnose:solver-route` npm script with an interface like
the following (this script does not exist yet):

```text
diagnose:solver-route --fixture=huge --left=discovery --right=rescheduled
```

Output JSON plus human-readable summary.

This will reduce repeated ad hoc diagnosis work.

---

## Task P2.3 — Engine modularization

Extract one low-risk primitive at a time.

Good first candidate:
- keeper-arrival/Pareto structures.

Acceptance criteria:
- generated engine check passes;
- same deterministic Grand Hall result;
- unit tests;
- no new module cycles;
- browser bundle still contains no Node built-ins.

---

# 58. Benchmark methodology for future solver changes

Every significant solver change should answer four separate questions.

## 58.1 Correctness

- Is the route legal?
- Is it solved?
- Are moves/pushes exact?
- If exact mode: is proof valid?

## 58.2 Search work

- expanded states;
- generated states;
- retained states;
- peak frontier;
- macro intermediate work;
- reachability calls;
- deadlock calls;
- cache hits.

## 58.3 Resource usage

- elapsed time;
- estimated memory;
- process RSS for Node benchmark;
- worker memory estimates;
- peak retained state.

## 58.4 Quality

- moves;
- pushes;
- walks;
- box switches;
- per-box detours;
- phase count;
- improvement over incumbent.

Do not collapse these into one score during evaluation.

---

# 59. Suggested benchmark tiers

## Tier A — correctness microfixtures

Purpose:
- catch unsoundness quickly.

Examples:
- oracle boards;
- deadlock counterexamples;
- tunnel regressions;
- repeated-label rescheduling.

## Tier B — exact small boards

Purpose:
- preserve optimality proof behavior.

Use:
- known optimum corpus;
- A*;
- IDA*.

## Tier C — structural medium boards

Purpose:
- evaluate bounded discovery quality and regressions.

Use:
- room-bearing corpus;
- corridor boards;
- typed boxes.

## Tier D — Grand Hall

Purpose:
- flagship stress case.

Always record:
- discovery;
- rewrite;
- reschedule;
- end-to-end public adapter.

## Tier E — browser

Purpose:
- validate real production behavior.

Use:
- Chromium;
- WebKit where meaningful.

---

# 60. Recommended invariant checklist before merging solver changes

A solver PR should be considered incomplete until the author answers:

### Legality
- Does independent replay still validate every accepted route?

### Objective
- Is total move count still the optimization objective?

### Keeper identity
- Did any state compression change exact keeper semantics?

### Hard pruning
- Did any new condition reject a legal state?
- If yes, where is the proof/counterexample coverage?

### Resource accounting
- Can parallel workers overspend the shared budget?

### Memory
- Did retained state or cache limits change?

### Determinism
- Did the reviewed deterministic guardrails change?
- Is the change intentional?

### Quality
- What happened to Grand Hall and representative corpus?

### Runtime
- What happened to generated/macro work, not just elapsed milliseconds?

### Documentation
- Were project reference/solver status/benchmark docs updated?

---

# 61. Current project strengths to preserve

Do not lose sight of what already works extremely well.

## 61.1 Pure immutable core

This is the bedrock of replay, testing, persistence, and solver verification.

## 61.2 Solver/core separation

The solver does not own game truth.

## 61.3 Independent verification

This is exceptional and must remain.

## 61.4 Exact/bounded separation

Discovery quality is not mislabeled as proof.

## 61.5 Worker isolation

Heavy solver computation does not block the app architecture.

## 61.6 Resource limits

Time/state/memory are treated as first-class constraints.

## 61.7 Benchmark evidence

The project records empirical evidence rather than relying on anecdotes.

## 61.8 Willingness to revert unsafe ideas

The source history/documentation shows several optimizations were rejected when evidence was poor.

That is healthy solver development.

---

# 62. Current project weaknesses

## 62.1 Flagship kernel complexity

The legacy generated engine is increasingly difficult to reason about.

## 62.2 Planning versus objective mismatch

The move objective is not represented strongly enough at early planning stages.

## 62.3 Candidate information loss

Macro and beam compression remove states that may matter for later move efficiency.

## 62.4 Runtime concentration

Large amounts of work happen below the retained-state level.

## 62.5 Documentation drift

Recent rescheduling changes have already outrun comments/docs.

## 62.6 Strongest quality result not yet the strongest integrated product gate

503-class repair needs better end-to-end protection.

---

# 63. Important interpretation of the 503 result

Do not overclaim the result.

The 503 route means:

- a replay-valid better route exists;
- the restricted rescheduling search found it;
- it uses fewer moves and pushes than the old reference;
- the low-level repair algorithm is powerful.

It does **not** mean:

- 503 is globally optimal;
- the public fast solver finds 503;
- the board-to-route pipeline reaches 503 in three seconds;
- exact proof has established 503 as the optimum;
- rescheduling alone generalizes equally well to every puzzle.

This distinction must remain explicit in docs and UI.

---

# 64. Flagship research thesis

The current code suggests a strong research thesis for Sokomind Solver:

> Separate global structural reasoning from exact movement optimization, but allow information to flow between them.

Today the flow is mostly one-directional:

```text
planner → incumbent → optimizer
```

The next generation should become:

```text
planner → incumbent → optimizer
   ↑                    ↓
   └── learned advisory structure ──┘
```

This is the most promising path to improving both:
- route quality;
- search efficiency.

---

# 65. Possible future "schedule skeleton" representation

A useful intermediate abstraction could be a soft schedule skeleton.

Example:

```ts
interface BoxAgendaHint {
  boxRole: string;
  phase: number;
  regionFrom?: string;
  regionTo?: string;
  preferredDoorway?: string;
  preferredSupportSide?: string;
  mustRemainReversible: true;
}
```

Important:
- hints are not legal constraints;
- multiple alternatives may coexist;
- task completion should be reversible;
- violating a hint should incur score, not rejection;
- hints should be validated against current board revision.

The existing strategic-plan contract may already provide much of this infrastructure.

Prefer extending an existing validated contract over inventing a completely parallel planner representation.

---

# 66. Possible use of the strategic analyzer

The strategic analyzer is conceptually well positioned to absorb rescheduling-derived lessons.

Potential additions:

- detect high-detour boxes;
- estimate room-transfer phases;
- identify likely transport-continuity opportunities;
- identify boxes likely to benefit from delayed assignment commitment;
- generate multiple stage/release hypotheses;
- rank support-access risks.

However:

> The analyzer must remain advisory.

Do not let inferred tasks silently become hard pruning unless separately proven.

---

# 67. Potential issue: tuning before search-space repair

The current tuning surface is broad enough that automated optimization could find better numbers.

But tuning cannot fix missing states.

If:
- a one-push handoff is discarded;
- a keeper-arrival variant is merged away;
- a box choice never enters selected first pushes;

then no scalar weight can recover it later.

Therefore:

1. first improve representation/candidate retention;
2. then retune weights.

Otherwise the optimizer will merely overfit around current blind spots.

---

# 68. Suggested experiment: route recoverability trace

Add a development-only mechanism that takes a known improved route and asks:

At each structural layer:
- was the next improved-route push generated?
- was its box represented?
- was its macro endpoint generated?
- was its exact state generated?
- was it rejected by a hard guard?
- was it transposition-pruned?
- was it beam-pruned?
- was it retained but later lost?

This is an extremely valuable diagnostic.

It separates:
- generation failure;
- pruning failure;
- ranking failure;
- budget failure.

Do not use the reference route in production.

Use it only as an offline diagnostic harness.

---

# 69. Suggested experiment: 503 route recoverability

For Grand Hall specifically:

1. load the reviewed 503 route as an offline reference;
2. trace its push sequence against the structural planner;
3. record the earliest divergence;
4. classify why that branch disappeared;
5. repeat after each major planner improvement.

This can identify whether the 503 route is:
- unreachable under current macros;
- reachable but pruned;
- reachable but beam-ranked away;
- recoverable only after schedule repair.

Again: this is an experiment, not production guidance.

---

# 70. Suggested experiment: reschedule earlier

Instead of waiting for a complete high-quality rewrite, try bounded rescheduling at earlier stages:

- first 893 incumbent;
- partially rewritten incumbent;
- top 2 diverse incumbents.

Measure whether:
- early rescheduling yields a better seed;
- the better seed improves subsequent rewrite;
- the additional cost pays for itself.

A staged pipeline might outperform the current fixed order.

---

# 71. Suggested experiment: joint-box repair

The current repair frees one box while holding all others' event ordering fixed.

The natural next extension is a small joint-role optimizer.

Do not start with arbitrary many boxes.

Try:
- 2-box pairs;
- selected by high interaction;
- bounded to one room/doorway phase;
- strict memory limits.

Candidate pair selection:
- boxes with high alternating pushes;
- boxes sharing doorway;
- boxes with correlated detour;
- boxes that repeatedly block each other's support cells.

This could close the gap between restricted optimization and true global schedule search.

---

# 72. Suggested experiment: assignment-aware rescheduling

Repeated-label boxes introduce assignment freedom.

The current expanded eligibility is a good step.

Future work can distinguish:

- physical box identity;
- label class;
- goal assignment.

A restricted optimizer could potentially allow:
- assignment swaps inside the same label class;
- fixed external event ordering.

This may produce additional gains without full Sokoban search.

Correctness and state explosion need careful handling.

---

# 73. Suggested experiment: incremental keeper distances

The rescheduler already shows how valuable exact keeper distance is.

Try to reuse similar distance machinery in structural discovery.

Rather than performing full reachability path materialization for every candidate:

- compute compact distance field;
- cache by occupancy signature;
- reconstruct path only for retained successor.

This should be evaluated carefully because occupancy changes per push.

---

# 74. Suggested experiment: box-work phase penalty

The route diagnosis indicates that repeated returns to the same box can be expensive.

Add a soft penalty based on:
- box phase restart;
- keeper travel to switch;
- whether prior box still had productive legal continuation.

This should not punish all switching.

Use it only as one feature in a portfolio.

---

# 75. Suggested experiment: move-aware macro endpoint scoring

Macro expansion currently emphasizes push progress.

Add endpoint metrics:

```text
macroPushes
macroMoves
keeperDistanceToNextProductivePush
keeperApproachSide
doorwayProgress
goalAccessDelta
```

Retain a small Pareto set per macro.

This may dramatically improve route quality without making the outer beam much wider.

---

# 76. Current CI status note

At the audit snapshot, the latest reviewed `main` commit was:

```text
07411a8c109e7c82c3956fea126f33b5c81d1b09
```

The corresponding Pages workflow was still reported as in progress at audit time.

Therefore this document should not be read as claiming that commit was already fully CI-green.

Before using this document later:

```bash
git rev-parse HEAD
```

and check whether:
- the solver behavior changed;
- the benchmark evidence changed;
- the rescheduling result changed;
- the CI status changed.

---

# 77. Recommended files for Codex to read first

Before changing solver behavior, Codex should read these in roughly this order:

```text
README.md
docs/architecture.md
docs/solver-status.md
docs/solver-benchmarks.md
docs/benchmarks/grand-hall-rescheduling.md

src/core/game-session.ts
src/solver/verification.ts
src/solver/contracts.ts

src/solver/implementations/sokomind-solver.ts
src/solver/implementations/sokomind-plans.ts
src/solver/implementations/sokomind-tuning.ts
src/solver/implementations/sokomind-legacy.ts
src/solver/implementations/sokomind-budget-tracker.ts
src/solver/implementations/sokomind-worker-registry.ts

src/solver/implementations/sokomind-engine/README.md
src/solver/implementations/sokomind-engine/source/solver-search.js
src/solver/implementations/sokomind-engine/source/box-rescheduling.js

tests/unit/box-rescheduling.test.ts
tests/performance/sokomind-solver-huge.test.ts
tests/e2e/strategic-analyzer.spec.ts
tests/unit/module-boundaries.test.ts
```

Then inspect:
- exact-search implementation;
- known optimum fixtures;
- benchmark scripts.

---

# 78. Recommended commands before modifying the flagship solver

Baseline:

```bash
npm install
npm run typecheck
npm run lint
npm run lint:docs
npm run test:unit
```

Solver correctness:

```bash
npm run test:solver:oracle
npm run test:solver:optimal
npm run test:solver:proof-regressions
npm run test:solver:multi
npm run test:solver:huge
```

Browser:

```bash
npm run build
npm run test:browser:dist
```

Benchmark smoke:

```bash
npm run benchmark:solver:v2 -- --fixture=ultra-tiny --profile=sokomind-fast --runs=1 --warmup=0
```

Grand Hall:

```bash
npm run benchmark:solver:v2 -- --fixture=huge --profile=sokomind-fast --runs=3 --warmup=0
```

Rescheduling-specific scripts/tests should also be run when changing repair behavior.

---

# 79. Recommended evidence required for a solver PR

A meaningful solver PR should include a short evidence table like:

| Fixture | Before moves | After moves | Before expanded | After expanded | Before generated | After generated | Replay | Notes |
|---|---:|---:|---:|---:|---:|---:|---|---|

For performance-sensitive changes, add:

| Fixture | Median before | Median after | Peak RSS before | Peak RSS after |
|---|---:|---:|---:|---:|

For exact features:
- both variants must prove;
- both variants must replay;
- feature activation counter must be nonzero;
- disabled variant must report zero mechanism use.

---

# 80. Final assessment

SokomindSolver is already a serious solver engineering project.

Its strongest qualities are:

- clean domain boundaries;
- independent replay;
- careful exact-proof semantics;
- strong testing;
- thoughtful resource accounting;
- willingness to reject unsound pruning;
- extensive benchmark evidence.

The flagship solver's current weakness is not a lack of features.

It arguably has too many.

The problem is that the earliest search stages still throw away information that the later optimizer proves was strategically important.

Grand Hall makes this clear.

A first-pass planner produces a valid but inefficient 893-move route.

Local rewrite improves it.

Whole-box rescheduling then discovers a dramatically better 503-move route.

That implies the project already possesses a powerful movement optimizer.

The next challenge is to make the planner see more of the structure that the optimizer discovers after the fact.

The recommended strategic direction is therefore:

> **Shift from adding more independent heuristics to building a feedback loop between long-range repair and structural discovery.**

At the same time:

- protect the 503-class result with stronger integration testing;
- remove stale documentation;
- preserve keeper-arrival alternatives more intelligently;
- reduce macro/reachability overhead;
- modularize legacy search code incrementally;
- keep all hard pruning and proof logic conservative.

If those improvements are executed carefully, Sokomind Solver has a realistic path from "sophisticated bounded solver with excellent repair" to a substantially stronger board-to-solution flagship engine.

---

# Appendix A — Key current numbers

## Grand Hall

| Path | Moves | Pushes | Interpretation |
|---|---:|---:|---|
| Current reviewed fast discovery | 893 | 278 | First structural solution |
| Historical full window rewrite | 789 | 270 | Local bounded refinement |
| Supplied human reference | 626 | 248 | Verified reference, not proven optimum |
| Current reviewed whole-box reschedule | 503 | 236 | Restricted repair result, not global proof |

Important:

- The 503 result is the strongest route-quality result discussed here.
- It is not proof of global optimality.
- It does not establish a 3-second end-to-end browser solve.

---

# Appendix B — Critical solver invariants

1. Core transition rules remain authoritative.
2. Every public solver solution is independently replayed.
3. Exact move-optimal identities retain enough keeper information.
4. Bounded first-solution search may compress state more aggressively but must not claim proof.
5. Deadlock hard prunes require proof-level safety.
6. Numeric bounds are not solutions.
7. Worker budgets are shared, not multiplied by concurrency.
8. Browser memory accounting must not double-count process-wide samples.
9. Generated engine must remain reproducible from source.
10. Tuning may affect ordering, not legality.
11. Proof records must remain versioned/fingerprinted.
12. Every optimization must preserve final solved replay.

---

# Appendix C — Codex instruction block

When using this document as context, Codex should follow these rules:

1. **Do not rewrite the flagship engine wholesale.**
2. **Do not remove replay verification.**
3. **Do not introduce a hard prune without explicit safety tests.**
4. **Do not treat 503 as proven optimal.**
5. **Do not use the human/reference route in production solver logic.**
6. **Do not benchmark only elapsed time; record deterministic work.**
7. **Do not improve Grand Hall by puzzle ID, dimensions, or hardcoded box labels.**
8. **Prefer general structural features and bounded policies.**
9. **Keep search policy in typed orchestration/planning modules when possible.**
10. **Add mechanism counters for experimental features.**
11. **Run exact/proof regressions after shared search changes.**
12. **Run browser worker tests after worker/protocol changes.**
13. **Update docs whenever behavior changes.**
14. **Treat the current best direction as planner/repair feedback, not merely weight tuning.**

---

# Appendix D — Suggested first Codex mission

A high-value first mission is:

> **Make the current rescheduling behavior and documentation internally consistent, then add an end-to-end Grand Hall quality regression that verifies the public adapter reaches a substantially stronger bound than 900 moves while preserving replay and resource limits.**

Why this first:

- it is low algorithmic risk;
- it protects the project's strongest recent improvement;
- it makes later research safer;
- it gives future planner experiments a reliable acceptance baseline.

After that, the next mission should be:

> **Instrument where the 503 route disappears from the structural planner, distinguishing generation, pruning, transposition, and beam-selection loss.**

That experiment is likely to be more informative than another round of blind heuristic-weight tuning.
