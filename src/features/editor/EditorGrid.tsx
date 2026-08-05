import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  isTypedBoxSymbol,
  isTypedGoalSymbol,
  type EditorAction,
  type EditorState,
} from "./editor-model";
import styles from "./EditorGrid.module.css";

interface EditorGridProps {
  readonly state: EditorState;
  readonly dispatch: (action: EditorAction) => void;
}

type EditorGridStyle = CSSProperties & {
  "--columns": number;
  "--rows": number;
};

interface ActivePointer {
  readonly id: number;
  readonly pointerType: string;
  readonly startX: number;
  readonly startY: number;
  readonly row: number;
  readonly column: number;
  moved: boolean;
}

const TOUCH_SCROLL_THRESHOLD = 8;

function cellLabel(symbol: string): string {
  if (symbol === "O") return "W";
  if (symbol === " ") return "";
  if (symbol === "S") return "G";
  return symbol;
}

function symbolName(symbol: string): string {
  if (symbol === "O") return "wall";
  if (symbol === " ") return "floor";
  if (symbol === "R") return "robot";
  if (symbol === "X") return "generic box";
  if (symbol === "S") return "generic goal";
  if (isTypedBoxSymbol(symbol)) return `typed box ${symbol}`;
  if (isTypedGoalSymbol(symbol)) return `typed goal ${symbol}`;
  return "unknown cell";
}

function cellFromTarget(target: EventTarget | null): HTMLButtonElement | null {
  return target instanceof Element
    ? target.closest<HTMLButtonElement>("button[data-editor-cell]")
    : null;
}

export function EditorGrid({ state, dispatch }: EditorGridProps) {
  const activePointer = useRef<ActivePointer | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const [activeCell, setActiveCell] = useState({ row: 0, column: 0 });
  const activeRow = Math.min(activeCell.row, state.height - 1);
  const activeColumn = Math.min(activeCell.column, state.width - 1);

  const paint = useCallback(
    (row: number, column: number) => {
      dispatch({ type: "set-cell", row, column });
    },
    [dispatch],
  );

  const paintElement = useCallback(
    (element: HTMLButtonElement | null) => {
      if (!element) return;
      const row = Number(element.dataset.row);
      const column = Number(element.dataset.column);
      if (Number.isInteger(row) && Number.isInteger(column)) {
        paint(row, column);
      }
    },
    [paint],
  );

  const finishPainting = (
    event: ReactPointerEvent<HTMLDivElement>,
    commitTouch: boolean,
  ): void => {
    const active = activePointer.current;
    if (!active || active.id !== event.pointerId) return;
    activePointer.current = null;
    if (commitTouch && active.pointerType === "touch" && !active.moved) {
      paint(active.row, active.column);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const focusCell = useCallback(
    (row: number, column: number) => {
      const next = {
        row: Math.max(0, Math.min(state.height - 1, row)),
        column: Math.max(0, Math.min(state.width - 1, column)),
      };
      setActiveCell(next);
      cellRefs.current.get(`${next.row}-${next.column}`)?.focus();
    },
    [state.height, state.width],
  );

  const handleCellKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    row: number,
    column: number,
  ): void => {
    let nextRow = row;
    let nextColumn = column;

    switch (event.key) {
      case "ArrowUp":
        nextRow -= 1;
        break;
      case "ArrowDown":
        nextRow += 1;
        break;
      case "ArrowLeft":
        nextColumn -= 1;
        break;
      case "ArrowRight":
        nextColumn += 1;
        break;
      case "Home":
        nextRow = event.ctrlKey ? 0 : row;
        nextColumn = 0;
        break;
      case "End":
        nextRow = event.ctrlKey ? state.height - 1 : row;
        nextColumn = state.width - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    focusCell(nextRow, nextColumn);
  };

  const style: EditorGridStyle = {
    "--columns": state.width,
    "--rows": state.height,
  };

  return (
    <div
      className={styles.viewport}
      data-testid="editor-grid-viewport"
      aria-label="Scrollable puzzle canvas"
    >
      <div
        className={styles.grid}
        style={style}
        data-testid="editor-grid"
        role="grid"
        aria-label="Puzzle editor grid"
        aria-rowcount={state.height}
        aria-colcount={state.width}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          const cell = cellFromTarget(event.target);
          if (!cell) return;
          const row = Number(cell.dataset.row);
          const column = Number(cell.dataset.column);
          if (!Number.isInteger(row) || !Number.isInteger(column)) return;
          activePointer.current = {
            id: event.pointerId,
            pointerType: event.pointerType,
            startX: event.clientX,
            startY: event.clientY,
            row,
            column,
            moved: false,
          };
          // Touch starts may be taps or native scroll gestures. Defer painting
          // until pointer-up proves the finger did not pan the canvas.
          if (event.pointerType === "touch") return;
          event.currentTarget.setPointerCapture(event.pointerId);
          paintElement(cell);
        }}
        onPointerMove={(event) => {
          const active = activePointer.current;
          if (!active || active.id !== event.pointerId) return;
          if (active.pointerType === "touch") {
            if (
              Math.hypot(
                event.clientX - active.startX,
                event.clientY - active.startY,
              ) > TOUCH_SCROLL_THRESHOLD
            ) {
              active.moved = true;
            }
            return;
          }
          paintElement(
            cellFromTarget(document.elementFromPoint(event.clientX, event.clientY)),
          );
        }}
        onPointerUp={(event) => finishPainting(event, true)}
        onPointerCancel={(event) => finishPainting(event, false)}
        onLostPointerCapture={(event) => {
          if (activePointer.current?.id === event.pointerId) {
            activePointer.current = null;
          }
        }}
      >
        {state.cells.map((row, rowIndex) => (
          <div
            className={styles.row}
            role="row"
            aria-rowindex={rowIndex + 1}
            key={`row-${rowIndex}`}
          >
            {row.map((symbol, columnIndex) => {
              const key = `${rowIndex}-${columnIndex}`;
              return (
                <button
                  key={key}
                  ref={(element) => {
                    if (element) {
                      cellRefs.current.set(key, element);
                    } else {
                      cellRefs.current.delete(key);
                    }
                  }}
                  className={styles.cell}
                  data-editor-cell
                  data-row={rowIndex}
                  data-column={columnIndex}
                  data-symbol={symbol}
                  data-labeled-box={isTypedBoxSymbol(symbol) || undefined}
                  data-labeled-goal={isTypedGoalSymbol(symbol) || undefined}
                  type="button"
                  role="gridcell"
                  aria-colindex={columnIndex + 1}
                  aria-label={`Row ${rowIndex + 1}, column ${columnIndex + 1}: ${symbolName(symbol)}. Paint ${symbolName(state.selectedTool)}.`}
                  title={`${symbolName(symbol)} — paint ${symbolName(state.selectedTool)}`}
                  tabIndex={
                    activeRow === rowIndex && activeColumn === columnIndex
                      ? 0
                      : -1
                  }
                  onFocus={() =>
                    setActiveCell({ row: rowIndex, column: columnIndex })
                  }
                  onKeyDown={(event) =>
                    handleCellKeyDown(event, rowIndex, columnIndex)
                  }
                  onClick={(event) => {
                    // Pointer input is handled above to support click-and-drag
                    // painting. A detail of zero identifies keyboard activation.
                    if (event.detail === 0) paint(rowIndex, columnIndex);
                  }}
                >
                  <span aria-hidden="true">{cellLabel(symbol)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
