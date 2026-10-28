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
  /**
   * The kinds tapped on the page (NEB_APP_UI §4.2: only ticks; the others are the lane's note
   * cards). All of them when absent.
   */
  kinds?: ReadonlySet<Annotation["markKind"]>;
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
 * - on a "?": "I read: … — right?", yes, or type what it says;
 * - on any other mark, "neb read: …" in small grey, and Fix what neb read (K10 §8.2): typing
 *   what the line says checks it again and teaches neb the student's handwriting (§8.3).
 * A layer above the page that follows the camera, like the entry notes.
 */
export function MarkLayer({ canvas, live, onWhy, kinds }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const marks = useLiveMarks((s) => s.marks);
  const pageId = useLiveMarks((s) => s.pageId);
  const hiddenHere = useNotebookUi((s) => (pageId ? s.marksHiddenOn.has(pageId) : false));
  const showTutorInk = useNotebookUi((s) => s.showTutorInk);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    return canvas.current?.onCamera(({ x, y, zoom }) => {
      if (layer.current)
        layer.current.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
    });
  }, [canvas]);

  const shown =
    hiddenHere || !showTutorInk
      ? []
      : marks.filter((m) => m.revealed && m.hitBox && (!kinds || kinds.has(m.markKind)));
  if (shown.length === 0) return null;
  const close = () => setOpenId(null);

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
                aria-label={markLabel(mark)}
                aria-expanded={open}
                onClick={() => (open ? close() : setOpenId(mark.id))}
                className="pointer-events-auto block rounded-md focus-visible:outline-2 focus-visible:outline-ink"
                style={{ width: w, height: h }}
              />
              {open && (
                <MarkMenu mark={mark} live={live} onWhy={onWhy} onClose={() => setOpenId(null)} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A mark's menu (K9 §7.1, K10): "neb read: …" with Fix, or the "?"'s "I read: … — right?";
 * Why?, Not wrong and Hide. Shared by the page's tap targets and the neb lane's note cards.
 */
export function MarkMenu({
  mark,
  live,
  onWhy,
  onClose,
  className = "absolute top-full left-0 z-20 mt-1",
}: {
  mark: Annotation;
  live: LiveAnnotator;
  onWhy(mark: Annotation): void;
  onClose(): void;
  className?: string;
}) {
  const [typing, setTyping] = useState(false);
  const close = () => {
    setTyping(false);
    onClose();
  };
  return (
    <div
      role="menu"
      aria-label="Mark"
      data-testid="mark-menu"
      className={`pointer-events-auto flex min-w-40 flex-col rounded-xl border border-line bg-paper-hi p-1 text-sm text-ink shadow-sh-2 ${className}`}
      onKeyDown={(event) => event.key === "Escape" && close()}
      onClick={(event) => event.stopPropagation()}
    >
      {mark.markKind !== "unsure" && mark.recognizedText && (
        <ReadAs
          mark={mark}
          typing={typing}
          onType={() => setTyping(true)}
          onTyped={(text) => {
            close();
            void live.reread(mark.id, text);
          }}
        />
      )}
      {mark.markKind === "unsure" ? (
        <Unsure
          mark={mark}
          typing={typing}
          onYes={() => {
            close();
            void live.reread(mark.id, null);
          }}
          onType={() => setTyping(true)}
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
  );
}

/** The label a mark is announced with ("Mark: sign?"). */
export function markLabel(mark: Pick<Annotation, "markKind" | "note">): string {
  return `${KIND_LABEL[mark.markKind]}${mark.note && mark.note !== "?" ? `: ${mark.note}` : ""}`;
}

function MenuItem({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="rounded-lg px-3 py-1.5 text-left hover:bg-line/60"
    >
      {children}
    </button>
  );
}

/** "neb read: 3x + 7 = 19" on a mark, and the way to correct it. */
function ReadAs({
  mark,
  typing,
  onType,
  onTyped,
}: {
  mark: Annotation;
  typing: boolean;
  onType(): void;
  onTyped(text: string): void;
}) {
  if (typing) return <SaysForm mark={mark} onTyped={onTyped} />;
  return (
    <>
      <p className="px-3 pt-1.5 text-xs text-muted" data-testid="mark-neb-read">
        neb read: <span className="font-mono">{mark.recognizedText}</span>
      </p>
      <MenuItem onClick={onType}>Fix what neb read</MenuItem>
    </>
  );
}

function SaysForm({ mark, onTyped }: { mark: Annotation; onTyped(text: string): void }) {
  const [text, setText] = useState(mark.recognizedText);
  return (
    <form
      className="flex flex-col gap-1 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) onTyped(text.trim());
      }}
    >
      <label className="text-xs text-muted" htmlFor={`${mark.id}-says`}>
        It says
      </label>
      <input
        id={`${mark.id}-says`}
        autoFocus
        maxLength={300}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="rounded-lg border border-line bg-paper px-2 py-1 outline-none focus:border-ink"
      />
      <button type="submit" className="self-end rounded-full bg-ink px-3 py-1 text-paper">
        Check it
      </button>
    </form>
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
  if (typing) return <SaysForm mark={mark} onTyped={onTyped} />;
  return (
    <>
      <p className="px-3 py-1.5 text-muted" data-testid="mark-read-as">
        I read: <span className="text-ink">{mark.recognizedText || "nothing"}</span> — right?
      </p>
      <MenuItem onClick={onYes}>Yes</MenuItem>
      <MenuItem onClick={onType}>No, it says…</MenuItem>
    </>
  );
}
