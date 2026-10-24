"use client";

import { panelGroups } from "@mew/shared";

import { useNotesCheck } from "./check-store";
import { dismissFinding } from "./follow-up";

/**
 * The Notes Check panel in the notebook (N4, brief §2.3): what the latest check found, grouped
 * like the desktop app's panel (differences first, matches collapsed). "Show me" brings a
 * finding's line into view; "Dismiss" sets it aside; a finding the student worked through (N5)
 * shows as done. The footer hides or shows the marks.
 */
export function NotesCheckPanel() {
  const { result, panelOpen, running, error, marksHidden, dismissed, progress } = useNotesCheck();
  const { closePanel, toggleMarks, focusFinding } = useNotesCheck.getState();
  if (!panelOpen) return null;

  const findings = (result?.findings ?? []).filter((f) => !dismissed.has(f.id));
  return (
    <aside
      aria-label="Notes Check"
      data-testid="notes-check-panel"
      className="pointer-events-auto flex max-h-full w-80 flex-col overflow-hidden rounded-2xl bg-paper text-sm text-ink shadow-xl ring-1 ring-ink/10"
    >
      <header className="flex items-center justify-between px-4 pt-3">
        <h2 className="font-semibold">Notes Check</h2>
        <button
          type="button"
          aria-label="Close Notes Check"
          onClick={closePanel}
          className="px-1 text-lg text-ink-muted"
        >
          ×
        </button>
      </header>
      <div aria-live="polite" className="px-4 pt-1">
        {running && <p className="text-ink-muted">Checking against your notes…</p>}
        {error && <p className="text-error">{error}</p>}
        {result && !running && <p>{result.speech}</p>}
        {result?.scopeLabel && !running && (
          <p className="mt-1 text-xs text-ink-muted">{result.scopeLabel}</p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
        {!running &&
          panelGroups(findings).map((group) => {
            const items = (
              <ul>
                {group.items.map((item) => {
                  const done = (progress[item.findingId]?.status ?? "open") !== "open";
                  return (
                    <li
                      key={item.findingId}
                      className="grid grid-cols-[1.5rem_1fr] gap-2 border-t border-ink/10 py-2"
                    >
                      <span
                        aria-hidden
                        className={`grid size-6 place-items-center rounded-full text-xs font-semibold ${
                          item.icon === "?" ? "bg-amber-100 text-amber-800" : "bg-ink/10"
                        }`}
                      >
                        {item.icon}
                      </span>
                      <div>
                        <p>{item.title}</p>
                        {item.detail && (
                          <p className="mt-1 text-xs text-ink-muted">{item.detail}</p>
                        )}
                        <div className="mt-1 flex gap-3 text-xs">
                          {item.inNotebook && (
                            <button
                              type="button"
                              className="font-medium underline"
                              onClick={() => focusFinding(item.findingId)}
                            >
                              Show me
                            </button>
                          )}
                          {item.type !== "match" && !done && (
                            <button
                              type="button"
                              className="text-ink-muted underline"
                              onClick={() => void dismissFinding(item.findingId)}
                            >
                              Dismiss
                            </button>
                          )}
                          {done && <span className="text-ink-muted">✓ Worked through</span>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            );
            return group.collapsed ? (
              <details key={group.type} className="mt-3">
                <summary className="cursor-pointer font-medium">{group.heading}</summary>
                {items}
              </details>
            ) : (
              <section key={group.type} className="mt-3">
                <h3 className="mb-1 font-medium">{group.heading}</h3>
                {items}
              </section>
            );
          })}
      </div>
      <footer className="border-t border-ink/10 px-4 py-2">
        <button
          type="button"
          className="text-xs underline"
          onClick={toggleMarks}
          aria-pressed={marksHidden}
        >
          {marksHidden ? "Show marks on the page" : "Hide marks on the page"}
        </button>
      </footer>
    </aside>
  );
}
