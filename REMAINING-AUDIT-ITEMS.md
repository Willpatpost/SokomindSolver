# Remaining Audit Items: Q8, P1, P2, P6

Four intentionally deferred roadmap items remain from the original 55-item
audit. They are not unpatched defects in the current deployment: Q8 is
algorithmic research for parity between the classic solvers and the production
Sokomind engine, while P1, P2, and P6 require externally sourced catalog data.
This document records their scope, evidence, and acceptance work separately
from the closed repository audit.

---

## Q8: Tunnel Macros, Goal Macros, and Corral Detection

### What It Is

The classic A\* and IDA\* solvers generate successors one push at a time. Every
single-cell box movement creates a new search node, even when the outcome is
forced (tunnels), the order is predetermined (goal rooms), or the push is
provably irrelevant (corrals). These classical Sokoban techniques are not yet
integrated into `src/solver/search/engine.ts` and
`src/solver/search/ida-star.ts`.

The production Sokomind engine is materially further ahead: its source modules
compile tunnel segments, use tunnel-aware push expansion, maintain goal-room
packing tables, and perform exact-player-region corral analysis. Q8 therefore
tracks classic-solver parity and further proof/benchmark work; it must not be
read as claiming those techniques are absent from the application as a whole.

**Tunnel macros**: When a box enters a 1-wide corridor, it can only exit from one of two ends. The solver should skip all intermediate states and emit only the two exit states, eliminating O(corridor\_length) nodes per tunnel push.

**Goal macros**: When a goal area has a single entrance and contains only goals, boxes must enter in a specific order and go to specific positions. The solver can precompute this ordering and jump directly to the final placement, pruning the entire subtree of intermediate states.

**Corral pruning**: A corral is a region enclosed by boxes and walls that the keeper cannot enter. If all goals in a corral are already satisfied (or no goals exist there), any push into that region is futile and can be pruned. This is a per-state check, not a static precomputation.

### Current State

The codebase has three deadlock detectors in `src/solver/search/deadlocks.ts` (182 lines):

| Detector | Type | Description |
|----------|------|-------------|
| Static dead cell | Pre-computed | A cell is dead for label L if no matching goal is reachable via reverse-push |
| 2x2 deadlock | Per-state | Any 2x2 block of walls/boxes with a misplaced box is dead |
| Freeze deadlock | Per-state | Fixpoint: a box frozen on both axes and not on its goal is dead |

These three typed detectors do not themselves address tunnels, goal rooms, or
corrals. The production engine implements related logic under
`src/solver/implementations/sokomind-engine/source/`; its sequence planning and
topology-aware push macros are distinct from adding equivalent behavior to the
classic A\*/IDA\* successor loops.

### Why It Is Hard

- **Tunnel detection** requires a static analysis pass over the board topology to identify 1-wide corridors, their entry/exit cells, and how they interact with goals. This analysis belongs in `src/solver/search/compiled-board.ts` and must integrate with the existing `ReachabilityTopology`. Estimated: 200-300 lines of new code.
- **Goal macros** require identifying goal rooms (connected components of goal cells behind single-entrance chokepoints), computing forced entry orderings, and validating that the macro is safe (no label conflicts). This is the most algorithmically complex of the three. Estimated: 300-400 lines.
- **Corral pruning** requires a reachability partition at each search state to identify enclosed regions the keeper cannot access. This is a per-node cost, so it must be fast enough that the pruning benefit outweighs the detection cost. Estimated: 200-250 lines across `deadlocks.ts` and the successor loops.
- All three require changes to both the A\* and IDA\* successor loops, doubling the integration surface.
- Correctness is critical: an incorrect macro or prune silently makes solvable puzzles appear unsolvable.

### What We Can Do

**Phase 1 - Tunnel macros (highest ROI, lowest risk)**

1. Add a `TunnelAnalysis` to `compiled-board.ts` that identifies 1-wide corridors during board compilation. A corridor cell has exactly 2 walkable neighbors along one axis and walls on the perpendicular axis.
2. In the successor loop of both engines, when a push moves a box into a tunnel entry cell, emit successor states for each tunnel exit instead of the single-push state.
3. The tunnel exit states skip all intermediate cells, so the `moves` count on the successor must account for the keeper walking through the tunnel to reach each push position.

**Phase 2 - Corral pruning (medium ROI, medium risk)**

1. After generating each successor state, partition the board into keeper-reachable and keeper-unreachable regions using the existing `KeeperReachability` flood.
2. For each unreachable region, check if all goals within it are satisfied. If yes, mark any push that targets a cell in that region as prunable.
3. This piggybacks on the reachability flood that already runs for canonical robot position (S1), so the incremental cost is the region analysis, not the flood itself.

**Phase 3 - Goal macros (highest complexity, highest reward for goal-heavy puzzles)**

