import { useMemo } from "react";
import styles from "./PuzzleMinimap.module.css";

interface PuzzleMinimapProps {
  readonly width: number;
  readonly height: number;
  readonly boxes: number;
  readonly puzzleId: string;
}

function seededIndices(
  id: string,
  count: number,
  total: number,
): ReadonlySet<number> {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  const indices = new Set<number>();
  let attempts = 0;
  while (indices.size < count && attempts < count * 4) {
    hash = ((hash * 1664525 + 1013904223) >>> 0) % total;
    indices.add(hash % total);
    attempts++;
  }
  return indices;
}

export function PuzzleMinimap({
  width,
  height,
  boxes,
  puzzleId,
}: PuzzleMinimapProps) {
  const cells = useMemo(() => {
    const total = width * height;
    const boxPositions = seededIndices(puzzleId, Math.min(boxes, total), total);
    const result: Array<"floor" | "box"> = [];
    for (let i = 0; i < total; i++) {
      result.push(boxPositions.has(i) ? "box" : "floor");
    }
    return result;
  }, [width, height, boxes, puzzleId]);

  return (
    <div
      className={styles.minimap}
      style={{
        gridTemplateColumns: `repeat(${width}, 1fr)`,
        gridTemplateRows: `repeat(${height}, 1fr)`,
        aspectRatio: `${width} / ${height}`,
      }}
      aria-hidden="true"
    >
      {cells.map((type, i) => (
        <span key={i} className={styles.cell} data-type={type === "box" ? "box" : undefined} />
      ))}
    </div>
  );
}
