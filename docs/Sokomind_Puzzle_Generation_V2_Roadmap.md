# Sokomind Puzzle Generation V2 Roadmap

## Purpose

This document proposes a complete redesign of Sokomind's procedural puzzle-generation system.

The current generated catalog is technically valid and generally solvable, but most generated puzzles are structurally weak: open rooms, scattered boxes and goals, little meaningful ordering, very few dependencies, and minimal need for staging, room traffic, packing logic, or long-term planning.

The goal of Generator V2 is not merely to generate *solvable boards*.

The goal is to generate puzzles that feel **designed**.

A strong generated Sokoban puzzle should deliberately create:

- rooms,
- corridors,
- hallways,
- narrow doorways,
- bottlenecks,
- packing order,
- box dependencies,
- support-square conflicts,
- staging requirements,
- temporary displacement,
- room exports/imports,
- crossing paths,
- misleading but plausible moves,
- and meaningful strategic choices.

The central philosophy is:

> **Do not generate a board and hope it contains a puzzle. Generate puzzle logic first, then construct geometry and box placement that realizes that logic.**

---

# 1. Diagnosis of the Current Generator

The current generator is built from several individually reasonable components that collectively produce weak Sokoban.

## 1.1 Current board generation

The current `generateFloorLayout()` approach creates:

1. a wall-filled grid,
2. random interior floor cells,
3. cellular-automata smoothing,
4. connected-component cleanup,
5. rejection if too little connected floor remains.

This is effective for generating cave-like connected shapes.

It is not effective for generating designed Sokoban topology.

The process has no explicit concept of:

- rooms,
- goal rooms,
- staging areas,
- hallways,
- narrow doorways,
- corridors,
- articulation points,
- box traffic,
- support squares,
- room roles,
- or forced ordering.

As a result, even when the board is visually irregular, its topology is often strategically shallow.

## 1.2 Current goal placement

Goals are selected from shuffled valid floor cells.

The generator tries to avoid obvious dead corners and dead-end alcoves, which is sensible for basic validity.

However, goals are not deliberately placed to create:

- deepest-first packing,
- room packing,
- shared-access dependencies,
- corridor queues,
- crossing routes,
- constrained matching,
- or intentional traffic conflicts.

This means the goals rarely participate in a designed puzzle mechanism.

## 1.3 Current reverse scrambling

The current generator's strongest conceptual choice is that it begins from a solved state and performs legal reverse pulls.

This is useful because it gives the generator a known path back to the solved state.

The weakness is **how reverse pulls are selected**.

The current behavior is effectively:

```text
enumerate legal reverse pulls
        ↓
choose one uniformly/randomly
        ↓
repeat
```

This guarantees displacement.

It does not guarantee interesting puzzle structure.

The reverse process does not currently ask:

- Does this create a dependency?
- Does this force one box to move before another?
- Does this create a useful staging requirement?
- Does this create a doorway conflict?
- Does this increase assignment ambiguity?
- Does this create a tempting wrong move?
- Does this deepen packing order?
- Does this force traffic through a bottleneck?

Therefore a high reverse-pull count can still produce a trivial puzzle.

## 1.4 Current difficulty classification

Difficulty is currently based primarily on:

- solution moves,
- solution pushes,
- box count.

That is not enough.

A puzzle can require many moves because:

- the room is large,
- boxes are far from goals,
- the keeper must walk long distances,
- or several boxes require obvious straight-line pushing.

That does not necessarily make the puzzle difficult.

A puzzle with 80 moves may be much harder than a 300-move puzzle if the shorter puzzle contains:

- subtle ordering,
- false choices,
- deadlock pressure,
- narrow access,
- box interdependence,
- or a difficult packing sequence.

Therefore Generator V2 must distinguish:

> **length**

from:

> **difficulty**

and also distinguish:

> **difficulty**

from:

> **tedium**.

---

# 2. New High-Level Architecture

