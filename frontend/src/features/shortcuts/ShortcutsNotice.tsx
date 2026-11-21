"use client";

import Link from "next/link";

import { useScreenCoachAvailability } from "../desktop/useScreenCoachAvailability";
import { useSettings } from "../settings/store";
import { SummonShortcutHelp, useMacKeyboard } from "./SummonShortcutHelp";
import { useShortcutKeys } from "./useShortcutKeys";

/**
 * "Shortcuts got simpler" (K2 §11.4): shown once to students who knew the old shortcuts (they
 * finished the introduction before K2), listing what changed. New students never see it: the
 * introduction marks it read.
 */
export function ShortcutsNotice({ hidden }: { hidden: boolean }) {
  const loaded = useSettings((s) => s.loaded);
  const onboarded = useSettings((s) => s.settings.onboarded);
  const seen = useSettings((s) => s.settings.shortcuts_notice_seen);
  const keys = useShortcutKeys();
  const mac = useMacKeyboard();
  const visible = !hidden && loaded && onboarded && !seen;
  const hasScreenCoach = useScreenCoachAvailability(visible);
  if (!visible) return null;
  const done = () => void useSettings.getState().update({ shortcuts_notice_seen: true });

  return (
    <section
      aria-labelledby="shortcuts-notice-title"
      data-testid="shortcuts-notice"
      className="pointer-events-auto w-[22rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-paper-hi p-4 text-sm shadow-[0_8px_30px_-12px_rgba(0,0,0,0.25)]"
    >
      <h2 id="shortcuts-notice-title" className="font-semibold">
        Shortcuts got simpler
      </h2>
      <p className="mt-1 text-muted">Notebook shortcuts are quick to reach.</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          Redo is <kbd>{keys.shown("redo")}</kbd> (Ctrl+Shift+Z is gone).
        </li>
        <li>
          New notebook <kbd>{keys.shown("new_notebook")}</kbd>, chapter{" "}
          <kbd>{keys.shown("new_chapter")}</kbd>, page <kbd>{keys.shown("new_page")}</kbd>, and
          check my work <kbd>{keys.shown("check_work")}</kbd>.
        </li>
        <li>
          <SummonShortcutHelp />
          {!mac &&
            hasScreenCoach &&
            " In Screen Coach, double-tap Ctrl+Alt to open the island and use Select to circle something."}
        </li>
      </ul>
      <div className="mt-3 flex items-center justify-end gap-3">
        <Link href="/settings#shortcuts" className="underline" onClick={done}>
          See all shortcuts
        </Link>
        <button
          type="button"
          onClick={done}
          className="rounded-full bg-ink px-3 py-1 font-medium text-paper"
        >
          Got it
        </button>
      </div>
    </section>
  );
}