1. During board compilation, identify goal rooms: connected components of goal cells where all paths to the rest of the board pass through a single chokepoint cell.
2. For each goal room, precompute the forced entry ordering using reverse-push analysis from the innermost goal outward.
3. In the successor loop, when a push would move a box into a goal room, validate against the forced ordering. If the box is next in order, emit a successor with the box placed on its final goal position. Otherwise, prune the push.

### How It Helps the Project

- **Solver speed**: Tunnel macros alone can reduce node count by 30-60% on corridor-heavy puzzles (Junghanns & Schaeffer, 2001). Corral pruning adds another 10-30% on open-floor puzzles. Goal macros can prune entire subtrees for goal-room puzzles.
- **AlphaEvolve fitness**: Faster solves = higher fitness scores in the benchmark harness. The tuning surface could also expose macro aggressiveness as a tunable parameter.
- **Puzzle coverage**: Some expert/master puzzles may currently time out. Better pruning makes them solvable within the benchmark time budget, improving solve rate and mean fitness.

### Files That Would Change

| File | Change |
|------|--------|
| `src/solver/search/compiled-board.ts` | Tunnel analysis, goal room identification |
| `src/solver/search/engine.ts` | Successor loop: tunnel expansion, corral check |
| `src/solver/search/ida-star.ts` | Same successor changes mirrored |
| `src/solver/search/deadlocks.ts` | Corral detection function |
| `src/solver/search/model.ts` | New types for tunnel/goal room data |

### References

- Junghanns, A. & Schaeffer, J. (2001). "Sokoban: Enhancing General Single-Agent Search Methods Using Domain Knowledge." *Artificial Intelligence*, 129(1-2), 219-251.
- Junghanns, A. & Schaeffer, J. (1998). "Single-Agent Search in the Presence of Deadlocks." *AAAI-98*.
- Virkkala, T. (2011). "Solving Sokoban." Master's thesis, University of Helsinki.

---

## P1: Extreme Difficulty Skew

### What It Is

The puzzle catalog has 2,194 puzzles distributed as follows:

| Difficulty | Canonical | Imported | Total | Share |
|------------|-----------|----------|-------|-------|
| Tutorial | 5 | 0 | 5 | 0.2% |
| Beginner | 5 | 41 | 46 | 2.1% |
| Intermediate | 7 | 1,083 | 1,090 | 49.7% |
| Advanced | 9 | 1,026 | 1,035 | 47.2% |
| Expert | 4 | 9 | 13 | 0.6% |
| Master | 2 | 3 | 5 | 0.2% |

97% of puzzles are intermediate or advanced. The tails (tutorial, beginner, expert, master) have almost nothing.

### Why It Is Hard

The skew comes from the imported puzzle sources:

| Collection | Count | Difficulties |
|------------|-------|-------------|
| Boxoban Medium | 1,000 | 100% intermediate |
| Boxoban Hard | 1,000 | 100% advanced |
| Microban | 124 | Mixed (beginner through master) |
| Caleb | 22 | Mixed |
| Extremely Easy | 10 | 100% beginner |
| Seemingly Hard | 5 | 100% expert |
| Illustrative Levels | 1 | intermediate |

Boxoban contributes 2,000 puzzles (91%) and only spans two difficulty tiers. Sourcing expert/master puzzles is hard because they require careful human design or sophisticated generators. Beginner/tutorial puzzles are easier to create but existing open collections don't label them as such.

### What We Can Do

**Option A: Import more diverse collections**

Several well-known Sokoban puzzle collections exist with broader difficulty ranges and varied grid sizes:

| Collection | Author | Puzzles | Sizes | Difficulty Range |
|------------|--------|---------|-------|-----------------|
| Sasquatch I-VI | David W. Skinner | ~300 | 7x7 to 20x20+ | Beginner to master |
| Minicosmos | Aymeric du Peloux | 40 | Small | Easy to medium |
| Microcosmos | Aymeric du Peloux | 40 | Small | Easy to medium |
| Nabocosmos | Aymeric du Peloux | 40 | Medium | Medium to hard |
| Picocosmos | Aymeric du Peloux | 40 | Tiny | Easy |
| XSokoban | MIT | 90 | Varied | Medium to hard |
| Yoshio Murase | Yoshio Murase | 50 | Varied | Medium to expert |
| Thinking Rabbit | Original game | 90 | Varied | Beginner to expert |
| Sokhard | Various | ~50 | Varied | Expert to master |

Importing 5-6 of these collections would add ~500-700 puzzles across all difficulty tiers. The conversion work is: parse SLC/SOK format (the standard Sokoban level exchange formats), map the wall/floor/box/goal characters to Sokomind's notation, and assign difficulty labels using `estimatePuzzleComplexity()` as a guide with manual review.

