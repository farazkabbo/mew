"use client";

import { useState } from "react";

import type { NotebookDb } from "../notebook/db";
import { isStored, progressOf, useNotesCheck } from "./check-store";
import {
  addGapHeading,
  answerFinding,
  checkGapLine,
  dismissFinding,
  explainFinding,
  type HeadingInk,
} from "./follow-up";

/** What "My note is right" says for the student; the tutor still weighs it against the material. */
const MY_NOTE_IS_RIGHT = "I think my note is right as it is.";

type Props = {
  findingId: string;
  kind: "question" | "gap";
  question: string;
  db: NotebookDb;
  ink: HeadingInk | null;
  onClose: () => void;
};

/**
 * What a mark opens (N5, brief §2.4–2.5): the finding's question and, once the check is stored,
 * the ways to follow it up. A difference: answer it, say the note is right, or be told. A gap:
 * "Add it" writes a heading for the student to fill in, then what they wrote is checked.
 */
export function FindingCard({ findingId, kind, question, db, ink, onClose }: Props) {
  const progress = useNotesCheck((s) => progressOf(s, findingId));
  const stored = useNotesCheck((s) => isStored(s, findingId));
  const [answer, setAnswer] = useState("");
  const open = progress.status === "open";
  const actions = stored && open;

  return (
    <>
      <p>{question}</p>
      {progress.reply && (
        <p
          aria-live="polite"
          className="mt-2 rounded-lg bg-ink/5 px-2 py-1.5"
          data-testid="finding-reply"
        >
          {progress.reply}
        </p>
      )}
      {progress.busy && <p className="mt-2 text-xs text-muted">Checking…</p>}

      {actions && kind === "question" && (
        <form
          className="mt-2"
          onSubmit={(event) => {
            event.preventDefault();
            const reply = answer.trim();
            if (!reply) return;
            setAnswer("");
            void answerFinding(findingId, reply);
          }}
        >
          <label className="sr-only" htmlFor={`answer-${findingId}`}>
            Your answer
          </label>
          <input
            id={`answer-${findingId}`}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            maxLength={500}
            placeholder="Your answer"
            className="w-full rounded-md bg-ink/5 px-2 py-1 ring-1 ring-ink/10"
          />
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            <button
              type="submit"
              disabled={progress.busy || !answer.trim()}
              className="font-medium underline disabled:opacity-50"
            >
              Check my answer
            </button>
            <button
              type="button"
              disabled={progress.busy}
              className="underline disabled:opacity-50"
              onClick={() => void answerFinding(findingId, MY_NOTE_IS_RIGHT)}
            >
              My note is right
            </button>
            <button
              type="button"
              disabled={progress.busy}
              className="underline disabled:opacity-50"
              onClick={() => void explainFinding(findingId)}
            >
              Tell me
            </button>
          </div>
        </form>
      )}

      {actions && kind === "gap" && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {progress.headingWritten ? (
            <button
              type="button"
              disabled={progress.busy}
              className="font-medium underline disabled:opacity-50"
              onClick={() => void checkGapLine(findingId, db)}
            >
              Check what I wrote
            </button>
          ) : (
            ink && (
              <button
                type="button"
                disabled={progress.busy}
                className="font-medium underline disabled:opacity-50"
                onClick={() => void addGapHeading(findingId, db, ink)}
              >
                Add it
              </button>
            )
          )}
          <button
            type="button"
            disabled={progress.busy}
            className="underline disabled:opacity-50"
            onClick={() => void explainFinding(findingId)}
          >
            Tell me
          </button>
        </div>
      )}

      {open && (
        <div className="mt-2 flex gap-3 text-xs">
          {!stored && (
            <button type="button" className="font-medium underline" onClick={onClose}>
              I&apos;ll look
            </button>
          )}
          <button
            type="button"
            className="text-muted underline"
            onClick={() => {
              void dismissFinding(findingId);
              onClose();
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
