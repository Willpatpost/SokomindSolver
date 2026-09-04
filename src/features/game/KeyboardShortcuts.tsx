import { Modal } from "@/src/shared/ui/Modal";
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
      { label: "Toggle Zen mode", keys: ["Z"] },
      { label: "Mute / restore audio", keys: ["M"] },
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
  return (
    <Modal open={open} onClose={onClose} label="Keyboard shortcuts" className={styles.panel}>
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

        <p className={styles.hint}>Press Esc to close</p>
    </Modal>
  );
}
