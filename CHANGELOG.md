# Changelog

Notable project changes are recorded here. This project follows the structure
of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and has not yet
published a stable release.

## [Unreleased]

### Added

- MIT licensing plus contributor, security-reporting, and code-ownership
  guidance.
- Source-derived documentation for the exact PDB allocation ceiling and the
  reviewed Grand Hall discovery and rewrite counters.
- Quality and Optimal publish the first replay-verified discovery route as the
  incumbent and upper bound when harvest starts, instead of after it ends.
- Optimal proves classic-sized boards (at most 8 boxes and 96 floor cells)
  right after discovery, capped at 30% of the time limit. Only a completed
  proof ends the run there; otherwise the existing pipeline runs with a fresh
  proof.
- Quality runs the same unmodified proof on classic-sized boards, for at most
  half of the time left, but only to improve the route. Quality still reports
  unknown optimality, never returns a proof, and never reports a lower bound or
  gap.
- Benchmark samples record the best route at 1, 5, 10, 30, 60 and 120 s, the
  phase timeline and the lower-bound history (benchmark schema 4). The
  solvable `v2-27box-open` memory board joins the corpus.
- A weekly 10-minute exact fuzz run in the Extended Solver Proof workflow,
  with a new printed seed each run.
- Deadlock-table telemetry: `deadlockTableWorkUnits` and
  `deadlockTableTruncated`. PDB telemetry: `pdbDegradedPartitions` and
  `pdbMemoryFallbacks`. The kernels also report `firstExpansionMs`.
- Solver progress can carry the incumbent's route (worker protocol 2), which
  the worker host and the client both replay. The solver dialog shows the best
  route so far, and **Stop and keep best** ends the search with that route as
  an unproven solved result.

### Changed

- IDA* keeps its contour-local best g and its h cache in open-addressing
  tables that store each state's exact robot cell and sorted box tokens,
  instead of maps of BigInt keys. A hash collision never merges two states,
  memory accounting counts the tables' real bytes, and a full table replaces or
  skips entries instead of evicting the oldest. Moves and proofs are unchanged.
  IDA* checkpoint schema 5.
- A* keeps its best path per state in an open-addressing table keyed by an
  incrementally updated Zobrist hash, instead of a map of BigInt keys. States
  still match only on the exact robot cell and box positions. Search counts,
  moves and proofs are unchanged.
- When the parallel proof finds a shorter route, it stops any lane whose
  partition's prefix alone already costs at least that route, and gives the
  lane the next partition. Verdicts are unchanged.
- The parallel proof gives its lanes the first-push partitions with the lowest
  prefix cost plus push bound first, so a shorter route tends to turn up
  sooner. Verdicts are unchanged.
- Fast no longer holds discovery back for the structural head start on large
  boards. With two or more workers and no state limit, discovery runs beside
  the structural plan search, and the first replayed route wins. With four or
  more workers, discovery runs the forward and reverse frontiers first and the
  guided push portfolio only if they find no route.
- With parallel proof workers, the small-board proof runs beside the route
  improvement. Optimal's proof and Quality's exact lane run alone for 5 s,
  then harvest and repair start beside the same proof on the threads and the
  eighth of memory its lanes leave. Optimal's proof runs to the time limit
  instead of 30% of it. Quality's lane still only improves the route.
- Quality's anytime loop runs pair repair on boards with at most 200 floor
  cells. Two-box repair picks its pairs in the engine from the boxes with the
  largest push detours. Goal reassignment becomes a same-label goal swap that
  sends each box of a pair to the other's goal; before, it never produced a
  route. Both were experimental and now run by default.
- Current catalog and solver documentation now links to one generated project
  reference instead of duplicating facts that can drift.
- Exact-search tunnel macros are now disabled by default. When enabled they
  only add look-ahead successors and no longer remove the single push.
- The exact-search goal-cut heuristic is now disabled by default. Its
  bottleneck surplus was documented as an admissible push bound, but boxes can
  cross a shared tunnel one after another at no extra cost, and no move-level
  bound has been proven. Oracle tests found no move-level overestimate, so
  discarding earlier certificates is a precaution.
- Solver versions are now `classic-dfs` 1.0.1, `classic-greedy` 1.0.1,
  `classic-astar` 2.2.9, `classic-ida-star` 2.2.9 and `sokomind-solver` 1.13.4. Sokomind 1.3.0 marked the earlier Quality
  changes: Quality never dispatches proof and reports unknown optimality,
  requests accept a replay-validated initial solution, and Quality repair runs
  on a parallel task-slot coordinator.