The proposed Generator V2 pipeline is:

```text
        STRUCTURAL BLUEPRINT
        rooms / corridors / doors
                   │
                   ▼
          SOLVED GOAL LAYOUT
        goal rooms / packing order
                   │
                   ▼
         REVERSE PLAN GENERATOR
      deliberately creates dependencies
                   │
                   ▼
          CANDIDATE PUZZLE
                   │
          ┌────────┴─────────┐
          ▼                  ▼
   STRUCTURAL ANALYZER     SOLVERS
          │                  │
          └────────┬─────────┘
                   ▼
           QUALITY SCORING
                   │
             reject / mutate
                   │
                   ▼
          CURATED PUZZLE
```

The generator should progressively become a **design system**, not merely a randomizer.

---

# 3. Structural Blueprint Generation

## 3.1 Generate topology before tiles

Do not begin by assigning every grid cell to floor or wall.

Instead, generate an abstract spatial structure first.

For example:

```text
Room A ───── corridor ───── Room B
  │                           │
  │                           │
small                      narrow
staging bay                doorway
  │                           │
  └──────── Room C ──────────┘
```

Represent this abstractly.

For example:

```ts
interface RoomNode {
    id: number;
    kind:
      | "general"
      | "goal-room"
      | "staging"
      | "transit"
      | "packing"
      | "exchange";
    minWidth: number;
    minHeight: number;
}

interface PassageEdge {
    from: number;
    to: number;
    width: 1 | 2;
    length: number;
    shape: "straight" | "turn";
}
```

The blueprint is then rasterized into a Sokoban grid.

## 3.2 Topology families

Generated puzzles should not all use the same topology.

Useful topology archetypes include:

### Linear chain

```text
A ─ B ─ C
```

Good for staged progression, ordered room access, and sequential room traffic.

### Hub

```text
    B
    │
A ─ C ─ D
    │
    E
```

Good for route conflicts, central staging, and dependencies through a shared region.

### Loop

```text
A ─ B
│   │
D ─ C
```

Good for alternate routes, keeper access, and box-route interaction.

### Two wings

```text
A ─ C ─ B
    │
    D
```

Good for task scheduling, cross-region travel, and staging around a hub.

### Nested packing chamber

```text
A ─ corridor ─ B ─ narrow goal room
```

Good for deepest-first packing and irreversible commitments.

### Multi-door room

A room with two narrow exits.

Good for traffic-direction decisions, routing, and doorway occupancy timing.

---

# 4. Give Rooms Explicit Roles

Rooms should not exist merely for visual variety.

Each region can have an intended structural purpose.

## 4.1 Goal / packing room

Several goals lie inside a room with restricted access.

This can create deepest-first packing, shallow-goal blocking, ordering dependencies, and commitment decisions.

## 4.2 Transit room

A region whose main purpose is movement through it.

Boxes should often pass through rather than remain.

## 4.3 Exchange room

Some boxes must leave while others must enter.

This naturally creates export/import dependencies.

## 4.4 Staging room

A region intentionally designed to hold boxes temporarily.

This enables puzzles requiring a box to be parked safely, another task performed, and the staged box revisited later.

## 4.5 Corridor queue

A narrow corridor through which multiple boxes must pass.

Correct order matters because boxes cannot pass each other.

## 4.6 Shared work area

Several boxes require the same keeper support cells or maneuvering region.

This can force ordering and careful preservation of access.

---

# 5. Build a Library of Sokoban Motifs

A motif is a small reusable puzzle mechanism, not a complete handcrafted board.

Generator V2 should compose motifs.

## 5.1 Deepest-first packing

```text
door → [ goal A ][ goal B ][ goal C ]
```

If the shallow goal is filled too early, deeper goals become inaccessible.

## 5.2 Doorway traffic

Multiple boxes require the same narrow doorway.

Possible mechanics include exports before imports, one-way staging, and doorway timing.

