# Sokomind UI/UX V2 — Implementation Roadmap

## Status

- **Plan revision:** 2026-08-28
- **Current delivery point:** Sprint 5 — Zen play and input polish completed
- **Next sprint:** Sprint 6 — Replay-valid personal bests
- **Product shape:** game-first Sokoban experience with an optional learning path and a first-class Solver Lab
- **Delivery model:** small, independently shippable sprints with accessibility, performance, and regression gates

This roadmap turns the earlier experience catalog into an implementation sequence. It preserves Sokomind's existing strengths, avoids rebuilding features that are already shipped, and creates shared foundations before adding visual or product complexity.

---

## 1. Product vision

Sokomind should serve four related experiences without making any one of them carry the full interface:

1. **Play** — a tactile, clear, satisfying Sokoban game.
2. **Learn** — an optional guided path that teaches puzzle concepts without locking the catalog.
3. **Improve** — persistent records, replayable personal-best routes, comparisons, and meaningful progression.
4. **Explore** — a Solver Lab for people interested in search algorithms, heuristics, and state-space behavior.

The default experience stays focused on the puzzle. Advanced analysis is available by choice rather than shown during every play session.

---

## 2. Decisions already made

These are product decisions, not open questions:

- The puzzle catalog remains open. The guided path recommends an order but never hard-locks catalog puzzles.
- Theme family and light/dark appearance are separate settings.
- The current visual language becomes the **Cozy Study** theme rather than being discarded.
- Accessibility settings are independent from themes. Contrast, reduced motion, and sound controls must work across every theme.
- Personal-best progress may retain the complete action log needed for replay.
- Saved routes must be validated before they are treated as records.
- Regular play exposes simple Hint and Solve actions; algorithm controls and instrumentation live in Solver Lab.
- Solver quality remains important, even though the Solver Lab is intended for an enthusiast subset of players.
- A future hosted database is expected, but the application remains local-first until that work is planned separately.

---

## 3. Design principles

### Game first

The board is the visual and interaction priority. Supporting panels should clarify the puzzle, not compete with it.

### Progressive disclosure

Common actions remain obvious. Detailed algorithm choices, diagnostics, replay comparisons, and creator analysis appear only when requested.

### Feedback with meaning

Motion, sound, and color communicate the same small vocabulary of events: move, blocked move, push, goal entered, goal left, deadlock risk, undo, reset, and solve.

### Orthogonal presentation state

Avoid encoding every visual choice into one large theme switch. Treat these axes separately:

- Theme family: Cozy Study, Midnight Neon, Minimal Ink, and future themes
- Appearance: system, light, dark
- Difficulty accent: metadata-derived color or ornament
- Puzzle state: playing, blocked, deadlock warning, solved
- Accessibility: motion, sound, contrast, focus visibility

### Honest progress

Completion, personal bests, optimality, streaks, and achievements must be earned from validated play data. Decorative rewards must not obscure useful puzzle information.

### Local-first, migration-ready data

Persist data behind versioned repositories and schemas. A later database sync should replace storage adapters, not force a redesign of the game domain.

---

## 4. Current baseline

The existing application already provides much of the product skeleton:

- Responsive board play with keyboard, pointer, and touch-oriented controls
- Undo, reset, move/push counters, deadlock warnings, and route trails
- Puzzle catalog search, filters, favorites, progress, and minimaps
- Daily challenges, streak tracking, achievements, and statistics
- Personal-best and optimal-result presentation
- Completion overlay with replay, sharing, next puzzle, and next-unsolved actions
- Solver playback with speed controls
- Puzzle editor with live validation and private playtesting
- Procedural audio, theme preference, motion preference, high-contrast support, and forced-colors support
- Static deployment and offline-capable architecture

The roadmap therefore concentrates on cohesion, tactile quality, durable replay data, navigation structure, and advanced solver presentation.

---

## 5. Target architecture

### 5.1 Experience events

Core game transitions remain pure. A presentation adapter derives typed experience events from the previous session, next session, and attempted action.

```text
input -> pure game transition -> typed experience event -> visual/audio/haptic presenters
                                  -> persistence and achievement consumers
```

The event vocabulary is shared by animation, audio, tests, telemetry, and future haptics. Presenters may ignore an event, but they should not independently infer conflicting meanings.

