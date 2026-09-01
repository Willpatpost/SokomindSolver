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

Delayed false starts and recovery optionality are intentionally not claimed by
passive analysis. They require bounded counterfactual searches in a later phase.

Semantic zones are derived from the final board, not copied from an earlier
blueprint, so tightening and typing cannot leave stale evidence.

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
