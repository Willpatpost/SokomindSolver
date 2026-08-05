import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import styles from "./Modal.module.css";

interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly labelledBy?: string;
  readonly describedBy?: string;
  readonly label?: string;
  readonly className?: string;
  readonly mobileSheet?: boolean;
  readonly closeOnBackdrop?: boolean;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}

const FOCUSABLE_SELECTOR = [
  "[data-autofocus]",
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Accessible application modal built on the browser's top-layer dialog.
 *
 * `showModal()` supplies focus containment and makes the rest of the page
 * inert. This wrapper adds predictable initial/return focus and backdrop
 * behavior for every Sokomind overlay.
 */
export function Modal({
  open,
  onClose,
  labelledBy,
  describedBy,
  label,
  className,
  mobileSheet = false,
  closeOnBackdrop = true,
  returnFocusRef,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (!open) {
      if (dialog.open) dialog.close();
      return;
    }

    previousFocusRef.current =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);

    if (!dialog.open) dialog.showModal();
    document.documentElement.dataset.modalOpen = "";

    const frame = window.requestAnimationFrame(() => {
      const initialFocus = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      initialFocus?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
      if (!document.querySelector("dialog[open]")) {
        delete document.documentElement.dataset.modalOpen;
      }
      const returnFocus = previousFocusRef.current;
      if (returnFocus?.isConnected) {
        window.requestAnimationFrame(() => {
          if (returnFocus.isConnected) returnFocus.focus();
        });
      }
    };
  }, [open, returnFocusRef]);

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;

    const dialog = event.currentTarget;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((element) => element.tabIndex >= 0);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (!closeOnBackdrop || event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const outside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;
    if (outside) onClose();
  }

  const dialogClassName = className
    ? `${styles.dialog} ${className}`
    : styles.dialog;

  return (
    <dialog
      aria-describedby={describedBy}
      aria-label={label}
      aria-labelledby={labelledBy}
      className={dialogClassName}
      data-mobile-sheet={mobileSheet || undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={handleKeyDown}
      onMouseDown={handleBackdrop}
      ref={dialogRef}
      tabIndex={-1}
    >
      {children}
    </dialog>
  );
}
