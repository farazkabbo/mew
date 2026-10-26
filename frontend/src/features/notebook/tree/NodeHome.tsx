"use client";

import { type Notebook, type NotebookTree, type Page, TREE_LIMITS } from "@mew/shared";
import { FileText, FileUp, GraduationCap, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { coursesApi } from "../../courses/api";
import { useShortcutKeys } from "../../shortcuts/useShortcutKeys";
import { Breadcrumb } from "./Breadcrumb";
import { NodeIcon } from "./node-style";
import { childNoun, plural } from "./tree-labels";

type Props = {
  node: Notebook;
  tree: NotebookTree<Notebook>;
  /** Reads how many pages each node has. */
  loadCounts(ids: readonly string[]): Promise<Map<string, number>>;
  /** This node's own pages ("Loose pages"). */
  pages: readonly Page[];
  now: number;
  onOpen(id: string): void;
  onOpenPage(pageId: string): void;
  onAddChild(): void;
  onAddPage(): void;
  /** K4: "Import PDF" into this node. */
  onImportPdf(): void;
};

/**
 * A notebook's (or chapter's) home (K1, docs/NOTEBOOKS_K.md §2.2): a card per chapter with its
 * page count and when it was last edited, its own "Loose pages", and a card to add a chapter.
 */
export function NodeHome({ node, tree, loadCounts, pages, now, ...actions }: Props) {
  const keys = useShortcutKeys();
  const root = tree.path(node.id)[0] ?? node;
  const children = tree.children(node.id);
  const childIds = children.map((c) => c.id).join(",");
  const [pageCounts, setPageCounts] = useState<ReadonlyMap<string, number>>(new Map());

  useEffect(() => {
    let live = true;
    void loadCounts(childIds ? childIds.split(",") : []).then(
      (counts) => live && setPageCounts(counts),
    );
    return () => {
      live = false;
    };
  }, [childIds, loadCounts]);
  // K4 decision 8: once a PDF's topics are found, a card says so (the import never waits).
  const [topics, setTopics] = useState<"processing" | "review" | null>(null);
  const courseId = root.courseId ?? null;
  useEffect(() => {
    if (!courseId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () =>
      void coursesApi
        .get(courseId)
        .then((detail) => {
          const status = detail.course.status;
          if (!live) return;
          setTopics(status === "review" || status === "processing" ? status : null);
          // Still being read: look again shortly (the card updates on its own).
          if (status === "processing") timer = setTimeout(check, 4000);
        })
        .catch(() => undefined);
    check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [courseId]);
  const canAdd = tree.depth(node.id) < TREE_LIMITS.maxDepth;
  const noun = childNoun(tree, node.id);
  const totalPages = children.reduce((sum, c) => sum + (pageCounts.get(c.id) ?? 0), pages.length);

  return (
    <div className="h-full overflow-y-auto" data-testid="node-home">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 pt-20 pb-28">
        <header className="flex flex-col gap-3">
          <Breadcrumb tree={tree} nodeId={node.id} onOpen={actions.onOpen} />
          <div className="flex items-center gap-3">
            <NodeIcon node={root} className="size-8" />
            <h1 className="font-serif text-4xl tracking-tight">{node.title}</h1>
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
            <span>
              {plural(children.length, noun)} · {plural(totalPages, "page")}
            </span>
            {root.courseId && (
              <Link
                href={`/courses/${root.courseId}`}
                className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
              >
                <GraduationCap className="size-4" aria-hidden />
                Course notebook
              </Link>
            )}
          </p>
        </header>

        {courseId && topics && (
          <aside
            data-testid="review-topics"
            className="flex items-center justify-between gap-4 rounded-2xl border border-rule bg-paper-raised p-4"
          >
            <span className="text-sm">
              {topics === "review"
                ? "Neb found the topics in your PDF. Check them so it can quiz you and track what you know."
                : "Neb is finding the topics in your PDF. You can write on its pages meanwhile."}
            </span>
            {topics === "review" && (
              <Link
                href={`/courses/${courseId}`}
                className="shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper"
              >
                Review topics
              </Link>
            )}
          </aside>
        )}

        <section aria-labelledby="chapters-heading" className="flex flex-col gap-3">
          <h2 id="chapters-heading" className="text-xs tracking-wide text-ink-muted uppercase">
            {root.childLabel}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {children.map((child, index) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => actions.onOpen(child.id)}
                  data-testid="chapter-card"
                  className="flex h-full w-full flex-col gap-2 rounded-2xl border border-rule bg-paper-raised p-4 text-left shadow-[0_8px_24px_-18px_rgba(0,0,0,0.35)] transition-colors hover:border-ink/25 motion-reduce:transition-none"
                >
                  <span className="text-xs text-ink-muted tabular-nums">{index + 1}</span>
                  <span className="font-serif text-xl leading-tight">{child.title}</span>
                  <span className="mt-auto text-xs text-ink-muted">
                    {plural(pageCounts.get(child.id) ?? 0, "page")}
                    {tree.children(child.id).length > 0 &&
                      ` · ${plural(tree.children(child.id).length, "section")}`}{" "}
                    · edited {ago(child.updatedAt, now)}
                  </span>
                </button>
              </li>
            ))}
            {canAdd && (
              <li>
                <button
                  type="button"
                  onClick={actions.onAddChild}
                  title={keys.shown("new_chapter")}
                  aria-keyshortcuts={keys.aria("new_chapter")}
                  className="flex h-full min-h-28 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-rule p-4 text-sm text-ink-muted hover:border-ink/30 hover:text-ink"
                >
                  <Plus className="size-4" aria-hidden />
                  Add {noun}
                </button>
              </li>
            )}
          </ul>
        </section>

        <section aria-labelledby="pages-heading" className="flex flex-col gap-3">
          <h2 id="pages-heading" className="text-xs tracking-wide text-ink-muted uppercase">
            Loose pages
          </h2>
          <ul className="flex flex-wrap gap-3">
            {pages.map((page) => (
              <li key={page.id}>
                <button
                  type="button"
                  onClick={() => actions.onOpenPage(page.id)}
                  className="flex h-28 w-24 flex-col items-center justify-center gap-2 rounded-xl border border-rule bg-paper-raised text-sm text-ink-muted hover:border-ink/25 hover:text-ink"
                >
                  <FileText className="size-5" aria-hidden />
                  Page {page.index + 1}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={actions.onAddPage}
                title={keys.shown("new_page")}
                aria-keyshortcuts={keys.aria("new_page")}
                className="flex h-28 w-24 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-rule text-sm text-ink-muted hover:border-ink/30 hover:text-ink"
              >
                <Plus className="size-5" aria-hidden />
                New page
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={actions.onImportPdf}
                title={keys.shown("import_pdf")}
                aria-keyshortcuts={keys.aria("import_pdf")}
                className="flex h-28 w-24 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-rule text-sm text-ink-muted hover:border-ink/30 hover:text-ink"
              >
                <FileUp className="size-5" aria-hidden />
                Import PDF
              </button>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "just now", "5 minutes ago", "yesterday"… */
export function ago(then: number, now: number): string {
  const seconds = Math.round((then - now) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 60],
    ["day", 24],
    ["week", 7],
    ["month", 4.35],
    ["year", 12],
  ];
  let value = seconds / 60;
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  for (const [name, size] of units.slice(1)) {
    if (Math.abs(value) < size) break;
    value /= size;
    unit = name;
  }
  return RELATIVE.format(Math.round(value), unit);
}