### 5.2 Experience director

After the event contract is stable, a small director coordinates presentation intensity. It must:

- Respect reduced-motion and sound preferences.
- Avoid overlapping effects during rapid input.
- Cancel obsolete effects on navigation, reset, or replay jumps.
- Keep visual feedback cosmetic; it must never delay or mutate game state.

### 5.3 Theme system

Theme families use semantic design tokens rather than component-specific overrides. At minimum:

- Surface, elevated surface, board void, floor, wall, goal, crate, keeper
- Primary and secondary text, outline, focus, success, warning, danger
- Shadow, texture, glow, radius, and motion-character tokens

Appearance selects light, dark, or system values within the active family. Theme assets must have a lightweight fallback and must not shift board geometry.

### 5.4 Route and record store

Summary progress remains small and synchronously available. Larger validated action logs belong behind an asynchronous route repository, preferably IndexedDB in the browser.

Each saved personal-best route should include:

- Puzzle identifier and puzzle-revision fingerprint
- Canonical input sequence
- Moves, pushes, completion time, and completion timestamp
- App/schema version
- Replay-validation result

Storage is bounded: keep current personal bests and a small recent history rather than an unlimited event archive.

### 5.5 Journey model

The guided path is a recommendation layer over the open catalog. It groups puzzles into concepts and suggests the next useful puzzle while preserving direct access, search, favorites, daily challenges, and random play.

### 5.6 Solver Lab boundary

The regular play route owns the human puzzle experience. Solver Lab owns:

- Algorithm and heuristic selection
- Frontier, visited-state, and cost inspection
- Step/run/pause/cancel controls
- Search metrics and comparisons
- Explanation of tradeoffs and failure modes

Both use the same solver service and replay format so results cannot diverge.

---

## 6. Quality gates for every sprint

A sprint is shippable only when all applicable gates pass:

- Keyboard, pointer, and narrow-screen behavior remain usable.
- New controls have accessible names and visible focus.
- Reduced motion meaningfully removes or simplifies new movement.
- Light, dark, high-contrast, and forced-colors modes retain readable state distinctions.
- No game rule or solver behavior is moved into presentation code.
- Unit tests cover pure state derivation; browser tests cover the user-visible contract.
- Production build, type checking, linting, documentation linting, and static-size checks pass.
- New persistence includes schema migration and corruption fallback tests.
- Effects do not create input latency or animate pieces farther than one legal move.

---

## 7. Delivery plan

### Sprint 1 — Tactile movement foundation

**Goal:** Make the most frequent interactions feel responsive while establishing one reliable event contract for future effects.

**Status:** Completed 2026-08-28

**Scope**

- Add a typed movement-experience event derived from the previous and next game sessions.
- Include direction, moved-box identity and positions, matched-goal counts, and a monotonically increasing presentation sequence.
- Preserve the existing feedback classifier as a compatibility wrapper.
- Add blocked-move keeper recoil.
- Add directional crate compression during pushes.
- Add a restrained goal ripple when a crate reaches a goal or completes the puzzle.
- Suppress the new effects when reduced motion is active.
- Expose a stable board feedback state for browser tests and future presenters.
- Update unit and browser coverage.

**Acceptance criteria**

- Repeated blocked inputs retrigger feedback without changing the session.
- Rapid legal input never visually moves a piece more than one adjacent cell.
- Goal feedback is driven by the moved box, not by a delayed board scan in the component.
- Effects cancel cleanly and do not survive route changes.
- Existing audio, deadlock, completion, and achievement behavior is unchanged.
- All quality gates pass.

### Sprint 2 — Completion and milestone presentation

**Goal:** Turn puzzle completion into a concise, rewarding summary without slowing the next action.

**Status:** Completed 2026-08-28

**Scope**

- Refine the completion hierarchy around result, improvement, optimality, and next action.
- Add milestone treatments for first clear, new move best, saved-route push improvement, verified optimal clear, and current collection completion.
- Reuse the milestone contract for guided-path chapter completion when the journey model ships in Sprint 8.
- Coordinate celebration intensity through the experience director.
- Keep replay, share, retry, next, and next-unsolved actions keyboard reachable.

**Acceptance criteria**

