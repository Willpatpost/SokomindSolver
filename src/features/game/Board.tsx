import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  Direction,
  GameSession,
  Goal,
  Position,
} from "@/src/core/model";
import { positionKey } from "@/src/core";
import styles from "./Board.module.css";
import type { PresentedGameExperienceEvent } from "./game-feedback";
import { extractTrailPositions } from "./trail-positions";

interface BoardProps {
  session: GameSession;
  reduceMotion?: boolean;
  immersive?: boolean;
  constrainToViewport?: boolean;
  deadlockedBoxIds?: ReadonlySet<string>;
  experienceEvent?: PresentedGameExperienceEvent | null;
}

type BoardStyle = CSSProperties & {
  "--columns": number;
  "--rows": number;
  "--board-catalog-limit": string;
  "--board-standard-height-limit": string;
  "--board-immersive-height-limit": string;
};

type PieceStyle = CSSProperties & {
  "--piece-hue"?: number;
};

type TrailStyle = CSSProperties & {
  "--trail-opacity": number;
  "--trail-scale": number;
};

const TRAIL_OPACITY = [0.42, 0.34, 0.27, 0.2, 0.14, 0.09] as const;
const TRAIL_SCALE = [1, 0.88, 0.77, 0.67, 0.58, 0.5] as const;

interface PieceSlotProps {
  id: string;
  puzzleId: string;
  position: Position;
  reduceMotion: boolean;
  experienceEvent?: PresentedGameExperienceEvent | null;
  children: ReactNode;
}

const DIRECTION_VECTOR: Readonly<Record<Direction, Position>> = {
  up: { row: -1, column: 0 },
  down: { row: 1, column: 0 },
  left: { row: 0, column: -1 },
  right: { row: 0, column: 1 },
};

function typedHue(label: string): number {
  if (label === "X") return 32;
  return 14 + ((label.charCodeAt(0) - 65) * 47) % 300;
}

function positionLabel(position: Position): string {
  return `row ${position.row + 1}, column ${position.column + 1}`;
}

// ---------------------------------------------------------------------------
// Memoized cell-level components
// ---------------------------------------------------------------------------

/**
 * StaticCell renders a single floor, wall, or goal cell. These cells are
 * derived entirely from ParsedBoard data which is immutable for the lifetime
 * of a puzzle, so they should never re-render during gameplay.
 */
interface StaticCellProps {
  cellKey: string;
  isWall: boolean;
  goal: Goal | undefined;
}

const StaticCell = memo(function StaticCell({
  isWall,
  goal,
}: StaticCellProps) {
  return (
    <div
      className={`${styles.cell} ${isWall ? styles.wall : styles.floor}`}
      aria-hidden="true"
    >
      {!isWall && goal ? (
        <span
          className={styles.goal}
          data-generic={goal.label === "X" || undefined}
          data-goal-label={goal.label}
          style={{ "--piece-hue": typedHue(goal.label) } as PieceStyle}
          aria-hidden="true"
        >
          <span>{goal.label === "X" ? "" : goal.label}</span>
        </span>
      ) : null}
    </div>
  );
});

/** TrailDot renders a single trail marker in the trail layer. */
interface TrailDotProps {
  column: number;
  row: number;
  age: number;
}

const TrailDot = memo(function TrailDot({ column, row, age }: TrailDotProps) {
  const presentationIndex = Math.min(age, TRAIL_OPACITY.length - 1);
  return (
    <span
      className={styles.trailMarker}
      data-trail-age={age}
      style={
        {
          gridColumn: column + 1,
          gridRow: row + 1,
          "--trail-opacity": TRAIL_OPACITY[presentationIndex],
          "--trail-scale": TRAIL_SCALE[presentationIndex],
        } as TrailStyle
      }
    />
  );
});

/**
 * BoxPiece renders the visual content of a single box. Memoized so it only
 * re-renders when its own on-goal / deadlocked / label state changes.
 */
interface BoxPieceProps {
  label: string;
  onGoal: boolean;
  deadlocked: boolean;
}

const BoxPiece = memo(function BoxPiece({
  label,
  onGoal,
  deadlocked,
}: BoxPieceProps) {
  return (
    <span
      className={styles.box}
      data-generic={label === "X" || undefined}
      data-box-label={label}
      data-home={onGoal || undefined}
      data-deadlocked={deadlocked || undefined}
      style={{ "--piece-hue": typedHue(label) } as PieceStyle}
    >
      <span className={styles.crateFace}>
        <span className={styles.sigil}>
          {label === "X" ? "" : label}
        </span>
      </span>
    </span>
  );
});

/** KeeperPiece is the static robot visual. It never changes for a puzzle. */
const KeeperPiece = memo(function KeeperPiece() {
  return (
    <span className={styles.robot}>
      <span className={styles.antenna} />
      <span className={styles.robotFace} />
    </span>
  );
});

// ---------------------------------------------------------------------------
// PieceSlot — memoized FLIP-animation wrapper for movable pieces
// ---------------------------------------------------------------------------

