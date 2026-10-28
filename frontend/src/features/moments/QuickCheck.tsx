"use client";

import {
  type MomentCheckResult,
  type MomentCheckView,
  pickQuickCheck,
  type SavedQuizFilter,
} from "@mew/shared";
import {
  BookOpen,
  ExternalLink,
  Lightbulb,
  Loader2,
  Mic,
  PenLine,
  Play,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useId, useState } from "react";

import { buttonClass } from "@/components/ui/Button";

import { Dialog } from "../notebook/tree/Dialog";
import { clipImageUrl, momentsApi, MomentApiError } from "./api";
import { type Moment, momentDay, openSourceLink } from "./moments";
import { useMomentChecks } from "./store";
import { SpacingTimeline, timelineDots } from "./SpacingTimeline";
import { WritePad } from "./WritePad";

type Props = {
  /** This device's copy of a moment (for Open source and its date), when it has one. */
  findMoment?(clipId: string): Moment | undefined;
  /** Replay the moment's explanation (the notebook opens its page and replays it). */
  onReplay(clipId: string): void;
  /** K8: a moment's PDF is imported in neb: open it there (at the circled words' page). */
  inNeb?(moment: Moment): boolean;
  onOpenInNeb?(moment: Moment): void;
  /** Start listening, to answer out loud (the notebook's voice: what's said comes back here). */
  onListen?(): void;
};

/**
 * The Quick check (K8 §4.7): 3–5 checks, mostly from recent moments. Each question comes first,
 * without its moment (retrieval practice); the student types an answer or picks a choice, the
 * server grades it, and only then is the moment shown ("From your moment on Tue") with Replay
 * and Open source. Looking at the moment first or asking for a hint makes a right answer count as
 * `with_hint`, not `independent`.
 */
export function QuickCheck(props: Props) {
  const request = useMomentChecks((s) => s.quickCheck);
  const close = useMomentChecks((s) => s.closeQuickCheck);
  return (
    <Dialog
      open={request !== null}
      onClose={close}
      label="Quick check"
      className="fixed top-[5vh] mx-auto max-h-[90vh] w-[min(68rem,calc(100vw-2rem))] overflow-y-auto"
    >
      {request && <QuickCheckBody {...props} filter={request.filter} nodeIds={request.nodeIds} />}
    </Dialog>
  );
}

type Phase =
  | { kind: "asking" }
  | { kind: "grading" }
  | { kind: "answered"; result: MomentCheckResult }
  | { kind: "error"; text: string };