## 5.3 Staging dependency

A must be moved temporarily so B can pass.

## 5.4 Support-square dependency

Box B requires the keeper to stand on a square currently occupied or blocked by A.

## 5.5 Gatekeeper box

A box blocks access to a region and must be moved temporarily.

## 5.6 Premature goal interference

A box can reach its goal early, but occupying it blocks future traffic or support access.

## 5.7 Crossing paths

Two or more boxes have intersecting routes and cannot be solved independently.

## 5.8 Wrong-room exchange

Boxes belong in opposite rooms and must pass through shared constrained space.

## 5.9 Temporary displacement

A box must first move away from its final target before later returning.

## 5.10 Shared staging square

Multiple boxes need the same temporary parking location at different times.

## 5.11 Keeper-side constraint

A box can only be pushed from the required direction after another task creates access.

## 5.12 Box-order corridor

Several boxes enter a narrow path, but only one ordering permits final placement.

---

# 6. Generate an Intended Dependency Graph

Before generating the final starting state, Generator V2 should create an intended high-level dependency structure.

Example:

```text
       move X from doorway
              │
      ┌───────┴───────┐
      ▼               ▼
 export A          export B
      │               │
      └───────┬───────┘
              ▼
          import C
              │
              ▼
          stage D
              │
              ▼
          pack C
              │
              ▼
          finish D
```

This graph is not necessarily a rigid total solution.

It can describe prerequisites, optional orderings, parallelizable work, room traffic, temporary staging, and commitment constraints.

Current philosophy:

```text
random board
    ↓
random goals
    ↓
random reverse pulls
    ↓
hope interesting puzzle emerges
```

Proposed philosophy:

```text
interesting puzzle logic
         ↓
construct compatible topology
         ↓
construct solved arrangement
         ↓
reverse-generate starting state
```

---

# 7. Keep Reverse Generation, Replace Random Pulls with Search

Reverse generation should remain.

The change is to replace random reverse pulls with **intelligent reverse search**.

## 7.1 Reverse beam search

Start from a solved state.

Generate many valid reverse pulls.

Score the resulting states for puzzle quality.

Retain the best and most structurally diverse candidates.

```text
solved
  │
  ├── reverse state A
  ├── reverse state B
  ├── reverse state C
  └── reverse state D
          ↓
    quality / interest scoring
          ↓
      retain best/diverse
          ↓
          expand
```

Useful symmetry:

```text
Sokoban Solver:
searches forward for solutions

Puzzle Forge:
searches backward for interesting problems
```

## 7.2 Other candidate methods

Possible algorithms include beam search, best-first search, MCTS, evolutionary search, novelty search, and hybrid beam + mutation.

Beam search is probably the most straightforward first implementation.

---

# 8. Puzzle Interest Vector

Do not collapse generation quality into one simplistic metric immediately.

Track a vector.

Possible features:

```ts
interface PuzzleInterestVector {
    structuralInteraction: number;
    dependencyDepth: number;
    meaningfulChoices: number;
    doorwayTraffic: number;
    packingComplexity: number;
    stagingRequirement: number;
    routeCrossing: number;
    assignmentAmbiguity: number;
    deadlockPressure: number;
    solverEffort: number;
    novelty: number;
    tedium: number;
}
```

---

# 9. Structural Interaction Metrics

Reward states where boxes meaningfully interact.

Examples:

- boxes crossing room boundaries,
- several boxes using one doorway,
- several boxes sharing support squares,
- intersecting box routes,
- one box's placement depending on another,
- temporary relocation,
- early completion blocking future work.

Avoid puzzles where every box is effectively independent.

---

# 10. Dependency Depth

A shallow dependency such as `A → B` is useful.

A deeper chain such as `A → B → C → D` is more strategically interesting.

However, avoid artificial chains that are merely tedious.

Dependency depth should be balanced with branching, meaningful choices, and compact geometry.

