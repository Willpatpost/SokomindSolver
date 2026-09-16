# Grand Hall Component PDB Report

## Correctness

**Admissibility argument**: Each component PDB is a reverse BFS in a single-box
relaxation (all other boxes removed). For any real solution, each box's
trajectory from its start to its final goal is a valid path in the single-box
relaxation. The PDB distance for that component is therefore a lower bound on
the real pushes needed by that component's boxes.

**Why component PDB values are additive**: Components partition the boxes by
label and matching structure. Each box belongs to exactly one component. Push
costs are disjoint across components — a push of box B in component C does not
count toward component D. Therefore, summing lower bounds across components
preserves admissibility.

**Why partition minimization preserves admissibility**: The forward state does
not preserve physical box identity within a label. The partition DP minimizes
over all valid assignments of current same-label boxes to components. Since the
real hidden assignment is one candidate in that minimum, the minimum is a lower
bound on the real cost.

**Why ordinary forward same-label identity remains valid**: The forward search
treats same-label boxes as interchangeable. The component PDB never expands the
forward state space — it only provides an admissible heuristic via partition
minimization at evaluation time.

---

## Grand Hall Structure

- **Total matching components**: 10
- **Finite edges**: 83, allowed: 55, eliminated: 28

Per-label breakdown:

| Label | Components | Sizes |
|-------|------------|-------|
| A     | 1          | [1]   |
| B     | 1          | [1]   |
| C     | 1          | [1]   |
| D     | 1          | [1]   |
| G     | 1          | [1]   |
| H     | 1          | [1]   |
| X     | 4          | [7, 2, 1, 1] |

### Generic X component membership

- **Component 6 (1 box)**: goal cell 13, initial cell 23, corridor: 2 cells, 2 edges
- **Component 7 (7 boxes)**: goals [1,2,6,10,11,15,20], initials [25,30,46,104,106,108,110], corridor: 86 cells, 207 edges
- **Component 8 (1 box)**: goal cell 22, initial cell 32, corridor: 2 cells, 2 edges
- **Component 9 (2 boxes)**: goals [115,125], initials [94,96], corridor: 20 cells, 37 edges

The two X singletons (components 6, 8) are geometrically forced: each goal is
reachable only from one initial position and vice versa. The 2-box component
(9) captures the lower-room pair. The 7-box component (7) is the main body of
generic boxes.

### Typed-label components

Each typed label (A, B, C, D, G, H) has exactly one box and one goal, forming
a singleton component with complete PDB and radius 13–22.

---

## PDB Build

| Component | Label | Boxes | States | Complete | Radius | Build (ms) | Retained |
|-----------|-------|-------|--------|----------|--------|------------|----------|
| 0         | A     | 1     | 89     | yes      | 22     | 0.3        | 708 B    |
| 1         | B     | 1     | 89     | yes      | 22     | 0.1        | 708 B    |
| 2         | C     | 1     | 82     | yes      | 20     | 0.1        | 708 B    |
| 3         | D     | 1     | 82     | yes      | 20     | 0.1        | 708 B    |
| 4         | G     | 1     | 65     | yes      | 17     | 0.1        | 708 B    |
| 5         | H     | 1     | 65     | yes      | 13     | 0.1        | 708 B    |
| 6         | X     | 1     | 2      | yes      | 1      | 0.0        | 708 B    |
| 7         | X     | 7     | 200000 | **no**   | **9**  | 2116       | 20.6 MB  |
| 8         | X     | 1     | 2      | yes      | 1      | 0.0        | 708 B    |
| 9         | X     | 2     | 175    | yes      | 22     | 1.0        | 18.7 KB  |

- Total build time: ~2.1 seconds
- Peak build memory: 33.9 MB
- Total retained: 20.6 MB

---

## Heuristic Behavior

On Grand Hall forward search (120-second runs, interaction boost disabled):

### A* (componentPdb ON)

- Partition queries: 170,254
- Partition cache hits: 161,699 (95.0% hit rate)
- **Times component bound beat existing bound: 0**
- Average improvement: 0
- Max improvement: 0
- Heuristic calls: 24,322
- Lower bound reached: 229

### IDA* (componentPdb ON)

- Partition queries: 236,908
- Partition cache hits: 227,071 (95.8% hit rate)
- **Times component bound beat existing bound: 0**
- Average improvement: 0
- Max improvement: 0
- Heuristic calls: 33,844
- Lower bound reached: 228

---

## Benchmarks

### A* (120s, interaction boost OFF, backward perimeter OFF)

| Config | Expanded | Generated | Heuristic Calls | Lower Bound | Preprocessing |
|--------|----------|-----------|-----------------|-------------|---------------|
| Baseline (componentPdb OFF) | 11,889 | 442,472 | 255,178 | 233 | ~1s |
| componentPdb ON | 1,100 | 41,248 | 24,322 | 229 | ~3s |

### IDA* (120s, interaction boost OFF, backward perimeter OFF)

| Config | Expanded | Generated | Heuristic Calls | Lower Bound | Preprocessing |
|--------|----------|-----------|-----------------|-------------|---------------|
| Baseline (componentPdb OFF) | 17,794 | 669,954 | 142,145 | 231 | ~1s |
| componentPdb ON | 3,912 | 147,187 | 33,844 | 228 | ~3s |

---

## Exact Result

**Grand Hall is NOT solved** within 120-second time budgets.

---

## Bottleneck Analysis

The component PDB **never exceeds the existing assignment heuristic** on any
expanded Grand Hall state. The assignment heuristic uses exact reverse-push
distances for each of the 17 box-goal pairs and computes optimal bipartite
matching costs. This naturally subsumes the per-component single-box push
distances that the component PDB provides.

The 7-box X component has `completedRadius = 9`. Most forward states are much
farther than 9 pushes from the goal within that component, so the PDB returns
the fallback bound of 10. The assignment heuristic easily predicts higher costs
for 7 boxes spread across the board.

The partition DP adds significant per-evaluation overhead (~7 family queries per
heuristic call, each involving bitmask enumeration over same-label boxes) while
providing no heuristic improvement.

**Primary bottleneck**: The existing assignment heuristic already dominates the
component PDB. The component PDB's single-box relaxation loses the very
information (box-box interaction costs) that would be needed to beat it.

---

## Recommended Next Step

The plan's escalation strategy (Section 12, Phase B) identifies the right
direction:

1. **Deeper 7-box component PDB**: Increase `maxStatesPerComponent` to 1M–5M.
   With completedRadius=9 at 200K states, the marginal cost of each additional
   radius layer grows exponentially. Even 5M states may only reach radius 12-14,
   which likely still won't beat the assignment heuristic.

2. **Subpattern abstractions**: Partition the 7 boxes into 3+4 or other
   subpatterns with admissible additive combination. This is the most promising
   approach — smaller patterns can be built to completion and would capture
   multi-box interactions.

3. **Pairwise interaction PDBs**: Build 2-box or 3-box interaction PDBs within
   the 7-box component where corridors overlap. These capture mutual blocking
   omitted by the single-box relaxation.

4. **Alternative heuristic combinations**: The existing assignment + linear
   conflict + PDB surplus + goal cut heuristic is strong. Rather than trying to
   beat it with component PDBs, consider strengthening the interaction boost
   evaluator or exploring IDA* with longer time budgets.

The fundamental challenge is that Grand Hall's 17-box, 127-floor state space is
enormous, and the current lower bounds (228-233 moves) are likely still far from
optimal. The solver needs either dramatically better heuristics or dramatically
more search capacity.
