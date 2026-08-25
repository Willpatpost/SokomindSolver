# Sokomind Whole-Product Improvements — August 11, 2026

**Purpose:** Forward-looking improvements for the website, player experience,
editor, solver, content, platform, and engineering workflow.  
**Companion audit:** [`AUG11AUDIT.MD`](AUG11AUDIT.MD)

This is a roadmap, not an issue tracker. The companion audit is closed; its
oracle, replay, recovery, budget, protocol, and browser controls remain
non-negotiable regression gates. The ideas below should be selected using
measured player or engineering outcomes rather than implemented as an
undifferentiated feature list.

## Product principles

1. **Correct before clever.** A legal route is not automatically optimal, and
   a fast solver is not useful if its proof or limits are unreliable.
2. **Local-first should feel dependable.** The app has no account or server, so
   recovery, export, cross-tab behavior, and honest save status are core product
   features.
3. **Complexity should be progressive.** New players should see a direct path
   into play; power users should still have deep solver, editor, and catalog
   controls.
4. **Every optimization needs a behavioral guard.** Solver speedups require
   oracle comparison and replay; UI speedups require accessibility and browser
   behavior checks.
5. **Offline should be understandable.** The PWA should explain what is cached,
   what is pending, and whether a reload will update or preserve the current
   session.

## Current opportunity baseline

- 150 validated puzzles across all six difficulty tiers.
- Difficulty is now broadly balanced, but 118 puzzles come from one generated
  collection and only 32 are originals.
- All 150 puzzles exercise typed boxes, so the earlier lack of labeled content is
  no longer a concern.
- The immutable game core, route sharing, local progress, editor, exact replay,
  multiple solvers, and offline shell already provide a strong product base.
- The main experience risk is not missing breadth; it is making the existing
  breadth easier to understand, trust, navigate, and recover.

## Foundations delivered in the August 14 follow-up

- Selector return routes now preserve page, filters, scroll, focus, and a
  recent-puzzle continuation for the current SPA session.
- The editor now has bounded named drafts, migration, create/duplicate/rename/
  delete operations, last-saved times, safe shared imports, starter templates,
  and a narrow-screen sticky tool palette.
- Progress-only reset, awaited mutation outcomes, and true repeat-completion
  activity close the main local-data honesty gaps.
- A dedicated 320 x 568 browser project, semantic mobile links, selected-state
  feedback, offline status, and retryable shard/lazy/worker failures strengthen
  the small-screen and recovery baseline.
- Exact preprocessing shares the run budget, frozen optimum gates are
  executable, benchmark promotion requires clean median-five evidence, and
  A/B decisions can veto time or RSS regressions.
- [`PROJECT-REFERENCE.md`](PROJECT-REFERENCE.md) is the source-checked index of
  important modules, APIs, schemas, defaults, and engineering contracts.

The sections below describe what remains beyond those foundations.

## 1. Home, navigation, and onboarding

### Make the first decision obvious

- Give the existing reconciled **Continue** or **Start playing** action stronger
  visual priority than the secondary destinations.
- Keep Daily Challenge, Browse, and Editor as strong secondary actions rather
  than equally weighted choices.
- Show a compact resume preview: puzzle title, difficulty, moves, pushes, and
  last-played time.

### Create a progressive tutorial path

- Turn the ten tutorial puzzles into a guided sequence that introduces walking,
  pushing, corners, undo, matching goals, labels, restart, and hints one concept
  at a time.
- Prefer contextual overlays and a dismissible first-use coach mark over a long
  standalone help document.
- Let experienced users skip the tutorial and remember that choice locally.

### Improve route continuity

- Extend the current SPA-session selector/recent context across reload only if
  the additional local-storage ownership has a clear recovery policy.
- Continue testing browser Back behavior from custom editor links, solver
  dialogs, and completion dialogs as those flows evolve.
- Expand the single recent-puzzle continuation into a bounded history only if
  it improves discovery without crowding Home.

### Success measures

- Fewer actions from first visit to first legal push.
- Resume selects the newest recoverable session across both storage layers.
- Keyboard focus returns to the originating card after closing or navigating
  back from a detail flow.

