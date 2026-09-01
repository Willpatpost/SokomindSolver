# Generator solution-story contract

Phase 0 defined this evidence contract. Phase 1 implements its canonical replay
foundation; it does not yet change candidate scoring or infer story phases.

## Canonical trace

Every analysis must consume one replay-valid trace produced from the exact final
rows that would ship. Boxes retain stable identities from the initial state to
the final state, including whether each box is generic or typed.

```ts
interface CanonicalSolutionTrace {
  puzzleId: string;
  boardHash: string;
  solved: boolean;
  boxes: readonly TraceBox[];
  goals: readonly TraceGoal[];
  steps: readonly TraceStepEvent[];
  pushes: readonly TracePushEvent[];
  phases: readonly TracePhase[];
  semanticZones: SemanticZoneMap;
}

interface TracePushEvent {
  stepIndex: number;
  pushIndex: number;
  boxId: number;
  boxKind: "generic" | "typed";
  from: Position;
  to: Position;
  keeperSupport: Position;
  fromZoneId: string;
  toZoneId: string;
  goalBefore?: string;
  goalAfter?: string;
  reachableRegionBefore: string;
  reachableRegionAfter: string;
  reachablePushesBefore: readonly TracePushOption[];
  reachablePushesAfter: readonly TracePushOption[];
  enabledBoxIds: readonly number[];
  disabledBoxIds: readonly number[];
}
```

Box and goal IDs are assigned in initial row-major order. A box keeps its ID
through every push. Replay is strict: blocked moves, incorrect walk/push kinds,
ragged boards, missing or duplicate robots, and optionally unsolved final states
return typed errors instead of partial evidence. Story phase segmentation is
reserved for its later analysis phase, so Phase 1 emits an empty `phases` list.

The implementation lives in `src/features/generator/v2/solution-trace.ts` and
the semantic partition in `src/features/generator/v2/semantic-zones.ts`.

## Phase 2 passive analysis

`analyzePassiveSolutionStory()` consumes the exact final grid and its canonical
trace. It produces separate, evidence-rich reports for:

1. path-aware generic-goal assignment misdirection;
2. temporary progress reversal with later recovery and demonstrated benefit to
   another box;
3. multi-room box journeys;
4. depth-ordered goal-room packing;
5. doorway gate opening, intervening traffic, return, and reopening;
6. typed/generic push interleaving, causal enable/disable edges, and shared
   route or support cells;
7. contiguous box-work phases and revisited work;
8. the final board's semantic-zone traversal identity.

The profile is attached to solved `PuzzleEvaluationResult` and `ForgeCandidate`
objects but is not part of `PuzzleEvaluationVector`. Phase 2 therefore changes
neither acceptance, ranking, difficulty, nor catalog output.

Compact story summaries, traversal-fingerprint distributions, and evidence-led
explanations are emitted through forge diagnostics and review packs only.

Delayed false starts and recovery optionality are intentionally not claimed by
passive analysis. They require bounded counterfactual searches in a later phase.

Semantic zones are derived from the final board, not copied from an earlier
blueprint, so tightening and typing cannot leave stale evidence.

## Phase 3 mechanism construction

Mechanism mode now converts every placed mechanism into an explicit
`MechanismConstructionTarget`. A target retains the real goal cells, their
room/depth roles, dependencies on other targets, a construction directive, and
the passive evidence that the final solution must demonstrate:

- packing chains construct depth-ordered goal sequences;
- gate mechanisms construct doorway traffic, including reopening when required;
- staging and parking mechanisms construct displacement-and-return work;
- corridor and exchange mechanisms construct shared multi-room transport;
- dependency chains construct ordered, revisited work;
- assignment misdirection splits compatible goals across rooms and requires
  the final generic pairing to bypass an initially nearer goal;
- support-square contention places goals around a shared keeper-support cell;
  and
- multi-chain merge constructs two ordered chains that converge on one merge
  constraint.

