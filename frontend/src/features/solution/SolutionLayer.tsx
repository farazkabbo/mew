"use client";

import { type RefObject, useEffect, useRef, useState } from "react";

import { buttonClass } from "@/components/ui/Button";

import type { CanvasHandle } from "../notebook/canvas/NotebookCanvas";
import type { ShowThenYou } from "./flow";
import type { SolutionRecords } from "./record";
import { SolutionStrip } from "./SolutionStrip";
import { useShowThenYou } from "./store";

type Props = {
  canvas: RefObject<CanvasHandle | null>;
  pageId: string;
  flow: ShowThenYou;
  records: SolutionRecords;
  /** How the check shortcut is shown (Alt+C, or the student's own). */
  checkShortcut: string | null;
  /** When the student last wrote (the strip folds at the first stroke of their turn). */
  writing: number;
};

/**
 * Show-then-You on the page (K6 §6.1): each folded solution as a "Solution · tap to peek" tab at
 * its place (following the camera, like Notes Check's marks), and the Your Turn's controls.
 */
export function SolutionLayer({ canvas, pageId, flow, records, checkShortcut, writing }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const solutions = useShowThenYou((s) => s.solutions);
  const peeking = useShowThenYou((s) => s.peeking);

  useEffect(() => {
    return canvas.current?.onCamera(({ x, y, zoom }) => {
      if (layer.current)
        layer.current.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
    });
  }, [canvas]);

  useEffect(() => {
    let live = true;
    void records.forPage(pageId).then((list) => {
      if (!live) return;
      flow.load(list);
      // A worked solution saved from the screen (K7) is written the first time its page opens.
      return flow.adoptEntries();
    });
    return () => {
      live = false;
    };
  }, [records, pageId, flow]);

  const tabs = solutions.filter((s) => s.pageId === pageId && s.groupId && s.folded);
  return (
    <>
      <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="solutions">
        <div ref={layer} className="absolute top-0 left-0 origin-top-left">
          {tabs.map((solution) => {
            const open = peeking.has(solution.id);
            const [x, y] = solution.bbox;
            return (
              <button
                key={solution.id}
                type="button"
                data-testid="solution-tab"
                aria-expanded={open}
                onClick={() => void flow.peek(solution.id)}
                className="pointer-events-auto absolute rounded-full border border-neb bg-neb-wash px-3 py-1 text-sm whitespace-nowrap text-neb-ink shadow-sh-2"
                style={{ left: x, top: y - 34 }}
              >
                {open ? "Solution · tap to fold" : "Solution · tap to peek"}
              </button>
            );
          })}
        </div>
      </div>
      <YourTurnPanel flow={flow} checkShortcut={checkShortcut} writing={writing} />
    </>
  );
}

function YourTurnPanel({
  flow,
  checkShortcut,
  writing,
}: Pick<Props, "flow" | "checkShortcut"> & { writing: number }) {
  const phase = useShowThenYou((s) => s.phase);
  const offerHint = useShowThenYou((s) => s.offerHint);
  const finished = useShowThenYou((s) => s.finished);
  const offerSolution = useShowThenYou((s) => s.offerSolution);
  const solutions = useShowThenYou((s) => s.solutions);
  // The strip folds at the first stroke of the student's turn (§5.3).
  const [turnStarted, setTurnStarted] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (phase === "your_turn") setTurnStarted(Date.now());
  }, [phase]);
  const offering = phase === "idle" && offerSolution;
  if ((phase === "idle" && !offering) || phase === "showing") return null;
  const latest = [...solutions].reverse().find((s) => s.steps?.length);
  const showStrip = phase === "your_turn" && latest && writing <= turnStarted;
  const turn = [...solutions].reverse().find((s) => s.yourTurn)?.yourTurn ?? null;
  return (
    <div className="pointer-events-none absolute top-4 right-4 bottom-20 left-4 z-40 flex items-start justify-end gap-4">
      {showStrip && latest && (
        <div className="min-h-0 flex-1 self-stretch">
          <SolutionStrip solution={latest} />
        </div>
      )}
      <section
        role="status"
        aria-live="polite"
        data-testid="your-turn-panel"
        className="pointer-events-auto relative w-[300px] shrink-0 rotate-[1.5deg] rounded-[4px] bg-paper-hi px-5 pt-6 pb-4 text-ink shadow-sh-2"
        style={{
          backgroundImage: "repeating-linear-gradient(transparent 0 31px, var(--rule) 31px 32px)",
          backgroundPosition: "0 52px",
        }}
      >
        <span
          aria-hidden
          className="absolute -top-2.5 left-1/2 h-5 w-20 -translate-x-1/2 -rotate-2 bg-note/90"
        />
        {offering && (
          <>
            <p className="neb-voice text-[13px]">stuck on this one?</p>
            <p className="mt-2 text-[15px]">
              I can show you every step, then give you one to try on your own.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="offer-solution"
                className={buttonClass("neb", { dense: true })}
                onClick={() => void flow.acceptOffer()}
              >
                Show me
              </button>
              <button
                type="button"
                className={buttonClass("quiet", { dense: true })}
                onClick={() => flow.declineOffer()}
              >
                Not now
              </button>
            </div>
          </>
        )}
        {phase === "solving" && (
          <p className="neb-voice text-[13px]">working it out and checking it…</p>
        )}
        {phase === "your_turn" && (
          <>
            <p className="neb-voice text-[13px]">
              <span className="sr-only">Your turn: </span>your turn · same idea, new numbers
            </p>
            {turn && <p className="mt-2 font-serif text-[28px] leading-tight">{turn.problem}</p>}
            <p className="mt-2 font-hand text-[20px] text-muted">
              write it in the box on the page…
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={buttonClass("neb", { dense: true })}
                onClick={() => void flow.check({ quiet: false })}
                title={`Check my work${checkShortcut ? ` (${checkShortcut})` : ""} · or say “check this”`}
              >
                Check my work{checkShortcut ? ` (${checkShortcut})` : ""}
              </button>
              {offerHint && (
                <button
                  type="button"
                  className={buttonClass("quiet", { dense: true })}
                  onClick={() => void flow.takeHintStep()}
                >
                  Peek at a step
                </button>
              )}
            </div>
            <p className="mt-2 flex items-center justify-between text-xs text-muted">
              <span>{offerHint ? "a peek counts as a hint" : "the steps are on the page"}</span>
              <button type="button" className="hover:text-ink" onClick={() => void flow.skip()}>
                Skip for now
              </button>
            </p>
          </>
        )}
        {phase === "done" && (
          <>
            <p className="neb-voice text-[15px]">{finished}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={buttonClass("neb", { dense: true })}
                onClick={() => void flow.oneMore()}
              >
                One more
              </button>
              <button
                type="button"
                className={buttonClass("ghost", { dense: true })}
                onClick={() => flow.back()}
              >
                Back to your work
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
