# Generator solution-story contract

Phase 0 defined this evidence contract. Phases 1–5 implemented replay, story
measurement, construction, typing, and bounded counterfactual analysis. Phase 6
applies a shared quality policy to both generation paths and release review.
Phase 7 curates qualified candidates by story and visual diversity and produces
evidence-led catalog review packs.

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

Pre-typing route, support, and causal relationships come directly from the
class-neutral canonical trace: the passive cross-class report is intentionally
empty on an all-generic board. Packing relationships use the actual
depth-ordered pairs, not arbitrary consecutive goal completions. Shared-support
mechanisms must retain a concrete cross-class support pair after evaluation.

The typing plan is bound to the labeled board hash. Final verification rebinds
target roles to the boxes that actually occupy their goals, since a different
solution can exchange generic assignments. Stale-board and unsolved evidence
cannot pass. Review JSON includes target box identities and individual checks;
the text report includes the number of verified typing targets.

## Phase 5 counterfactual analysis

`analyzeCounterfactualStory()` runs bounded push-space searches from checkpoints
in the exact final, solved canonical trace. It supplies three kinds of probes:

- **Alternative push:** take a reachable push other than the observed one, then
  search for any compatible solution. Generic boxes may exchange destinations;
  typed boxes must still reach their own labels. A recovery result includes a
  legal push witness that can be independently replayed.
- **Preserve goal:** when the observed route vacates a matched goal, hold that
  box fixed and try to finish the puzzle. A found solution shows the vacancy was
  optional at that checkpoint; exhaustion shows it was necessary there.
- **Freeze enabler:** when moving one box makes a previously immobile box
  pushable, hold the enabling box fixed and search for any push of the beneficiary.
  This tests a local enabling dependency, not whole-puzzle solvability. An
  alternative enabling route disproves necessity even if that route would not
  ultimately solve the whole puzzle.

Search states preserve stable box identities and normalize the keeper's reachable
component. Static reverse-push distances respect goal compatibility. Their dead
squares are a sound prune for complete-solution queries, but are deliberately
not used for local enabling queries. No heuristic failure is treated as proof.
The engine reports `solved`, `exhausted`, or `unknown`. A discarded frontier,
state limit, total-state limit, elapsed-time limit, or cancellation cannot yield
an exhaustion claim. Necessity is scoped to the recorded checkpoint and exact
constraint; it does not imply uniqueness of the puzzle's solution.

A delayed false start must initially reduce the moved box's static compatible
goal distance, admit at least two further pushes of **that same box** without a
static dead square, and have an exhausted recovery search. Unrelated work on
other boxes cannot supply the delay. The report includes a concrete continuation
witness. Immediate dead-square mistakes and unknown branches never qualify.
This is conservative evidence of a plausible false start, not a prediction of
every player's experience or a required number of such branches per puzzle.

Defaults are 12 probes, 256 visited/expanded states per probe, 2,048 total
expansions, and a 100 ms search deadline per candidate. Dependency, goalward
alternative, and other-alternative samples are interleaved across the trace.
Omitted probes are counted separately from tested-but-unknown probes. The
deterministic state/probe budgets are reproducible; a real-time deadline may
produce more unknowns on a busy machine. Tests inject a clock for repeatability.
`ForgeConfig.counterfactualBudget` can override these limits, including zero
probes to disable the searches.

Both generation paths attach `counterfactualStory` after final typing/evaluation
and the initial acceptance checks. Review JSON retains the full evidence, and
review text and forge diagnostics expose outcomes, budget usage, and uncertainty.
These Phase 5 measurements do not change acceptance, ranking, difficulty, or the
production catalog. The earlier `counterfactualEdges` structural verifier remains
separate; its counts are not claims that these bounded searches proved anything.

Executable positive and near-miss fixtures live in
`tests/fixtures/generator/counterfactual-stories.ts`, including a premature
corridor entry and the same layout with a recovery bypass, necessary packing
vacancy versus gratuitous vacancy, and a mixed-class doorway enabler.

## Phase 6 quality policy and gates

