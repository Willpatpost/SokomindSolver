import { memo, useEffect, useRef } from "react";
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

  useEffect(() => {
    ref.current?.scrollTo({ left: ref.current.scrollWidth, behavior: "smooth" });
  }, [actionLog]);

  if (moves === 0) return null;

  const { glyphs, truncated, offset } = formatActionLog(actionLog);

  return (
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
  );
});
