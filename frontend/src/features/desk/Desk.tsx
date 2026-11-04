"use client";

import type { Notebook, NotebookTree } from "@mew/shared";
import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { Keys } from "@/components/ui/Keycap";
import { NebMark } from "@/components/ui/NebDot";

import { clipImageUrl } from "../moments/api";
import { type Moment, subtreeIds } from "../moments/moments";
import { COLORS } from "../notebook/tree/node-style";
import { ago } from "../notebook/tree/NodeHome";
import { DeskCover, NewNotebookCover } from "./DeskCover";
import { DeskMenu } from "./DeskMenu";
import { MomentCard } from "./MomentCard";
import { TonightCard, type TonightRow } from "./TonightCard";

export type DeskProps = {
  tree: NotebookTree<Notebook>;
  /** Unsorted (K8): where moments wait to be filed. */
  unsortedId: string;
  now: number;
  /** The student's first name, when signed in. */
  name: string | null;
  moments: readonly Moment[];
  /** Checks due now on each node, counted up the tree (K8). */
  dueCounts: ReadonlyMap<string, number>;
  /** All checks due now, anywhere. */
  dueTotal: number;
  /** What stayed per root notebook (§6.4): all of it, and this week's. */
  stayed?: ReadonlyMap<string, { count: number; week: number }>;
  /** A course's exam within two weeks, if any (its reviews come first). */
  exam: { title: string; days: number } | null;
  /** How many pages each node has (its own). */
  loadCounts(ids: readonly string[]): Promise<Map<string, number>>;
  keys: { jump: string; newNotebook: string };
  onOpen(id: string): void;
  onOpenMoment(moment: Moment): void;
  onQuickCheck(): void;
  onJump(): void;
  onNewNotebook(): void;
  onDropPdf?(nodeId: string, file: File): void;
};

/** NEB_APP_UI §5.1: "Good evening, Faraz." / "Late one, Faraz." after 11 pm. */
export function greeting(now: number, name: string | null): string {
  const hour = new Date(now).getHours();
  const who = name ? `, ${name}` : "";
  if (hour >= 23 || hour < 4) return `Late one${who}.`;
  if (hour < 12) return `Good morning${who}.`;
  if (hour < 18) return `Good afternoon${who}.`;
  return `Good evening${who}.`;
}

/**
 * The desk (docs/NEB_APP_UI.md §5.1, board 1): the student's home. Tonight's card and the Unsorted
 * tray on the left; their notebooks as covers and the latest moments on the right. A desk, not a
 * dashboard: the only number that counts is what stayed.
 */
