"use client";

import { type MewEvent, MewEventPage, type MewLabel } from "@mew/shared";
import { Download, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { CourseShell } from "../courses/CourseShell";
import { useSettings } from "../settings/store";
import { EventCard } from "./EventCard";

const PAGE = 50;

async function fetchPage(unlabeled: boolean, before?: string): Promise<MewEvent[]> {
  const params = new URLSearchParams();
  if (unlabeled) params.set("unlabeled", "true");
  if (before) params.set("before", before);
  const response = await fetch(`/api/mew/events?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(String(response.status));
  return MewEventPage.parse(await response.json()).events;
}

/**
 * "Teach Mew" (M10): the student's kept gate decisions, to label with what Mew should have
 * done. The labels train Mew v2; they can be downloaded, and everything can be deleted.
 */
export function TeachApp() {
  const optedIn = useSettings((s) => s.settings.mew_logging_opt_in);
  const loaded = useSettings((s) => s.loaded);
  const [events, setEvents] = useState<MewEvent[] | null>(null);
  const [unlabeledOnly, setUnlabeledOnly] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback((unlabeled: boolean) => {
    fetchPage(unlabeled).then(
      (page) => {
        setEvents(page);
        setMore(page.length === PAGE);
        setError(null);
      },
      () => setError("Couldn't load Mew's decisions."),
    );
  }, []);

  useEffect(() => {
    void useSettings.getState().load();
  }, []);
  useEffect(() => reload(unlabeledOnly), [reload, unlabeledOnly]);

  const label = async (event: MewEvent, value: MewLabel | null) => {
    const previous = events;
    setEvents(
      (list) => list?.map((e) => (e.id === event.id ? { ...e, human_label: value } : e)) ?? null,
    );
    const response = await fetch(`/api/mew/events/${event.id}`, {
      method: "PATCH",
      keepalive: true, // a label set just before leaving the page still lands
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ human_label: value }),
    }).catch(() => null);
    if (!response?.ok) {
      setEvents(previous);
      setError("Couldn't save that label.");
    }
  };

  const loadMore = async () => {
    const last = events?.at(-1);
    if (!last) return;
    const page = await fetchPage(unlabeledOnly, last.created_at).catch(() => []);
    setEvents((list) => [...(list ?? []), ...page]);
    setMore(page.length === PAGE);
  };

  const deleteAll = async () => {
    if (
      !window.confirm("Delete every decision Mew kept, and their labels? This can't be undone.")
    ) {
      return;
    }
    const response = await fetch("/api/mew/events", { method: "DELETE" }).catch(() => null);
    if (response?.ok) setEvents([]);
    else setError("Couldn't delete them. Try again.");
  };

  const labelled = events?.filter((e) => e.human_label !== null).length ?? 0;

  return (
    <CourseShell
      back={{ href: "/settings", label: "Settings" }}
      title="Teach Mew"
      subtitle="Mark what Mew should have done. Your labels train a faster Mew that runs on your device."
    >
      {loaded && !optedIn && (
        <p
          role="status"
          className="mb-6 rounded-2xl border border-rule bg-paper-raised p-4 text-sm"
        >
          Mew isn&apos;t keeping new decisions. Turn on <em>Keep Mew&apos;s decisions</em> in{" "}
          <Link href="/settings" className="underline hover:text-accent">
            Settings
          </Link>{" "}
          to collect some.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={unlabeledOnly}
            onChange={(e) => setUnlabeledOnly(e.target.checked)}
            className="accent-(--accent)"
          />
          Only unlabelled
        </label>
        <div className="flex flex-wrap gap-2">
          <a
            href="/api/mew/events/export"
            download="mew-labels.jsonl"
            className="inline-flex items-center gap-1.5 rounded-full border border-rule px-3 py-1.5 hover:border-accent"
          >
            <Download className="size-4" aria-hidden />
            Download labels
          </a>
          <button
            type="button"
            onClick={() => void deleteAll()}
            className="inline-flex items-center gap-1.5 rounded-full border border-rule px-3 py-1.5 hover:border-error hover:text-error"
          >
            <Trash2 className="size-4" aria-hidden />
            Delete everything
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-error">
          {error}
        </p>
      )}
      {events === null && !error && <p className="mt-6 text-ink-muted">Loading…</p>}
      {events?.length === 0 && (
        <p className="mt-6 text-ink-muted" data-testid="teach-empty">
          Nothing here yet. Mew keeps its decisions while you study (with the setting on).
        </p>
      )}
      {events && events.length > 0 && (
        <>
          <p className="mt-6 text-sm text-ink-muted" aria-live="polite">
            {labelled} of {events.length} shown labelled · keys 1–6 label the focused decision
          </p>
          <ol className="mt-3 space-y-3">
            {events.map((event) => (
              <EventCard key={event.id} event={event} onLabel={(v) => void label(event, v)} />
            ))}
          </ol>
          {more && (
            <button
              type="button"
              onClick={() => void loadMore()}
              className="mt-4 rounded-full border border-rule px-4 py-1.5 text-sm hover:border-accent"
            >
              Load older decisions
            </button>
          )}
        </>
      )}
    </CourseShell>
  );
}
