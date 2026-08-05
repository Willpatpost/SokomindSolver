# Experience, sound, and motion

The experience layer is optional presentation around the deterministic game.
It can be replaced or disabled without changing a puzzle, snapshot, or solver
contract.

## Preferences

`ExperienceProvider` stores a versioned `sokomind.experience.v1` record:

- master audio;
- procedural music;
- effects volume;
- music volume;
- motion mode: system, full, or reduced.

Malformed or unavailable storage falls back safely. Sound and music are
opt-in. Browsers require an input gesture before Web Audio can start, so the
controller creates or resumes its context only from a control or game action.

## Procedural audio

`ProceduralAudioController` synthesizes short cues and a quiet pentatonic
soundscape. It downloads no files. Effects and music have separate gain paths,
the page-visibility lifecycle pauses scheduling, and `dispose()` stops timers
and active nodes.

Available cues are:

```text
step, push, goal-enter, goal-leave, blocked, undo, reset, solve
```

Add a new cue by extending `AUDIO_CUES`, implementing its short synthesis
recipe, and mapping a pure game feedback event to it. Never trigger audio from
the core engine.

## Motion

`useResolvedMotion()` combines the stored preference with
`prefers-reduced-motion`. The provider exposes the result and places
`data-motion="full|reduced"` on the document root.

Animated pieces are rendered in a visual overlay keyed by stable box IDs. The
board exposes a concise semantic summary plus polite move announcements, which
avoids forcing assistive technology through hundreds of noninteractive cells.
FLIP movement is disabled when reduced motion is active.

Ambient halos, motes, completion particles, and crate settling are decorative,
`aria-hidden`, pointer-inert, and disabled or simplified for reduced motion.
The completion message itself uses a polite live region.

## Deadlock feedback

When a push creates a deadlocked box (detected by the deadlock bridge in
`src/core/deadlock-bridge.ts`), the box cell receives a `data-deadlocked`
attribute. CSS applies a coral glow to visually distinguish stuck boxes. A
toast notification warns the player with "That box looks stuck." This feedback
is purely presentational and does not prevent further moves.

## Undo trail

The last six unique robot positions from the undo history are rendered as
fading blue dots in a trail layer between the cell grid and piece overlay
(`src/features/game/trail-positions.ts`). Older positions fade more than
recent ones. The trail is suppressed when reduced motion is active, matching
the same `useResolvedMotion()` gate used by piece animations.

## Move notation strip

`src/features/game/MoveNotation.tsx` displays a compact strip of directional
arrow glyphs below the board. Each move in the action log maps to one of the
four arrows. The strip shows the most recent 24 moves with a leading ellipsis
when the log is longer, and auto-scrolls to keep the latest move visible.

## Performance rules

- Prefer transform and opacity.
- Avoid perpetual blur or shadow animation.
- Keep celebration particles bounded and deterministic.
- Cancel old piece animations before starting replacements.
- Pause music when the page is hidden.
- Never let sound or animation mutate game state.