export function Desk(props: DeskProps) {
  const { tree, unsortedId, now, moments, dueCounts } = props;
  const notebooks = tree
    .children(null)
    .filter((n) => n.id !== unsortedId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const unsortedMoments = moments.filter((m) => m.nodeId === unsortedId);
  const recent = [...moments].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);

  // Pages per notebook (their whole tree), for "5 chapters · 38 pages".
  const ids = useMemo(
    () => notebooks.flatMap((n) => [...subtreeIds(tree, n.id)]),
    [notebooks, tree],
  );
  const idsKey = ids.join(",");
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const { loadCounts } = props;
  useEffect(() => {
    let live = true;
    void loadCounts(idsKey ? idsKey.split(",") : []).then((c) => live && setCounts(c));
    return () => {
      live = false;
    };
  }, [idsKey, loadCounts]);

  /** The most recently used place in a notebook (itself, a chapter or a section). */
  const latestIn = (root: Notebook): Notebook =>
    [...subtreeIds(tree, root.id)]
      .map((id) => tree.get(id))
      .filter((n): n is Notebook => !!n && tree.isLive(n.id))
      .reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a), root);
  const placeName = (node: Notebook) =>
    tree
      .path(node.id)
      .map((n) => n.title)
      .join(" › ");
  const placeOf = (nodeId: string) => {
    const node = tree.get(nodeId);
    return node && nodeId !== unsortedId ? placeName(node) : "Unsorted";
  };

  const stayedWeek = [...(props.stayed?.values() ?? [])].reduce((sum, s) => sum + s.week, 0);

  // Tonight (§5.1): at most 3 rows, in this order.
  const rows: TonightRow[] = [];
  if (props.dueTotal > 0) {
    rows.push({
      id: "checks",
      title: `${props.dueTotal} quick ${props.dueTotal === 1 ? "check" : "checks"}`,
      detail: `from things you saved · about ${Math.max(1, props.dueTotal * 2)} min`,
      action: { label: "Start", variant: "neb", run: props.onQuickCheck },
    });
  }
  const lastUsed = notebooks.map(latestIn).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (lastUsed) {
    rows.push({
      id: "resume",
      title: placeName(lastUsed),
      detail: `you were here · ${ago(lastUsed.updatedAt, now)}`,
      action: { label: "Resume", variant: "ghost", run: () => props.onOpen(lastUsed.id) },
    });
  }
  if (unsortedMoments.length > 0) {
    rows.push({
      id: "unsorted",
      title: `${unsortedMoments.length} loose ${unsortedMoments.length === 1 ? "page" : "pages"}`,
      detail: "saved from your screen, waiting for a chapter",
      action: { label: "File", variant: "ghost", run: () => props.onOpen(unsortedId) },
    });
  }
  if (props.exam) {
    rows.push({
      id: "exam",
      title: `${props.exam.title} exam ${props.exam.days === 0 ? "today" : `in ${props.exam.days} ${props.exam.days === 1 ? "day" : "days"}`}`,
      detail: "its reviews come first",
      action: { label: "Plan", variant: "ghost", href: "/review" },
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-desk text-ink" data-testid="desk">
      <header className="flex h-[76px] shrink-0 items-center gap-6 border-b border-line px-10">
        <Link href="/desk" className="flex items-center gap-2.5" aria-label="neb, your desk">
          <NebMark className="h-[26px] w-[34px]" stroke="var(--neb)" />
          <Wordmark />
        </Link>
        <h1
          className="ml-6 truncate font-serif text-[30px] leading-none whitespace-nowrap"
          suppressHydrationWarning
        >
          {greeting(now, props.name)}
        </h1>
        <div className="flex-1" />
        <button
          type="button"
          onClick={props.onJump}
          className="hidden h-11 w-[340px] shrink-0 items-center gap-2.5 rounded-full whitespace-nowrap border border-line bg-paper px-3.5 text-sm text-muted transition-colors duration-[120ms] hover:border-ink/40 md:flex"
          title={`Jump to any page or moment (${props.keys.jump}) · or say “open physics chapter 3”`}
          data-keytip={props.keys.jump}
        >
          <Search className="size-4 shrink-0" strokeWidth={1.8} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left">Jump to any page or moment</span>
          <Keys keys={props.keys.jump.split("+")} size="md" />
        </button>
        <button
          type="button"
          onClick={props.onNewNotebook}
          className="flex h-11 shrink-0 items-center gap-2.5 rounded-full bg-ink px-3.5 text-sm font-medium whitespace-nowrap text-paper transition-opacity duration-[120ms] hover:opacity-90"
          title={`New notebook (${props.keys.newNotebook}) · or say “new notebook called chemistry”`}
          data-keytip={props.keys.newNotebook}
        >
          <Plus className="size-4" strokeWidth={2.2} aria-hidden />
          New notebook
          <span className="hidden items-center gap-1 sm:inline-flex">
            {props.keys.newNotebook.split("+").map((k) => (
              <kbd
                key={k}
                className="inline-flex h-[22px] items-center rounded-[5px] border border-b-2 border-[#55524A] bg-[#3A3833] px-1.5 text-xs font-medium text-[#F7F3EA]"
              >
                {k}
              </kbd>
            ))}
          </span>
        </button>
        <DeskMenu name={props.name} />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-10 overflow-y-auto px-10 py-8 md:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-6">
          <TonightCard rows={rows.slice(0, 3)} stayedWeek={stayedWeek} />
          <UnsortedTray moments={unsortedMoments} onOpen={() => props.onOpen(unsortedId)} />
        </aside>

        <main className="flex min-w-0 flex-col gap-7">
          {notebooks.length === 0 ? (
            <EmptyDesk onNew={props.onNewNotebook} />
          ) : (
            <section aria-labelledby="desk-notebooks">
              <SectionTitle
                id="desk-notebooks"
                title="Your notebooks"
                note="tap one to open where you left off"
              />
              <ul className="flex flex-wrap items-start gap-[30px]">
                {notebooks.map((root) => {
                  const latest = latestIn(root);
                  const chapters = tree.children(root.id);
                  const pages = [...subtreeIds(tree, root.id)].reduce(
                    (sum, id) => sum + (counts.get(id) ?? 0),
                    0,
                  );
                  const recentChapters = [...chapters]
                    .sort((a, b) => b.updatedAt - a.updatedAt)
                    .slice(0, 3);
                  return (
                    <li key={root.id}>
                      <DeskCover
                        name={root.title}
                        color={COLORS[root.color ?? "slate"].hex}
                        meta={`${chapters.length} ${chapters.length === 1 ? "chapter" : "chapters"} · ${pages} ${pages === 1 ? "page" : "pages"}`}
                        tabs={recentChapters.length}
                        due={dueCounts.get(root.id) ?? 0}
                        stayed={props.stayed?.get(root.id)?.count ?? 0}
                        last={
                          latest.id === root.id
                            ? ago(root.updatedAt, now)
                            : `${latest.title} · ${ago(latest.updatedAt, now)}`
                        }
                        onOpen={() => props.onOpen(latest.id)}
                        {...(props.onDropPdf && {
                          onDropPdf: (file: File) => props.onDropPdf?.(root.id, file),
                        })}
                      />
                    </li>
                  );
                })}
                <li>
                  <NewNotebookCover onNew={props.onNewNotebook} />
                </li>
              </ul>
            </section>
          )}

          <section aria-labelledby="desk-moments" className="min-w-0">
            <SectionTitle
              id="desk-moments"
              title="Recent moments"
              note="every time neb explained something, saved where it belongs"
            />
            {recent.length === 0 ? (
              <p className="text-sm text-muted">
                Nothing saved yet. Hold Ctrl Alt and circle anything on your screen to ask neb.
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 xl:grid-cols-3">
                {recent.map((moment) => (
                  <li key={moment.imageId}>
                    <MomentCard
                      moment={moment}
                      where={`${placeOf(moment.nodeId)} · ${ago(moment.createdAt, now)}`}
                      image={clipImageUrl(moment.clipId)}
                      onOpen={() => props.onOpenMoment(moment)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function SectionTitle({ id, title, note }: { id: string; title: string; note: string }) {
  return (
    <div className="mb-[18px] flex flex-wrap items-baseline gap-3.5">
      <h2 id={id} className="font-serif text-[28px] leading-none">
        {title}
      </h2>
      <span className="text-[13px] text-muted">{note}</span>
    </div>
  );
}

/** The neb wordmark (board 1). */
export function Wordmark() {
  return (
    <svg width="58" height="22" viewBox="0 0 256 96" role="img" aria-label="neb">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 86 V58 C10 40 22 30 38 30 C54 30 66 40 66 58 V86" />
        <path d="M101 58 H155 A27 27 0 1 0 147 77" />
        <path d="M190 8 V86" />
        <path d="M218 30 A28 28 0 1 1 217.99 30" />
      </g>
    </svg>
  );
}

/** §5.1: a shallow inset tray with up to 3 fanned pages; tap to file them. */
function UnsortedTray({ moments, onOpen }: { moments: readonly Moment[]; onOpen(): void }) {
  const fan = moments.slice(0, 3);
  const turns = ["-rotate-[7deg]", "rotate-[3deg]", "rotate-[9deg]"];
  const lefts = ["left-[34px]", "left-[96px]", "left-[150px]"];
  return (
    <section className="flex flex-col gap-3" aria-labelledby="desk-unsorted">
      <h2
        id="desk-unsorted"
        className="text-xs font-semibold tracking-[0.1em] text-muted uppercase"
      >
        Unsorted tray
      </h2>
      <button
        type="button"
        onClick={onOpen}
        disabled={fan.length === 0}
        aria-label={
          fan.length === 0
            ? "The unsorted tray is empty"
            : `File ${moments.length} loose ${moments.length === 1 ? "page" : "pages"}`
        }
        className="relative h-[230px] overflow-hidden rounded-[10px] bg-[color-mix(in_srgb,var(--desk)_92%,var(--ink))] shadow-[inset_0_3px_8px_#00000018] disabled:cursor-default"
      >
        {fan.length === 0 && (
          <span className="absolute inset-0 grid place-items-center text-sm text-muted">
            nothing loose
          </span>
        )}
        {fan.map((m, i) => (
          <span
            key={m.imageId}
            className={`absolute top-6 h-[150px] w-[120px] overflow-hidden bg-paper-hi p-2 shadow-[0_4px_10px_#0002] ${turns[i]} ${lefts[i]}`}
          >
            {/* The clip itself, as small as a page in a tray. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={clipImageUrl(m.clipId)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover object-top"
            />
          </span>
        ))}
        {fan.length > 0 && (
          <span className="neb-voice absolute bottom-3 left-[150px] rounded-[10px] bg-neb px-2 py-1 text-xs text-white normal-case">
            file {moments.length === 1 ? "it" : "them"} →
          </span>
        )}
      </button>
    </section>
  );
}

/** First run (§5.1): one dashed cover in the middle. */
function EmptyDesk({ onNew }: { onNew(): void }): ReactNode {
  return (
    <div className="grid min-h-[320px] place-items-center" data-testid="desk-empty">
      <NewNotebookCover onNew={onNew} first />
    </div>
  );
}
