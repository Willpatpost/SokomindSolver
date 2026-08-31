# Generator solution-story contract

This is the Phase 0 data contract for later story analysis. It defines evidence
only; Phase 0 does not yet implement the analyzer or change candidate scoring.

## Canonical trace

Every analysis must consume one replay-valid trace produced from the exact final
rows that would ship. Boxes retain stable identities from the initial state to
the final state, including whether each box is generic or typed.

```ts
interface SolutionStoryTrace {
  puzzleId: string;
  boardHash: string;
  solved: boolean;
  boxes: readonly StoryBox[];
  goals: readonly StoryGoal[];
  pushes: readonly StoryPushEvent[];
  phases: readonly StoryPhase[];
}

interface StoryPushEvent {
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
  enabledBoxIds: readonly number[];
  disabledBoxIds: readonly number[];
}
```

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
