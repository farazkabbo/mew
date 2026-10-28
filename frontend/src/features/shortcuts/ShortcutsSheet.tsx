"use client";

import type { ShortcutAction } from "@mew/shared";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { Keys } from "@/components/ui/Keycap";

import { useShortcutKeys } from "./useShortcutKeys";

type Row = { keys: string[]; hold?: boolean; what: string; say: string };

/**
 * "Two keys, max" (docs/NEB_APP_UI.md §5.6, board 6): every action fits one hand, so the other
 * keeps the pencil, or it's said out loud instead. The keys come from the student's own bindings.
 */
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const keys = useShortcutKeys();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const k = (action: ShortcutAction) => keys.shown(action).split("+");
  const rows: Row[] = [
    {
      keys: ["Ctrl", "Alt"],
      hold: true,
      what:
        keys.platform === "desktop"
          ? "Circle and ask: hold in neb, double tap on your screen"
          : "Circle and ask, on the page",
      say: "or say “what's this?”",
    },
    {
      keys: k("check_work"),
      what: "Check my work, or unfold the margin",
      say: "or say “check this”",
    },
    { keys: k("jump"), what: "Jump to any page or moment", say: "or say “open physics chapter 3”" },
    {
      keys: ["Ctrl", "D"],
      what: "Choose where it's saved",
      say: "or say “save it to physics chapter 5”",
    },
    {
      keys: k("new_notebook"),
      what: "New notebook, named first",
      say: "or say “new notebook called chemistry”",
    },
    {
      keys: k("new_chapter"),
      what: "New chapter here",
      say: "or say “add a chapter called optics”",
    },
    { keys: k("new_page"), what: "New page here", say: "or say “new page”" },
    { keys: k("import_pdf"), what: "Bring in a PDF", say: "or drop it on a notebook" },
  ];

  return (
    <dialog
      ref={dialog}
      aria-labelledby="shortcuts-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(1180px,calc(100vw-2rem))] rounded-[14px] border-0 bg-desk p-0 text-ink shadow-sh-3 backdrop:bg-ink/40"
      data-testid="shortcuts-sheet"
    >
      <div className="flex flex-col gap-8 p-10">
        <header className="flex items-start gap-6">
          <div className="flex-1">
            <h2 id="shortcuts-title" className="font-serif text-[56px] leading-none">
              Two keys, max.
            </h2>
            <p className="mt-3 max-w-xl text-muted">
              Every action fits one hand, so the other one keeps the pencil. Or skip the keys and
              just say it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-10 place-items-center rounded-full hover:bg-ink/5"
          >
            <X className="size-5" aria-hidden />
          </button>
        </header>
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {rows.map((row) => (
            <li
              key={row.what}
              className={`flex flex-col gap-3 rounded-[12px] p-5 shadow-sh-1 ${row.hold ? "bg-neb-wash" : "bg-paper"}`}
            >
              <span className="flex items-center gap-2">
                <Keys keys={row.keys} size="xl" />
                {row.hold && <span className="neb-voice text-xs">hold</span>}
              </span>
              <span className="font-serif text-[26px] leading-tight">{row.what}</span>
              <span className="neb-voice text-[13px]">{row.say}</span>
            </li>
          ))}
        </ul>
        <p className="flex items-center gap-3 text-muted">
          <Keys keys={["Alt"]} size="lg" />
          Hold Alt anywhere in neb and every button shows its key. Let go and they disappear.
        </p>
      </div>
    </dialog>
  );
}
