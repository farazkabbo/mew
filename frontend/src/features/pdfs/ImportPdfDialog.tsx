"use client";

import {
  type Notebook,
  type NotebookTree,
  parsePageRange,
  type PdfInfo,
  planImport,
  TREE_LIMITS,
} from "@mew/shared";
import { FileUp, Loader2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { DestinationPicker } from "../notebook/tree/DestinationPicker";
import { Dialog } from "../notebook/tree/Dialog";
import { PdfApiError, uploadPdf } from "./api";
import type { ImportChoice } from "./import";

type Props = {
  open: boolean;
  tree: NotebookTree<Notebook>;
  /** Where it goes unless changed: where it was dropped, or the open chapter. */
  nodeId: string | null;
  /** A file already chosen (dropped on the sidebar or a page). */
  file: File | null;
  onImport(info: PdfInfo, choice: ImportChoice): Promise<void>;
  onClose(): void;
};

/**
 * Importing a PDF (K4 §5.1): the file is read first (its page count and outline), then the
 * student chooses where it goes, which pages, whether to split it into chapters by its outline
 * (renaming or leaving some out, with which pages go where), and whether it's course material
 * (on by default; for a notebook without a course it says one is made). Nothing is created until
 * Import.
 */
export function ImportPdfDialog(props: Props) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      label="Import a PDF"
      className="fixed top-12 mx-auto w-[min(34rem,calc(100vw-2rem))]"
    >
      <ImportForm {...props} />
    </Dialog>
  );
}

type Read =
  | { state: "idle" }
  | { state: "reading" }
  | { state: "read"; info: PdfInfo }
  | { state: "failed"; message: string };

