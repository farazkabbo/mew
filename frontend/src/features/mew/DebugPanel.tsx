"use client";

import { X } from "lucide-react";
import { type FormEvent, useState } from "react";

import { useSettings } from "../settings/store";
import { TutorDebug } from "../tutor/TutorDebug";
import { useVoice } from "../voice/store";
import { type DecisionRecord, useMew } from "./store";

type Props = {
  /** Feeds typed text through the same path as a spoken utterance (testing without a mic). */
  onSimulateUtterance(text: string): void;
  onSummon(): void;
};

/** Developer view of the voice → Mew pipeline: live transcript, gate decisions, sensitivity. */
export function DebugPanel({ onSimulateUtterance, onSummon }: Props) {
  const { status, error, partial, segments, level } = useVoice();
  const { decisions, threshold, toggleDebug } = useMew();
  const [draft, setDraft] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSimulateUtterance(text);
    setDraft("");
  };

  return (
    <aside
      aria-label="Mew debug panel"
      className="pointer-events-auto flex h-full w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-rule bg-paper-raised/95 text-sm shadow-xl backdrop-blur"
    >
      <header className="flex items-center justify-between border-b border-rule px-4 py-3">
        <h2 className="font-serif text-lg">Mew debug</h2>
        <button
          aria-label="Close debug panel"
          onClick={useMew.getState().toggleDebug}
          className="rounded p-1 text-ink-muted hover:text-ink"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <section aria-label="Voice">
          <h3 className="mb-2 text-xs tracking-wide text-ink-muted uppercase">Voice</h3>
          <p>
            Status:{" "}
            <span data-testid="voice-status" className="font-medium">
              {status}
            </span>
            {error && <span className="text-error"> — {error}</span>}
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-rule" aria-hidden>
            <div
              className="h-full bg-accent transition-[width] duration-100"
              style={{ width: `${Math.min(100, level * 600)}%` }}
            />
          </div>
          <p
            className="mt-2 min-h-5 text-ink-muted italic"
            data-testid="partial-transcript"
            aria-live="polite"
          >
            {partial}
          </p>
          <ol className="mt-1 space-y-1" data-testid="transcript">
            {segments.slice(-6).map((s) => (
              <li key={s.id} className="rounded bg-paper px-2 py-1">
                {s.text}
              </li>
            ))}
          </ol>
        </section>

        <section aria-label="Simulate">
          <h3 className="mb-2 text-xs tracking-wide text-ink-muted uppercase">Simulate speech</h3>
          <form onSubmit={submit} className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type what the student says…"
              aria-label="Simulated utterance"
              maxLength={500}
              className="min-w-0 flex-1 rounded-lg border border-rule bg-paper px-2 py-1.5 outline-none focus:border-accent"
            />
            <button className="rounded-lg bg-ink px-3 text-paper">Send</button>
          </form>
          <button
            onClick={onSummon}
            className="mt-2 text-xs text-accent underline-offset-2 hover:underline"
          >
            Summon Mew (tap mascot)
          </button>
        </section>

        <TutorDebug />

        <section aria-label="Sensitivity">
          <h3 className="mb-2 text-xs tracking-wide text-ink-muted uppercase">Sensitivity</h3>
          <label className="flex items-center gap-3">
            <span className="shrink-0">Threshold</span>
            <input
              type="range"
              min={0.3}
              max={0.95}
              step={0.05}
              value={threshold}
              onChange={(e) =>
                void useSettings.getState().update({ mew_threshold: Number(e.target.value) })
              }
              className="flex-1 accent-(--accent)"
            />
            <span className="w-10 text-right tabular-nums">{threshold.toFixed(2)}</span>
          </label>
        </section>

        <section aria-label="Decisions">
          <h3 className="mb-2 text-xs tracking-wide text-ink-muted uppercase">Mew decisions</h3>
          {decisions.length === 0 ? (
            <p className="text-ink-muted">Nothing yet. Speak, write, or simulate an utterance.</p>
          ) : (
            <ol className="space-y-2" data-testid="decisions">
              {decisions.map((d) => (
                <DecisionRow key={d.id} decision={d} />
              ))}
            </ol>
          )}
        </section>
      </div>
      <footer className="border-t border-rule px-4 py-2 text-xs text-ink-muted">
        <button onClick={toggleDebug} className="hover:text-ink">
          Close
        </button>
      </footer>
    </aside>
  );
}

function DecisionRow({ decision: d }: { decision: DecisionRecord }) {
  return (
    <li className="rounded-lg border border-rule bg-paper p-2" data-label={d.output.label}>
      <div className="flex items-center justify-between gap-2">
        <span className={`font-medium ${d.acted ? "text-tutor" : "text-ink-muted"}`}>
          {d.output.label}
        </span>
        <span className="text-xs text-ink-muted tabular-nums">
          {d.output.confidence.toFixed(2)} · {d.source} · {d.roundTripMs} ms
        </span>
      </div>
      <p className="mt-1 truncate text-xs text-ink-muted" title={d.utterance}>
        [{d.trigger}] {d.utterance || "—"}
      </p>
      <p className="text-xs text-ink-muted">{d.output.reason}</p>
    </li>
  );
}