- The optimal-record proof revision is now `exact-moves-ida-contour-exit-v1`
  and the storage key is `sokomind.optimal.v10`, so certificates stored under
  earlier revisions are discarded in both storage tiers and older open tabs
  cannot overwrite current ones.
- The IDA* checkpoint schema is now 4, so checkpoints written by the earlier
  kernels restart instead of resuming.
- The frozen known-optimum gate now also replays small oracle-backed entries
  through exact IDA*, covers a proven-unsolvable board, and records which
  entries have independent step-oracle provenance.
- CI now fails when the committed generated engine or catalog metadata is
  stale, and the unit suite checks the generated catalog manifest against the
  shipped catalog.
- CI browser runs now fail when a test only passes on retry. The Grand Hall
  cancel test accepts only the cancelled outcome, and browser specs wait on
  `page.clock` or web-first assertions instead of fixed sleeps.
- The exact kernels and their table builders yield through `setImmediate` or a
  `MessageChannel` before falling back to `setTimeout`. Search states are
  unchanged; a same-node A/B ran the classic profiles 1.67x faster on geometric
  mean.
- Exact A* cuts a child on its push and walk bounds before computing the
  extras. Retained successors, state counts, moves and proofs are unchanged.
- Exact IDA* floods the keeper's area once per frame and keeps the walk to
  each push, instead of flooding again whenever a child returns.
  `idaReachabilitySnapshots` and `idaSnapshotPeriod` are still accepted but
  ignored, and IDA* checkpoints from earlier versions restart. The assignment
  heuristic, pattern-database lookups and builds, the freeze and 2x2 checks
  and the deadlock tables reuse their buffers instead of allocating per call.
  State counts, moves and proofs are unchanged; a same-node A/B ran the
  classic profiles at 0.85x geometric-mean time.
- The pattern-database heuristic finds its minimum over box subsets by branch
  and bound on the boxes' goal distances, instead of looking up every subset.
  h, state counts, moves and proofs are unchanged; only `pdbLookups` falls.
- Freeze deadlocks now also catch a box held by a wall or a frozen box on one
  side of each axis, or by dead cells on both sides, as long as it is off its
  own goal or leaves the other boxes no way to the free goals. Exact searches
  prune these states, and the UI deadlock warning flags them sooner.
- On small boards, the parallel proof beside the route improvement takes each
  route the improvement publishes. A route that replays and beats the proof's
  best lowers its bound, so partitions close sooner; one that fails replay is
  dropped without stopping a lane.
- A pattern-database build that hits the memory limit keeps its partial table,
  or disables that partition, instead of aborting exact search. Both are
  admissible: unreached entries read `frontierDepth + 1`, and a disabled table
  adds nothing to h.
- The deadlock-table build stops after a fixed amount of work (2,000,000
  region-search states) instead of a 2 s wall-clock budget, so every machine
  builds the same table. Regions enumerate label classes instead of labels,
  and a region search cut short by any limit still adds no pattern.
- Proof lanes that are building tables resend their progress every 5 s, so the
  coordinator's 30 s silence watchdog no longer stops a healthy lane. The
  single-lane proof leaves the coordinator memory reservation out of its
  kernel's limit, as each parallel lane already did.
- The bundled engine's collapsed forced-push chains keep their first source,
  last destination and every touched cell, so the goal-cut decomposition and
  the packed-room check no longer drop or miscount them. Discovery only.
- When Quality or Optimal has no exact answer, bounded repair now runs on
  routes of any length. Before, routes under 100 moves got no repair.
- Diverse harvest beams now receive their profile's move weight (0.005, 0.003
  and 0.008); before, every harvest beam ran with the default 0.002.
- Production benchmark profiles carry only the app's deadline and memory
  limit, so large boards run to their deadline instead of stopping at 500k
  states.
- CI runs lint, doc lint and the generated-file checks even after an earlier
  step fails, and the coverage timeouts are 20 minutes.
- Sokomind keeps its engine and proof workers for the whole request instead
  of starting new ones for each plan and each proof, and a proof worker reuses
  its board-only pattern-database, deadlock and room tables across runs on the
  same board. Search results are unchanged.
- Requests that set an expanded- or generated-state limit skip Optimal's
  early proof and Quality's proof lane, so neither can spend the states the
  pipeline proof needs.
- The parallel proof runs fewer lanes when that keeps exact A*, instead of
  splitting memory across every lane and falling back to IDA*. With the app's
  proof workers, six light boards that stayed unproven at 120 s now prove in
  0.4-15 s (sym-diamond in 398 ms), and the light boards' median-time
  geometric mean falls to 0.36x. On large and theme-parking, which neither
  version proves, peak process memory rises from about 3.2 GB to 4.0 and
  4.9 GB.

