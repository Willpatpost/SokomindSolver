# Experience, themes, Zen play, sound, and motion

The experience layer is optional presentation around the deterministic game.
It can be replaced or disabled without changing a puzzle, snapshot, or solver
contract.

## Preferences

`ExperienceProvider` stores a versioned `sokomind.experience.v2` record:

- master audio;
- procedural music;
- effects volume;
- music volume;
- motion mode: system, full, or reduced;
- theme family: Cozy Study, Midnight Neon, or Minimal Ink;
- appearance: system, light, or dark;
- Zen play layout: enabled or disabled.

Malformed or unavailable storage falls back safely. For a fresh profile, sound
effects and music are enabled with both gain controls at 50%. Explicit stored
choices are preserved through the version 2 schema. Version 1 records migrate
to Cozy Study while retaining their explicit light, dark, or system choice.
Browsers require an input gesture before Web Audio can start, so enabled audio
begins only after the first control or game action.

## Theme families and appearance

Theme family and appearance are independent. The provider resolves system
appearance with `prefers-color-scheme`, then writes `data-theme-family` and
the resolved `data-theme` to the document root. Shared surfaces and board
pieces consume semantic CSS variables, so switching a family changes paint
without changing board geometry or loading additional assets.

The settings dialog presents compact family swatches that update the live
interface immediately. All six family/appearance combinations remain local,
offline-capable, compatible with forced colors, and subject to the same focus
and contrast checks.

## Zen play and input

Zen mode is a reversible, persisted board-first layout for play routes. Players
can enter or leave it from the play header or press `Z`. The compact header
always retains the puzzle exit, move and push counters, undo, restart, sound and
settings controls, and the control that leaves Zen mode. Touch devices retain a
compact directional pad and the same hint and route actions used by the full
sidebar.

All input paths call the same guarded move function. Movement is locked while
play is paused or a modal experience owns focus. Swipe input requires a minimum
distance and a clear dominant axis, ignores gestures that start on interactive
controls, and never emits more than one move per gesture. Mobile guidance and
48-pixel coarse-pointer targets make the available gestures explicit.

The board calculates separate catalog, normal-play viewport, and immersive
viewport limits from its row/column ratio. Large boards reduce decorative gaps
and padding before cell size, while narrow screens use the available inline
width and page scrolling rather than clipping the board.

## Procedural audio

`ProceduralAudioController` synthesizes short cues and a quiet pentatonic
soundscape. It downloads no files. Effects and music have separate gain paths,
the page-visibility lifecycle pauses scheduling, and `dispose()` stops timers
and active nodes. Frequent movement cues are rate-limited, zero-volume states
avoid allocating Web Audio resources, and effects and music can be previewed
from settings.

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
`src/solver/deadlock-bridge.ts`), the box cell receives a `data-deadlocked`
attribute. CSS applies a coral glow to visually distinguish stuck boxes. A
toast notification warns the player with "That box looks stuck." This feedback
is purely presentational and does not prevent further moves.

## Undo trail

The last six unique robot positions from the undo history are rendered as
fading blue dots in a trail layer between the cell grid and piece overlay
(`src/features/game/trail-positions.ts`). Older positions fade and shrink more
than recent ones. The trail is suppressed when reduced motion is active, matching
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
- Cancel old piece animations before measuring replacement grid geometry.
- Derive piece transforms from logical cell deltas, never page-level reflow.
- Scale boards through aspect-ratio-aware limits instead of transforms.
- Animate only adjacent logical moves; resets and multi-step undo snap in place.
- Pause music when the page is hidden.
- Never let sound or animation mutate game state.
