import { memo, useCallback, useEffect, useRef, useState } from "react";
import styles from "./MoveNotation.module.css";
import { formatActionLog } from "./move-notation-format.ts";

const DIR_NAME: Readonly<Record<string, string>> = {
  U: "up",
  D: "down",
  L: "left",
  R: "right",
};

interface MoveNotationProps {
  readonly actionLog: string;
  readonly moves: number;
}

export const MoveNotation = memo(function MoveNotation({ actionLog, moves }: MoveNotationProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    ref.current?.scrollTo({ left: ref.current.scrollWidth, behavior: "smooth" });
  }, [actionLog]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(actionLog);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may not be available
    }
  }, [actionLog]);

  if (moves === 0) return null;

  const { glyphs, truncated, offset } = formatActionLog(actionLog);

  return (
    <div className={styles.notationRow}>
      <div
        className={styles.notation}
        ref={ref}
        aria-label={`Move history: ${moves} moves, recent: ${actionLog
          .slice(-5)
          .split("")
          .map((c) => DIR_NAME[c] ?? c)
          .join(" ")}`}
      >
        {truncated ? <span className={styles.ellipsis}>...</span> : null}
        {glyphs.map((glyph, i) => (
          <span key={offset + i} className={styles.glyph}>
            {glyph}
          </span>
        ))}
      </div>
      <button
        type="button"
        className={styles.copyButton}
        onClick={() => void handleCopy()}
        title="Copy move notation"
        aria-label={copied ? "Copied" : "Copy move notation"}
      >
        {copied ? "✓" : "⎘"}
      </button>
    </div>
  );
});