- Removed the unreachable Sokomind `harvestAndImprove` schedule and the
  single-rewrite fallback in `solvedWithImprovement`. Quality and Optimal
  already dispatch to their own schedulers, and an unknown mode now throws
  instead of falling through. The reschedule-value predictor is kept, but the
  docs now say it is not wired into production.
- The browser and Node proof workers now share one runtime module, so the
  proof-result mapping is maintained in one place. The browser worker no longer
  passes the `persistTransposition` option, which exact IDA* ignores.
- Removed the bundled Sokomind engine's one-way tunnel prune. It skipped
  pushes out of a tunnel flagged as a dead end, but every tunnel cell has two
  opposite floor neighbours, so the flag was never set and the prune never ran.
  Solver results are unchanged. A dead-end test on its own would not be a safe
  replacement, because it ignores push direction and goals inside the pocket.
- The Sokomind engine worker now rejects search commands for algorithms other
  than the five with typed payloads, and treats a result whose status is not
  `solved`, `cutoff`, `cancelled` or `failed` as a malformed message. Both
  checks accepted any string before. Production plans send only those
  algorithms, and the engine emits only those statuses.
- ESLint now checks the bundled Sokomind engine's source files, which it
  ignored before, and runs `no-undef` and `no-unused-vars` on the generated
  bundle, where the files share one scope. Unused variables and initial values
  that were always overwritten are removed from the sources; solver results are
  unchanged.
- Removed the unused `allocateParallelRewriteBudgets` helper. Repair operators
  now map to their engine plans explicitly; `perturb-and-repair` still runs
  the window rewrite, now on purpose.

### Fixed

- An exact IDA* lane that held a move bound but no route, such as a parallel
  proof lane whose partition contains the discovery route, no longer repeats
  its last contour until a limit stops it. A finished contour that leaves
  nothing below the bound now ends the lane, and a route found at the
  contour's threshold is proven optimal even when a limit stops that contour.
- A room-pattern table cut at its 12,000-state cap no longer lets the
  interaction boost exceed the remaining pushes. A cut table skipped the box
  selections it lacked; such a selection now costs at least the table's depth,
  because the table holds every state with fewer pushes. Three boosts on
  measured boards were over by up to 2.
- A key pressed as soon as the play page appears now moves the keeper. The
  keyboard listener was attached in a passive effect that could run after the
  board was painted; it now attaches before paint.
- Opening a dialog focuses its primary action immediately instead of waiting
  for an animation frame, which WebKit could hold long enough to leave focus
  on the first button.
- Tapping or clicking a distant floor cell walks the whole route again. The
  walk read a session ref that only updates after React re-renders, saw no
  move after the first step and stopped; it now continues on the mover's own
  result and cancels when input is disabled.
- Swipes no longer vanish when the play timer ticks mid-gesture, and the game
  keyboard listener is no longer removed and re-added on every render. Both
  hooks now read their latest callbacks through effect events, so inline
  callbacks from the play page no longer rebind their listeners.
- Pinch zoom no longer re-renders the play page and rebinds its touch
  listeners on every gesture frame; the transform is applied to the board
  directly. While zoomed, one-finger drags only pan the board instead of also
  swiping the keeper, and a tap waits out the double-tap window so the first
  tap of a zoom-reset double tap no longer starts a walk.
- The play page's "Skip to puzzle" link focuses the board again. It used to
  set the URL hash to `#game-stage`, which the hash router read as an unknown
  route and sent the player home.
- The play page's "More actions" menu works from the keyboard. Opening it
  focuses the first item, the arrow, Home and End keys move between items
  instead of moving the keeper, and Escape closes the menu and returns focus
  to its button instead of leaving the page. Choosing an item also returns
  focus to the button, so closing "How to play" lands there.
- Screen readers now hear each move on the play page and in editor playtest
  from one live region placed beside the board. It used to sit inside the
  board's image role, whose contents assistive technology may ignore, and the
  header counters announced every move a second time through a changing
  label; the counters are now plain text.
- Escape on a page opened from a link on another site no longer leaves the
  app. The router now records how many app pages precede each history entry
  and steps back only into one of those; otherwise Escape goes up one level
  (a puzzle returns to its list, a list to the difficulties, other pages to
  home).
- A custom-puzzle link whose board has no boxes is now rejected instead of
  opening a puzzle that is already solved. Core puzzle validation requires at
  least one box, as the editor already did; row-level parsing still accepts
  boards without boxes.
