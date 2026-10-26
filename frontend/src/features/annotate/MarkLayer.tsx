"use client";

import type { Annotation } from "@mew/shared";
import { type RefObject, useEffect, useRef, useState } from "react";

import type { CanvasHandle } from "../notebook/canvas/NotebookCanvas";
import { useNotebookUi } from "../notebook/store";
import type { LiveAnnotator } from "./annotator";
import { useLiveMarks } from "./store";

type Props = {
  canvas: RefObject<CanvasHandle | null>;
  live: LiveAnnotator;
  /** "Why?": the tutor explains that line (Mew `answer_question`, the line as context). */
  onWhy(mark: Annotation): void;
};

const KIND_LABEL: Record<Annotation["markKind"], string> = {
  tick: "Tick",
  error: "Mark",
  missing: "Mark",
  margin: "Note",
  unsure: "Not sure what I read",
};

/**
 * Tapping a live annotation (K9 §7.1): over each mark's tick, note or "?" (never the loop round
 * the student's line, which they write on to fix it) a button opens a small menu:
 * - Why? asks the tutor about that line;
 * - Not wrong removes the mark and keeps it as a correction (it feeds the eval sets);
 * - Hide removes it;
 * - on a "?": "I read: … — right?", yes, or type what it says.
 * A layer above the page that follows the camera, like the entry notes.
 */
export function MarkLayer({ canvas, live, onWhy }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const marks = useLiveMarks((s) => s.marks);
  const pageId = useLiveMarks((s) => s.pageId);
  const hiddenHere = useNotebookUi((s) => (pageId ? s.marksHiddenOn.has(pageId) : false));
  const showTutorInk = useNotebookUi((s) => s.showTutorInk);
  const [openId, setOpenId] = useState<string | null>(null);
  const [typing, setTyping] = useState<string | null>(null);

  useEffect(() => {
    return canvas.current?.onCamera(({ x, y, zoom }) => {
      if (layer.current)
        layer.current.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
    });
  }, [canvas]);

  const shown = hiddenHere || !showTutorInk ? [] : marks.filter((m) => m.revealed && m.hitBox);
  if (shown.length === 0) return null;
  const close = () => {
    setOpenId(null);
    setTyping(null);
  };

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="mark-layer">
      <div ref={layer} className="absolute top-0 left-0 origin-top-left">
        {shown.map((mark) => {
          const [x, y, w, h] = mark.hitBox ?? [0, 0, 0, 0];
          const open = openId === mark.id;
          return (
            <div key={mark.id} className="absolute" style={{ left: x, top: y }}>
              <button
                type="button"
                data-testid="live-mark"
                data-kind={mark.markKind}
                aria-label={`${KIND_LABEL[mark.markKind]}${mark.note && mark.note !== "?" ? `: ${mark.note}` : ""}`}
                aria-expanded={open}
                onClick={() => (open ? close() : setOpenId(mark.id))}
                className="pointer-events-auto block rounded-md focus-visible:outline-2 focus-visible:outline-accent"
                style={{ width: w, height: h }}
              />
              {open && (
                <div
                  role="menu"
                  aria-label="Mark"
                  data-testid="mark-menu"
                  className="pointer-events-auto absolute top-full left-0 z-20 mt-1 flex min-w-40 flex-col rounded-xl border border-rule bg-paper-raised p-1 text-sm shadow-lg"
                  onKeyDown={(event) => event.key === "Escape" && close()}
                >
                  {mark.markKind === "unsure" ? (
                    <Unsure
                      mark={mark}
                      typing={typing === mark.id}
                      onYes={() => {
                        close();
                        void live.reread(mark.id, null);
                      }}
                      onType={() => setTyping(mark.id)}
                      onTyped={(text) => {
                        close();
                        void live.reread(mark.id, text);
                      }}
                    />
                  ) : (
                    mark.markKind !== "tick" && (
                      <MenuItem
                        onClick={() => {
                          close();
                          void live.askedWhy(mark.id).then((asked) => asked && onWhy(asked));
                        }}
                      >
                        Why?
                      </MenuItem>
                    )
                  )}
                  {mark.markKind !== "tick" && mark.markKind !== "margin" && (
                    <MenuItem
                      onClick={() => {
                        close();
                        void live.dismiss(mark.id, "not_wrong");
                      }}
                    >
                      Not wrong
                    </MenuItem>
                  )}
                  <MenuItem
                    onClick={() => {
                      close();
                      void live.dismiss(mark.id, "hidden");
                    }}
                  >
                    Hide
                  </MenuItem>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MenuItem({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="rounded-lg px-3 py-1.5 text-left hover:bg-rule/60"
    >
      {children}
    </button>
  );
}

function Unsure({
  mark,
  typing,
  onYes,
  onType,
  onTyped,
}: {
  mark: Annotation;
  typing: boolean;
  onYes(): void;
  onType(): void;
  onTyped(text: string): void;
}) {
  const [text, setText] = useState(mark.recognizedText);
  if (typing) {
    return (
      <form
        className="flex flex-col gap-1 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) onTyped(text.trim());
        }}
      >
        <label className="text-xs text-ink-muted" htmlFor={`${mark.id}-says`}>
          It says
        </label>
        <input
          id={`${mark.id}-says`}
          autoFocus
          maxLength={300}
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="rounded-lg border border-rule bg-paper px-2 py-1 outline-none focus:border-accent"
        />
        <button type="submit" className="self-end rounded-full bg-ink px-3 py-1 text-paper">
          Check it
        </button>
      </form>
    );
  }
  return (
    <>
      <p className="px-3 py-1.5 text-ink-muted" data-testid="mark-read-as">
        I read: <span className="text-ink">{mark.recognizedText || "nothing"}</span> — right?
      </p>
      <MenuItem onClick={onYes}>Yes</MenuItem>
      <MenuItem onClick={onType}>No, it says…</MenuItem>
    </>
  );
}
