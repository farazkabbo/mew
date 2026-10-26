"use client";

import { MARK_LEVEL_LABELS, MarkLevel } from "@mew/shared";
import { CheckCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useNotebookUi } from "../notebook/store";
import { useMarkPrefs } from "./prefs";

type Props = { notebookId: string | null; pageId: string | null };

/**
 * The toolbar's live annotations control (K9 §7.1): how much the tutor marks in this notebook
 * (Off, Quiet, Normal, Coach), "Hide marks until I'm done" (Alt+C shows them), and this page's
 * marks layer (its eye).
 */
export function MarksMenu({ notebookId, pageId }: Props) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const prefs = useMarkPrefs((s) => s.prefsFor(notebookId));
  const level = useMarkPrefs((s) => s.levelFor(notebookId));
  const quiet = useMarkPrefs((s) => Date.now() < s.quietUntil);
  const hiddenHere = useNotebookUi((s) => (pageId ? s.marksHiddenOn.has(pageId) : false));

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-testid="marks-menu"
        title={`Live marks: ${MARK_LEVEL_LABELS[level]}`}
        aria-label={`Live marks: ${MARK_LEVEL_LABELS[level]}`}
        aria-expanded={open}
        aria-controls={`${ids}-panel`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-ink-muted hover:bg-rule/50 hover:text-ink aria-expanded:bg-rule/60"
      >
        <CheckCheck className="size-4" aria-hidden />
        <span className="hidden capitalize sm:inline">{level}</span>
      </button>
      {open && (
        <div
          id={`${ids}-panel`}
          role="group"
          aria-label="Live marks"
          className="absolute top-10 right-0 z-30 w-72 rounded-xl border border-rule bg-paper-raised p-3 text-sm shadow-lg"
        >
          <fieldset disabled={!notebookId}>
            <legend className="mb-1 text-xs font-medium text-ink-muted">
              Marks while I write (this notebook)
            </legend>
            {MarkLevel.options.map((option) => (
              <label key={option} className="flex items-center gap-2 py-0.5">
                <input
                  type="radio"
                  name={`${ids}-level`}
                  checked={prefs.level === option}
                  onChange={() =>
                    notebookId && useMarkPrefs.getState().setLevel(notebookId, option)
                  }
                />
                {MARK_LEVEL_LABELS[option]}
              </label>
            ))}
            {quiet && prefs.level !== "quiet" && prefs.level !== "off" && (
              <p role="status" className="mt-1 text-xs text-ink-muted">
                On Quiet for the rest of today: today&apos;s live marking budget is used.
              </p>
            )}
            <label className="mt-2 flex items-center gap-2 border-t border-rule pt-2">
              <input
                type="checkbox"
                checked={prefs.hideUntilDone}
                onChange={(event) =>
                  notebookId &&
                  useMarkPrefs.getState().setHideUntilDone(notebookId, event.target.checked)
                }
              />
              Hide marks until I&apos;m done (Alt+C shows them)
            </label>
          </fieldset>
          <label className="mt-1 flex items-center gap-2">
            <input
              type="checkbox"
              disabled={!pageId}
              checked={!hiddenHere}
              onChange={() => pageId && useNotebookUi.getState().toggleMarksOn(pageId)}
            />
            Show marks on this page
          </label>
        </div>
      )}
    </div>
  );
}