- Legacy `#puzzle=` and `#custom=` links now redirect in place without
  committing the route a second time, so the page no longer loses track of
  the previous route and treats a switch to another puzzle as a fresh attempt.
- Clicks and taps on a pinch-zoomed board land on the cell under the pointer.
  The mapping subtracted unscaled padding from the zoomed board's scaled size,
  so a click near a cell's edge could pick its neighbour. Pieces on a zoomed
  board also slide in from the adjacent cell instead of from as many cells
  away as the zoom factor.
- A first visit no longer downloads the puzzle generator and replay comparison
  dialogs for offline use, about 54 KB gzip that play-only visitors never
  needed. As the architecture notes already described, optional dialogs are
  now cached the first time they open, so each needs one online open before it
  works offline. A static test caps the install-time precache.
- A first visit no longer shows "A new version of Sokomind is available".
  The first worker briefly waits before activating by itself, which was
  mistaken for an update; only a worker waiting behind an active one counts
  now. Reload on an update that has already activated reloads the page
  instead of staying on "Updating…".
- Exact pattern-database combination counts no longer wrap at 32 bits on large
  valid custom boards, and oversized optional tables safely fall back to the
  remaining admissible heuristics.
- Exact A* and IDA* no longer drop the single push into a tunnel when a tunnel
  macro applies. That prune discarded routes that park a box part-way into a
  tunnel, so both exact kernels and the adapters built on them could report
  non-optimal move counts as proven optima and prove solvable boards
  unsolvable.
- IDA* tunnel-macro children are keyed by the keeper's actual cell instead of
  the box's origin cell, so heuristic-cache and contour transposition entries
  no longer alias a different state.
- Exact pattern-deadlock caching now keys each window by the floor just
  outside it as well as its contents. A verdict cached for a window whose exits
  were walled could otherwise prune the same window elsewhere on the board
  where a box could still escape, producing false proven optima and false
  `unsolvable` proofs with default features. A cache instance also starts
  afresh when handed a different board.
- The bundled Sokomind engine's local pattern-deadlock memo has the same
  corrected key, so it no longer prunes live states and loses solution quality.
- IDA* no longer keeps a cheap push+walk bound in its cross-contour h-cache
  as if it were the full heuristic. A later contour now recomputes the full
  bound for a state whose cached value no longer prunes, so the linear
  conflict, interaction, pattern-database, perimeter and component bounds
  apply there too. On the inter-rooms board this expands about 9% fewer
  states. A new `hCacheUpgrades` counter reports the recomputations.
- The opt-in move-cost pattern database no longer overestimates. Its reverse
  build credited a push to any keeper position reachable from the pushing
  side, skipping the walk from the cell the box vacated, so a straight run of
  pushes could cost more than the true remainder. A build whose table fills
  now stops instead of dropping states that its radius fallback assumed were
  settled. The table is off by default and no production caller enables it,
  so stored certificates are unaffected.
- The exact linear-conflict bound no longer overestimates the remaining
  pushes. It counted every crossing pair in one minimum assignment, but a
  label with several goals can have another assignment of the same cost that
  crosses nothing, and a box whose shortest route already leaves the line can
  pass the other box for free. A pair now counts only when both labels have a
  single goal on that line and both boxes' push distances are straight. No
  move-level overestimate was found, so discarding earlier certificates is a
  precaution.
- The exact pattern database no longer overestimates the remaining pushes.
  Its table moves boxes only within a goal region, so it counted only routes
  that keep every box inside; on a probe board it stored 16 pushes where 12
  suffice. A lookup now returns the smaller of the table value and an exit
  bound built from full-board push distances. Lookups with a box outside the
  region, and entries a build deadline left missing, used to return no bound;
  a minimum over box subsets skipped them and could settle on a larger value.
  Outside boxes now get the exit bound, and missing entries one more than the
  last depth the build expanded. New `pdbLookups`, `pdbExitCapTrims`,
  `pdbExitCapTrimTotal` and `pdbOutsideRegionLookups` counters show how often
  the bound applies. No false certificate was found, so discarding earlier
  certificates is a precaution.
- The exact interaction-boost and PDB-surplus caches no longer rely on callers
  passing label costs from the same state. Both values subtract the assignment
  label costs but were cached by box key alone; the evaluators now use their
  caches only when the assignment heuristic's last box key matches. Both exact
  kernels already passed matching costs, so results are unchanged.
- The classic search engine's `astar` strategy no longer expands a forced push
  ahead of its queue order. When a state had a single legal push, its child
  was expanded next instead of waiting in the priority queue, so the search
  could reach a goal and report a non-optimal route as proven while a cheaper
  one was still queued. Only tests use this strategy; the Classic A* solver
  and Optimal proofs run the exact A* kernel, so stored certificates are
  unaffected.