- A completion state is understandable without relying on animation or sound.
- Milestone copy is accurate for first and repeated clears.
- The dialog remains usable at 320 px and at 200% zoom.

### Sprint 3 — Adaptive audio and feedback settings

**Goal:** Give each event an intentional sound signature without producing fatigue.

**Status:** Completed 2026-08-28

**Scope**

- Route movement events through a unified audio presenter.
- Add subtle variants for pushes, goals, undo, reset, blocked moves, warnings, and solve milestones.
- Add previewable effect/music controls and a mute shortcut.
- Add rate limiting and graceful Web Audio fallback behavior.

**Acceptance criteria**

- Audio never blocks input or throws when browser audio is unavailable.
- Muted and zero-volume states perform no unnecessary audio work.
- Settings are announced and operable with assistive technology.

### Sprint 4 — Theme-family foundation

**Goal:** Support multiple visual identities without duplicating component CSS.

**Status:** Completed 2026-08-28

**Scope**

- Separate `themeFamily` from `appearance` in preferences with a versioned migration.
- Convert shared surfaces and board pieces to semantic tokens.
- Ship three coherent families: Cozy Study, Midnight Neon, and Minimal Ink.
- Give every family light and dark variants.
- Add compact live previews in settings.

**Acceptance criteria**

- Every family works in both appearances and with system appearance.
- Existing users migrate to Cozy Study with their current light/dark choice preserved.
- Switching themes causes no board reflow and remains available offline.
- Contrast and focus checks pass for every variant.

### Sprint 5 — Zen play and input polish

**Goal:** Let players choose a more immersive board-first layout and improve control confidence.

**Status:** Completed 2026-08-28

**Scope**

- Add a reversible Zen mode with compact chrome.
- Improve touch target spacing, gesture affordances, and accidental-input prevention.
- Add scalable board framing for larger puzzles.
- Preserve counters and critical actions through a compact overlay or reveal control.

**Acceptance criteria**

- Zen mode never hides the only route to undo, reset, settings, or exit.
- Touch and keyboard behavior remain equivalent.
- Large boards remain readable without layout overflow.

### Sprint 6 — Replay-valid personal bests

**Goal:** Make improvement durable and replayable while preparing storage for future sync.

**Scope**

- Introduce a versioned asynchronous route repository.
- Save the action log for each personal-best result.
- Replay every candidate route from the canonical initial state before promotion.
- Store puzzle fingerprints and reject stale or corrupt records safely.
- Bound retained history and expose storage-management controls.

**Acceptance criteria**

- A promoted record reproduces the saved move/push counts and solved state.
- Missing, corrupt, stale, or quota-limited storage never prevents play.
- Existing summary progress migrates without data loss.

### Sprint 7 — Replay comparison and ghosts

**Goal:** Help players understand improvement rather than only showing lower numbers.

**Scope**

- Add personal-best replay from completion and statistics surfaces.
- Compare current and best routes using a timeline and divergence markers.
- Add an optional non-interactive ghost/trace presentation.
- Provide accessible textual comparison when motion is reduced.

**Acceptance criteria**

- Ghost state can never affect collisions or game state.
- Replay controls support pause, seek, speed, keyboard, and screen-reader labels.
- Differences are understandable without color alone.

### Sprint 8 — Guided journey and Daily V2

**Goal:** Offer direction to new and returning players without closing the catalog.

**Scope**

- Curate concept-based chapters and recommended prerequisites.
- Add a suggested-next algorithm based on progress, not mandatory locks.
- Add lightweight chapter maps and concept explanations.
- Enrich daily challenge framing, history, and recovery states.

**Acceptance criteria**

- Every catalog puzzle remains directly playable.
- Players can dismiss or resume the guided path.
- Recommendations are deterministic, explainable, and covered by unit tests.

### Sprint 9 — Achievements, collections, and cosmetics

**Goal:** Make long-term progress expressive while keeping rewards secondary to puzzle mastery.

**Scope**

- Group achievements into understandable collections.
- Add progress indicators for non-secret achievements.
- Add cosmetic unlocks that work across compatible theme families.
- Add a recent-milestones view and restrained unlock presentation.

**Acceptance criteria**

- No achievement requires hidden tracking that users cannot reasonably infer.
- Cosmetics preserve board legibility and accessibility settings.
- Unlock evaluation remains deterministic and testable.

