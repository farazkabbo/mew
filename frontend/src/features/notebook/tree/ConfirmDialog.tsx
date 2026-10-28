"use client";

import { Dialog } from "./Dialog";

type Props = {
  open: boolean;
  title: string;
  body: string;
  confirm: string;
  onConfirm(): void;
  onCancel(): void;
};

/** A yes-or-no question before something big ("Delete Physics with 4 chapters?"). */
export function ConfirmDialog({ open, title, body, confirm, onConfirm, onCancel }: Props) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      label={title}
      className="fixed top-[20vh] mx-auto w-[min(26rem,calc(100vw-2rem))]"
    >
      <div className="flex flex-col gap-3 p-5">
        <h2 className="font-serif text-xl">{title}</h2>
        <p className="text-sm text-muted">{body}</p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-line/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            {confirm}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
