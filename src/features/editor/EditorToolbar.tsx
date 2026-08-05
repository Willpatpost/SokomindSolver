import { useId, useState } from "react";
import {
  EDITOR_TOOLS,
  TYPED_LABELS,
  isTypedGoalSymbol,
  type EditorAction,
  type TypedLabel,
} from "./editor-model";
import styles from "./EditorToolbar.module.css";

interface EditorToolbarProps {
  readonly selectedTool: string;
  readonly dispatch: (action: EditorAction) => void;
}

const STANDARD_GROUPS = [
  { key: "terrain", label: "Terrain" },
  { key: "pieces", label: "Pieces" },
] as const;

function toolGlyph(symbol: string): string {
  if (symbol === "O") return "W";
  if (symbol === " ") return "·";
  if (symbol === "S") return "◎";
  return symbol;
}

export function EditorToolbar({
  selectedTool,
  dispatch,
}: EditorToolbarProps) {
  const labelSelectId = useId();
  const [typedLabel, setTypedLabel] = useState<TypedLabel>("A");
  const typedKind = isTypedGoalSymbol(selectedTool) ? "goal" : "box";

  const selectTypedLabel = (label: TypedLabel) => {
    setTypedLabel(label);
    dispatch({
      type: "set-tool",
      tool: typedKind === "goal" ? label.toLowerCase() : label,
    });
  };

  return (
    <section className={styles.toolbar} aria-label="Editor tools">
      {STANDARD_GROUPS.map((group) => (
        <div key={group.key} className={styles.group}>
          <p className={styles.groupLabel}>{group.label}</p>
          <div className={styles.tools}>
            {EDITOR_TOOLS.filter((tool) => tool.group === group.key).map(
              (tool) => (
                <button
                  key={tool.symbol}
                  className={styles.tool}
                  type="button"
                  data-active={selectedTool === tool.symbol || undefined}
                  aria-label={tool.label}
                  aria-pressed={selectedTool === tool.symbol}
                  title={tool.label}
                  onClick={() =>
                    dispatch({ type: "set-tool", tool: tool.symbol })
                  }
                >
                  {toolGlyph(tool.symbol)}
                </button>
              ),
            )}
          </div>
        </div>
      ))}

      <fieldset className={styles.typedGroup}>
        <legend className={styles.groupLabel}>Typed pair</legend>
        <label className={styles.labelSelect} htmlFor={labelSelectId}>
          Label
          <select
            id={labelSelectId}
            value={typedLabel}
            onChange={(event) =>
              selectTypedLabel(event.currentTarget.value as TypedLabel)
            }
          >
            {TYPED_LABELS.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.typedTools}>
          <button
            className={styles.typedTool}
            type="button"
            aria-label={`Typed box ${typedLabel}`}
            aria-pressed={selectedTool === typedLabel}
            data-active={selectedTool === typedLabel || undefined}
            onClick={() =>
              dispatch({ type: "set-tool", tool: typedLabel })
            }
          >
            <strong>{typedLabel}</strong>
            <span>Box</span>
          </button>
          <button
            className={styles.typedTool}
            type="button"
            aria-label={`Typed goal ${typedLabel.toLowerCase()}`}
            aria-pressed={selectedTool === typedLabel.toLowerCase()}
            data-active={
              selectedTool === typedLabel.toLowerCase() || undefined
            }
            onClick={() =>
              dispatch({
                type: "set-tool",
                tool: typedLabel.toLowerCase(),
              })
            }
          >
            <strong>{typedLabel.toLowerCase()}</strong>
            <span>Goal</span>
          </button>
        </div>
        <p className={styles.typedHint}>
          Each typed box only fits its matching lowercase goal.
        </p>
      </fieldset>
    </section>
  );
}