---

# 11. Decision Quality

A puzzle is interesting when the player must choose between plausible options.

At important states, measure legal pushes, reasonable-looking pushes, progressive pushes, and deadlocking pushes.

Trivial:

```text
legal pushes: 1
good pushes: 1
```

Interesting:

```text
legal pushes: 6
plausible pushes: 4
actually productive pushes: 1–2
```

This better reflects human difficulty than raw solution length.

---

# 12. Tedium Must Be Scored Separately

Long does not mean hard.

Create an explicit **Tedium Score**.

Penalize:

- huge empty rooms,
- long walks with no decisions,
- repeated straight pushes,
- unused floor,
- many independent boxes,
- excessive corridor backtracking,
- obvious forced sequences,
- long solutions caused only by distance.

Generation should optimize:

```text
maximize:
    structural difficulty
    meaningful dependencies
    decision quality
    novelty

minimize:
    tedium
    empty walking
    redundant geometry
```

---

# 13. Replace the Difficulty Classifier

The current threshold-based classifier should eventually be replaced or supplemented by a richer model.

Suggested:

```ts
interface DifficultyVector {
    solverEffort: number;
    dependencyDepth: number;
    meaningfulChoices: number;
    deadlockPressure: number;
    packingComplexity: number;
    roomTrafficComplexity: number;
    assignmentAmbiguity: number;
    topologyComplexity: number;
    pushes: number;
    moves: number;
    tedium: number;
}
```

---

# 14. Solver Effort as Difficulty Evidence

Instead of asking only how many moves are in the solution, also ask how much search was required.

Potential metrics:

- expanded states,
- generated states,
- transposition count,
- deadlock rejections,
- frontier size,
- elapsed time,
- heuristic plateaus,
- number of competing branches.

A shorter puzzle requiring far more search may be more difficult than a long obvious puzzle.

---

# 15. Use Multiple Solvers to Grade Candidates

For offline generation, evaluate candidates using several solver approaches where practical:

- Greedy,
- A*,
- IDA*,
- Sokomind Solver,
- FESS,
- bounded exact searches.

Interesting patterns:

```text
Greedy solves instantly
→ likely straightforward

Greedy struggles, structural solver succeeds
→ likely structural dependency

A* expands huge search tree
→ combinatorial difficulty

multiple solver families struggle
→ potentially genuinely hard
```

Do not optimize exclusively against one solver.

---

# 16. Tempting Bad Pushes as a Difficulty Signal

At solution checkpoints, classify alternatives as:

- productive,
- neutral,
- reversible mistake,
- subtle long-term mistake,
- immediate deadlock.

A puzzle with multiple plausible but strategically dangerous choices can be very interesting.

---

# 17. Geometry Tightening

After discovering an interesting puzzle, optimize board geometry.

For nonessential floor cells:

```text
floor → wall
    ↓
revalidate
    ↓
resolve
    ↓
did puzzle remain solvable and interesting?
```

If yes, consider keeping the wall.

Goals:

- remove useless open space,
- strengthen corridors,
- create purposeful geometry,
- reduce tedium.

Every mutation must be revalidated and preferably re-solved.

---

# 18. Mutation Phase

Useful mutations include:

- add/remove wall,
- widen/narrow doorway,
- lengthen corridor,
- shift goal,
- shift initial box,
- alter room dimensions,
- add staging alcove,
- remove redundant floor,
- rotate local structure,
- swap motif location.

After mutation:

1. validate board,
2. verify solvability,
3. recompute structural features,
4. recompute difficulty,
5. compare quality.

---

# 19. Generate Many Candidates, Keep Few

Official catalog generation should be highly selective.

Example funnel:

```text
100,000 candidate generations
        ↓
30,000 structurally valid
        ↓
12,000 meaningfully interactive
        ↓
5,000 suitable difficulty
        ↓
2,000 diverse high-quality puzzles
```

