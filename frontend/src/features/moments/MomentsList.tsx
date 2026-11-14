"use client";

import {
  AppWindow,
  BookOpen,
  ExternalLink,
  FileText,
  Globe,
  NotebookTabs,
  Play,
  Search,
  Video,
} from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";

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
const KIND_NAME = { video: "Video", web: "Web page", pdf: "PDF", app: "App" } as const;

/** Moments shown per group before "Show N more". */
const PER_GROUP = 6;

type Props = {
  /** The moments of this node and everything under it, newest first. */
  moments: readonly Moment[];
  now: number;
  onOpen(moment: Moment): void;
  /** Opens it and plays its explanation again, step by step. */
  onReplay?(moment: Moment): void;
  /** Notes Check on this moment (when its text was read). */
  onCheckNotes?(moment: Moment): void;
  /** Moments with a check due (their clip ids). */
  dueClipIds?: ReadonlySet<string>;
  /** Where each one is ("Chapter 3"), when the list spans more than one place. */
  placeOf?(moment: Moment): string | null;
  /** K8: its PDF is imported in neb: open it there, at the page of the circled words. */
  inNeb?(moment: Moment): boolean;
  onOpenInNeb?(moment: Moment): void;
  /** Where a moment's picture comes from (the clip by default; /dev/ui shows none). */
  thumbnail?(moment: Moment): string | null;
};

type Group = { key: string; title: string; meta: string; kind: SourceKind | null; items: Moment[] };

/** Moments by where they came from (the default) or by day, newest first within each. */
export function groupMoments(
  moments: readonly Moment[],
  by: "source" | "day",
  now: number,
): Group[] {
  const groups = new Map<string, Group>();
  for (const moment of moments) {
    const key =
      by === "source" ? `${moment.kind}:${moment.sourceName}` : momentDay(moment.createdAt, now);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: by === "source" ? moment.sourceName : key,
        meta: "",
        kind: by === "source" ? moment.kind : null,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(moment);
  }
  for (const group of groups.values()) {
    const count = `${group.items.length} ${group.items.length === 1 ? "moment" : "moments"}`;
    const latest = group.items[0];
    group.meta =
      by === "source" && group.kind && latest
        ? `${KIND_NAME[group.kind]} · ${count} · ${momentDay(latest.createdAt, now)}`
        : count;
  }
  return [...groups.values()];
}

/**
 * A notebook's or chapter's Moments tab (K8 §4.7; docs/NEB_APP_UI.md decision U28, board
 * Moments): every moment saved there, searchable, filtered by kind of source, grouped by source
 * (its line shown once) or by day, each a card with its picture, question, Replay, Open source
 * and Check against my notes.
 */