const PieceSlot = memo(function PieceSlot({
  id,
  puzzleId,
  position,
  reduceMotion,
  experienceEvent,
  children,
}: PieceSlotProps) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const previousPosition = useRef<Position | null>(null);
  const previousPuzzle = useRef(puzzleId);
  const animation = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    animation.current?.cancel();
    animation.current = null;

    const nextRect = element.getBoundingClientRect();
    const priorPosition = previousPosition.current;
    const adjacent = priorPosition !== null &&
      Math.abs(priorPosition.row - position.row) +
        Math.abs(priorPosition.column - position.column) === 1;

    const rememberPosition = () => {
      previousPosition.current = {
        row: position.row,
        column: position.column,
      };
      previousPuzzle.current = puzzleId;
    };

    const presentAnimation = (
      keyframes: Keyframe[],
      options: KeyframeAnimationOptions,
    ) => {
      const nextAnimation = element.animate(keyframes, options);
      animation.current = nextAnimation;
      const clearCancelledAnimation = () => {
        if (animation.current === nextAnimation) animation.current = null;
      };
      nextAnimation.onfinish = () => {
        clearCancelledAnimation();
        nextAnimation.cancel();
      };
      nextAnimation.oncancel = clearCancelledAnimation;
    };

    if (
      id === "keeper" &&
      experienceEvent?.kind === "blocked" &&
      !reduceMotion
    ) {
      const vector = DIRECTION_VECTOR[experienceEvent.direction];
      const distance = Math.max(3, Math.min(nextRect.width, nextRect.height) * 0.11);
      const x = vector.column * distance;
      const y = vector.row * distance;
      presentAnimation(
        [
          { transform: "translate3d(0, 0, 0)", offset: 0 },
          { transform: `translate3d(${x}px, ${y}px, 0)`, offset: 0.42 },
          { transform: `translate3d(${-x * 0.22}px, ${-y * 0.22}px, 0)`, offset: 0.72 },
          { transform: "translate3d(0, 0, 0)", offset: 1 },
        ],
        {
          duration: 180,
          easing: "cubic-bezier(0.3, 0.8, 0.3, 1)",
        },
      );
      rememberPosition();
      return;
    }

    if (
      priorPosition &&
      previousPuzzle.current === puzzleId &&
      adjacent &&
      !reduceMotion
    ) {
      const layerStyle = element.parentElement
        ? getComputedStyle(element.parentElement)
        : null;
      const parsedColumnGap = Number.parseFloat(layerStyle?.columnGap ?? "0");
      const parsedRowGap = Number.parseFloat(layerStyle?.rowGap ?? "0");
      const columnGap = Number.isFinite(parsedColumnGap) ? parsedColumnGap : 0;
      const rowGap = Number.isFinite(parsedRowGap) ? parsedRowGap : 0;
      const x =
        (priorPosition.column - position.column) * (nextRect.width + columnGap);
      const y =
        (priorPosition.row - position.row) * (nextRect.height + rowGap);

      if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) {
        const pushedBox = experienceEvent?.movedBox?.id === id;
        const horizontalPush =
          experienceEvent?.direction === "left" ||
          experienceEvent?.direction === "right";
        const keyframes: Keyframe[] = pushedBox
          ? [
              {
                transform: `translate3d(${x}px, ${y}px, 0) ${horizontalPush ? "scale3d(0.9, 1.06, 1)" : "scale3d(1.06, 0.9, 1)"}`,
                offset: 0,
              },
              {
                transform: `translate3d(${x * 0.2}px, ${y * 0.2}px, 0) ${horizontalPush ? "scale3d(0.96, 1.03, 1)" : "scale3d(1.03, 0.96, 1)"}`,
                offset: 0.68,
              },
              {
                transform: `translate3d(0, 0, 0) ${horizontalPush ? "scale3d(1.035, 0.985, 1)" : "scale3d(0.985, 1.035, 1)"}`,
                offset: 0.86,
              },
              { transform: "translate3d(0, 0, 0) scale3d(1, 1, 1)", offset: 1 },
            ]
          : [
              { transform: `translate3d(${x}px, ${y}px, 0)` },
              { transform: "translate3d(0, 0, 0)" },
            ];
        presentAnimation(
          keyframes,
          {
            duration: pushedBox ? 220 : 190,
            easing: "cubic-bezier(0.2, 0.8, 0.3, 1)",
          },
        );
      }
    }

    rememberPosition();
  }, [
    experienceEvent,
    id,
    position.column,
    position.row,
    puzzleId,
    reduceMotion,
  ]);

  useLayoutEffect(
    () => () => {
      animation.current?.cancel();
    },
    [],
  );

  return (
    <span
      className={styles.pieceSlot}
      data-piece-id={id}
      data-piece-row={position.row}
      data-piece-column={position.column}
      data-piece-feedback={experienceEvent?.kind}
      ref={elementRef}
      style={{
        gridColumn: position.column + 1,
        gridRow: position.row + 1,
      }}
    >
      {children}
    </span>
  );
});