function ImportForm({ tree, nodeId, file, onImport, onClose }: Props) {
  const ids = useId();
  const input = useRef<HTMLInputElement>(null);
  const [read, setRead] = useState<Read>({ state: "idle" });
  const [destination, setDestination] = useState<string | null>(nodeId);
  const [picking, setPicking] = useState(false);
  const [range, setRange] = useState("");
  const [split, setSplit] = useState(true);
  const [titles, setTitles] = useState<ReadonlyMap<number, string>>(new Map());
  const [skip, setSkip] = useState<ReadonlySet<number>>(new Set());
  const [course, setCourse] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const readFile = (chosen: File) => {
    setRead({ state: "reading" });
    void uploadPdf(chosen)
      .then((info) => setRead({ state: "read", info }))
      .catch((error: unknown) =>
        setRead({
          state: "failed",
          message:
            error instanceof PdfApiError ? error.message : "Couldn't read that PDF. Try again.",
        }),
      );
  };
  // A dropped file is read as soon as the dialog opens.
  useEffect(() => {
    if (!file) return;
    void Promise.resolve().then(() => readFile(file));
  }, [file]);

  const info = read.state === "read" ? read.info : null;
  const node = destination ? tree.get(destination) : undefined;
  const root = destination ? tree.path(destination)[0] : undefined;
  const canSplit =
    !!info &&
    info.outline.length > 0 &&
    !!destination &&
    tree.depth(destination) < TREE_LIMITS.maxDepth;
  const pages = info ? parsePageRange(range, info.pageCount) : null;
  const plan = useMemo(
    () =>
      info && pages
        ? planImport(info, pages, canSplit && split, {
            titles: new Map(titles),
            skip: new Set(skip),
          })
        : null,
    [info, pages?.first, pages?.last, canSplit, split, titles, skip], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const where = node
    ? tree
        .path(node.id)
        .map((n) => n.title)
        .join(" › ")
    : "Choose a notebook";

  const submit = async () => {
    if (!info || !plan || !destination) return;
    setBusy(true);
    setProblem(null);
    try {
      await onImport(info, { nodeId: destination, plan, courseMaterial: course });
    } catch {
      setProblem("Couldn't add the pages. Try again.");
      setBusy(false);
    }
  };

  return (
    <form
      className="flex max-h-[calc(100dvh-6rem)] flex-col gap-4 overflow-y-auto p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-serif text-2xl">Import a PDF</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-8 place-items-center rounded-lg text-ink-muted hover:bg-rule/60"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {read.state === "idle" || read.state === "failed" ? (
        <div className="flex flex-col gap-2">
          <input
            ref={input}
            id={`${ids}-file`}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (chosen) readFile(chosen);
            }}
          />
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-rule px-4 py-8 text-ink-muted hover:border-ink/30 hover:text-ink"
          >
            <FileUp className="size-5" aria-hidden />
            Choose a PDF (up to 100 MB)
          </button>
          {read.state === "failed" && (
            <p role="alert" className="text-sm text-error">
              {read.message}
            </p>
          )}
        </div>
      ) : read.state === "reading" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Reading the PDF…
        </p>
      ) : (
        info && (
          <>
            <p className="text-sm">
              <span className="font-medium">{info.fileName}</span> · {info.pageCount} pages
            </p>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-ink-muted">Destination</span>
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="rounded-lg border border-rule bg-paper px-3 py-2 text-left text-sm hover:border-accent"
              >
                {where}
              </button>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={`${ids}-range`} className="text-xs font-medium text-ink-muted">
                Pages (all, or a range like 40–62)
              </label>
              <input
                id={`${ids}-range`}
                value={range}
                placeholder={`1–${info.pageCount}`}
                onChange={(event) => setRange(event.target.value)}
                className="rounded-lg border border-rule bg-paper px-3 py-2 text-sm outline-none focus:border-accent"
              />
              {!pages && (
                <p role="alert" className="text-xs text-error">
                  Pages 1 to {info.pageCount}, like “40–62”.
                </p>
              )}
            </div>

            {canSplit && (
              <fieldset className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={split}
                    onChange={(event) => setSplit(event.target.checked)}
                    className="size-4 accent-(--accent)"
                  />
                  Split into chapters using the PDF&apos;s contents
                </label>
                {split && plan && (
                  <ol aria-label="Chapters" className="flex flex-col gap-1 pl-6">
                    {info.outline.map((item, index) => {
                      const planned = plan.chapters.find((c) => c.firstPage === item.pageIndex + 1);
                      const inRange =
                        pages &&
                        item.pageIndex + 1 >= pages.first &&
                        item.pageIndex + 1 <= pages.last;
                      if (!inRange) return null;
                      return (
                        <li key={index} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            aria-label={`Import ${item.title}`}
                            checked={!skip.has(index)}
                            onChange={(event) =>
                              setSkip((now) => {
                                const next = new Set(now);
                                if (event.target.checked) next.delete(index);
                                else next.add(index);
                                return next;
                              })
                            }
                            className="size-4 accent-(--accent)"
                          />
                          <input
                            aria-label={`Chapter name for ${item.title}`}
                            value={titles.get(index) ?? item.title}
                            onChange={(event) =>
                              setTitles((now) => new Map(now).set(index, event.target.value))
                            }
                            disabled={skip.has(index)}
                            className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-2 py-1 disabled:opacity-50"
                          />
                          <span className="shrink-0 text-xs text-ink-muted tabular-nums">
                            {planned ? `pp. ${planned.firstPage}–${planned.lastPage}` : "left out"}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {split && plan?.loose && (
                  <p className="pl-6 text-xs text-ink-muted">
                    Pages {plan.loose.firstPage}–{plan.loose.lastPage} go straight into{" "}
                    {node?.title}.
                  </p>
                )}
              </fieldset>
            )}

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={course}
                onChange={(event) => setCourse(event.target.checked)}
                className="mt-0.5 size-4 accent-(--accent)"
              />
              <span>
                {root?.courseId
                  ? "Use as course material"
                  : `Use as course material (creates a ${root?.title ?? "new"} course)`}
                <span className="block text-xs text-ink-muted">
                  Neb learns from it to explain, quiz you and track what you know. Turn it off for
                  PDFs that aren&apos;t for study.
                </span>
              </span>
            </label>

            {problem && (
              <p role="alert" className="text-sm text-error">
                {problem}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm">
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !plan || !destination}
                className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-50"
              >
                {busy ? "Importing…" : "Import"}
              </button>
            </div>
          </>
        )
      )}

      <DestinationPicker
        open={picking}
        title="Import into…"
        tree={tree}
        topLevel={false}
        refuse={() => null}
        onPick={(picked) => {
          if (picked) setDestination(picked);
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    </form>
  );
}
