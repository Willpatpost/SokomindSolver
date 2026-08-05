import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { GameSession, Goal, Position } from "@/src/core/model";
import { positionKey } from "@/src/core";
import styles from "./Board.module.css";
import { extractTrailPositions } from "./trail-positions";

interface BoardProps {
  session: GameSession;
  reduceMotion?: boolean;
  deadlockedBoxIds?: ReadonlySet<string>;
}

type BoardStyle = CSSProperties & {
  "--columns": number;
  "--rows": number;
};

type PieceStyle = CSSProperties & {
  "--piece-hue"?: number;
};

interface PieceSlotProps {
  id: string;
  puzzleId: string;
  position: Position;
  reduceMotion: boolean;
  children: ReactNode;
}

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
  return (
    <span
      className={styles.trailMarker}
      style={
        {
          gridColumn: column + 1,
          gridRow: row + 1,
          "--trail-age": age,
        } as CSSProperties
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
  children,
}: PieceSlotProps) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const previousRect = useRef<DOMRect | null>(null);
  const previousPuzzle = useRef(puzzleId);
  const animation = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const nextRect = element.getBoundingClientRect();
    const previous = previousRect.current;

    if (
      previous &&
      previousPuzzle.current === puzzleId &&
      !reduceMotion
    ) {
      const x = previous.left - nextRect.left;
      const y = previous.top - nextRect.top;

      if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) {
        animation.current?.cancel();
        animation.current = element.animate(
          [
            { transform: `translate3d(${x}px, ${y}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          {
            duration: 190,
            easing: "cubic-bezier(0.2, 0.8, 0.3, 1)",
          },
        );
      }
    }

    previousRect.current = nextRect;
    previousPuzzle.current = puzzleId;
  }, [position.column, position.row, puzzleId, reduceMotion]);

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
  deadlockedBoxIds = EMPTY_SET,
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
    maxWidth: `${board.width * 44}px`,
  };

  return (
    <div
      className={styles.board}
      style={style}
      role="img"
      aria-label={boardSummary}
      data-solved={snapshot.solved || undefined}
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