`assessCandidateQuality()` is the common qualification entry point for flat and
funnel generation. It combines the existing numeric quality floors (geometry,
interaction, causal depth, decisions, mechanism integrity, elegance, and tedium)
with the versioned `story-quality-1` policy in `story-quality-policy.ts`.
Both run after final geometry, typing, and forward evaluation. The funnel keeps
this assessment through finalist review; it cannot overwrite it with an older
vector-only pass. Flat generation can no longer bypass the quality assessment.

The non-negotiable checks are:

- a solved canonical trace, passive story, typing plan, and evaluation belonging
  to the exact final board;
- no Tutorial generation; the tier is derived solely from actual box count;
- at least one generic and one typed box in Beginner, at least two of each above;
- at least two actual pushes and two occupied cells for every box;
- every box has a concrete interaction partner through routes, keeper support,
  causal enable/disable effects, productive reversal, gates, or ordered packing;
- a genuine typed/generic relationship, not merely consecutive work switches;
- a passing final story-aware typing verification; and
- every declared construction target retains its target-local evidence.

Positive floors use a **basket** of distinct observed features. A puzzle does
not need every mechanism, generic-goal surprise, a trap, or a reversal to qualify.
Initial, deliberately explicit family floors are:

| Box-count tier | Boxes | Minimum distinct story families |
| --- | --- | --- |
| Beginner | 3–6 | 1 |
| Intermediate | 7–9 | 2 |
| Advanced | 10–13 | 3 |
| Expert | 14–17 | 3 |
| Master | 18+ | 4 |

The eight qualifying families are assignment misdirection, productive reversal,
multi-room journey, ordered packing, gate traffic, shared transport, shared
keeper support, and causal dependency. Mere switch counts, repeated occurrences
of one feature, visual fingerprints, solver runtime, and raw solution length
cannot inflate the family count. The initial floors are tunable through
`ForgeConfig.storyQualityPolicy`; tuning cannot disable the core requirements.
Release always rechecks the current default floor even if a research run used a
weaker custom family policy. These are initial quality thresholds, not a claim
of empirically calibrated human difficulty.

Counterfactual confirmations, recoverability, optionality, unknown outcomes, and
omitted probes remain separate in the quality report. No number of dead ends or
proven dependencies is required. Disabling probes or exhausting their budget
cannot change qualification. The earlier structural `counterfactualEdges` count
is no longer required by the release gate as if it were a search proof.

Since construction evidence is now gating, packing must include an actual
depth-ordered pair **within the target**; an ordered pair elsewhere in that room
does not suffice. Cross-class mechanism evidence uses the same real interaction
relationships as typing and quality, not switch-only evidence. Empty, duplicated,
or unsolved target goal assignments cannot pass verification.

Review JSON records the policy version, actual tier, per-box participation and
partners, cross-class pairs, observed family basket, target realization, and
stable rejection codes with explanations. Diagnostics retain failed assessments
as well as passes. Release rejects missing, stale, malformed, or failing story
reports and reruns the rules against the recorded measurements rather than
trusting a `passed` flag. Quota shortfalls remain shortfalls: no gate is silently
relaxed and no difficulty tier is changed. No move-count proof floor is added,
and implementing the policy does not populate or modify the production catalog.

## Phase 7 catalog diversity and review

`curateForgeCandidates()` is the shared selection path for flat generation,
funnel finalists, and the CLI's reconciled catalog pools. Selection happens
**after** qualification and does not change box-count tiers or quality floors.
Small or underfilled pools still go through curation. No refill pass can restore
a puzzle rejected for similarity or concentration just to meet a target.

### Story and visual identity

`story-diversity.ts` defines the versioned `story-diversity-1` profile:

- an observed story-family basket from the Phase 6 quality report;
- pacing: linear work, revisited work, or heavily interleaved work, based on
  the fraction of phases returning to an earlier box (0, below 40%, or 40%+);
- interaction spread: localized or woven, based on whether the average box
  has more than two concrete work partners;
- a label/class-insensitive box-and-goal layout, canonical across all eight
  rotations/reflections and external wall framing, ignoring keeper location;
- a separately canonicalized wall/floor silhouette.

Layout comparisons use full canonical strings, avoiding short-hash collisions.
Recoloring a board or moving its keeper does not buy another catalog slot.
Changing wall geometry can earn visual novelty, but does not make an otherwise
identical story into a new story basket. Stable box IDs, zone IDs, raw move
counts, solver runtime, and bounded counterfactual outcomes do not enter this
identity. Unknown counterfactual probes still neither help nor hurt selection.

