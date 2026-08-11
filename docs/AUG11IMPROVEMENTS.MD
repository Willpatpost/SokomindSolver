# Sokomind Whole-Product Improvements — August 11, 2026

**Purpose:** Forward-looking improvements for the website, player experience,
editor, solver, content, platform, and engineering workflow.  
**Companion audit:** [`AUG11AUDIT.MD`](AUG11AUDIT.MD)

This is a roadmap, not an issue tracker. Release-blocking correctness work in
the audit takes precedence. The ideas below should be selected using measured
player or engineering outcomes rather than implemented as an undifferentiated
feature list.

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

- 2,095 validated puzzles across all six difficulty tiers.
- Difficulty is now broadly balanced, but 2,058 puzzles come from one generated
  collection and only 37 are originals.
- 2,078 puzzles exercise typed boxes, so the earlier lack of labeled content is
  no longer a concern.
- The immutable game core, route sharing, local progress, editor, exact replay,
  multiple solvers, and offline shell already provide a strong product base.
- The main experience risk is not missing breadth; it is making the existing
  breadth easier to understand, trust, navigate, and recover.

## 1. Home, navigation, and onboarding

### Make the first decision obvious

- Present one primary **Continue** or **Start playing** action based on a
  reconciled recoverable session.
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

- Preserve selector filters, page, scroll position, and focused puzzle when
  navigating into Play and back.
- Make browser Back behavior predictable from nested selector routes, custom
  editor links, solver dialogs, and completion dialogs.
- Add a small recent-puzzles list independent of best-record progress.

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

### Rebuild Daily Challenge around participation

- Use date-indexed daily records rather than inferring participation from the
  puzzle's lifetime best.
- Define local-time rollover, travel/timezone changes, repeated assignments,
  and offline completion behavior.
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
- Queue unlock notifications from explicit old/new snapshots so multiple
  milestones can be announced once and reviewed later.
- Avoid achievements that reward excessive grinding over meaningful learning.

### Make import/export trustworthy

- Use one versioned schema and one bounded parser everywhere.
- Preview added, improved, unchanged, rejected, and invalid records before
  commit.
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

- Support named draft slots, duplicate, rename, last-saved time, and a small
  local version history.
- Open shared puzzles as previews and require explicit import into a chosen
  draft.
- Quarantine malformed drafts and let users export or delete only the damaged
  record.

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

### Establish a proof trust boundary

- Centralize the rule that only finite, replay-valid, cost-consistent results
  may influence an incumbent or proof.
- Keep proof generation separate from proof validation. The validator should
  distrust every worker, checkpoint, and cache record.
- Display `found`, `bounded`, and `proven` as distinct states with plain-language
  explanations.

### Make resource behavior understandable

- Report one run-wide elapsed/state/memory ledger across discovery, rewrite,
  and proof phases.
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

Correct AUD-001 through AUD-004 before measuring or adopting new pruning.

### Safe exact-search improvements

- Use exact-state best-`g` dominance for IDA* and retain collision-checked state
  identity.
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
- Bound preprocessing by the same run ledger and preserve responsive
  cancellation after every event-loop yield.
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

- Bind checkpoints to schema, algorithm version, objective, exact snapshot,
  board rules, and tuning parameters.
- Make writes atomic and bounded, retain only a small recent set, and expose
  checkpoint age and compatibility in CLI output.
- Use the same portable digest representation in Node and browser environments.

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
- Surface offline readiness and update availability without interrupting an
  active solve or draft.
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

- Replace regex-only import checks with AST-aware architecture rules.
- Move shared solver UI types out of the controller and eliminate type cycles.
- Formalize nested-worker creation and environment capabilities in the adapter
  contract.
- Continue decomposing generated-engine source by responsibility while keeping
  the generated artifact freshness gate.

### Strengthen tests

- Add component behavior coverage for every route rather than relying on
  imported-file percentages.
- Maintain deterministic oracle, replay, mirror, rotation, typed-label, partial-
  state, cancellation, memory, and worker-failure matrices.
- Add fault injection for localStorage, IndexedDB, service-worker caches, worker
  construction, malformed messages, and checkpoint corruption.
- Treat flaky native-process exits as tracked CI signals with captured crash
  metadata rather than silently retrying forever.

### Make documentation executable

- Validate all Markdown files recursively and case-insensitively.
- Check normal links, anchors, source paths, npm scripts, route examples, and
  generated catalog counts.
- Generate small fact tables from source where possible.
- Keep one active audit and one improvements roadmap; retain specs and progress
  logs as history without treating them as current issue status.

## Suggested delivery sequence

### Phase 0 — Trust and recovery

- Close audit P0/P1 solver findings.
- Protect editor drafts and correct daily participation.
- Unify persistence health and targeted recovery.

### Phase 1 — Player flow

- Improve Continue, recent puzzles, selector continuity, tutorial progression,
  and mobile board fit.
- Repair achievement and import feedback.

### Phase 2 — Editor and solver usability

- Add draft slots, safe share import, stronger construction tools, and clearer
  solver proof/resource presentation.

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
