import type { CSSProperties } from "react";
import styles from "./CelebrationOverlay.module.css";

export interface CelebrationOverlayProps {
  readonly active: boolean;
  readonly message?: string;
  readonly className?: string;
}

type ParticleStyle = CSSProperties & {
  "--travel-x": string;
  "--travel-y": string;
  "--delay": string;
  "--duration": string;
  "--rotation": string;
  "--particle-hue": number;
};

const PARTICLES = [
  [-210, -155, 0, 760, -190, 34, "square"],
  [-148, -224, 45, 820, 150, 95, "leaf"],
  [-82, -182, 90, 700, -120, 195, "dot"],
  [-24, -248, 18, 860, 220, 32, "square"],
  [48, -202, 76, 740, -170, 110, "leaf"],
  [122, -232, 32, 830, 180, 22, "dot"],
  [204, -148, 105, 720, -230, 154, "square"],
  [236, -52, 62, 810, 135, 34, "leaf"],
  [196, 42, 12, 760, -160, 95, "dot"],
  [224, 136, 94, 840, 210, 195, "square"],
  [136, 202, 46, 720, -135, 22, "leaf"],
  [54, 232, 112, 820, 175, 110, "dot"],
  [-34, 214, 30, 750, -205, 34, "square"],
  [-112, 238, 88, 860, 125, 154, "leaf"],
  [-190, 174, 54, 710, -155, 32, "dot"],
  [-232, 78, 120, 830, 240, 95, "square"],
  [-242, -18, 24, 770, -120, 195, "leaf"],
  [-170, -76, 132, 800, 190, 22, "dot"],
  [158, -92, 140, 740, -170, 110, "square"],
  [98, 112, 118, 850, 220, 34, "leaf"],
] as const;

export function CelebrationOverlay({
  active,
  message = "Puzzle solved.",
  className,
}: CelebrationOverlayProps) {
  if (!active) return null;

  const overlayClassName = className
    ? `${styles.overlay} ${className}`
    : styles.overlay;

  return (
    <>
      <div className={overlayClassName} aria-hidden="true">
        <span className={styles.wash} />
        <span className={styles.ring} />
        <span className={styles.flare} />
        <span className={styles.particles}>
          {PARTICLES.map(
            (
              [
                travelX,
                travelY,
                delay,
                duration,
                rotation,
                hue,
                shape,
              ],
              index,
            ) => (
              <span
                data-shape={shape}
                key={`${travelX}-${travelY}-${index}`}
                style={
                  {
                    "--travel-x": `${travelX}px`,
                    "--travel-y": `${travelY}px`,
                    "--delay": `${delay}ms`,
                    "--duration": `${duration}ms`,
                    "--rotation": `${rotation}deg`,
                    "--particle-hue": hue,
                  } as ParticleStyle
                }
              />
            ),
          )}
        </span>
      </div>
      <span
        className={styles.announcement}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {message}
      </span>
    </>
  );
}
