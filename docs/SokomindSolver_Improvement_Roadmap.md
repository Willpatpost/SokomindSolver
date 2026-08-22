# Sokomind Solver Improvement Roadmap

**Repository:** `Willpatpost/SokomindSolver`  
**Focus:** General-purpose Sokoban solution quality and browser performance  
**Primary stress test:** Grand Hall  
**Current first-found Grand Hall result:** ~893 moves / 278 pushes / ~4.5 seconds in-browser  
**Known high-quality route:** ~628 moves / 244 pushes  
**Long-term target:** <700 moves in <10 seconds in-browser, without Grand Hall-specific logic

---

## 1. Purpose of This Document

This document consolidates the solver-improvement ideas discussed so far, including:

- improvements that have already been implemented successfully,
- experiments that were attempted and reverted,
- ideas that were only partially attempted,
- original suggestions that have not yet been tested,
- newly proposed analyzer/planner improvements,
- newly proposed route/search improvements,
- and a prioritized roadmap for future development.

The guiding principle is that **Grand Hall is a diagnostic stress test, not the optimization target itself**. Any retained change should make structural sense for Sokoban generally and should be evaluated across a representative puzzle corpus.

The central design philosophy is increasingly:

> **Make the analyzer understand the puzzle well enough that the search does not need to be excessively complex.**

---

# 2. Current State and What Has Already Been Learned

## 2.1 Current Grand Hall Progress

The structural solver improved from approximately:

| Version | Moves | Pushes | Notes |
|---|---:|---:|---|
| Former fast baseline | 1,066 | 322 | Original branch policy + hard stranded-export guard |
| Current first-found | **893** | **278** | Distinct-box reserve + relaxed stranded-export hard guard |
| Current quality rewrite | **789** | **270** | More expensive post-discovery rewrite |
| Known high-quality route | ~628 | ~244 | Best known/reference-quality route |

This is a strong sign that **better structural decisions can improve both quality and speed simultaneously**.

The current 893 solution uses:

- 278 pushes,
- approximately 615 non-push keeper moves,
- versus ~244 pushes and ~384 non-push keeper moves in the 628 route.

The remaining gap is therefore approximately:

- 34 extra pushes,
- 231 extra non-push walking moves,
- 265 total moves.

The remaining problem is no longer simply “the solver pushes the wrong boxes everywhere.” The push count is much closer to the reference route, while substantial inefficiency remains in **task sequencing, repeated box work, regional backtracking, and keeper travel caused by the chosen order of otherwise valid operations**.

---

# 3. Controlled Experiments Already Performed

The following experiments were reported by Codex.

| Experiment | Result | Decision |
|---|---|---|
| Original branch policy + stranded hard guard | 1,066 / 322 | Baseline |
| Distinct-box reserve only | 1,020 / 288, more generated work | Incomplete alone |
| Guard relaxation only | Cutoff, 5,043 visited / 30,659 generated | Reject alone |
| Reserve + guard relaxation | **893 / 278**, less search than baseline | **Retain** |
| One enabling handoff per box | Cutoff, 54,942 generated | Revert |
| Persistent agenda-resumption slot | 1,121 / 322 | Revert |
| Macro alternate-approach reserve | Cutoff, ~27.5 s | Revert |
| Move-aware macro arrival diversity | Cutoff, ~20.6 s | Revert |
| Temporary-goal penalty | 918 / 278, more search | Revert |
| Remove temporary goals from milestone identity | Cutoff, 5,025 visited / 39,580 generated | Revert |

## 3.1 What the Successful Change Means

The two retained changes interact strongly:

1. **Distinct-box reserve** preserves an additional distinct box agenda before spending branch slots on alternate directions for already represented boxes.
2. **Stranded-export guard relaxation** stops treating a local one-push reachability estimate as a proof that an import is invalid.

Each change alone was insufficient or unstable. Together they expose and preserve better strategic plans without increasing the total branching budget.

This suggests an important design lesson:

