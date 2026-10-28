"use client";

import { MEW_LABEL_NAMES, type MewEvent, MewLabel } from "@mew/shared";
import { Check } from "lucide-react";
import type { KeyboardEvent } from "react";

const LABELS = MewLabel.options;

/** One kept decision: what Mew saw and decided, and what it should have done (keys 1–6). */
export function EventCard({
  event,
  onLabel,
}: {
  event: MewEvent;
  onLabel(label: MewLabel | null): void;
}) {
  const { input, output, human_label: label } = event;
  const signals = input.notebookSignals;
  const onKey = (e: KeyboardEvent) => {
    const index = Number(e.key) - 1;
    const chosen = LABELS[index];
    if (chosen && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      onLabel(chosen);
    }
  };

  return (
    <li
      tabIndex={0}
      onKeyDown={onKey}
      data-testid="mew-event"
      data-label={label ?? ""}
      aria-label={`Decision: ${input.lastUtterance || "writing pause"}`}
      className="rounded-xl border border-line bg-paper-hi p-4 outline-none focus-visible:border-ink"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {input.lastUtterance ? `“${input.lastUtterance}”` : <em>(a pause in writing)</em>}
        </p>
        <time className="text-xs text-muted" dateTime={event.created_at}>
          {new Date(event.created_at).toLocaleString()}
        </time>
      </div>
      <p className="mt-1 text-xs text-muted">
        {input.trigger.replace("_", " ")}
        {input.recentTranscript.length > 0 && ` · before: “${input.recentTranscript.at(-1)}”`}
        {signals.activeRegionText && ` · writing “${signals.activeRegionText}”`}
        {input.tutorSpokeRecently && " · tutor had just spoken"}
      </p>
      <p className="mt-2 text-sm">
        Neb decided <strong>{MEW_LABEL_NAMES[output.label]}</strong>{" "}
        <span className="text-muted">
          ({Math.round(output.confidence * 100)}%{output.source ? `, ${output.source}` : ""})
        </span>
      </p>

      <div
        role="group"
        aria-label="What should Neb have done?"
        className="mt-3 flex flex-wrap gap-1.5"
      >
        {LABELS.map((option, i) => (
          <button
            key={option}
            type="button"
            aria-pressed={label === option}
            onClick={() => onLabel(label === option ? null : option)}
            className="rounded-full border border-line px-3 py-1 text-xs hover:border-ink aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-paper"
          >
            <span className="mr-1 text-muted tabular-nums">{i + 1}</span>
            {MEW_LABEL_NAMES[option]}
          </button>
        ))}
        {label === null && (
          <button
            type="button"
            onClick={() => onLabel(output.label)}
            className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs text-neb-ink hover:underline"
          >
            <Check className="size-3.5" aria-hidden />
            Neb was right
          </button>
        )}
      </div>
    </li>
  );
}