The exact numbers are not important.

The principle is:

> Rejection is healthy.

Do not accept a weak puzzle merely because it is solvable.

---

# 20. Separate Browser Generator from Official Catalog Forge

The best official generator should not be limited by interactive browser latency.

## Browser Generator

Purpose:

- fun,
- quick,
- decent quality.

Possible constraints:

- small candidate count,
- shallow reverse beam,
- lightweight structural scoring,
- short solver limits.

## Offline Puzzle Forge

Purpose:

- produce the official Sokomind catalog.

Can use:

- thousands of candidates,
- multiple solvers,
- expensive structural analysis,
- mutation,
- novelty search,
- difficulty calibration,
- curation,
- deduplication.

Run from Node or batch tooling.

The GitHub Pages application only needs the final puzzle data.

---

# 21. Generation Profiles / Puzzle Styles

Difficulty alone should not define a puzzle.

Introduce style profiles.

Examples:

## Packing

Focus on goal rooms, deepest-first ordering, and commitment timing.

## Traffic

Focus on doorway crossings, exports/imports, and room occupancy.

## Staging

Focus on temporary parking, reversibility, and workspace management.

## Corridor

Focus on queues, narrow channels, and ordering.

## Interlock

Focus on box dependencies and support-square conflicts.

## Exchange

Focus on boxes moving between regions in opposite directions.

## Mixed

Combine several motifs.

This prevents all difficult puzzles from feeling alike.

---

# 22. Difficulty Within Styles

Example:

## Beginner Packing

- 2–3 boxes,
- one obvious packing order,
- little deceptive access.

## Expert Packing

- multiple deep goals,
- temporary staging,
- shared doorway,
- partial assignment ambiguity.

## Master Packing

- several interacting packing orders,
- reopening risk,
- staging dependencies,
- multiple entrances or constrained access.

---

# 23. Use Typed / Labeled Boxes Intentionally

Generator V2 can sometimes decide typed assignments in advance.

Example:

```text
A must reach a
B must reach b
```

Then deliberately create crossing assignments, constrained traffic, wrong-room exchanges, and assignment dependencies.

Not every puzzle should be typed.

Typed puzzles should be a deliberate profile.

---

# 24. Structural Quality Metrics

Potential metrics:

| Metric | Desired tendency |
|---|---|
| Room count | varied |
| Doorway count | reward |
| Chokepoints | reward selectively |
| Largest open-area ratio | penalize excessive openness |
| Corridor count | varied |
| Corridor length | controlled |
| Articulation points | reward when meaningful |
| Box dependency edges | reward |
| Dependency depth | reward |
| Mandatory room crossings | reward |
| Packing dependencies | reward |
| Box path crossings | reward moderately |
| Required staging | reward |
| Support-square conflicts | reward |
| Assignment ambiguity | reward selectively |
| Solver expanded states | reward |
| Meaningful decision count | strongly reward |
| Forced trivial pushes | penalize |
| Empty walking | penalize |
| Independent-box ratio | penalize |
| Unused floor ratio | penalize |
| Structural novelty | reward |

---

# 25. Novelty / Diversity

Generating 2,000 strong puzzles is not enough if they are all structurally equivalent.

Novelty comparison could use:

- room graph shape,
- box count,
- goal-room configuration,
- motif signature,
- dependency graph,
- corridor pattern,
- solution push profile,
- topology hash,
- structural feature vector.

Reject near-duplicates.

---

# 26. Known-Solution Preservation

Reverse generation provides a valuable property: every generated candidate can retain a known forward path.

Preserve this.

Store generation provenance during offline generation:

```ts
interface GenerationProvenance {
    seed: number;
    blueprintId: string;
    reversePath: readonly ReverseMove[];
    motifs: readonly string[];
    structuralMetrics: StructuralMetrics;
}
```

This need not ship to production.