Every mechanism carries an explicit sequence index and a target-local
typed/generic dependency requirement.

Verification is localized. Evidence only realizes a target when it involves
the boxes that actually finish on that target's goal cells. This prevents an
unrelated story elsewhere on the board from validating a decorative or lost
mechanism. Verification runs against the final post-typing canonical trace and
is attached to forge candidates and provenance. During Phase 3 it remains
diagnostic and does not change acceptance, ranking, difficulty, or catalog
output.

Hybrid typing is also constructive rather than a random fraction. It builds a
weighted interaction graph from shared box routes, shared keeper-support
cells, and consecutive push switches, then chooses typed boxes to maximize the
cut across that graph. Beginner puzzles retain at least one typed and one
generic box. Every higher tier with at least four boxes retains at least two of
each. Typed labels remain paired to the exact goals reached by the canonical
solution.

Mechanism goal groups add high-weight edges to that interaction graph. Thus a
global typed/generic interaction elsewhere cannot satisfy a mechanism: each
target must contain its own cross-class cut and its final passive verification
must observe target-local cross-type evidence.

Reverse scoring rewards assignment surprise, shared-support contention,
converging-chain participation, staging/parking revisits, and the reverse of
the declared forward mechanism sequence. These rewards act during construction;
the final evaluator remains the authority on whether the intended evidence
survived.

## Phase 4 story-aware typing

Hybrid typing is now a constrained solution-story assignment rather than a
cosmetic post-process. The optimizer consumes the generic witness replay and
searches for a fixed-size typed subset that satisfies all of the following:

- at least one typed and one generic box in Beginner, and at least two of each
  in every higher tier;
- a global cross-class relationship backed by causal enable/disable evidence,
  a shared route or keeper-support cell, doorway traffic, productive reversal,
  or verified goal-room ordering;
- target-local typed/generic minima for every constructed mechanism;
- role opposition for gates, staging, parking, corridor traffic,
  support-square contention, and both incoming chains of a merge; and
- for assignment-misdirection, at least one surprising box and a nearer
  alternative both remain generic so labels cannot reveal the assignment.

Boards whose only relationship is that two independent boxes are pushed one
after another do not receive a hybrid assignment. If no assignment satisfies
the story constraints, the candidate is rejected with `story-typing-failed`;
the pipeline no longer silently falls back to an all-generic board.

For boards with at most fourteen boxes the class assignment is selected by an
exact constrained search. Larger boards use deterministic seeded multi-start
local search. Both approaches maximize the weighted route/support/ordering cut
after satisfying the hard story constraints.

After final forward evaluation, `verifyStoryAwareTyping()` checks the class
minimums, strong cross-class relationship, preserved generic ambiguity, and
role opposition against the exact final trace selected by the evaluator. The
plan and verification are attached to the forge candidate and summarized in
provenance/review output. Unlike Phase 3's diagnostic-only construction report,
failed Phase 4 typing verification rejects the candidate.

## Required feature families

The story profile will preserve separate measurements for:

1. generic-goal assignment misdirection;
2. temporary progress reversal;
3. multi-room box journeys;
4. ordered goal-room packing;
5. gate opening, traffic, and reopening;
6. typed/generic interleaving and dependency edges;
7. distinct solution phases;
8. delayed, plausible false starts;
9. recoverable alternatives and optionality;
10. visual and structural identity.

These measurements influence acceptance and curation only. Difficulty remains
classified solely by final box count.

## Evidence rules

- A metric must identify the concrete boxes, goals, cells, pushes, or phases
  that support it.
- An intended mechanism is not evidence that the final solution realizes it.
- Analysis runs after every geometry and typing mutation.
- A bounded counterfactual timeout is `unknown`, never negative evidence.
- Immediate corner deaths do not qualify as controlled false starts.
- A reversal requires displacement, benefit to another task, and later recovery.
- Generic-goal surprise uses path-aware distance and the observed final pairing.
- Finalist review must expose a concise explanation assembled from evidence.