**Option B: Subsample Boxoban**

Reduce the Boxoban contribution from 2,000 to 200-400 (100-200 per tier), selected for maximum diversity (varied wall patterns, floor ratios, box positions). This rebalances without adding new content but reduces total catalog size.

**Option C: Generate puzzles for underrepresented tiers**

Write a puzzle generator targeting specific difficulty profiles. Reverse-play generation (start from solved state, apply reverse pushes to create the puzzle) is the standard approach. Control difficulty by: grid size, box count, solution length, and dead-end density. This is substantial engineering (500+ lines) but produces unlimited puzzles at any difficulty.

**Recommended approach**: Option A first (fastest path to diversity), then Option B (rebalance), then Option C for ongoing generation.

### How It Helps the Project

- **AlphaEvolve training**: A skewed corpus means the solver is primarily tuned for 10x10/4-box intermediate/advanced puzzles. Expert and master puzzles are almost unrepresented in fitness evaluations, so AlphaEvolve has no signal to optimize for them.
- **Benchmark validity**: The benchmark corpus (`scripts/benchmark-sokomind-solver.ts`) tries to span all tiers, but with only 5 tutorial and 5 master puzzles to choose from, it can't be representative.
- **User experience**: Players who complete beginner puzzles face a cliff — 1,090 intermediate puzzles with no gradual ramp. Similarly, advanced players have only 13 expert + 5 master puzzles before exhausting the catalog.

---

## P2: Boxoban Homogeneity

### What It Is

The imported puzzle catalog is dominated by a single format:

**Grid dimensions (imported puzzles):**

| Size | Count | Share |
|------|-------|-------|
| 10x10 | 2,002 | 92.6% |
| Other (23 distinct sizes) | 160 | 7.4% |

**Box counts (imported puzzles):**

| Boxes | Count | Share |
|-------|-------|-------|
| 4 | 2,045 | 94.6% |
| Other (1-12 range) | 117 | 5.4% |