// ---------------------------------------------------------------------------
// Board — top-level memoized component
// ---------------------------------------------------------------------------

const EMPTY_SET = new Set<string>();

export const Board = memo(function Board({
  session,
  reduceMotion = false,
  immersive = false,
  constrainToViewport = false,
  deadlockedBoxIds = EMPTY_SET,
  experienceEvent = null,
}: BoardProps) {
  const { board, snapshot, puzzle } = session;

  // Pre-compute static board topology — stable for the lifetime of a puzzle.
  const { cellDescriptors, goals } = useMemo(() => {
    const wallSet = new Set(board.walls.map(positionKey));
    const goalMap = new Map(
      board.goals.map((goal) => [positionKey(goal.position), goal]),
    );

    const descriptors = Array.from(
      { length: board.width * board.height },
      (_, index) => {
        const row = Math.floor(index / board.width);
        const column = index % board.width;
        const key = positionKey({ row, column });
        return {
          key,
          isWall: wallSet.has(key),
          goal: goalMap.get(key),
        };
      },
    );

    return { cellDescriptors: descriptors, goals: goalMap };
  }, [board]);

  const trailPositions = useMemo(
    () => extractTrailPositions(session.history.head, snapshot.robot),
    [session.history.head, snapshot.robot],
  );

  const matchedBoxes = snapshot.boxes.filter(
    (box) => goals.get(positionKey(box.position))?.label === box.label,
  ).length;
  const boardSummary = [
    `${puzzle.title} puzzle board, ${board.width} columns by ${board.height} rows.`,
    `Keeper at ${positionLabel(snapshot.robot)}.`,
    `${matchedBoxes} of ${snapshot.boxes.length} boxes on matching goals.`,
    `${snapshot.moves} ${snapshot.moves === 1 ? "move" : "moves"} and ${snapshot.pushes} ${snapshot.pushes === 1 ? "push" : "pushes"}.`,
  ].join(" ");

  const style: BoardStyle = {
    "--columns": board.width,
    "--rows": board.height,
    "--board-catalog-limit": `${board.width * 44}px`,
    "--board-standard-height-limit": `${((board.width / board.height) * 58).toFixed(2)}dvh`,
    "--board-immersive-height-limit": `${((board.width / board.height) * 66).toFixed(2)}dvh`,
  };

  return (
    <div
      className={styles.board}
      style={style}
      role="img"
      aria-label={boardSummary}
      data-solved={snapshot.solved || undefined}
      data-feedback={experienceEvent?.kind}
      data-feedback-sequence={experienceEvent?.sequence}
      data-fit-viewport={constrainToViewport || undefined}
      data-board-size={
        board.width >= 14 || board.height >= 14 ? "large" : "standard"
      }
      data-immersive={immersive || undefined}
      data-testid="game-board"
    >
      {cellDescriptors.map((desc) => (
        <StaticCell
          key={desc.key}
          cellKey={desc.key}
          isWall={desc.isWall}
          goal={desc.goal}
        />
      ))}

      {!reduceMotion && trailPositions.length > 0 ? (
        <div className={styles.trailLayer} aria-hidden="true">
          {trailPositions.map((trail) => (
            <TrailDot
              key={`trail-${trail.age}`}
              column={trail.position.column}
              row={trail.position.row}
              age={trail.age}
            />
          ))}
        </div>
      ) : null}

      {!reduceMotion &&
      (experienceEvent?.kind === "goal" ||
        experienceEvent?.kind === "solved") &&
      experienceEvent.movedBox ? (
        <div className={styles.feedbackLayer} aria-hidden="true">
          <span
            className={styles.goalRipple}
            data-feedback-effect="goal-ripple"
            data-feedback-sequence={experienceEvent.sequence}
            key={`goal-${experienceEvent.sequence}`}
            style={{
              gridColumn: experienceEvent.movedBox.to.column + 1,
              gridRow: experienceEvent.movedBox.to.row + 1,
            }}
          />
        </div>
      ) : null}

      <div className={styles.pieceLayer} aria-hidden="true">
        {snapshot.boxes.map((box) => {
          const goal = goals.get(positionKey(box.position));
          const boxOnGoal = goal?.label === box.label;

          return (
            <PieceSlot
              id={box.id}
              key={box.id}
              puzzleId={puzzle.id}
              position={box.position}
              reduceMotion={reduceMotion}
              experienceEvent={
                experienceEvent?.movedBox?.id === box.id
                  ? experienceEvent
                  : null
              }
            >
              <BoxPiece
                label={box.label}
                onGoal={boxOnGoal}
                deadlocked={deadlockedBoxIds.has(box.id)}
              />
            </PieceSlot>
          );
        })}

        <PieceSlot
          id="keeper"
          puzzleId={puzzle.id}
          position={snapshot.robot}
          reduceMotion={reduceMotion}
          experienceEvent={
            experienceEvent?.kind === "blocked" ? experienceEvent : null
          }
        >
          <KeeperPiece />
        </PieceSlot>
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {snapshot.moves > 0 ? boardSummary : ""}
      </span>
    </div>
  );
});
