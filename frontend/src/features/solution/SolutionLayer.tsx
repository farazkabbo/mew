"use client";

import { type RefObject, useEffect, useRef } from "react";

import type { CanvasHandle } from "../notebook/canvas/NotebookCanvas";
import type { ShowThenYou } from "./flow";
import type { SolutionRecords } from "./record";
import { useShowThenYou } from "./store";

type Props = {
  canvas: RefObject<CanvasHandle | null>;
  pageId: string;
  flow: ShowThenYou;
  records: SolutionRecords;
  /** How the check shortcut is shown (Alt+C, or the student's own). */
  checkShortcut: string | null;
};

/**
 * Show-then-You on the page (K6 §6.1): each folded solution as a "Solution · tap to peek" tab at
 * its place (following the camera, like Notes Check's marks), and the Your Turn's controls.
 */
export function SolutionLayer({ canvas, pageId, flow, records, checkShortcut }: Props) {
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
                className="pointer-events-auto absolute rounded-full border border-line bg-paper-hi px-3 py-1 text-sm whitespace-nowrap text-ink shadow-sm"
                style={{ left: x, top: y - 34 }}
              >
                {open ? "Solution · tap to fold" : "Solution · tap to peek"}
              </button>
            );
          })}
        </div>
      </div>
      <YourTurnPanel flow={flow} checkShortcut={checkShortcut} />
    </>
  );
}

function YourTurnPanel({ flow, checkShortcut }: Pick<Props, "flow" | "checkShortcut">) {
  const phase = useShowThenYou((s) => s.phase);
  const offerHint = useShowThenYou((s) => s.offerHint);
  const finished = useShowThenYou((s) => s.finished);
  const offerSolution = useShowThenYou((s) => s.offerSolution);
  const offering = phase === "idle" && offerSolution;
  if ((phase === "idle" && !offering) || phase === "showing") return null;
  const button =
    "rounded-full px-3 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2";
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-24 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        data-testid="your-turn-panel"
        className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-2xl bg-ink px-4 py-2 text-sm text-paper shadow-lg"
      >
        {offering && (
          <>
            <span>Stuck on this one? I can show you every step, then give you one to try.</span>
            <button
              type="button"
              data-testid="offer-solution"
              className={`${button} bg-paper text-ink`}
              onClick={() => void flow.acceptOffer()}
            >
              Show me
            </button>
            <button
              type="button"
              className={`${button} opacity-80`}
              onClick={() => flow.declineOffer()}
            >
              Not now
            </button>
          </>
        )}
        {phase === "solving" && <span>Working it out and checking it…</span>}
        {phase === "your_turn" && (
          <>
            <span>Your turn: write your answer in the box.</span>
            <button
              type="button"
              className={`${button} bg-paper text-ink`}
              onClick={() => void flow.check({ quiet: false })}
            >
              Check{checkShortcut ? ` (${checkShortcut})` : ""}
            </button>
            {offerHint && (
              <button
                type="button"
                className={`${button} border border-paper/60`}
                onClick={() => void flow.takeHintStep()}
              >
                Hint step
              </button>
            )}
            <button
              type="button"
              className={`${button} opacity-80`}
              onClick={() => void flow.skip()}
            >
              Skip for now
            </button>
          </>
        )}
        {phase === "done" && (
          <>
            <span>{finished}</span>
            <button
              type="button"
              className={`${button} bg-paper text-ink`}
              onClick={() => void flow.oneMore()}
            >
              One more
            </button>
            <button type="button" className={`${button} opacity-80`} onClick={() => flow.back()}>
              Back to your work
            </button>
          </>
        )}
      </div>
    </div>
  );
}
