"use client";

import { type ReactNode, useEffect, useRef } from "react";

type Props = {
  open: boolean;
  onClose(): void;
  /** The dialog's accessible name. */
  label: string;
  children: ReactNode;
  /** Extra classes for placement and size. */
  className?: string;
};

/**
 * A modal dialog on the native `<dialog>` element: the browser traps focus, closes it on Esc
 * and puts the page behind it out of reach. Clicking the backdrop closes it too.
 */
export function Dialog({ open, onClose, label, children, className = "" }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault(); // Esc: the owner closes it (and may confirm first)
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === ref.current) onClose(); // a press on the backdrop
      }}
      className={`rounded-2xl border border-rule bg-paper-raised p-0 text-ink shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)] backdrop:bg-black/30 ${className}`}
    >
      {open && children}
    </dialog>
  );
}