export function MomentsList({
  moments,
  now,
  onOpen,
  onReplay,
  onCheckNotes,
  dueClipIds,
  placeOf,
  inNeb,
  onOpenInNeb,
  thumbnail = (moment) => clipImageUrl(moment.clipId),
}: Props) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SourceKind | null>(null);
  const [by, setBy] = useState<"source" | "day">("source");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const shown = useMemo(
    () => filterMoments(moments, { query, ...(kind && { kind }) }),
    [moments, query, kind],
  );
  const counts = useMemo(() => {
    const byKind = new Map<SourceKind | null, number>([[null, moments.length]]);
    for (const m of moments) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
    return byKind;
  }, [moments]);
  const groups = useMemo(() => groupMoments(shown, by, now), [shown, by, now]);

  if (moments.length === 0) {
    return (
      <p data-testid="moments-empty" className="text-sm text-muted">
        Nothing saved here yet. Circle something on your screen and ask about it: it&apos;s kept
        here with its explanation, and neb checks you on it later.
      </p>
    );
  }

  return (
    <div className="flex flex-col" data-testid="moments-list">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative flex min-w-0 flex-[1_1_260px]">
          <span className="sr-only">Search moments</span>
          <Search
            aria-hidden
            strokeWidth={1.8}
            className="pointer-events-none absolute top-[13px] left-4 size-[18px] text-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search what you asked or saved"
            className="h-11 min-w-0 flex-1 rounded-full border border-line bg-paper-hi pr-4 pl-11 text-[15px] text-ink outline-none focus:border-ink"
          />
        </label>
        <FilterChips
          label="Source"
          options={KINDS.map((o) => ({
            id: o.kind ?? "all",
            label: o.label,
            count: counts.get(o.kind) ?? 0,
          }))}
          selected={kind ?? "all"}
          onSelect={(id) => setKind(id === "all" ? null : (id as SourceKind))}
        />
      </div>
      <div className="mt-3.5 flex items-center justify-end gap-2.5 text-[13px] text-muted">
        Group by
        <Segmented
          label="Group by"
          options={[
            { id: "source", label: "Source" },
            { id: "day", label: "Day" },
          ]}
          selected={by}
          onSelect={(id) => setBy(id as "source" | "day")}
        />
      </div>

      {groups.map((group) => {
        const Icon = group.kind ? ICON[group.kind] : NotebookTabs;
        const first = group.items[0];
        const all = open.has(group.key);
        const items = all ? group.items : group.items.slice(0, PER_GROUP);
        const more = group.items.length - items.length;
        return (
          <section key={group.key} className="mt-7" data-testid="moment-group">
            <div className="mb-3.5 flex flex-wrap items-center gap-x-3.5 gap-y-3">
              <span
                aria-hidden
                className="grid size-10 flex-none place-items-center rounded-[10px] bg-sunk"
              >
                <Icon className="size-5" strokeWidth={1.8} />
              </span>
              <div className="min-w-0 flex-[1_1_240px]">
                <h3 className="truncate text-base font-semibold">{group.title}</h3>
                <div className="text-[13px] text-muted">{group.meta}</div>
              </div>
              {first && onOpenInNeb && group.kind === "pdf" && inNeb?.(first) && (
                <button
                  type="button"
                  onClick={() => onOpenInNeb(first)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-ink px-3.5 text-[13px] font-semibold text-ink hover:bg-ink/5"
                >
                  <BookOpen className="size-3.5" strokeWidth={2} aria-hidden />
                  Open in neb
                </button>
              )}
            </div>
            <ul
              aria-label={group.title}
              className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4"
            >
              {items.map((moment) => (
                <MomentCard
                  key={moment.imageId}
                  moment={moment}
                  src={thumbnail(moment)}
                  now={now}
                  due={dueClipIds?.has(moment.clipId) ?? false}
                  place={placeOf?.(moment) ?? null}
                  onOpen={() => onOpen(moment)}
                  {...(onReplay && { onReplay: () => onReplay(moment) })}
                  {...(onCheckNotes &&
                    moment.image.ocrText && { onCheckNotes: () => onCheckNotes(moment) })}
                />
              ))}
            </ul>
            {more > 0 && (
              <button
                type="button"
                onClick={() => setOpen((s) => new Set([...s, group.key]))}
                className="mt-4 h-10 rounded-full border border-line px-[18px] text-sm font-medium text-ink hover:border-ink/40"
              >
                Show {more} more{group.kind === "pdf" ? " from this PDF" : ""}
              </button>
            )}
          </section>
        );
      })}
      {shown.length === 0 && <p className="mt-6 text-sm text-muted">No moment matches.</p>}
    </div>
  );
}

