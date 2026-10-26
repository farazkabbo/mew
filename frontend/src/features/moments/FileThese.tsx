"use client";

import type { MomentSuggestion } from "@mew/shared";
import { Check, FolderInput, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { momentsApi } from "./api";
import type { Moment } from "./moments";

type Props = {
  /** The moments waiting in Unsorted, newest first. */
  moments: readonly Moment[];
  /** Is this place still in the student's tree on this device? */
  isLive(nodeId: string): boolean;
  /** Files one moment there (moves its entry, then tells the server). */
  onFile(moment: Moment, nodeId: string): Promise<void>;
  /** "Choose…": the place picker, for one with no suggestion (or a different place). */
  onChoose(moment: Moment): void;
};

/** Moments offered at once (the server suggests for 30 a call). */
const SHOWN = 30;

type Row = { suggestion: MomentSuggestion | null; state: "idle" | "filing" | "filed" | "failed" };

/**
 * Unsorted's batch tidy (K8 §4.6): "File these", with a suggested place for each waiting moment
 * (from the same filing as when it was saved, minus Unsorted), accepted one by one or all at
 * once. A moment with no suggestion is filed with "Choose…". Never makes a notebook.
 */
export function FileThese({ moments, isLive, onFile, onChoose }: Props) {
  const [rows, setRows] = useState<ReadonlyMap<string, Row>>(new Map());
  /** The moments the suggestions were asked for (they're being found until it's these). */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const clipIds = moments
    .slice(0, SHOWN)
    .map((m) => m.clipId)
    .join(",");

  useEffect(() => {
    if (!clipIds) return;
    let live = true;
    momentsApi
      .suggestions(clipIds.split(","))
      .then(({ suggestions }) => {
        if (!live) return;
        setRows(
          new Map(suggestions.map((s) => [s.clipId, { suggestion: s, state: "idle" as const }])),
        );
      })
      .catch(() => undefined) // offline: "Choose…" still works
      .finally(() => live && setLoadedFor(clipIds));
    return () => {
      live = false;
    };
  }, [clipIds]);

  if (moments.length === 0) return null;
  const loading = loadedFor !== clipIds;

  const placeOf = (moment: Moment) => {
    const suggestion = rows.get(moment.clipId)?.suggestion;
    return suggestion?.nodeId && suggestion.path && isLive(suggestion.nodeId)
      ? { nodeId: suggestion.nodeId, path: suggestion.path, matched: suggestion.matched ?? null }
      : null;
  };
  const file = async (moment: Moment) => {
    const place = placeOf(moment);
    if (!place) return;
    const set = (state: Row["state"]) =>
      setRows((now) => {
        const next = new Map(now);
        next.set(moment.clipId, { suggestion: now.get(moment.clipId)?.suggestion ?? null, state });
        return next;
      });
    set("filing");
    try {
      await onFile(moment, place.nodeId);
      set("filed");
    } catch {
      set("failed");
    }
  };
  const ready = moments.filter((m) => placeOf(m) && rows.get(m.clipId)?.state === "idle");

  return (
    <section
      aria-labelledby="file-these-heading"
      data-testid="file-these"
      className="flex flex-col gap-3 rounded-2xl border border-rule bg-paper-raised p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="file-these-heading" className="font-serif text-xl">
          File these
        </h2>
        {loading ? (
          <span role="status" className="flex items-center gap-2 text-sm text-ink-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Finding places…
          </span>
        ) : (
          ready.length > 1 && (
            <button
              type="button"
              onClick={() => {
                // One at a time: each move is its own transaction on the device.
                void ready.reduce((done, m) => done.then(() => file(m)), Promise.resolve());
              }}
              className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-paper"
            >
              File all {ready.length}
            </button>
          )
        )}
      </div>
      <ul className="flex flex-col divide-y divide-rule">
        {moments.slice(0, SHOWN).map((moment) => {
          const place = placeOf(moment);
          const state = rows.get(moment.clipId)?.state ?? "idle";
          return (
            <li
              key={moment.imageId}
              data-testid="file-these-row"
              className="flex items-center gap-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{moment.question}</span>
                <span className="block truncate text-xs text-ink-muted">
                  {state === "filed" && place
                    ? `Filed in ${place.path.join(" › ")}`
                    : state === "failed"
                      ? "Couldn't file this one. Try again, or choose a place."
                      : place
                        ? `${place.path.join(" › ")}${place.matched ? ` · matched “${place.matched}”` : ""}`
                        : loading
                          ? " "
                          : "No suggestion"}
                </span>
              </span>
              {state === "filed" ? (
                <Check className="size-4 text-check" aria-label="Filed" />
              ) : (
                <>
                  {place && (
                    <button
                      type="button"
                      disabled={state === "filing"}
                      onClick={() => void file(moment)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-rule px-3 py-1 text-sm hover:border-accent disabled:opacity-60"
                    >
                      <FolderInput className="size-3.5" aria-hidden />
                      File
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={state === "filing"}
                    onClick={() => onChoose(moment)}
                    className="rounded-full px-3 py-1 text-sm text-ink-muted hover:text-ink"
                  >
                    Choose…
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
