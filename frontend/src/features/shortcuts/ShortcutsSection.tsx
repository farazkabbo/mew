"use client";

import {
  bindingsFor,
  checkBinding,
  defaultBindings,
  FIXED_KEYS,
  formatBinding,
  recordKey,
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  type ShortcutAction,
  type ShortcutBindings,
} from "@mew/shared";
import { type KeyboardEvent, useState } from "react";

import { Section } from "../settings/controls";
import { useSettings } from "../settings/store";
import { useShortcutKeys } from "./useShortcutKeys";

type Recording = {
  action: ShortcutAction;
  /** A modifier held so far ("Ctrl + …"). */
  pending: string | null;
  problem: string | null;
  suggestion: string | null;
};

const FIXED_LABELS: Record<string, string> = { Equal: "+", Minus: "−" };

/**
 * Settings → Shortcuts (K2, docs/NOTEBOOKS_K.md §11.4): every notebook shortcut, a key recorder
 * that refuses anything over two keys ("Neb shortcuts are two keys max"), clashes with the
 * browser, Windows, input methods and Neb's other shortcuts (with a free one suggested), and Reset
 * to defaults. The student's own bindings are saved with their other settings.
 */
export function ShortcutsSection() {
  const keys = useShortcutKeys();
  const { platform, own } = keys;
  const [recording, setRecording] = useState<Recording | null>(null);

  const save = (next: ShortcutBindings) => void useSettings.getState().update({ shortcuts: next });
  const bind = (action: ShortcutAction, binding: string) => {
    const rest = Object.fromEntries(
      Object.entries(own).filter(([other]) => other !== action),
    ) as ShortcutBindings;
    // Choosing the default again just forgets the student's own.
    const isDefault = defaultBindings(action, platform)[0] === binding;
    save(isDefault ? rest : { ...rest, [action]: binding });
    setRecording(null);
  };

  const onRecordKey = (action: ShortcutAction, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey) return; // keep moving around
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      setRecording(null);
      return;
    }
    const recorded = recordKey(event.nativeEvent);
    const show = (problem: string, suggestion: string | null = null) =>
      setRecording({ action, pending: null, problem, suggestion });
    switch (recorded.kind) {
      case "pending":
        setRecording({
          action,
          pending: recorded.modifier,
          problem: null,
          suggestion: null,
        });
        return;
      case "too_many":
        return show("Neb shortcuts are two keys max.");
      case "shift":
        return show("Shift types capitals, so Neb doesn't use it. Try Ctrl or Alt.");
      case "unsupported":
        return show("That key can't be a shortcut.");
      case "binding": {
        const check = checkBinding(recorded.binding, action, platform, own);
        if (check.ok) bind(action, recorded.binding);
        else show(check.reason, check.suggestion);
      }
    }
  };

  return (
    <Section title="Shortcuts">
      <div id="shortcuts" className="space-y-6">
        <p className="text-sm text-muted">
          Every Neb shortcut is two keys at most. Single keys only work in the notebook when
          you&apos;re not typing in a box.
        </p>

        <table className="w-full text-sm">
          <caption className="sr-only">Notebook shortcuts</caption>
          <tbody>
            {SHORTCUT_ACTIONS.map((action) => {
              const current = bindingsFor(action, platform, own);
              const mine = own[action] !== undefined;
              const isRecording = recording?.action === action;
              return (
                <tr key={action} className="border-t border-line align-top">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {SHORTCUT_LABELS[action]}
                  </th>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {current.map((binding) => (
                      <kbd key={binding} className="mr-1">
                        {formatBinding(binding)}
                      </kbd>
                    ))}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button
                      type="button"
                      data-testid={`record-${action}`}
                      aria-label={`Change the shortcut for ${SHORTCUT_LABELS[action]}`}
                      aria-pressed={isRecording}
                      onClick={() =>
                        setRecording(
                          isRecording
                            ? null
                            : { action, pending: null, problem: null, suggestion: null },
                        )
                      }
                      onKeyDown={(event) => isRecording && onRecordKey(action, event)}
                      onKeyUp={() =>
                        isRecording &&
                        recording.pending &&
                        setRecording({ ...recording, pending: null })
                      }
                      onBlur={() => isRecording && !recording.problem && setRecording(null)}
                      className="rounded-full border border-line px-3 py-1 hover:border-ink aria-pressed:border-ink"
                    >
                      {isRecording
                        ? recording.pending
                          ? `${recording.pending} + …`
                          : "Press keys…"
                        : "Change"}
                    </button>
                    {mine && !isRecording && (
                      <button
                        type="button"
                        className="ml-2 text-muted underline"
                        onClick={() => bind(action, defaultBindings(action, platform)[0] ?? "")}
                      >
                        Default
                      </button>
                    )}
                    {isRecording && recording.problem && (
                      <p role="alert" className="mt-1 text-right whitespace-normal text-muted">
                        {recording.problem}
                        {recording.suggestion && (
                          <>
                            {" "}
                            <button
                              type="button"
                              className="font-medium underline"
                              onClick={() => bind(action, recording.suggestion as string)}
                            >
                              Use {formatBinding(recording.suggestion)}
                            </button>
                          </>
                        )}
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <button
          type="button"
          onClick={() => {
            setRecording(null);
            save({});
          }}
          disabled={Object.keys(own).length === 0}
          className="rounded-full border border-line px-4 py-1.5 text-sm hover:border-ink disabled:opacity-50"
        >
          Reset to defaults
        </button>

        <div>
          <h3 className="font-medium">Always the same</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {Object.entries(FIXED_KEYS).map(([key, label]) => (
              <li key={key}>
                <kbd>{FIXED_LABELS[key] ?? formatBinding(key)}</kbd> {label}
              </li>
            ))}
            <li>
              <kbd>Ctrl+Alt</kbd> held: talk to Neb, let go to ask
            </li>
          </ul>
        </div>

        <div>
          <h3 className="font-medium">In the desktop app, anywhere on your PC</h3>
          <ul className="mt-2 space-y-1 text-sm">
            <li>
              <kbd>Ctrl+Alt</kbd> held: circle with the mouse, pen or finger and talk at the same
              time; let go to ask
            </li>
            <li>
              <kbd>Ctrl+Alt</kbd> twice: draw mode on or off (for pen and touch)
            </li>
            <li>
              <kbd>Esc</kbd>: stop (only while Neb is showing something)
            </li>
            <li>
              In the ask bar: <kbd>Enter</kbd> ask, <kbd>Ctrl+S</kbd> save without an explanation,{" "}
              <kbd>→</kbd> <kbd>←</kbd> next step and repeat, <kbd>Space</kbd> pause
            </li>
          </ul>
          <p className="mt-2 text-sm text-muted">
            Only left Ctrl and left Alt count, after a moment with no other key, so typing with
            AltGr (@, €, {"{"}) never starts Neb.
          </p>
        </div>
      </div>
    </Section>
  );
}