function QuickCheckBody({
  findMoment,
  onReplay,
  onListen,
  inNeb,
  onOpenInNeb,
  filter,
  nodeIds,
}: Props & { filter: SavedQuizFilter | null; nodeIds: readonly string[] | null }) {
  const ids = useId();
  const all = useMomentChecks((s) => s.checks);
  const exam = useMomentChecks((s) => s.exam);
  const answered = useMomentChecks((s) => s.answered);
  const close = useMomentChecks((s) => s.closeQuickCheck);
  // Chosen once, when it opens: answering reschedules a check, it doesn't change the set.
  const [now] = useState(() => Date.now());
  const [picked] = useState<MomentCheckView[]>(() =>
    pickQuickCheck(all ?? [], {
      now,
      since: filter?.since ?? null,
      nodeIds: nodeIds ? new Set(nodeIds) : null,
      examSoon: exam !== null,
    }),
  );
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "asking" });
  const [reply, setReply] = useState("");
  const [peeked, setPeeked] = useState(false);
  const [hinted, setHinted] = useState(false);
  const [score, setScore] = useState({ asked: 0, right: 0, stayed: 0 });
  const [writing, setWriting] = useState(false);
  // Said out loud (the notebook's voice hands it here while this is open): it's the answer.
  useEffect(
    () =>
      useMomentChecks.subscribe((state, previous) => {
        if (state.heard && state.heard !== previous.heard) {
          const said = state.heard.text.trim();
          setReply((now) => (now.trim() ? `${now.trim()} ${said}` : said).slice(0, 500));
        }
      }),
    [],
  );

  const check = picked[index];
  if (all === null) {
    return (
      <Shell onClose={close} progress={null}>
        <p role="status" className="text-sm text-muted">
          Your checks couldn&apos;t be loaded. Check your connection and try again.
        </p>
      </Shell>
    );
  }
  if (!check) {
    return (
      <Shell onClose={close} progress={null}>
        <p role="status" data-testid="quick-check-done" className="text-sm">
          {score.asked > 0
            ? `${score.asked} of ${score.asked} done · ${score.stayed} stayed today. They come back when they're due.`
            : filter?.since === "today"
              ? "Nothing you saved today has a check yet."
              : "Nothing to check right now. Save a moment from your screen and it'll come back here."}
        </p>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={close} className={PRIMARY}>
            Close
          </button>
        </div>
      </Shell>
    );
  }

  const submit = async (answer: string, dontKnow = false) => {
    const text = answer.trim();
    if (!text || phase.kind === "grading") return;
    setPhase({ kind: "grading" });
    try {
      const result = await momentsApi.answer(check.id, {
        answer: text,
        peeked,
        hinted,
        ...(dontKnow && { dontKnow }),
      });
      answered(check.id, result.nextDue);
      setScore((s) => ({
        asked: s.asked + 1,
        right: s.right + (result.correct ? 1 : 0),
        stayed: s.stayed + (result.stayed ? 1 : 0),
      }));
      setPhase({ kind: "answered", result });
    } catch (error) {
      setPhase({
        kind: "error",
        text: error instanceof MomentApiError ? error.message : "Couldn't check that just now.",
      });
    }
  };
  const next = () => {
    setWriting(false);
    setIndex((i) => i + 1);
    setPhase({ kind: "asking" });
    setReply("");
    setPeeked(false);
    setHinted(false);
  };
  const result = phase.kind === "answered" ? phase.result : null;
  const showMoment = peeked || result !== null;
  // A "quiz me on this" card (S6) has no saved moment: only the window it was about.
  const clips = [check.clipId, ...check.mergedClipIds].filter((id): id is string => id !== null);

  const firstMoment = clips[0] ? findMoment?.(clips[0]) : undefined;
  return (
    <Shell
      onClose={close}
      progress={`${index + 1} of ${picked.length}`}
      at={index}
      of={picked.length}
    >
      <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Left: the moment this check came from (§5.5), hidden until answered. */}
        <section aria-label="The saved moment" className="flex min-w-0 flex-col gap-4">
          <div className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">
            The moment this check came from
          </div>
          <div className="relative h-[270px] overflow-hidden rounded-[10px] bg-[#0F2430] shadow-sh-2">
            {clips[0] ? (
              // eslint-disable-next-line @next/next/no-img-element -- a private, signed-in image
              <img
                src={clipImageUrl(clips[0])}
                alt=""
                className={`h-full w-full object-cover transition-[filter] duration-[220ms] ${showMoment ? "" : "blur-xl"}`}
              />
            ) : (
              <div className="grid h-full place-items-center px-6 text-center text-sm text-white/80">
                {check.sourceTitle ? `From your screen: ${check.sourceTitle}` : "From your screen"}
              </div>
            )}
            {!showMoment && clips.length > 0 && (
              <button
                type="button"
                onClick={() => setPeeked(true)}
                className="absolute inset-0 grid place-items-center bg-ink/30 px-6 text-center text-[15px] font-medium text-white"
              >
                Try it first. Tap to see the moment.
              </button>
            )}
          </div>
          {showMoment && firstMoment && (
            <p className="font-serif text-[28px] leading-tight">“{firstMoment.question}”</p>
          )}
          {showMoment && clips.length === 0 && check.sourceTitle && (
            <p data-testid="quick-check-source" className="text-xs text-muted">
              From your screen: {check.sourceTitle}
            </p>
          )}
          {showMoment && clips.length > 0 && (
            <ul data-testid="quick-check-moments" className="flex flex-col gap-2">
              {clips.slice(0, SHOWN_MOMENTS).map((clipId) => (
                <MomentRow
                  key={clipId}
                  clipId={clipId}
                  moment={findMoment?.(clipId)}
                  fallbackAt={check.createdAt}
                  now={now}
                  {...(onOpenInNeb && {
                    onOpenInNeb: (moment: Moment) => {
                      close();
                      onOpenInNeb(moment);
                    },
                  })}
                  {...(inNeb && { inNeb })}
                  onReplay={() => {
                    if (!result) setPeeked(true);
                    close();
                    onReplay(clipId);
                  }}
                />
              ))}
              {clips.length > SHOWN_MOMENTS && (
                <li className="text-xs text-muted">
                  and {clips.length - SHOWN_MOMENTS} more moments about this
                </li>
              )}
            </ul>
          )}
        </section>

        {/* Right: the check on an index card (§5.5). */}
        <article
          className="flex min-w-0 flex-col rounded-[4px] px-6 pt-6 pb-5 shadow-sh-2"
          style={{
            backgroundColor: "var(--paper-hi)",
            backgroundImage:
              "linear-gradient(var(--paper-hi) 18px, var(--margin-red) 18px, var(--margin-red) 19px, transparent 19px), repeating-linear-gradient(transparent 0 33px, var(--rule) 33px 34px)",
            backgroundPosition: "0 0, 0 19px",
          }}
        >
          <p
            id={`${ids}-q`}
            data-testid="quick-check-question"
            className="mt-3 font-serif text-[32px] leading-tight"
          >
            {check.prompt}
          </p>
          {hinted && check.conceptHints.length > 0 && (
            <p className="mt-2 text-sm">
              <span className="text-muted">It&apos;s about: </span>
              {check.conceptHints.join(", ")}
            </p>
          )}

          {!result && check.kind === "mcq" && (
            <div role="group" aria-labelledby={`${ids}-q`} className="mt-4 flex flex-col gap-2">
              {check.choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  disabled={phase.kind === "grading"}
                  onClick={() => void submit(choice)}
                  className="rounded-[10px] border border-line bg-paper px-4 py-2 text-left text-sm hover:border-ink disabled:opacity-60"
                >
                  {choice}
                </button>
              ))}
            </div>
          )}
          {!result && check.kind !== "mcq" && (
            <form
              className="mt-4 flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submit(reply);
              }}
            >
              <label htmlFor={`${ids}-answer`} className="text-xs font-medium text-muted">
                Your answer
              </label>
              <textarea
                id={`${ids}-answer`}
                data-testid="quick-check-answer"
                autoFocus
                rows={check.kind === "work" ? 3 : 2}
                maxLength={500}
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                onKeyDown={(event) => {
                  // Enter checks; Shift+Enter is a new line (for working).
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submit(reply);
                  }
                }}
                className="w-full resize-y rounded-[10px] border border-line bg-paper px-3 py-2 font-hand text-[22px] outline-none focus:border-ink"
              />
              {writing && (
                <WritePad
                  onRead={(text) =>
                    setReply((now) => (now.trim() ? `${now.trim()} ${text}` : text).slice(0, 500))
                  }
                />
              )}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {onListen && (
                  <button type="button" onClick={onListen} className={SECONDARY}>
                    <Mic className="size-3.5" aria-hidden />
                    Say it
                  </button>
                )}
                <button
                  type="button"
                  aria-pressed={writing}
                  onClick={() => setWriting((v) => !v)}
                  className={`${SECONDARY} aria-pressed:border-ink`}
                >
                  <PenLine className="size-3.5" aria-hidden />
                  Write it
                </button>
                <button
                  type="submit"
                  disabled={!reply.trim() || phase.kind === "grading"}
                  className={buttonClass("neb", { dense: true })}
                >
                  Check
                </button>
                {phase.kind === "grading" && (
                  <span role="status" className="flex items-center gap-2 text-muted">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Checking…
                  </span>
                )}
              </div>
            </form>
          )}

          {phase.kind === "error" && (
            <p role="alert" className="mt-3 text-sm text-muted">
              {phase.text}
            </p>
          )}

          {result && (
            <div role="status" data-testid="quick-check-result" className="mt-4 text-sm">
              <p className="flex items-start gap-2">
                <span
                  aria-hidden
                  className={`neb-voice text-[30px] leading-none ${result.correct ? "" : "text-muted"}`}
                >
                  {result.correct ? "✓" : "○"}
                </span>
                <span className={result.correct ? "font-medium" : "text-muted"}>
                  {result.feedback}
                </span>
              </p>
              {result.stayed && (
                <p className="neb-voice mt-2 text-[14px]">
                  that one stayed. you saved it on{" "}
                  {momentDay(Date.parse(check.createdAt), now).toLowerCase()}.
                </p>
              )}
              <p className="mt-3 rounded-[10px] border border-line bg-paper p-2.5">
                <span className="text-xs tracking-wide text-muted uppercase">Answer </span>
                {result.answerKey}
              </p>
            </div>
          )}

          <div className="mt-6">
            <SpacingTimeline
              dots={timelineDots({
                savedAt: Date.parse(check.createdAt),
                now,
                nextDue: result ? Date.parse(result.nextDue) : null,
              })}
            />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
            {!result && check.conceptHints.length > 0 && !hinted && (
              <button type="button" onClick={() => setHinted(true)} className={SECONDARY}>
                <Lightbulb className="size-3.5" aria-hidden />
                Hint
              </button>
            )}
            {!result && !peeked && clips.length > 0 && (
              <button type="button" onClick={() => setPeeked(true)} className={SECONDARY}>
                Show the moment
              </button>
            )}
            {!result && (
              <button
                type="button"
                onClick={() => void submit("I don't know yet", true)}
                disabled={phase.kind === "grading"}
                className={buttonClass("quiet", { dense: true })}
                title="That's fine: it comes back sooner."
              >
                I don&apos;t know yet
              </button>
            )}
            <span className="flex-1" />
            {result ? (
              <button
                type="button"
                autoFocus
                onClick={next}
                className={buttonClass("neb", { dense: true })}
              >
                {index + 1 < picked.length ? "Next" : "Finish"}
              </button>
            ) : (
              <button type="button" onClick={next} className="text-muted hover:text-ink">
                Skip
              </button>
            )}
          </div>
        </article>
      </div>
    </Shell>
  );
}