### Sprint 10 — Solver Lab

**Goal:** Turn the project's search-algorithm roots into an excellent optional educational workspace.

**Scope**

- Create a dedicated Solver Lab route.
- Present algorithm and heuristic choices with concise explanations.
- Add run, pause, step, cancel, and playback controls.
- Visualize frontier/visited state, solution path, elapsed time, expansions, pushes, and memory-relevant metrics.
- Support side-by-side result comparison on the same puzzle and configuration.
- Keep simple Hint and Solve entry points in regular play.

**Acceptance criteria**

- Solver work runs away from the main UI thread or yields frequently enough to keep controls responsive.
- Cancellation is reliable and stale runs cannot overwrite current results.
- A returned solution is replay-validated before presentation.
- Metrics use documented, consistent definitions.
- The lab is useful with animation disabled and on a narrow viewport.

### Sprint 11 — Creator intelligence

**Goal:** Help puzzle authors make playable, intentional puzzles without turning the editor into a solver console.

**Scope**

- Add optional solvability checks and solution summaries.
- Surface dead squares, obvious frozen boxes, unreachable areas, and duplicate-layout warnings.
- Add difficulty signals with clear caveats.
- Provide one-click transfer from the editor playtest to Solver Lab.

**Acceptance criteria**

- Static warnings distinguish certain errors from heuristic concerns.
- Analysis is cancellable and never destroys editor state.
- Exported puzzles remain compatible with the existing format.

### Sprint 12 — Online-readiness boundary

**Goal:** Prepare domain contracts for accounts and cross-device sync without prematurely selecting a backend.

**Scope**

- Document server-authoritative and client-authoritative data.
- Define sync identifiers, revision semantics, conflict policy, and deletion behavior.
- Separate local repositories from domain services where needed.
- Add export/import for progress and replay records.
- Write a dedicated backend decision record and migration plan before implementation.

**Acceptance criteria**

- The static application remains fully functional without an account or network.
- Exported data is versioned, validated, and round-trippable.
- No backend SDK is added until privacy, authentication, hosting, and operating-cost choices are explicit.

---

## 8. Dependency order

```text
Experience events
  -> tactile feedback
  -> completion choreography
  -> adaptive audio

Semantic tokens
  -> theme families
  -> compatible cosmetics

Validated route store
  -> personal-best replay
  -> comparisons and ghosts
  -> future sync

Open catalog metadata
  -> guided journey
  -> richer daily recommendations

Solver service contract
  -> Solver Lab
  -> creator analysis
```

The ordering is intentional. Later sprints may be reprioritized, but they should not bypass their shared foundation.

---

## 9. Deferred experiments

The following ideas remain valid experiments but are not committed implementation work:

- Weather, seasonal, or time-of-day theme variants
- Heavy particle systems or screen shake
- Public profiles, leaderboards, social feeds, and competitive ranking
- User-generated puzzle hosting and moderation
- Cloud accounts and cross-device sync
- Shared/community hint systems
- Downloadable asset packs
- Procedural daily puzzle generation

Each needs a separate product and technical review. Public or shared features in particular require identity, moderation, privacy, abuse, and operating-cost plans.

---

## 10. Success measures

Use measurements to validate direction, not to manipulate play time.

- First puzzle start and first clear completion rates
- Return-to-play rate after a clear
- Guided-path adoption versus direct catalog use
- Hint/Solve and Solver Lab usage as separate behaviors
- Personal-best replay and retry rates
- Input error, reset, undo, and deadlock-warning patterns
- Theme-family and appearance selections
- Accessibility-setting usage and accessibility regressions
- Interaction latency, animation stability, build size, and crash/error rate

Any telemetry implementation must be separately approved, privacy-preserving, documented, and optional where appropriate.

---

## 11. Definition of V2 complete

V2 is complete when Sokomind offers:

- Tactile, accessible, event-driven play feedback
- A polished completion and improvement loop
- Multiple selectable theme families with light and dark appearance
- An open catalog plus optional guided journey
- Replay-valid personal-best routes and useful comparisons
- A dedicated educational Solver Lab
- Creator analysis that builds on the same solver contracts
- Local-first, versioned data that can migrate to a future hosted service

The result should feel more expressive without becoming less legible, less responsive, or less recognizably Sokomind.
