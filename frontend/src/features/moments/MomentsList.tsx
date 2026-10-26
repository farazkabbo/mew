"use client";

import { AppWindow, ExternalLink, FileText, Globe, Search, Video } from "lucide-react";
import { useMemo, useState } from "react";

import { clipImageUrl } from "./api";
import { filterMoments, type Moment, momentDay, openSourceLink, type SourceKind } from "./moments";

const KINDS: { kind: SourceKind | null; label: string }[] = [
  { kind: null, label: "All" },
  { kind: "video", label: "Videos" },
  { kind: "web", label: "Web pages" },
  { kind: "pdf", label: "PDFs" },
  { kind: "app", label: "Apps" },
];

const ICON = { video: Video, web: Globe, pdf: FileText, app: AppWindow } as const;

type Props = {
  /** The moments of this node and everything under it, newest first. */
  moments: readonly Moment[];
  now: number;
  onOpen(moment: Moment): void;
  /** Where each one is ("Chapter 3"), when the list spans more than one place. */
  placeOf?(moment: Moment): string | null;
};

/**
 * A notebook's or chapter's Moments tab (K8 §4.7): every moment saved there, with its picture,
 * question, date and where it came from, searchable and filtered by kind of source. Opening one
 * shows it on its page; Open source goes back to the exact spot.
 */
export function MomentsList({ moments, now, onOpen, placeOf }: Props) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SourceKind | null>(null);
  const shown = useMemo(
    () => filterMoments(moments, { query, ...(kind && { kind }) }),
    [moments, query, kind],
  );

  if (moments.length === 0) {
    return (
      <p data-testid="moments-empty" className="text-sm text-ink-muted">
        Nothing saved here yet. Circle something on your screen and ask about it: it&apos;s kept
        here with its explanation, and Neb checks you on it later.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="moments-list">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-48 flex-1 items-center gap-2 rounded-full border border-rule bg-paper px-3 py-1.5">
          <Search className="size-4 shrink-0 text-ink-muted" aria-hidden />
          <span className="sr-only">Search moments</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search moments…"
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
        <div role="group" aria-label="Source" className="flex flex-wrap gap-1">
          {KINDS.map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={kind === option.kind}
              onClick={() => setKind(option.kind)}
              className="rounded-full px-3 py-1 text-xs text-ink-muted hover:text-ink aria-pressed:bg-ink aria-pressed:text-paper"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <ul aria-label="Moments" className="flex flex-col divide-y divide-rule">
        {shown.map((moment) => {
          const Icon = ICON[moment.kind];
          const link = openSourceLink(moment.image);
          const place = placeOf?.(moment);
          return (
            <li
              key={moment.imageId}
              data-testid="moment-row"
              className="flex items-center gap-3 py-2"
            >
              <button
                type="button"
                onClick={() => onOpen(moment)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left hover:bg-rule/40"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a private, signed-in image */}
                <img
                  src={clipImageUrl(moment.clipId)}
                  alt=""
                  loading="lazy"
                  className="h-12 w-16 shrink-0 rounded-md bg-rule/40 object-cover"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{moment.question}</span>
                  <span className="flex items-center gap-1.5 truncate text-xs text-ink-muted">
                    <Icon className="size-3.5 shrink-0" aria-label={moment.kind} />
                    <span className="truncate">{moment.sourceName}</span>
                    <span aria-hidden>·</span>
                    <span>{momentDay(moment.createdAt, now)}</span>
                    {place && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="truncate">{place}</span>
                      </>
                    )}
                  </span>
                </span>
              </button>
              {link && (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open source"
                  aria-label={`Open source: ${moment.sourceName}`}
                  className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-rule/60 hover:text-ink"
                >
                  <ExternalLink className="size-4" aria-hidden />
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && <p className="text-sm text-ink-muted">No moment matches.</p>}
    </div>
  );
}