function MomentCard({
  moment,
  src,
  now,
  due,
  place,
  onOpen,
  onReplay,
  onCheckNotes,
}: {
  moment: Moment;
  src: string | null;
  now: number;
  due: boolean;
  place: string | null;
  onOpen(): void;
  onReplay?: () => void;
  onCheckNotes?: () => void;
}) {
  const link = openSourceLink(moment.image);
  const [broken, setBroken] = useState(false);
  return (
    <li
      data-testid="moment-row"
      className="flex flex-col overflow-hidden rounded-xl bg-paper-hi shadow-sh-2"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open: ${moment.question}`}
        className="relative block h-32 border-b border-line bg-[#FFFEFB]"
      >
        {src && !broken && (
          // eslint-disable-next-line @next/next/no-img-element -- a private, signed-in image
          <img
            src={src}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
            className="size-full object-cover"
          />
        )}
        {due && (
          <span className="absolute top-2.5 left-2.5 inline-flex h-6 items-center gap-1.5 rounded-full bg-neb-wash px-2.5 font-neb text-[13px] font-medium text-neb-ink lowercase">
            <span aria-hidden className="size-1.5 rounded-full bg-neb" />
            check due
          </span>
        )}
      </button>
      <div className="flex flex-1 flex-col gap-2.5 px-4 pt-3.5 pb-3">
        <button
          type="button"
          onClick={onOpen}
          className="line-clamp-3 text-left text-[15px] leading-[1.35] font-semibold text-ink"
        >
          {moment.question}
        </button>
        {place && <span className="-mt-1.5 truncate text-[13px] text-muted">{place}</span>}
        <div className="mt-auto flex items-center gap-1">
          {onReplay && (
            <button
              type="button"
              onClick={onReplay}
              className="inline-flex h-9 items-center gap-1.5 pr-2.5 pl-1 text-[13px] font-semibold text-ink"
            >
              <Play className="size-3 fill-current" aria-hidden />
              Replay
            </button>
          )}
          <span className="text-[13px] text-muted">{momentDay(moment.createdAt, now)}</span>
          <span className="flex-1" />
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open source: ${moment.sourceName}`}
              aria-label={`Open source: ${moment.sourceName}`}
              className="grid size-9 place-items-center rounded-full text-muted hover:bg-ink/5 hover:text-ink"
            >
              <ExternalLink className="size-4" strokeWidth={1.8} aria-hidden />
            </a>
          )}
          {onCheckNotes && (
            <button
              type="button"
              onClick={onCheckNotes}
              title="Check against my notes"
              aria-label="Check against my notes"
              className="grid size-9 place-items-center rounded-full text-muted hover:bg-ink/5 hover:text-ink"
            >
              <NotebookTabs className="size-4" strokeWidth={1.8} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Chips that choose one (a radio group): arrows move and choose, Home and End go to the ends.
 * Counts follow each label; a zero count is dimmed.
 */
export function FilterChips({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: readonly { id: string; label: string; count: number }[];
  selected: string;
  onSelect(id: string): void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = options.findIndex((o) => o.id === selected);
    const last = options.length - 1;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    const option = next === null ? undefined : options[next];
    if (!option) return;
    event.preventDefault();
    onSelect(option.id);
    refs.current.get(option.id)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKey} className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const on = option.id === selected;
        return (
          <button
            key={option.id}
            ref={(el) => {
              if (el) refs.current.set(option.id, el);
              else refs.current.delete(option.id);
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(option.id)}
            className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] ${on ? "border-ink bg-ink font-semibold text-paper" : `border-line font-medium ${option.count === 0 ? "text-muted" : "text-ink"} hover:border-ink/40`}`}
          >
            {option.label}
            <span className="tabular-nums opacity-65">{option.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A small two-way switch on the sunk desk tone (Group by: Source · Day). */
function Segmented({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: readonly { id: string; label: string }[];
  selected: string;
  onSelect(id: string): void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-full bg-sunk p-[3px]">
      {options.map((option) => {
        const on = option.id === selected;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onSelect(option.id)}
            className={`h-[30px] rounded-full px-3 text-[13px] ${on ? "bg-paper-hi font-semibold text-ink shadow-[0_1px_2px_rgba(30,29,26,.18)]" : "font-medium text-muted hover:text-ink"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