It is useful for debugging, reproducibility, difficulty analysis, and regression testing.

---

# 27. Puzzle Quality Is Multi-Objective

Do not immediately create one magic scalar score and assume its coefficients are correct.

Keep raw vectors.

Use:

- Pareto selection,
- tier-specific ranges,
- profile-specific weighting,
- diversity constraints.

A corridor puzzle should not be penalized because it has fewer rooms.

A packing puzzle should not require high route-crossing score.

---

# 28. Puzzle Acceptance Gates

Before a generated puzzle enters the catalog, require several gates.

## Gate 1: Validity

- valid Sokoban representation,
- equal boxes/goals,
- valid keeper region,
- no malformed geometry.

## Gate 2: Solvability

- canonical replay succeeds,
- known reverse-generated solution works.

## Gate 3: Structural quality

Reject if too open, too much floor is unused, too few interactions exist, boxes are largely independent, or no meaningful mechanism exists.

## Gate 4: Difficulty

The intended tier must be plausible and not merely long.

## Gate 5: Tedium

Reject excessive tedium.

## Gate 6: Novelty

Reject near-duplicates.

---

# 29. Difficulty Calibration with Human Feedback

Eventually, solver-derived difficulty should be calibrated against player data.

Potential signals:

- completion rate,
- average restarts,
- undo count,
- solve time,
- hint usage,
- abandonment rate.

This can reveal disagreements between solver classification and human experience.

This is a later phase, not required for initial Generator V2.

---

# 30. Recommended Implementation Order

## Phase 1 — Structural Blueprint Generator

Replace cellular-automata topology for official generation.

Implement:

- room graph,
- passage edges,
- rasterization,
- topology validation.

Success criteria:

- generated boards visibly contain designed rooms and corridors,
- topology metrics can distinguish open-room boards from structured boards.

## Phase 2 — Structural Metrics

Implement:

- room count,
- corridor count,
- doorway count,
- articulation points,
- open-area ratio,
- floor utilization,
- chokepoint analysis.

Use these first as diagnostics.

## Phase 3 — Goal-Aware Room Design

Implement deliberate goal rooms, packing chambers, corridor goals, and staging areas.

Stop uniformly scattering goals.

## Phase 4 — Reverse Beam Search

Replace uniform random reverse pulling.

Implement:

- reverse frontier,
- state scoring,
- structural diversity,
- bounded beam.

Initial scoring can use room crossing, distance, box interaction, doorway traffic, and support conflict.

## Phase 5 — Puzzle Interest / Difficulty Vector

Implement structural interaction, solver effort, dependency approximation, tedium, and meaningful choices.

Do not yet overfit coefficients.

## Phase 6 — Motif Library

Add intentional motif generators for packing, doorway traffic, staging, support dependency, temporary displacement, crossing routes, and exchanges.

## Phase 7 — Dependency Graph Generation

Generate desired puzzle logic first, then create geometry and reverse scrambling that preserve it.

## Phase 8 — Geometry Mutation and Tightening

Post-process strong candidates, remove useless floor, strengthen topology, and re-solve after every mutation.

## Phase 9 — Offline Puzzle Forge

Build batch generation tooling with large candidate pools, multiple solver evaluation, novelty, deterministic seeds, reporting, and catalog export.

## Phase 10 — Catalog Replacement

Do not immediately replace all current generated puzzles.

Generate a curated candidate set first.

Review samples manually.

Compare existing generated puzzles, new V2 puzzles, and handcrafted puzzles.

Only then replace or migrate the generated catalog.

---

# 31. Recommended Early Milestones

## Milestone A

Generate boards that clearly have 2+ rooms, corridors, narrow doorways, and low open-area ratio.

No concern about difficulty yet.

## Milestone B

Generate solvable puzzles where boxes cross between rooms and at least one ordering dependency exists.

## Milestone C

Generate puzzles requiring staging, packing order, and doorway traffic.

