"use client";

import {
  type HandoffBrief,
  type HandoffMoment,
  type HandoffPlaintext,
  TTS_SAMPLE_RATE,
} from "@mew/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { isDesktop, pickUpHandoff } from "../desktop/bridge";
import { useSettings } from "../settings/store";
import { PcmStreamPlayer } from "../tutor/pcm-player";
import { openPackage } from "./crypto";

type Reply = { id: string; authorName: string; body: string; createdAt: string; mine: boolean };
type View = {
  signedIn: true;
  id: string;
  title: string;
  senderName: string;
  role: "sender" | "recipient";
  expiresAt: string;
  contentKey: string;
  replies: Reply[];
  members?: { email: string; openedAt: string | null; pickedUpAt: string | null }[] | null;
};
type Teaser = { signedIn: false; title: string };
type Segment = { momentId: string | null; text: string };
type Answer = { answer: string; citations: string[]; covered: boolean };

const SPEEDS = [1, 1.5, 2] as const;

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Something went wrong. Please try again.");
  return body as T;
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

/** A moment's picture with its marks redrawn up to `progress` (0..1). */
function Replay({
  moment,
  src,
  progress,
}: {
  moment: HandoffMoment;
  src: string;
  progress: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const all = moment.ink.flatMap((s) => s.points.map((p) => p[3]));
    const end = all.length ? Math.max(...all) : 0;
    const until = end * progress;
    for (const stroke of moment.ink) {
      const pts = stroke.points.filter((p) => p[3] <= until);
      if (pts.length < 2) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(pts[0]![0], pts[0]![1]);
      for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
  }, [moment, progress]);
  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-line bg-white">
      {/* eslint-disable-next-line @next/next/no-img-element -- a decrypted data URL */}
      <img src={src} alt={`Moment from ${moment.app}: ${moment.window}`} className="block w-full" />
      <canvas
        ref={canvas}
        width={moment.width}
        height={moment.height}
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden
      />
    </div>
  );
}

