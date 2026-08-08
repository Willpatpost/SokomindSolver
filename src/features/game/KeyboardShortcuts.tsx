import { useEffect } from "react";
import styles from "./KeyboardShortcuts.module.css";

interface KeyboardShortcutsProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const SHORTCUTS = [
  {
    group: "Movement",
    items: [
      { label: "Move up", keys: ["↑", "W"] },
      { label: "Move down", keys: ["↓", "S"] },
      { label: "Move left", keys: ["←", "A"] },
      { label: "Move right", keys: ["→", "D"] },
    ],
  },
  {
    group: "Actions",
    items: [
      { label: "Undo last move", keys: ["U", "Ctrl+Z"] },
      { label: "Request hint", keys: ["H"] },
      { label: "Restart puzzle", keys: ["R"] },
      { label: "Pause / resume", keys: ["P"] },
      { label: "Toggle favorite", keys: ["F"] },
    ],
  },
  {
    group: "Navigation",
    items: [
      { label: "Previous puzzle", keys: ["[", "PgUp"] },
      { label: "Next puzzle", keys: ["]", "PgDn"] },
      { label: "Next unsolved", keys: ["N"] },
      { label: "Go back", keys: ["Esc"] },
      { label: "Show shortcuts", keys: ["?"] },
      { label: "Toggle dark mode", keys: ["Shift+T"] },
    ],
  },
] as const;

export function KeyboardShortcuts({ open, onClose }: KeyboardShortcutsProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "?") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div className={styles.panel} role="dialog" aria-label="Keyboard shortcuts">
        <div className={styles.heading}>
          <h2>Keyboard shortcuts</h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {SHORTCUTS.map((group, gi) => (
          <div key={group.group} className={styles.group}>
            <p className={styles.groupLabel}>{group.group}</p>
            <div className={styles.shortcuts}>
              {group.items.map((item) => (
                <div key={item.label} className={styles.row}>
                  <span className={styles.label}>{item.label}</span>
                  <span className={styles.keys}>
                    {item.keys.map((key) => (
                      <kbd key={key} className={styles.key}>{key}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            {gi < SHORTCUTS.length - 1 && <div className={styles.divider} />}
          </div>
        ))}

        <p className={styles.hint}>Press ? or Esc to close</p>
      </div>
    </div>
  );
}