> **Strategic diversity helps when it preserves semantically different plans. Generic diversity often explodes the search.**

## 3.2 What the Failed Experiments Mean

### One enabling handoff per box

This suggests that **general-purpose multi-box tactical handoffs are too expensive when enabled broadly**. It does not prove that all compound macros are bad. It suggests that any future enabling macro should be **analyzer-directed and selectively activated**.

### Persistent agenda-resumption slot

This argues against rigidly preserving a previous agenda merely because it existed. Sokoban plans often need to be interrupted deliberately.

### Macro alternate-approach reserve

Preserving multiple local geometric approaches to the same macro endpoint appears to waste frontier capacity without preserving genuinely different strategic plans.

### Move-aware macro arrival diversity

Retaining many keeper-arrival variants globally is too expensive. If keeper-position diversity matters, it should likely be preserved only at selected strategic boundaries.

### Temporary-goal penalty

A simple global penalty for temporarily occupied goals does not adequately represent the real issue. The useful concept is likely **dynamic commitment / traffic dependency**, not “goal occupancy is bad.”

### Removing temporary goals from milestone identity

Temporary goal state contains important structural information and should not be collapsed away indiscriminately.

---

# 4. High-Level Problem Decomposition

There are two major quality problems.

## 4.1 Analyzer / Planning Problem

> **What should be done, in what order, where should boxes wait, and which work should be advanced opportunistically?**

This includes:

- room flow,
- doorway scheduling,
- task dependencies,
- safe staging,
- packing order,
- goal commitment,
- task batching,
- box-work episodes,
- region-work episodes,
- and choosing between independent tasks based on keeper location.

This is currently believed to be the highest-leverage area.

## 4.2 Search / Execution Problem

> **Given a good strategic intent, how can the solver realize it with fewer pushes and less keeper walking?**

This includes:

- macro realization,
- local route optimization,
- push-block reordering,
- local window rewrite,
- strategic boundary keeper position,
- and better anytime improvement.

The search should not be asked to discover all strategy from scratch if the analyzer can determine much of it cheaply.

---

# 5. Original Suggestions That Were Only Partially Attempted or Not Attempted

## 5.1 Teacher-Route / Divergence Analyzer — **Partially Attempted**

The current `planDiagnostics` instrumentation is useful, but it is not yet the full general teacher-route analyzer originally envisioned.

### Desired capability

Given:

```text
puzzle + high-quality reference route
```

identify the first major strategic divergence and answer:

- Was the reference push/macro generated?
- What rank did it receive?
- Which scoring components affected it?
- Did it enter the beam?
- How long did it survive?
- Was it pruned?
- Was it dominated by a transposition?
- Did a macro begin correctly but fail to complete?
- Was a hard guard responsible?
- Was a strategically different state displaced by another state with a superficially better scalar score?

### Why this matters

This replaces blind heuristic tuning with evidence.

Instead of:

> “Try changing this coefficient.”

we want:

> “At push 143, the better branch was generated, ranked 6th, retained for two layers, then removed by region transposition because two strategically different temporary-goal states were treated as equivalent.”

### Recommendation

Continue expanding diagnostics only where they answer concrete search-quality questions. Avoid building a massive logging framework with no immediate decision value.

---

## 5.2 Strategic State Diversity — **Partially Attempted and Partially Successful**

### Successful form

The distinct-box reserve was a major success.

### Failed forms

- generic alternate macro approaches,
- move-aware arrival diversity,
- persistent agenda slots.

### Remaining direction

Preserve diversity based on **meaningful strategic dimensions**, not local geometric variants.

Possible strategic features:

- active room/region,
- pending exports,
- feasible imports,
- packing depth,
- unresolved dependencies,
- provisional vs committed goals,
- corridor availability,
- safe staging progress,
- box episode identity,
- task-graph phase,
- keeper region only at strategically important boundaries.

The goal is not “more diversity.” The goal is:

> **Do not allow one numerically dominant plan family to erase all semantically different plans.**

---

## 5.3 Rich Room / Doorway Agenda Representation — **Partially Attempted**

The lower-room schedule is now much better, but the current upper-room sequencing remains inefficient.

Potential state information includes:

- pending exports,
- pending imports,
- currently feasible imports,
- room capacity,
- doorway capacity,
- required future crossings,
- packing progress,
- unresolved dependencies,
- safe staging capacity,
- traffic-critical cells,
- and whether a region is logically open, closing, or safely sealable.

Avoid rigid phase rules. These should be analyzer-derived structural facts, not hard-coded finite-state behavior.

---

## 5.4 Compound / Enabling Macros — **Simple Version Tried and Failed**

A broad “one enabling handoff per box” experiment exploded the search.

However, the more selective original idea remains largely untested.

### Better formulation

Only attempt an enabling macro when the analyzer already identifies a **high-value strategic objective** and detects a specific local blocker.

Conceptually:

```text
target box has useful strategic objective
        ↓
target cannot continue
        ↓
identify specific blocking/support problem
        ↓
small bounded tactical search
        ↓
allow 1–N enabling pushes involving another box
        ↓
re-test target progress
```

### Important constraint

Do **not** enable this for every box or every macro.

Potential activation criteria:

- target is part of a certified room-flow task,
- target is near completion of a high-value import/export/packing task,
- exactly one local support/blocking issue prevents continuation,
- expected branch count is small,
- enabling pushes preserve future flexibility.

---

## 5.5 Goal Commitment Semantics — **Simple Versions Tried and Failed**

A global temporary-goal penalty was not effective.

The richer concept remains valid:

```text
unsolved
provisionally on goal
safely committed
```

A box should be considered safely committed only when placing it permanently does not interfere with:

- required future traffic,
- support-square access,
- another box’s route,
- room entry/exit,
- packing order,
- or mandatory crossings.

This should be based on **dependency and critical-square lifetime analysis**, not a global penalty.

---

## 5.6 FESS / Feature-Space Search — **Not Meaningfully Tried for This Objective**

FESS already exists in the codebase but is not part of the main discovery portfolio.

Potential roles:

1. full alternate discovery lane,
2. structural planner for difficult room boards,
3. source of selection ideas for the existing structural planner,
4. task-graph/agenda diversity mechanism.

The most promising use may be conceptual rather than replacing the solver outright:

> Preserve progress across several orthogonal structural dimensions instead of collapsing everything into one heuristic number.

Candidate feature dimensions:

- packing,
- connectivity,
- room connectivity,
- task completion,
- staging quality,
- commitment safety,
- region switching,
- out-of-plan measure.

---

## 5.7 Strategic Restarts — **Not Tried**

Potential approach:

Run multiple bounded deterministic planning lanes with genuinely different strategic emphases, such as:

- baseline structural policy,
- staging-aware policy,
- delayed-commitment policy,
- room-flow policy,
- task-locality policy.

Avoid arbitrary score noise.

The question is whether several small, strategically distinct planners outperform one homogeneous wider beam.

---

## 5.8 Seed Discovery from Structural Checkpoints — **Not Tried**

Current architecture can retain promising structural-plan checkpoints when the plan does not solve the board, but those checkpoints are not necessarily used to seed later discovery.

Potential experiment:

- preserve top structurally distinct checkpoints,
- seed the fallback beam/discovery search with them,
- include the original state as well,
- measure whether this creates a useful head start or merely biases the search into local optima.

---

## 5.9 Better Anytime Improvement — **Partially Exists**

Quality mode already demonstrates that the first-found 893 route can be rewritten to around 789 / 270.

This proves that substantial post-discovery waste remains.

Potential future architecture:

```text
find valid incumbent quickly
        ↓
keep it permanently available
        ↓
use remaining time on targeted improvement
        ↓
return best replay-verified route before deadline
```