## 2. Puzzle selector and content discovery

### Add richer, stable filters

- Filter by difficulty, collection, dimensions, box count, typed/generic boxes,
  completion state, favorite state, rating, and recently played.
- Permit sharable selector state in the hash without placing private progress
  data in the URL.
- Provide saved local filter presets such as “short unsolved typed puzzles.”

### Improve large-list performance

- Keep metadata-only loading and add measured row virtualization only if long
  pages show input or paint delay on lower-end mobile devices.
- Precompute normalized search tokens and facet counts during catalog
  generation rather than doing repeated full scans in render paths.
- Preserve accessible list semantics and deterministic focus if virtualization
  is introduced.

### Surface meaningful puzzle information

- Show dimensions, box count, typed status, estimated solution band, personal
  best, favorite/rating, and collection attribution consistently.
- Distinguish authored, imported, and generated content visually without
  implying a quality hierarchy.
- Add curated playlists: first hour, compact puzzles, typed-box showcase,
  unusual topology, expert weekend, and editor inspiration.

## 3. Daily challenge, progress, and stats

### Extend Daily Challenge participation

- Build richer rewards and history views on the date-indexed participation
  ledger without conflating them with the puzzle's lifetime best.
- Explain local-time rollover and travel/timezone behavior in the UI, including
  how an offline completion will be assigned.
- Show the next rollover time and whether today's completion is safely stored.

### Make progress more informative

- Separate “first solved,” “best route,” “daily participation,” and “recently
  played” instead of overloading one record.
- Add completion trends, difficulty progression, move/push improvement, solver
  usage, and typed-versus-generic breakdowns.
- Keep charts accessible with summaries, table alternatives, and reduced-motion
  behavior.

### Improve achievements

- Explain every achievement's requirement and current progress.
- Add a persistent notification history so already-deduplicated milestone
  unlocks can be reviewed after their toast disappears.
- Avoid achievements that reward excessive grinding over meaningful learning.

### Make import/export trustworthy

- Add a dry-run preview of the existing added, improved, unchanged, rejected,
  and invalid merge categories before commit.
- Offer a downloadable backup before destructive reset or incompatible schema
  migration.

## 4. Play experience

### Improve moment-to-moment clarity

- Make selected goals, box labels, dead squares, and the keeper's reachable area
  available as optional overlays.
- Add a concise move timeline for recent actions with direct undo-to-point on
  desktop and an accessible equivalent on mobile.
- Distinguish restart puzzle, abandon session, and reset all progress with
  different language and confirmation weight.

### Make hints educational

- Offer graduated hints: point out a deadlock risk, identify a productive box,
  suggest a push direction, then optionally reveal a short verified sequence.
- Explain why a move is risky rather than merely playing solver output.
- Ensure hint jobs share arbitration and cancellation with full solver runs.

### Improve touch and small-screen play

- Measure board fit before choosing cell size, with a persistent zoom level and
  a one-tap “fit board” action.
- Keep the D-pad reachable without covering the board and respect safe-area
  insets.
- Provide explicit swipe sensitivity and an option to disable swipe movement.

## 5. Editor experience

### Treat drafts as documents

- Add a small local version history on top of the delivered named draft slots,
  with explicit retention and storage-pressure behavior.
- Let an explicitly imported shared preview choose an existing destination as
  well as the current safe default of creating a new draft.
- Extend the existing scoped quarantine with recovery metadata and a guided
  repair view for damaged records.

### Improve construction tools

- Add rectangular select, move, copy/paste, fill, mirror, rotate, crop, and
  resize-with-preview operations.
- Provide palette shortcuts that do not conflict with native text editing.
- Add optional symmetry guides, reachable-area visualization, goal/box balance,
  and static dead-square overlays.

### Improve validation and publishing

- Group validation errors by location and make each item focus the affected
  cell or field.
- Offer quick fixes for padding, unreachable floor, missing keeper, and obvious
  symbol mistakes where the correction is unambiguous.
- Add an explicit publish/share review showing title, dimensions, rules,
  payload size, and whether a saved draft will be affected.

### Add authoring assistance carefully

- Provide bounded solver validation in the background after a quiet period,
  never on every paint action.