- The classic search engine's assignment cache now restores the matched
  state's assignment on a hit. It kept only the cost, so the linear conflict
  that followed was computed from whichever state had been evaluated last.
  The DFS and greedy searches, including the generator's greedy checks, may
  therefore order states differently; the exact A* and IDA* kernels key their
  cache by box state and are unaffected.
- The bundled Sokomind engine no longer reports `proven-unsolvable` when a
  `push-ida-star`, `push-astar`, `astar`, `bfs` or `dfs` search empties its
  frontier. Those searches prune with unverified deadlock, sealed-corral,
  forced-macro and goal-cut checks, so the result is now a `cutoff` with reason
  `frontier-exhausted-unverified`. The worker accepted these algorithm names,
  but no production plan uses them, so solver results are unchanged.
- The bundled Sokomind engine's cell lookup no longer wraps a column offset
  past a side edge into the neighbouring row. Pattern windows and pattern
  eligibility counted cells from the far side of the board, which could make a
  narrow corridor ineligible for pattern-deadlock checks. No catalog board's
  eligibility or pattern windows change.
- The unit tests that evaluate the Sokomind engine sources in a VM now load
  the same module list as the bundle. Their own copies had drifted and left out
  `schedule-trace.js`, and one also left out `pdb.js`, so code reaching the
  rescheduling trace or the pattern database would have thrown there.
- The Sokomind engine prepare script now fails when the strategic validator's
  end marker is missing or a source registration line no longer matches its
  strip patterns. Before, a missing marker wrote nearly the whole strategic
  contract into `strategic-validation.generated.js`, and `--check` compared
  against the same output and passed. `--check` also imports the validator
  artifact to confirm it loads on its own.
- The bundled Sokomind engine finds articulation points with an explicit stack
  instead of recursion, so parsing a board with a corridor of several thousand
  cells no longer overflows the worker's call stack. It visits cells in the
  same order, so room tie-breaking and search results are unchanged.
- Tunnel macros no longer return a one-push stop that duplicates the single
  push, and they cap stops at 64 pushes so the A* node encoding cannot wrap on
  long custom-board tunnels.
- Parallel proof progress no longer lowers its published lower bound when a
  proof lane crashes, goes silent, or sends an invalid report. The worker host
  rejected that as a monotonicity violation and discarded the verified
  incumbent. A running lane's bound now appears in the progress detail as
  provisional until its partition completes.
- Parallel proof reaches the same verdict whatever order lane events arrive
  in. A failed partition whose prefix alone already costs at least the
  incumbent no longer downgrades an optimal result to a bounded one with a
  zero gap when it is the last partition to close.
- A zero proof gap is labelled optimal only for a completed optimal proof.
  Live progress and bounded results now show it as bounds met, proof
  incomplete.
- Cancelling a single-lane Optimal proof now returns cancelled, as parallel
  proof already did, instead of the discovery incumbent. Exact A* cancelled
  after its bound already meets the incumbent returns that solution as proven
  with its optimal proof instead of an internally inconsistent result.
- When the cancellation watchdog terminates an unresponsive solver worker, the
  client is now retired and the solver dialog and Solver Lab start a fresh
  worker. Previously the client stayed usable, so the next search posted to the
  terminated worker and never finished.
- Sokomind no longer reports an unsolved board as exhausted when its budget ran
  out before the complete fallback search could start. The discovery portfolio
  is incomplete, so that case now reports `limit-reached` with the budget that
  ran out.
- Sokomind keeps a replay-verified route that arrives in the same worker
  message that reaches a work, time or memory limit, in discovery as in repair.
  It previously discarded that route and reported `limit-reached`, although
  engines stop at their grants and so found it within the limit. A route whose
  reported work passes a state limit, or that arrives after cancellation, is
  still not accepted, and repair candidates are archived only once kept.
- The solver dialog's screen-reader announcement no longer calls every
  unsolved result a timeout. It names the reason (search finished, search
  limit, or unsupported puzzle) and says "proven optimal" only for a proven
  route. The advanced-settings note now says A* and IDA* prove a minimum only
  when they finish within the limits, and that Sokomind Solver marks a route
  optimal only after an explicit proof.
- The fuzz support module's symbol grid type, which had failed typecheck, and
  with it deploy, since 2026-09-24.
- The move-cost pattern database decodes state ranks above 2^31 exactly.
  Before, Grand Hall's patterns crashed the build or expanded the wrong state.
  The feature is off by default, so no shipped run or certificate used it.