function BriefPanel({ brief, onMoment }: { brief: HandoffBrief; onMoment: (id: string) => void }) {
  const cite = (id?: string) =>
    id ? (
      <button type="button" className="ml-1 text-sm underline" onClick={() => onMoment(id)}>
        see {id}
      </button>
    ) : null;
  return (
    <section aria-labelledby="brief" className="space-y-3">
      <h2 id="brief" className="font-serif text-2xl">
        {brief.title}
      </h2>
      {brief.where && (
        <p>
          <strong>Where:</strong> {brief.where}
        </p>
      )}
      {brief.goal && (
        <p>
          <strong>Goal:</strong> {brief.goal}
        </p>
      )}
      {brief.tried.length > 0 && (
        <div>
          <h3 className="font-medium">Tried</h3>
          <ol className="list-decimal pl-5">
            {brief.tried.map((t, i) => (
              <li key={i}>
                {t.text}
                {cite(t.momentId)}
              </li>
            ))}
          </ol>
        </div>
      )}
      {brief.blockers.length > 0 && (
        <div>
          <h3 className="font-medium">Blocked by</h3>
          <ul className="list-disc pl-5">
            {brief.blockers.map((t, i) => (
              <li key={i}>
                {t.text}
                {cite(t.momentId)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {brief.next.length > 0 && (
        <div>
          <h3 className="font-medium">Next</h3>
          <ol className="list-decimal pl-5">
            {brief.next.map((n, i) => (
              <li key={i}>
                {n.text}
                {n.kind === "command" && n.target && (
                  <span className="ml-2 inline-flex items-center gap-2">
                    <code className="rounded bg-black/5 px-1">{n.target}</code>
                    <button
                      type="button"
                      className="text-sm underline"
                      onClick={() => void navigator.clipboard.writeText(n.target!)}
                    >
                      Copy
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ol>
          <p className="text-sm text-muted">
            Commands are never run for you: copy them and run them yourself.
          </p>
        </div>
      )}
      {brief.openQuestions.length > 0 && (
        <div>
          <h3 className="font-medium">Open questions</h3>
          <ul className="list-disc pl-5">
            {brief.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function HandoffViewer({ id }: { id: string }) {
  const [view, setView] = useState<View | Teaser | null>(null);
  const [plain, setPlain] = useState<HandoffPlaintext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [progress, setProgress] = useState(1);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [caption, setCaption] = useState<string>("");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<({ q: string } & Answer)[]>([]);
  const [reply, setReply] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const player = useRef<PcmStreamPlayer | null>(null);
  const stop = useRef(false);
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const v = await json<View | Teaser>(
          await fetch(`/api/handoff/${id}`, { cache: "no-store" }),
        );
        if (cancelled) return;
        setView(v);
        if (!v.signedIn) return;
        const bytes = await (
          await fetch(`/api/handoff/${id}/package`, { cache: "no-store" })
        ).arrayBuffer();
        const opened = await openPackage(bytes, v.contentKey);
        if (cancelled) return;
        setPlain(opened);
        setCurrent(opened.manifest.moments[0]?.id ?? null);
        if (v.role === "recipient") void post(`/api/handoff/${id}/events`, { type: "opened" });
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "This handoff couldn't be opened.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const show = useCallback((momentId: string) => {
    setCurrent(momentId);
    setProgress(0);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, ((now - start) / 1200) * speedRef.current);
      setProgress(t);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  const speak = useCallback(async (text: string) => {
    const { voice_id, language } = useSettings.getState().settings;
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voiceId: voice_id, language }),
      cache: "no-store",
    }).catch(() => null);
    if (response?.ok && response.body) {
      player.current ??= new PcmStreamPlayer();
      await player.current.play(response.body, { sampleRate: TTS_SAMPLE_RATE });
    } else {
      // No voice: the caption alone, at reading pace.
      await new Promise((r) => setTimeout(r, (text.split(" ").length * 330) / speedRef.current));
    }
  }, []);

  const play = useCallback(
    async (from = 0) => {
      if (!plain) return;
      setPlaying(true);
      stop.current = false;
      try {
        let segs = segments;
        if (!segs) {
          const language = useSettings.getState().settings.language;
          const made = await json<{ segments: Segment[] }>(
            await post(`/api/handoff/${id}/walkthrough`, { language }),
          );
          segs = made.segments;
          setSegments(segs);
        }
        for (const seg of segs.slice(from)) {
          if (stop.current) break;
          if (seg.momentId) show(seg.momentId);
          setCaption(seg.text);
          await speak(seg.text);
        }
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "The walkthrough couldn't play.");
      } finally {
        setPlaying(false);
      }
    },
    [id, plain, segments, show, speak],
  );

  const pause = () => {
    stop.current = true;
    player.current?.stop();
    setPlaying(false);
  };

  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    setQuestion("");
    try {
      const language = useSettings.getState().settings.language;
      const a = await json<Answer>(await post(`/api/handoff/${id}/ask`, { question: q, language }));
      setAnswers((list) => [...list, { q, ...a }]);
      if (!a.covered) setReply(`About "${q}": `);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Couldn't ask that just now.");
    }
  };

  const sendReply = async () => {
    const body = reply.trim();
    if (!body || !view?.signedIn) return;
    try {
      const r = await json<Reply>(await post(`/api/handoff/${id}/reply`, { body }));
      setView({ ...view, replies: [...view.replies, r] });
      setReply("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Couldn't send that.");
    }
  };

  const revoke = async () => {
    if (
      !window.confirm(
        "Revoke this handoff? The link stops working at once and the package is deleted.",
      )
    )
      return;
    const r = await post(`/api/handoff/${id}/revoke`);
    setNotice(r.ok ? "Revoked. The link no longer works." : "Couldn't revoke it just now.");
  };

  const pickUp = async () => {
    try {
      await pickUpHandoff(id);
      void post(`/api/handoff/${id}/events`, { type: "picked_up" });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Couldn't pick up from here.");
    }
  };

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="font-serif text-3xl">Handoff</h1>
        <p className="mt-4" role="alert">
          {error}
        </p>
      </main>
    );
  }
  if (!view)
    return (
      <main className="mx-auto max-w-2xl px-6 py-16" aria-busy>
        Opening the handoff…
      </main>
    );
  if (!view.signedIn) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-sm text-muted">Handoff is being built.</p>
        <h1 className="mt-2 font-serif text-3xl">{view.title}</h1>
        <p className="mt-4">Sign in with the email it was sent to, to open it.</p>
        <Link
          className="mt-6 inline-block rounded-full bg-ink px-5 py-2 text-white"
          href={`/sign-in?redirect_url=/h/${id}`}
        >
          Sign in
        </Link>
        <p className="mt-10 text-sm text-muted">Made with neb · get it for Windows</p>
      </main>
    );
  }

  const moments = plain?.manifest.moments ?? [];
  const moment = moments.find((m) => m.id === current) ?? moments[0];
  const src = moment && plain ? `data:image/jpeg;base64,${plain.files[moment.crop] ?? ""}` : null;
  const desktop = isDesktop();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <p className="text-sm text-muted">Handoff (being built) · from {view.senderName}</p>
      <div className="mt-4 grid gap-8 lg:grid-cols-[3fr_2fr]">
        <section aria-label="Replay" className="space-y-3">
          {moment && src ? (
            <Replay moment={moment} src={src} progress={progress} />
          ) : (
            <p className="rounded-lg border border-line p-6 text-muted">
              No moments in this handoff, just the brief.
            </p>
          )}
          <p aria-live="polite" className="min-h-6">
            {caption}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {playing ? (
              <button
                type="button"
                className="rounded-full border border-line px-4 py-1.5"
                onClick={pause}
              >
                Pause
              </button>
            ) : (
              <button
                type="button"
                className="rounded-full bg-ink px-4 py-1.5 text-white"
                onClick={() => void play()}
                disabled={!plain}
              >
                Play walkthrough
              </button>
            )}
            <label className="text-sm">
              Speed{" "}
              <select
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])}
              >
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </label>
            {desktop ? (
              <button
                type="button"
                className="rounded-full border border-line px-4 py-1.5"
                onClick={() => void pickUp()}
              >
                Pick up from here
              </button>
            ) : (
              <a
                className="rounded-full border border-line px-4 py-1.5"
                href={`neb://handoff/${id}`}
              >
                Open in neb
              </a>
            )}
          </div>
          {segments && (
            <ol className="space-y-1 text-sm" aria-label="Walkthrough">
              {segments.map((s, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="text-left hover:underline"
                    onClick={() => {
                      pause();
                      void play(i);
                    }}
                  >
                    {s.text}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="flex gap-2 overflow-x-auto" aria-label="Moments">
            {moments.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => show(m.id)}
                aria-pressed={m.id === moment?.id}
                className={`shrink-0 rounded border px-2 py-1 text-sm ${m.id === moment?.id ? "border-ink" : "border-line"}`}
              >
                {m.id} · {m.app}
              </button>
            ))}
          </div>
        </section>
        <div className="space-y-8">
          {plain && <BriefPanel brief={plain.manifest.brief} onMoment={show} />}
          <section aria-labelledby="ask" className="space-y-2">
            <h2 id="ask" className="font-medium">
              Ask about this session
            </h2>
            {answers.map((a, i) => (
              <div key={i} className="rounded border border-line p-3">
                <p className="text-sm text-muted">{a.q}</p>
                <p>{a.answer}</p>
                {a.citations.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="mr-2 text-sm underline"
                    onClick={() => show(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void ask();
              }}
              className="flex gap-2"
            >
              <label className="sr-only" htmlFor="handoff-question">
                Your question
              </label>
              <input
                id="handoff-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                maxLength={500}
                className="flex-1 rounded border border-line px-3 py-1.5"
                placeholder="Why not just delete the duplicates?"
              />
              <button type="submit" className="rounded-full border border-line px-4">
                Ask
              </button>
            </form>
          </section>
          <section aria-labelledby="replies" className="space-y-2">
            <h2 id="replies" className="font-medium">
              Replies
            </h2>
            {view.replies.map((r) => (
              <p key={r.id}>
                <strong>{r.mine ? "You" : r.authorName}:</strong> {r.body}
              </p>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendReply();
              }}
              className="flex gap-2"
            >
              <label className="sr-only" htmlFor="handoff-reply">
                Reply to {view.senderName}
              </label>
              <input
                id="handoff-reply"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                maxLength={2000}
                className="flex-1 rounded border border-line px-3 py-1.5"
                placeholder={`Reply to ${view.senderName}`}
              />
              <button type="submit" className="rounded-full border border-line px-4">
                Send
              </button>
            </form>
          </section>
          {view.role === "sender" && (
            <section aria-labelledby="audit" className="space-y-2">
              <h2 id="audit" className="font-medium">
                Who opened it
              </h2>
              <ul className="text-sm">
                {(view.members ?? []).map((m) => (
                  <li key={m.email}>
                    {m.email}:{" "}
                    {m.openedAt
                      ? `opened ${new Date(m.openedAt).toLocaleString()}`
                      : "not opened yet"}
                    {m.pickedUpAt ? ", picked up" : ""}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="rounded-full border border-danger px-4 py-1.5 text-danger"
                onClick={() => void revoke()}
              >
                Revoke
              </button>
            </section>
          )}
          {view.role === "recipient" && (
            <p className="text-xs text-muted">
              {view.senderName} can see that you opened this, and when.
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
      </div>
    </main>
  );
}