The important improvement is not merely “run rewrite longer.” It is to make improvement **targeted and analyzer-guided**.

---

# 6. New Analyzer-First Improvements

# 6.1 Safe Staging Map

One of the strongest new ideas is to give the analyzer an explicit concept of **safe staging positions**.

A square should not merely be classified as:

```text
goal / not goal
deadlock / not deadlock
```

It should have dynamic strategic properties for a given box and board state.

Possible staging features:

- not statically/dynamically deadlocked,
- does not occupy a critical doorway,
- does not consume a required support square,
- retains multiple future push directions,
- keeper can regain useful support access later,
- does not block another unresolved task,
- reasonably aligned with likely destination,
- preserves room traffic,
- does not prematurely seal a region,
- has low expected future retrieval cost.

### Example conceptual score

```text
stagingQuality =
    futurePushFlexibility
  + supportAccess
  + goalAlignment
  + trafficSafety
  + keeperReentryQuality
  - doorwayInterference
  - dependencyInterference
  - futureRetrievalCost
```

The exact formulation should be benchmark-driven.

### Why this matters

The planner can intentionally say:

> “Advance this box now, leave it in a strategically good waiting position, then continue another task.”

That is more sophisticated than either:

- finishing the box immediately, or
- abandoning it with no explicit staging rationale.

---

# 6.2 Opportunity Windows / Opportunistic Staging

This formalizes the idea of doing useful work while the keeper is already nearby or passing through.

Suppose the keeper is traveling toward task B and passes near box C.

The analyzer can estimate:

```text
small detour now
        ↓
push C into safe staging position
        ↓
continue to B
        ↓
avoid expensive future return trip to C
```

Conceptual value estimate:

```text
opportunityValue =
    expectedFutureTravelSaved
  + expectedFuturePushSaved
  + stagingProgress
  - immediateDetourCost
  - interferenceRisk
```

### Important restriction

Do not let the low-level search consider every nearby box opportunistically.

The analyzer should surface only a very small number of high-confidence opportunities, perhaps 0–2 at a time.

This preserves the advantage without reproducing the branching explosion seen in generic enabling-handoff experiments.

---

# 6.3 Task Graph / Partial-Order Planning

Instead of forcing one complete sequence too early:

```text
A → B → C → D
```

represent dependencies as a graph:

```text
        Clear doorway
             ↓
       ┌─────┴─────┐
       ↓           ↓
    Stage A     Export B
       ↓           ↓
       └─────┬─────┘
             ↓
          Import C
             ↓
        Pack goal room
```

Some tasks are mandatory predecessors. Others are independent.

### Benefit

When two tasks are independent, the scheduler can choose based on:

- keeper location,
- current region,
- staging opportunities,
- future travel,
- local setup cost.

This allows the analyzer to express **strategy without prematurely fixing execution order**.

---

# 6.4 Task Scheduling With Travel Cost

Once the analyzer has a task graph, order independent tasks using a small scheduling optimization.

Each task can have attributes such as:

- box,
- region,
- expected pushes,
- prerequisites,
- required support cells,
- resulting staging state,
- traffic impact,
- goal/packing impact.

Switching between tasks has a keeper-travel/setup cost.

This becomes a small **precedence-constrained routing/scheduling problem** over perhaps 10–30 strategic tasks instead of a search over millions of Sokoban states.

Possible methods:

- small beam search,
- dynamic programming on task subsets where feasible,
- A* over task graph states,
- greedy + local improvement,
- deterministic bounded search.

This may be one of the most powerful ways to reduce global keeper travel.

---

# 6.5 Box Episodes

Define a **box episode** as a contiguous period of active manipulation of the same box before the solver leaves it to perform unrelated work.

Example:

```text
H episode 1
→ unrelated work
H episode 2
→ unrelated work
H episode 3
```

The current documentation already notes that H is manipulated in four episodes in the 893 route.

### Diagnostics to add

For each box:

- number of episodes,
- pushes per episode,
- keeper travel between episodes,
- reason episode ended,
- reason box was revisited,
- whether the interruption was structurally necessary,
- whether a safe staging alternative existed.

### Why this matters

High-quality routes likely have fewer unnecessary revisit episodes.

This metric can expose sequencing problems much more clearly than move count alone.

---

# 6.6 Region Episodes

The same concept can apply to structural regions/rooms.

Measure sequences such as:

```text
upper → lower → upper → left → upper
```

versus more coherent batches:

```text
lower-work batch → upper-work batch → left-work batch
```

Do not force regions to be completed in one visit. Some puzzles require revisiting them.

Instead, treat region switches as a **setup/travel cost** and let structural dependencies justify when repeated visits are necessary.

---

# 6.7 Critical-Square Lifetime Analysis

Extend analyzer reasoning from “this square matters” to:

> **How long must this square remain available?**

A square can be required by:

- future support pushes,
- keeper access,
- room entry/exit,
- another box’s path,
- mandatory crossings,
- packing order.

Represent something like:

```text
critical square X
required until tasks A3 and C2 complete
```

This directly improves:

- goal commitment,
- staging safety,
- doorway preservation,
- corridor preservation.

A box occupying a goal on a still-needed critical square is then clearly **provisional**, not safely committed.

---

# 6.8 Box Flexibility / Reversibility

Humans often prefer positions where a box remains easy to manipulate later.

Quantify this.

Potential features:

- number of future push directions,
- reachable support sides,
- number of legal exits,
- distance from wall traps,
- room accessibility,
- dependency interference,
- ability to recover after another task changes the board.

A **flexibility score** helps distinguish:

> legal staging

from:

> robust strategic staging.

---

# 6.9 Abstract Room Solving

For sufficiently isolated rooms, create a smaller abstract problem:

> Given these boxes, goals, and doorways, what good evacuation/import/packing order exists inside this room?

The analyzer could produce a room-level strategy such as:

```text
1. export generic surplus box
2. stage typed box outside
3. import deep-goal box
4. pack deep goal
5. import remaining box
6. seal room
```

The global solver would then coordinate these room strategies rather than rediscover every local ordering from scratch.

---

# 6.10 Box-Flow Graph

Represent the puzzle at a higher level using:

- rooms/regions,
- doorways,
- boxes,
- goals,
- mandatory crossings,
- candidate assignments,
- crossing capacity,
- packing constraints.

Example:

```text
Box X: room 1 → corridor → room 3
Box A: room 2 → room 1
Box B: already in destination region
```

The structural planner can reason about **flows and task order**, while low-level search realizes those flows.

This is a natural extension of the current room/doorway analyzer and aligns strongly with the analyzer-first philosophy.

---

# 6.11 Audit Hard Prunes: Certificates vs Heuristics

The 893 breakthrough exposed a broader lesson:

`strandedExports` was a local estimate but was treated as a hard rejection.

Audit other hard guards for the same pattern.

### Principle

Hard rejection should ideally require a **certificate**:

- provably deadlocked,
- impossible matching,
- provably inaccessible,
- certified packing-order violation,
- certified continuation impossibility.

Unproven but suspicious states should usually receive a scoring penalty rather than unconditional rejection.

This must be handled carefully because relaxing hard guards indiscriminately can explode the search. Each relaxation should be paired with better semantic prioritization/diversity.

---

# 6.12 Learn/Tune Analyzer Features From the Full Corpus

The repository contains 2,095 puzzles, which can serve as a powerful offline tuning corpus.

Without requiring neural networks, generate:

- fast solutions,
- quality solutions,
- possibly expensive offline reference solutions,
- analyzer feature values at strategic decisions.

Then evaluate which features predict better choices.

Candidate learned/tuned quantities:

- staging quality,
- region-switch cost,
- box-episode penalty,
- goal-commitment safety,
- flexibility value,
- task-locality value,
- future traffic cost.

Use held-out puzzle subsets to guard against overfitting.