92.6% of puzzles are exactly 10x10 and 94.6% have exactly 4 boxes. This is because Boxoban (DeepMind's generator) outputs a fixed format.

### Why It Is Hard

The homogeneity is structural to the data source, not a labeling problem. The Boxoban dataset was generated with fixed parameters (10x10 grid, 4 boxes, specific wall density). Generating more Boxoban puzzles won't help — they'll have the same format.

Diversifying requires either:
1. Importing collections with different formats (same as P1's solution)
2. Building or adapting a generator that targets varied configurations
3. Both

### What We Can Do

**Immediate: Import varied-format collections (same as P1 Option A)**

The non-Boxoban collections listed under P1 naturally provide dimensional diversity:

| Collection | Typical grid sizes | Typical box counts |
|------------|-------------------|--------------------|
| Microban (remaining 31) | 5x5 to 15x15 | 1-8 |
| Sasquatch | 7x7 to 20x20+ | 2-20+ |
| Minicosmos/Microcosmos | 5x5 to 9x9 | 1-5 |
| XSokoban | 8x8 to 20x20 | 3-12 |
| Thinking Rabbit | 10x10 to 20x20 | 3-12 |

This directly addresses both P1 and P2 with the same import work.

**Medium-term: Parameterized puzzle generator**

A reverse-play generator with configurable parameters:
- Grid size: width x height (e.g., 5x5 through 25x25)
- Box count: 1 through N
- Wall density: sparse to dense
- Corridor prevalence: open floor vs. maze-like

This could be integrated into the project as `scripts/generate-puzzles.ts` and run periodically to backfill underrepresented configurations.

### How It Helps the Project

- **Solver generalization**: A solver tuned on 10x10/4-box puzzles may develop strategies that don't transfer to other configurations. For example, it might learn that 4-box problems are best solved with a specific Hungarian matching weight, but this doesn't generalize to 8-box problems where the combinatorics are fundamentally different.
- **AlphaEvolve overfitting**: If 95% of the fitness signal comes from one puzzle shape, AlphaEvolve will optimize for that shape. Weight parameters that help on 10x10/4-box but hurt on 15x15/8-box will be selected for.
- **Search space coverage**: The tuning surface has 21 parameters. Evaluating them on a homogeneous corpus means most of the parameter space's effect is unmeasured.

---

## P6: No Labeled-Box Imported Puzzles

### What It Is

Sokomind supports labeled boxes — boxes marked A-Z that must reach their matching lowercase goal (a-z). This is a superset of standard Sokoban (where all boxes are interchangeable). The solver fully supports this:

- Label-aware heuristic matching in `src/solver/search/assignment.ts`
- Label-aware deadlock detection in `src/solver/search/deadlocks.ts`
- Label-aware solved checks in `src/core/game-session.ts`
- `capabilities.labeledBoxes: true` in `sokomind-solver.ts:2153`

However, **0 of 2,162 imported puzzles use labeled boxes**. Only 15 of 32 canonical puzzles use them. This means the labeled-box code path is exercised by only 0.7% of the catalog.

### Why It Is Hard

No standard Sokoban puzzle collection uses labeled boxes. The standard Sokoban format (SLC/SOK files) has no notation for them — there's just `$` (box) and `.` (goal), all interchangeable. Labeled boxes are a Sokomind-specific extension.

This means:
1. We cannot import labeled-box puzzles from existing collections — they don't exist.
2. We must either create them manually or build a generator.
3. Converting standard puzzles to labeled puzzles is possible but non-trivial: assigning labels changes the puzzle's difficulty because the solver can no longer treat boxes as interchangeable.

### What We Can Do

**Option A: Label-injection post-processor**

Take existing generic puzzles and assign labels to boxes and goals. This is a mapping problem:

1. Solve the generic puzzle to find the optimal box-to-goal assignment.
2. Assign matching labels based on this assignment (Box 1 → A, its destination goal → a, etc.).
3. The resulting puzzle has the same solution but is now a labeled puzzle with a unique solution mapping.

This is automatable: run the solver on each generic puzzle, extract the box-goal pairing from the solution, and write back with labels. A script of ~150 lines could process the entire catalog.

**Caveat**: Puzzles where multiple boxes are interchangeable (e.g., three identical boxes going to three identical goals in a line) become trivially harder or the same difficulty with labels. The interesting labeled puzzles are ones where boxes must cross paths to reach their goals — these require intentional design.

**Option B: Hand-craft labeled puzzles**

Design puzzles specifically around the labeled-box mechanic. The interesting design space is:
- Puzzles where the obvious box-goal pairing is wrong (boxes must swap positions)
- Puzzles where labeled constraints force a specific solving order
- Puzzles where removing labels would make the puzzle trivially easier

This produces higher-quality puzzles but doesn't scale.

**Option C: Generate labeled puzzles**

Extend a puzzle generator to:
1. Generate a standard puzzle with N boxes and N goals.
2. Assign labels such that at least one pair of boxes must cross paths in the solution.
3. Verify the puzzle is solvable with the assigned labels (not just as a generic puzzle).

This is the most engineering-heavy option but produces unlimited high-quality labeled puzzles.

**Recommended approach**: Option A first (fast, automatable, gets labeled puzzles into the catalog immediately), then Option B/C for puzzles that truly exercise the mechanic.

### How It Helps the Project

- **Test coverage**: The label-aware code paths in the solver are barely exercised. A bug in label matching could go undetected because 99.3% of puzzles never trigger it.
- **AlphaEvolve tuning**: The tuning surface includes weights that affect label-aware heuristics (`labelMatchWeight`, etc. in the Hungarian matching). Without labeled puzzles in the benchmark corpus, AlphaEvolve has no fitness signal to tune these weights.
- **Feature validation**: Labeled boxes are a differentiating feature of Sokomind vs. standard Sokoban. If the feature is untested at scale, it's a liability rather than an asset.

---

## Summary and Recommended Order

| Priority | Item | Effort | Impact | Approach |
|----------|------|--------|--------|----------|
| 1 | **P1 + P2** (combined) | Medium | High | Import 5-6 open Sokoban collections (Sasquatch, du Peloux, XSokoban, etc.); subsample Boxoban to 200-400 |
| 2 | **P6** | Low-Medium | Medium | Label-injection post-processor on selected generic puzzles |
| 3 | **Q8 Phase 1** | Medium | High | Tunnel macros in compiled-board + both search engines |
| 4 | **Q8 Phase 2** | Medium | Medium | Corral pruning piggybacking on existing reachability flood |
| 5 | **Q8 Phase 3** | High | High | Goal macros with forced ordering precomputation |

P1 and P2 are best solved together since the same import work addresses both. P6 is a quick follow-up using the solver's own output. Q8 is phased so each technique can be validated independently.

### Estimated Total Effort

| Work Item | Lines of Code | Days (est.) |
|-----------|--------------|-------------|
| SLC/SOK parser + import pipeline | ~200 | 1 |
| Collection import + difficulty labeling | ~100 + manual review | 1-2 |
| Boxoban subsampling script | ~80 | 0.5 |
| Label-injection post-processor | ~150 | 0.5 |
| Tunnel macros (Q8 Phase 1) | 200-300 | 2-3 |
| Corral pruning (Q8 Phase 2) | 200-250 | 2 |
| Goal macros (Q8 Phase 3) | 300-400 | 3-4 |
| Tests for all of the above | ~500 | 2 |
| **Total** | **~1,700-2,000** | **~12-16** |
