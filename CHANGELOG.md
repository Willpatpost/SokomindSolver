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

### Changed

- Current catalog and solver documentation now links to one generated project
  reference instead of duplicating facts that can drift.
- Exact-search tunnel macros are now disabled by default. When enabled they
  only add look-ahead successors and no longer remove the single push.
- Solver versions are now `classic-astar` 2.2.2, `classic-ida-star` 2.2.1 and
  `sokomind-solver` 1.3.0. Sokomind 1.3.0 also marks the earlier Quality
  changes: Quality never dispatches proof and reports unknown optimality,
  requests accept a replay-validated initial solution, and Quality repair runs
  on a parallel task-slot coordinator.
- The optimal-record proof revision is now `exact-moves-pattern-key-v1` and
  the storage key is `sokomind.optimal.v7`, so certificates stored under
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

- Removed the unreachable Sokomind `harvestAndImprove` schedule and the
  single-rewrite fallback in `solvedWithImprovement`. Quality and Optimal
  already dispatch to their own schedulers, and an unknown mode now throws
  instead of falling through. The reschedule-value predictor is kept, but the
  docs now say it is not wired into production.
- The browser and Node proof workers now share one runtime module, so the
  proof-result mapping is maintained in one place. The browser worker no longer
  passes the `persistTransposition` option, which exact IDA* ignores.

### Fixed

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
- Legacy `#puzzle=` and `#custom=` links now redirect in place without
  committing the route a second time, so the page no longer loses track of
  the previous route and treats a switch to another puzzle as a fresh attempt.
- Clicks and taps on a pinch-zoomed board land on the cell under the pointer.
  The mapping subtracted unscaled padding from the zoomed board's scaled size,
  so a click near a cell's edge could pick its neighbour. Pieces on a zoomed
  board also slide in from the adjacent cell instead of from as many cells
  away as the zoom factor.
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