/** Moments a merged card shows at once (one card can gather a week of them). */
const SHOWN_MOMENTS = 3;

/** "From your moment on Tue", with its picture, Replay and Open source. */
function MomentRow({
  clipId,
  moment,
  fallbackAt,
  now,
  onReplay,
  inNeb,
  onOpenInNeb,
}: {
  clipId: string;
  moment: Moment | undefined;
  fallbackAt: string;
  now: number;
  onReplay(): void;
  inNeb?(moment: Moment): boolean;
  onOpenInNeb?(moment: Moment): void;
}) {
  const link = moment ? openSourceLink(moment.image) : null;
  return (
    <li
      data-testid="quick-check-moment"
      className="flex items-center gap-3 rounded-xl border border-line bg-paper p-2"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a private, signed-in image */}
      <img
        src={clipImageUrl(clipId)}
        alt=""
        className="h-14 w-20 shrink-0 rounded-md object-cover"
      />
      <div className="min-w-0 flex-1 text-sm">
        <p className="text-muted">
          From your moment on {momentDay(moment?.createdAt ?? Date.parse(fallbackAt), now)}
        </p>
        {moment && <p className="truncate font-medium">{moment.question}</p>}
      </div>
      <button type="button" onClick={onReplay} className={SECONDARY}>
        <Play className="size-3.5" aria-hidden />
        Replay
      </button>
      {moment && onOpenInNeb && inNeb?.(moment) && (
        <button type="button" onClick={() => onOpenInNeb(moment)} className={SECONDARY}>
          <BookOpen className="size-3.5" aria-hidden />
          Open in neb
        </button>
      )}
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer" className={SECONDARY}>
          <ExternalLink className="size-3.5" aria-hidden />
          Open source
        </a>
      )}
    </li>
  );
}

function Shell({
  onClose,
  progress,
  at = 0,
  of = 0,
  children,
}: {
  onClose(): void;
  progress: string | null;
  /** Which check this is, of how many (the progress bars). */
  at?: number;
  of?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col bg-desk p-8" data-testid="quick-check">
      <header className="mb-5 flex items-center gap-3 text-sm text-muted">
        <Sparkles className="size-4 text-neb-ink" aria-hidden />
        <span>Quick check{progress && ` · ${progress}`}</span>
        <span aria-hidden className="flex flex-1 gap-1">
          {Array.from({ length: of }, (_, i) => (
            <span key={i} className={`h-1 w-8 rounded-full ${i <= at ? "bg-neb" : "bg-line"}`} />
          ))}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the quick check"
          className="grid size-7 place-items-center rounded-md hover:bg-ink/5 hover:text-ink"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>
      {children}
    </div>
  );
}

const SECONDARY =
  "inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 hover:border-ink";
const PRIMARY =
  "rounded-full bg-ink px-4 py-1.5 font-medium text-paper disabled:cursor-not-allowed disabled:opacity-50";
