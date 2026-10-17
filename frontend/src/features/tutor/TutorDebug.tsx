"use client";

import { type Turn, type TurnTimings, useTutor } from "./store";

/** Tutor settings and recent turns with per-stage latency, for the debug panel. */
export function TutorDebug() {
  const { answerStyle, captions, turns, setSettings } = useTutor();

  return (
    <section aria-label="Tutor">
      <h3 className="mb-2 text-xs tracking-wide text-ink-muted uppercase">Tutor</h3>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">Answer style</legend>
          {(["hints_first", "direct"] as const).map((style) => (
            <label key={style} className="flex items-center gap-1">
              <input
                type="radio"
                name="answer-style"
                checked={answerStyle === style}
                onChange={() => setSettings({ answerStyle: style })}
                className="accent-(--accent)"
              />
              {style === "hints_first" ? "Hints first" : "Direct answers"}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={captions}
            onChange={(e) => setSettings({ captions: e.target.checked })}
            className="accent-(--accent)"
          />
          Captions
        </label>
      </div>

      {turns.length > 0 && (
        <ol className="mt-3 space-y-2" data-testid="tutor-turns">
          {turns.slice(0, 5).map((turn) => (
            <TurnRow key={turn.id} turn={turn} />
          ))}
        </ol>
      )}
    </section>
  );
}

function TurnRow({ turn }: { turn: Turn }) {
  return (
    <li className="rounded-lg border border-rule bg-paper p-2" data-outcome={turn.outcome}>
      <div className="flex justify-between gap-2 text-xs text-ink-muted">
        <span>
          {turn.intent} · {turn.outcome}
        </span>
        <Timings timings={turn.timings} />
      </div>
      {turn.speech && <p className="mt-1">{turn.speech}</p>}
      {turn.actions.length > 0 && (
        <details className="mt-1 text-xs text-ink-muted">
          <summary>
            {turn.actions.length} board action{turn.actions.length === 1 ? "" : "s"} (drawn from M4)
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(turn.actions, null, 1)}
          </pre>
        </details>
      )}
    </li>
  );
}

/** "gate 210 · speech 930 · audio 1180 ms" — each measured from the trigger. */
function Timings({ timings }: { timings: TurnTimings }) {
  const parts = [
    ["gate", timings.gateMs],
    ["speech", timings.tutorSpeechMs],
    ["audio", timings.firstAudioMs],
  ].filter((p): p is [string, number] => typeof p[1] === "number");
  return (
    <span className="tabular-nums" title="Milliseconds from the trigger">
      {parts.map(([k, v]) => `${k} ${v}`).join(" · ")} ms
    </span>
  );
}