Pareto sorting now retains structural and story fingerprints instead of
dropping them before novelty scoring. The legacy structural fingerprint has
separate motif/composition and mechanism fields; its scale field uses the
current box-count tier. Metadata caps count each mechanism in a combined plan,
not the whole combination as if it were a new mechanism.

### Selection and shortfalls

The initial qualified pick follows Pareto rank and normalized novelty, with a
stable ID tie-break. Subsequent picks maximize newly covered story families
plus distance from the closest selected story. Distance uses family-set
difference (60%), pacing (15%), interaction spread (10%), and visual layout
(15%). Exact class-neutral layout clones have zero distance regardless of
labels or story differences.

Initial diversity limits per requested selection target are:

- at most one copy of a class-neutral layout;
- at most `ceil(target * 0.35)` of the same story basket/pacing/interaction;
- at most `ceil(target * 0.20)` of the same wall/floor silhouette.

Each nonzero target permits at least one entry per bucket. The shares are
configurable via `ForgeConfig.storyDiversityPolicy`. Exact layout deduplication
cannot be disabled. Optional topology, mode, motif, and mechanism quotas apply
to the **actual selected set**, alongside story caps; rejected clones cannot
consume those quotas. These are initial curation heuristics to calibrate through
playtesting, not proven thresholds for human enjoyment or difficulty.

Every considered candidate receives a decision: selected, missing story
evidence, layout clone (with its retained counterpart), story cap, visual cap,
metadata cap, or quota. Forge reports and CLI review JSON retain the requested
target, selected count, limits, decisions, and honest shortfall. CLI seed-window
retries remain bounded; final curation does not silently relax constraints or
claim that a short target was filled.

### Human review and release

Review schema **2** adds exact final rows, the full passive evidence, and the
versioned diversity profile. Catalog and per-tier summaries show family
coverage, missing families, story baskets, pacing, visual groups, and clone
groups. Each candidate has up to three closest catalog neighbors, with a
distance and concrete reasons for the similarity. The text review includes:

- stable box identities, class, actual pushes, visited cells, and work partners;
- generic-goal assignment alternatives and observed final destinations;
- productive reversal/recovery and gate traffic landmarks with push indices;
- the ordered phase timeline, participating boxes, and semantic zones;
- existing construction, quality, typing, and counterfactual explanations;
- a playtest checklist covering filler, ambiguity, mixed-class interaction,
  pacing/tedium, nearest-neighbor comparison, and a keep/rework/reject note.

These are explanations of the evaluated witness, not optimality or necessity
claims. Automatic qualification is not human playtest approval. Reviewers
should play a spread of story baskets and especially compare nearest neighbors,
not merely choose the largest solver counts. No review decision is fabricated.

Release rebuilds each diversity profile from its exact rows, validated quality
measurements, and passive summary. Missing or stale evidence fails closed;
old review files must be regenerated, not given a new schema number by hand.
Label-insensitive layout clones are hard failures. Coverage gaps and story or
visual concentration in the **actual** catalog are review warnings, including
when an underfilled target made the selected share larger than expected.
Release recomputes these summaries instead of trusting cached catalog totals.
The production manifest schema stays at 1. This phase changes no production
catalog entries and does not generate or publish a replacement catalog.

## Phase 8 generation verification and promotion

The current objective is small-sample quality verification, not a catalog-sized
generation run. `npm.cmd run verify:generator-quality` regenerates two known
positive seeds, verifies every box's participation and interactions, and
replays each final solution independently. Both examples are at Beginner box
counts; successful higher-tier generation is not yet demonstrated.

For future promotion, review packs retain the evaluated witness and the typing
and construction plans. `scripts/lib/catalog-promotion.ts` independently replays
and remeasures them, verifies exact catalog/manifest/review binding, and backs
up the old catalog pair before installation. `--accept ... --dry-run` does not
write production. No promotion or gate relaxation is part of the present
small-sample verification. See `docs/generator-phase-8-verification.md` for
results, observed limitations, CLI controls, and recovery behavior.

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