## Milestone D

Generate puzzles that fool Greedy but remain solvable by stronger search.

## Milestone E

Produce a batch of 100 generated puzzles that human review judges significantly better than the current generated catalog.

---

# 32. Anti-Patterns to Avoid

Do not equate:

```text
many boxes = difficult
```

Do not equate:

```text
many moves = difficult
```

Do not equate:

```text
large board = difficult
```

Do not equate:

```text
irregular walls = intricate
```

Do not simply add more walls to random rooms.

Do not optimize solely against Sokomind Solver.

Do not generate deliberate solver bugs/pathologies.

Do not accept every solvable candidate.

Do not let novelty create ugly or incoherent boards.

Do not make every Master puzzle a giant multi-room puzzle.

---

# 33. Relationship to the Sokomind Solver

The solver project and generator project can reinforce each other.

The solver already contains or is developing concepts such as:

- rooms,
- doorways,
- support dependencies,
- deadlocks,
- goal access,
- staging,
- packing order,
- box flexibility,
- task scheduling.

Those same concepts can become generator quality metrics.

Likewise, a stronger generator produces better solver benchmarks.

```text
better analyzer
    ↓
better generator evaluation
    ↓
harder/more varied generated puzzles
    ↓
better solver benchmark corpus
    ↓
better analyzer
```

However, generator and solver code should remain separate enough that generated puzzles do not become tailored exclusively to one solver's heuristics.

---

# 34. Long-Term Vision

The ultimate official-puzzle generation process could look like:

```text
Choose style:
    traffic / packing / staging / mixed

        ↓

Generate abstract room topology

        ↓

Choose puzzle motifs

        ↓

Generate dependency graph

        ↓

Construct solved goal configuration

        ↓

Reverse-search for difficult starting state

        ↓

Analyze structural quality

        ↓

Solve using several algorithms

        ↓

Estimate:
    difficulty
    decision quality
    tedium

        ↓

Mutate / tighten geometry

        ↓

Novelty comparison

        ↓

Accept into candidate pool

        ↓

Human spot review

        ↓

Official catalog
```

---

# 35. Core Design Principles

1. **Design puzzle logic before randomizing positions.**
2. **Reverse generation should search for interesting states, not merely distant states.**
3. **Difficulty is about constraints and decisions, not raw move count.**
4. **Tedium is not difficulty. Penalize it explicitly.**
5. **Rooms and corridors should have functional purposes.**
6. **Boxes should interact. Independent boxes make weak puzzles.**
7. **Generate many candidates and reject aggressively.**
8. **Official catalog generation can be computationally expensive offline.**
9. **Use multiple solver perspectives when evaluating puzzles.**
10. **Preserve diversity of puzzle mechanics, not just board appearance.**

---

# Final Recommendation

The existing generator should not be improved merely by tuning:

- cellular-automata density,
- reverse pull counts,
- box count,
- board dimensions,
- or difficulty thresholds.

Those parameters can make the existing output larger or longer, but they do not solve the core problem.

The foundational redesign should be:

```text
FROM:

random geometry
+ random goals
+ random reverse pulls
= technically valid Sokoban


TO:

structural blueprint
+ intentional room roles
+ puzzle motifs
+ dependency graph
+ intelligent reverse search
+ structural quality scoring
+ solver evaluation
+ anti-tedium filtering
+ novelty selection
= designed-feeling Sokoban
```

The highest-priority concrete work is:

1. build a structural room/corridor blueprint generator;
2. create structural-quality diagnostics;
3. deliberately place goals into functional regions;
4. replace random reverse pulling with reverse beam search;
5. score interaction, dependency, difficulty, and tedium separately;
6. create a motif library;
7. build an offline Puzzle Forge for the official catalog.

If executed well, Generator V2 should stop producing boards that merely *contain boxes and goals* and begin producing puzzles that deliberately demand planning, ordering, staging, and insight.