- Show whether the puzzle is solvable, the best known route, and whether
  optimality is proven or merely bounded.
- Preserve the exact draft and seed when offering transformations or generation.

## 6. Solver correctness and explainability

### Expose the proof trust boundary

- Surface the existing finite, replay-valid, cost-consistent trust checks in
  diagnostic output so proof failures are understandable.
- Add exportable proof diagnostics without exposing mutable worker,
  checkpoint, or cache internals as trusted data.
- Display `found`, `bounded`, and `proven` as distinct states with plain-language
  explanations.

### Make run-wide resource behavior understandable

- Present the existing run-wide elapsed/state/memory ledger across discovery,
  rewrite, and proof phases in the advanced UI.
- Show why a run ended: solved, proven, time limit, state limit, memory limit,
  cancelled, worker failed, or unsupported.
- Provide basic presets and an advanced details panel instead of exposing every
  tuning parameter at the same level.

### Improve solver progress UI

- Present current phase, incumbent moves/pushes, lower bound, proof gap, elapsed
  time, and memory in a stable layout.
- Use sparklines or compact phase history only when they add diagnostic value;
  retain a text/table alternative.
- Make cancellation immediate and leave the best replay-valid incumbent
  available when the contract permits it.

## 7. Solver efficiency roadmap

Preserve the closed audit's exact-oracle, replay, budget, and protocol gates
before measuring or adopting new pruning.

### Safe exact-search improvements

- Investigate contour-local allocation reuse, compact stacks, and parent/action
  arenas without changing search order or proof semantics.
- Reuse keeper reachability and occupancy buffers where generation ownership is
  explicit and differential tests prove equivalence.
- Add deterministic tiny-board oracle sweeps to every optimization pull request.

### Macros and pruning

- Evaluate classic-solver tunnel macros first because forced corridor sequences
  offer a comparatively understandable correctness argument.
- Add goal-room packing only with label-aware ordering proofs and exhaustive
  small-room comparison.
- Expand corral pruning only when the rejected subtree has a machine-checkable
  proof condition; record prune-family counters separately.
- Keep every new prune individually disableable for differential diagnosis.

### Heuristics and preprocessing

- Measure incremental assignment repair and pattern-database hit rate by puzzle
  family before increasing cache size.
- Measure the now-budgeted preprocessing cost and hit rate by fixture family;
  keep its cancellation checkpoints responsive as constructors evolve.
- Cache immutable board topology across repeated runs, but never snapshot-
  dependent state under a board-only key.

### Portfolio and worker efficiency

- Reuse a bounded worker pool after lifecycle and execution-identity tests prove
  isolation between runs.
- Allocate proof partitions by estimated subtree difficulty rather than count
  alone, while preserving deterministic fallback scheduling.
- Compact legacy beam and bidirectional parent records to reduce allocation
  churn on large typed rooms.
- Calibrate algorithm selection from measured memory and board topology, not
  only broad device categories.

### Checkpointing

- Make writes atomic and bounded, retain only a small recent set, and expose
  checkpoint age and compatibility in CLI output.
- Add checkpoint inspection and migration tooling around the portable v2
  representation; never migrate an incumbent without replay validation.

## 8. Catalog and puzzle-quality improvements

The old difficulty-skew and labeled-content issues are resolved. The next
content question is quality and diversity within the now-large generated set.

### Measure diversity beyond difficulty labels

- Track dimensions, boxes, goals, topology, tunnel density, room count,
  branching, label count, solution length, push count, deadlock pressure, and
  solver-family success.
- Detect near-duplicate boards under translation, reflection, rotation, and
  cosmetic wall padding.
- Publish a generated catalog report so distribution changes are reviewable.

### Add curated authorship

- Commission or handcraft more puzzles that teach or exploit Sokomind's typed
  mechanic rather than merely labeling generated pairs.
- Review licensing and attribution before importing external collections.
- Use community/editor submissions only with validation, moderation, provenance,
  and duplicate detection.

### Improve difficulty calibration

- Combine solver metrics with human play data only if an explicit privacy-safe
  local or opt-in design is chosen.
