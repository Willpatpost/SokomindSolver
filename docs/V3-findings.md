# V3 Findings: Grand Hall Parameter Experiments

Last updated: August 14, 2026

Target: Grand Hall (17 boxes, 127 floor, 4 rooms)
Algorithm: `plan-macro-beam` (direct `search()` call, same as huge test)
Environment: Waterfield login node (~9x slower than fast hardware)

---

## Baseline

| Metric | Value |
|---|---|
| Moves | 1,010 |
| Pushes | 316 |
| Visited | 1,843 |
| Generated | 13,844 |
| Rewrite (quality mode) | 874 moves / 304 pushes |

Scoring formula (`scoreCandidate`, solver-search.js:1300):
```
score = pushCost + planMoveWeight * moves
      + (evacActive ? 0.25 : 1.15) * estimate
      + 4 * goalAccessPenalty + 0.08 * evacuation
      + (evacActive ? 4 : 3) * doorwayPenalty
      - (evacComplete ? 250 : 0)
```

Default `planMoveWeight` = 0.005 (engine hardcoded default).

---

## Experiment 1: planMoveWeight Variations

**Hypothesis:** Increasing planMoveWeight penalizes total moves in scoring,
should bias beam toward shorter-move solutions.

**Result: COUNTERPRODUCTIVE.** All increases made move count WORSE.

| planMoveWeight | Moves | Pushes | Visited | Delta | Verdict |
|---|---|---|---|---|---|
| 0.005 (baseline) | 1,010 | 316 | 1,843 | — | BASELINE |
| 0.01 | 1,083 | 322 | 1,972 | +73 | WORSE |
| 0.02 | 1,008 | 314 | 1,875 | −2 | NEUTRAL |
| 0.03 | 1,150 | 340 | 2,292 | +140 | WORSE |
| 0.05 | 1,210 | 334 | 2,514 | +200 | WORSE |

**Why it fails:** planMoveWeight adds `weight * totalMoves` to every
candidate's score. This penalizes ALL historical moves, not just the current
segment's walk. A productive macro that requires a 30-move keeper walk to
reach a distant box gets permanently penalized, causing the beam to prefer
nearby-but-structurally-inferior pushes. The beam takes a structurally worse
path to avoid walking, which paradoxically results in more total moves.

**Key insight:** The problem is not that moves are penalized, but that
ACCUMULATED moves are penalized. A per-segment move penalty might work,
but the accumulated penalty creates a compounding disadvantage for early
long-walk segments that may be structurally optimal.

---

## Experiment 2: Structural Parameters (Beam Width, Slack, Segments, etc.)

**Hypothesis:** More beam width, slack, segments, and budget can improve
solution quality by exploring more diverse strategies.

(Results pending from current experiment run)

| Parameter | Moves | Pushes | Visited | Delta | Verdict |
|---|---|---|---|---|---|
| planBeamWidth=48 | 1,122 | 338 | 3,173 | +112 | WORSE |
| planBeamWidth=64 | (pending) | | | | |
| maxPlanSegments=240 | (pending) | | | | |
| planSlack=360 | (pending) | | | | |
| planSlack=480 | (pending) | | | | |
| planBoxBranches=8 | (pending) | | | | |
| sequenceMacroLimit=32 | (pending) | | | | |
| sequenceMacroLimit=48 | (pending) | | | | |
| maxVisited=12000 | (pending) | | | | |

---

## Experiment 3: Combined Parameters

| Combination | Moves | Pushes | Visited | Delta | Verdict |
|---|---|---|---|---|---|
| beam64 + visited12k | | | | | |
| beam64 + slack480 | | | | | |
| beam64 + box8 + visited12k | | | | | |

---

## Tuning Changes (Adapter Path, NOT Huge Test)

These changes to `sokomind-tuning.ts` affect the production adapter path
but NOT the huge test (which uses hardcoded parameters).

| Parameter | Original | Changed | Effect |
|---|---|---|---|
| planMoveWeight | 0.005 | 0.03 | WORSE (plan-macro-beam) |
| heuristicWeight | 3.0 | 2.5 | Untested (beam search only) |
| costWeight | 0.0 | 0.5 | Untested (beam search only) |
| relevanceWeight | 0.6 | 1.0 | Untested (beam search only) |