Ship only the final compact coefficients/rules to the browser.

---

# 7. Search / Execution Improvements

# 7.1 Verify Local Keeper Optimality on the 893 Route

The old 1,066 route had shortest keeper walks between each chosen pair of pushes.

Re-run this diagnostic on 893.

If each local walk is still shortest, then the search-side problem is **not pathfinding between pushes**. It is the order in which push tasks are selected.

If some local walks are not shortest, fix those first because that is a cheaper and more direct source of waste.

---

# 7.2 Push-Sequence Reordering

Take a valid solution such as 893 / 278 and treat its pushes as partially ordered operations.

Dependencies may include:

- same-box push order,
- occupancy conflicts,
- support-square dependencies,
- room constraints,
- keeper-access constraints,
- goal/packing dependencies.

Many push blocks may be legally commutable.

Search for a different legal ordering of largely the same work that reduces keeper travel.

This attacks the 615 non-push moves without re-solving the entire puzzle.

---

# 7.3 Adjacent Push-Block Commuting

A simpler version of push-sequence reordering.

Example route structure:

```text
AAAA
BBBB
AA
CCCC
BB
```

Try legal transformations such as:

```text
AAAAAA
BBBBBB
CCCC
```

when dependencies permit.

This can reduce repeated trips between boxes/regions while preserving most of the discovered strategy.

---

# 7.4 Analyzer-Directed Local Route Windows

The current quality rewrite can improve 893 to roughly 789, proving that substantial removable waste remains.

Instead of expensive whole-route rewrite, detect suspicious windows using analyzer metrics such as:

- high walk/push ratio,
- repeated box episodes,
- repeated region switching,
- provisional goals later reopened,
- boxes pushed away and later returned,
- long keeper travel between related tasks.

Then solve only those windows:

```text
state at push N
   ↓
local bounded search
   ↓
state at push N+K
```

Goal:

> Reach the same or strategically equivalent endpoint with fewer moves/pushes.

---

# 7.5 Strategic Anchors

Identify high-confidence milestones such as:

- room fully evacuated,
- doorway phase safely completed,
- deep goal safely packed,
- region safely sealed,
- mandatory crossing completed.

Use these as rewrite anchors.

Instead of optimizing the entire solution at once:

```text
start → anchor 1
anchor 1 → anchor 2
anchor 2 → anchor 3
```

Optimize segments independently where safe.

This may dramatically reduce rewrite complexity.

---

# 7.6 Selective Keeper-Arrival Diversity

Global keeper-arrival diversity was too expensive.

A narrower idea remains:

At selected strategic boundaries, preserve at most one or two keeper representatives when they have materially different future travel consequences.

Example:

```text
same boxes
same structural progress
same region

keeper A: near next unresolved task
keeper B: far across board
```

Ordinary Sokoban reachability may treat these as equivalent for solvability, but they are not equivalent for move optimization.

Only preserve this distinction at analyzer-selected milestones, not everywhere.

---

# 7.7 Strategic Task-Transition Cost

Do not merely weight distance to the next push.

Instead estimate the cost of **switching strategic tasks**.

A candidate that requires a longer walk now but enables several productive local pushes may be better than a nearby push that causes immediate future backtracking.

Potential quantity:

```text
taskTransitionCost =
    keeperTravelToTask
  + expectedFutureRegionSwitchCost
  + expectedRevisitCost
```

This is different from naive keeper-distance weighting, which has already been tested unsuccessfully in simpler forms.

---

# 7.8 Anytime Improvement Within the 10-Second Budget

The first solution currently arrives around 4.5 seconds in-browser.

That leaves roughly 5.5 seconds inside the target budget.

Potential architecture:

```text
0.0s   begin structural search
~4.5s  find 893 incumbent
       preserve it permanently
4.5–10s run targeted quality lanes
10.0s  return best verified incumbent
```

Potential lanes:

- analyzer-guided local windows,
- strategic restarts,
- push-block reordering,
- selected checkpoint continuation,
- selective FESS lane,
- task-order optimization.

Fast mode semantics should remain a product decision. If immediate return is desirable, this can be a quality mode or a user-configurable bounded quality mode.

---

# 8. Ideas That Should Not Be Repeated Naively

Based on current experiments, avoid simply retrying the following without a substantially different formulation:

- broad enabling handoffs,
- persistent agenda resumption,
- generic alternate macro approaches,
- global move-aware keeper-arrival diversity,
- global temporary-goal penalties,
- removal of temporary-goal identity,
- blind keeper-distance weighting,
- indiscriminate beam widening,
- indiscriminate macro-budget increases,
- indiscriminate hard-guard relaxation,
- arbitrary heuristic-noise restarts.

These ideas may still contain useful principles, but their naive/global forms have already shown poor cost/benefit.

---

# 9. Recommended Priority Order

## Priority 1 — Analyzer Diagnostics and Episode Analysis

Add or extend diagnostics for:

- box episodes,
- region episodes,
- keeper travel between episodes,
- first divergence from reference route,
- reasons a promising task is abandoned/revisited,
- safe staging opportunities missed.

This is the highest-information next step.

---

## Priority 2 — Safe Staging Analysis

Build a general staging-quality model using:

- deadlock safety,
- future push flexibility,
- support access,
- traffic preservation,
- future retrieval cost,
- dependency interference.

The analyzer should be able to distinguish:

> “box is not on goal yet”

from:

> “box is intentionally parked in a strategically excellent temporary position.”

---

## Priority 3 — Task Graph / Partial-Order Planning

Represent strategic dependencies without fixing all independent task orderings too early.

This creates the foundation for better keeper-aware scheduling.

---

## Priority 4 — Opportunistic Work / Opportunity Windows

When the keeper is already near useful work, allow the analyzer to recommend a small amount of safe progress before leaving the region.

This should be analyzer-driven and tightly capped.

---

## Priority 5 — Task Scheduling With Travel Cost

Order independent tasks based on:

- keeper location,
- region locality,
- staging opportunities,
- switch cost,
- future revisit cost.

This directly targets global walking waste.

---

## Priority 6 — Push-Block Reordering / Local Route Optimization

Once a good push agenda exists, optimize execution cheaply by commuting independent work and rewriting suspicious route windows.

---

## Priority 7 — Critical-Square Lifetime + Goal Commitment

Replace global temporary-goal penalties with explicit dependency-aware commitment analysis.

---

## Priority 8 — Strategic Restarts / FESS / Checkpoint Seeding

Explore these after analyzer improvements, not before.

The analyzer should first give these alternate search lanes better structural information to exploit.

---

# 10. Suggested Long-Term Architecture

A desirable future architecture is:

```text
                    BOARD
                      │
                      ▼
               SMART ANALYZER
                      │
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
   room/flow      safe staging   dependencies
       │              │              │
       ├──────────────┼──────────────┤
       ▼              ▼              ▼
 critical cells   flexibility    goal commitment
       │              │              │
       └──────────────┼──────────────┘
                      ▼
                  TASK GRAPH
                      │
                      ▼
             TASK / AGENDA SCHEDULER
          “what should happen, and when?”
                      │
                      ▼
               MACRO REALIZATION
              “how do I do the task?”
                      │
                      ▼
               LOW-LEVEL SEARCH
          “fewest moves to realize intent”
                      │
                      ▼
                VERIFIED ROUTE
                      │
                      ▼
          TARGETED ROUTE OPTIMIZER
```

The long-term objective is to move more intelligence upward into the analyzer and task scheduler so that the low-level search needs to explore fewer strategically meaningless states.

---

# 11. Evaluation Metrics

Continue measuring traditional metrics:

- solved / unsolved,
- moves,
- pushes,
- runtime,
- visited,
- generated,
- retained,
- frontier size,
- memory.

Add strategic metrics where practical:

- keeper walking moves,
- pushes by box,
- box episodes,
- region episodes,
- travel between episodes,
- goals reopened,
- pushes involving boxes already on goals,
- doorway crossings,
- room transfers,
- safe staging events,
- missed staging opportunities,
- task switches,
- repeated task revisits,
- failed targeted macros,
- enabling macros attempted/succeeded,
- strategic frontier diversity,
- route-window rewrite savings.

These metrics should be optional in production hot loops.

---

# 12. Generalization and Anti-Overfitting Rules

Never retain improvements that depend on:

- Grand Hall puzzle ID,
- exact Grand Hall dimensions,
- specific Grand Hall coordinates,
- specific box labels,
- fixed export/import counts,
- hard-coded fragments of the 628 route,
- or unexplained coefficients chosen solely because Grand Hall improved.

Use Grand Hall to expose weaknesses.

Fix the weakness in general Sokoban terms.

Benchmark across:

- small/simple puzzles,
- corridor puzzles,
- room/doorway puzzles,
- typed-box puzzles,
- many-box puzzles,
- packing-order puzzles,
- corral-heavy puzzles,
- puzzles currently solved very quickly,
- difficult structural puzzles,
- Grand Hall.

A change should ideally improve:

- aggregate solution quality,
- hard-puzzle solution quality,
- runtime,
- or quality per visited/generated state.

Regressions must be reported explicitly.

---

# 13. Experimental Discipline

Use one coherent change at a time.

Recommended loop:

```text
identify bottleneck
      ↓
add only necessary diagnostics
      ↓
implement one general hypothesis
      ↓
benchmark
      ↓
keep / modify / revert
      ↓
record result
```

Do not stack many heuristic changes before measuring them.

Preserve successful checkpoints.

Revert failed experiments cleanly.

Keep the repository coherent if work is interrupted.

---

# 14. Key Strategic Hypotheses Going Forward

The following hypotheses currently appear especially promising:

1. **The remaining move gap is substantially caused by task order and repeated regional travel, not by shortest-path keeper routing itself.**
2. **Safe temporary staging is a missing first-class planning concept.**
3. **Independent tasks should be represented as a partial order and scheduled using keeper-travel/setup cost.**
4. **Repeated box episodes and region episodes are useful indicators of poor global sequencing.**
5. **Some post-discovery move waste can be removed cheaply by reordering independent push blocks rather than re-solving the entire puzzle.**
6. **Hard pruning should require proof-like structural evidence; heuristic suspicion should usually influence ranking rather than act as an unconditional rejection.**
7. **Strategic diversity should preserve semantically different plans, not arbitrary geometric variants.**
8. **The analyzer should expose only a small number of high-confidence opportunity actions so that smarter planning does not create search explosion.**

---

# 15. Desired Milestones

The end target remains:

```text
<700 moves
<10 seconds
browser
```

Useful intermediate milestones:

```text
<850 first-found
<800 first-found
<750 first-found
<700 first-found or bounded-quality result
```

But the numeric milestone is secondary to the deeper goal:

> **The solver should improve because it understands Sokoban structure better, not because it searches disproportionately harder.**

The ideal improvement looks like the 1,066 → 893 breakthrough:

- better solution,
- fewer pushes,
- less search,
- and behavior that generalizes beyond Grand Hall.

---

# 16. Final Principle

The most promising future direction for Sokomind Solver is not to build an ever-larger brute-force search.

It is to make the analyzer progressively better at understanding:

- what must happen,
- what can happen in either order,
- what should happen while the keeper is already nearby,
- where boxes can safely wait,
- which cells must remain available,
- when a goal is truly safe to commit,
- when a box/region is being revisited unnecessarily,
- and which strategic tasks can be reordered to reduce travel.

If those questions are answered well, the low-level search can become smaller, faster, and more reliable while producing substantially better routes.

That is the direction most likely to make Sokomind Solver both **faster** and **smarter** across the full puzzle catalog.