- Until then, use solution depth, forcedness, search effort across multiple
  solvers, and manual review rather than one heuristic score.
- Recalibrate playlists independently from the six broad catalog tiers.

## 9. Performance and PWA improvements

- Add repeatable Web Vitals and interaction benchmarks for Home, selector,
  first puzzle load, editor paint, solver-dialog updates, and route transitions.
- Keep board shards lazy and consider idle prefetch only for the visibly likely
  next puzzle and only on suitable connections.
- Extend the delivered offline/update notices with per-puzzle cache-readiness
  detail without interrupting an active solve or draft.
- Test service-worker upgrades with old IndexedDB/localStorage schemas and an
  in-progress session, not just a clean install.
- Add a storage-management view showing approximate local usage, recoverable
  records, and targeted cleanup choices.

## 10. Accessibility improvements

- Add browser tests for keyboard-only completion of Home, selector, Play,
  editor, Stats import, and solver cancellation.
- Test 200% and 400% zoom, Windows High Contrast, forced colors, and narrow
  landscape layouts.
- Announce solver phase changes at a restrained cadence so live regions do not
  become noisy.
- Ensure every canvas-like or grid interaction has an equivalent semantic
  keyboard path and concise instructions.
- Preserve focus across lazy route loads, dialogs, import errors, and PWA update
  prompts.

## 11. Engineering and maintainability improvements

### Strengthen boundaries

- Extend the AST-aware architecture gate to cover stylesheet ownership,
  generated imports, and newly introduced source layers.
- Add a small dependency-graph report to CI so boundary changes are easy to
  review before they become cycles.
- Keep nested-worker capabilities explicit when adding adapters or execution
  environments, and keep search kernels free of worker globals.
- Continue decomposing generated-engine source by responsibility while keeping
  the generated artifact freshness gate.

### Strengthen tests

- Expand the required route behavior matrix with component coverage where it
  provides faster diagnostics than browser-only tests.
- Maintain deterministic oracle, replay, mirror, rotation, typed-label, partial-
  state, cancellation, memory, and worker-failure matrices.
- Extend current storage and worker fault injection to IndexedDB transaction
  ordering, service-worker cache failures, and upgrade interruption.
- Treat flaky native-process exits as tracked CI signals with captured crash
  metadata rather than silently retrying forever.

### Make documentation executable

- Keep the generated project-reference facts and recursive links, anchors,
  paths, commands, and encoding checks current as new source domains appear.
- Generate additional fact tables only for stable contracts whose source owner
  is unambiguous.
- Keep one active audit and one improvements roadmap; retain specs and progress
  logs as history without treating them as current issue status.

## Suggested delivery sequence

### Phase 1 — Player flow

- Build on delivered recent-puzzle and selector continuity with tutorial
  progression, stronger Continue context, and mobile board fit.
- Add richer daily history, achievement progress, and pre-commit import
  previews.

### Phase 2 — Editor and solver usability

- Add draft version history, stronger construction tools, and clearer solver
  proof/resource presentation.

### Phase 3 — Measured efficiency

- Establish deterministic optimization gates, then pursue compact state,
  reachability reuse, safe macros, and adaptive portfolio scheduling.

### Phase 4 — Content and long-term quality

- Build diversity reports, curate authored collections, refine difficulty, and
  add privacy-conscious quality feedback only if it has a clear product need.

## Proposed success dashboard

| Area | Suggested measure |
|---|---|
| Correctness | Zero oracle differentials; zero invalid or false-proven cached results |
| Recovery | Every owned key reports failure; newest valid session is discoverable |
| Daily | Date-correct streak behavior across repeat assignments and timezone tests |
| Editor | Shared preview never mutates a draft without explicit action |
| UX | Reduced actions to resume/play; stable keyboard focus across routes |
| Accessibility | Critical flows pass keyboard, axe, zoom, and forced-color matrices |
| Solver | Lower median nodes/time at identical route/proof results and bounded memory |
| Content | Measured topology/solution diversity, not only balanced tier counts |
| PWA | Upgrade/offline scenarios preserve sessions and drafts across schema versions |
| Engineering | Route behavior coverage, architectural rules, and valid documentation links |