**Note:** `heuristicWeight`, `costWeight`, and `relevanceWeight` are used by
`beamSearch` (discovery portfolio), NOT by `planMacroBeamSearch`. They have
zero effect on Grand Hall's plan-macro-beam result. The plan-macro-beam
only uses `planMoveWeight` from the tuning profile.

---

## Root Cause Analysis

The 1,010-move Grand Hall solution has 316 pushes and 694 keeper walks.
The push count is efficient; the walk count is excessive.

**Why plan-macro-beam produces excessive walks:**

1. **Scoring ignores keeper proximity.** The `scoreCandidate` formula
   uses pushCost (accumulated pushes), estimate (remaining assignment LB),
   goalAccess, evacuation, and doorwayPenalty. None of these relate to
   keeper position or walk distance.

2. **First-push selection ignores proximity.** The per-segment first-push
   ranking (line 1360) uses: `estimate * weight + accessDelta * 5 +
   evacuation * 0.08 + doorwayDelta * 4 - evacBonus - blockerProgress * 12`.
   No keeper-distance term.

3. **Macro expansion is structurally guided.** Macro sequences are expanded
   toward targets (assigned goals, doorway tasks), not toward nearby pushes.
   A targeted macro prefers structural progress over keeper efficiency.

4. **Transposition comparison uses push cost only.** `seenExact` deduplicates
   by box configuration and keeps the path with fewer pushes
   (`(seenExact.get(id) ?? Infinity) <= cost`). A path with 300 pushes / 600
   moves beats one with 310 pushes / 500 moves.

---

## Proposed Engine Changes

### Option A: Per-Segment Move Penalty (Moderate Impact)

Add `child.segmentMoves = next.path.length` to the child state, then
add `(payload.planSegmentMoveWeight ?? 0) * child.segmentMoves` to
the scoring formula. This penalizes the current segment's walk without
compounding historical penalty.

**Pros:** Targeted, doesn't pollute historical scoring.
**Cons:** Might still bias against productive distant pushes.
**Risk:** Low — additive scoring term, tunable via payload parameter.

### Option B: Keeper Proximity in First-Push Ranking (High Impact)

Add a keeper-distance term to the first-push ranking at line 1360:
```
score += (payload.proximityWeight ?? 0) * keeperDistance(current, next)
```

This biases which BOXES get expanded, not which endpoints survive.

**Pros:** Directly addresses the root cause (pushing distant boxes).
**Cons:** Could sacrifice structural progress for proximity.
**Risk:** Medium — changes which boxes are expanded, not just scored.

### Option C: Move-Aware Transposition (Invasive)

Change `seenExact` comparison from push-cost-only to a weighted
combination: `cost + moveWeight * moves`. This would keep paths with
fewer total moves even at the expense of slightly more pushes.

**Pros:** Fundamentally changes which paths survive deduplication.
**Cons:** Very invasive, could regress push count significantly.
**Risk:** High.

### Option D: Improved Rewrite Pass (Safe)

Improve the post-discovery rewrite to be more aggressive. Current rewrite
reduces 1,010 → 874 moves (−13.5%). More aggressive window sizes and
more move-window passes could push below 700.

**Pros:** Doesn't touch discovery quality at all.
**Cons:** Adds time (rewrite is already ~20s on fast hardware).
**Risk:** Low — independent from discovery.

---

## Summary of What Works and What Doesn't

### Does NOT work:
- Increasing `planMoveWeight` (penalizes accumulated moves, makes things worse)

### Untested but promising:
- Wider beam width (more diversity)
- More visited budget (more search depth)
- Per-segment move penalty (Option A)
- Keeper proximity in first-push ranking (Option B)
- More aggressive rewrite (Option D)
- Discovery portfolio optimization (skip useless A*/greedy lanes)
- Continuation/endgame probes

### Confirmed baseline:
- 1,010 moves / 316 pushes (plan-macro-beam, baseline params)
- 874 moves / 304 pushes (after rewrite)
