"use client";

import type { Notebook, Page } from "@mew/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DebugPanel } from "../mew/DebugPanel";
import { MewDock } from "../mew/MewDock";
import { useMew } from "../mew/store";
import { useMewSession } from "../mew/useMewSession";
import { type CanvasHandle, NotebookCanvas } from "./canvas/NotebookCanvas";
import { NotebookDb } from "./db";
import { PageEngine } from "./engine";
import { cropCurrentLine, downloadBlob } from "./export-line";
import { PageNav } from "./PageNav";
import { NotebookRepository } from "./repository";
import { Sidebar } from "./Sidebar";
import { useNotebookUi } from "./store";
import { Toolbar } from "./Toolbar";
import { useShortcuts } from "./useShortcuts";

type Notice = { text: string; tone: "info" | "error" };

export function NotebookApp({ userId }: { userId: string }) {
  const repo = useMemo(() => new NotebookRepository(new NotebookDb(userId)), [userId]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageId, setPageId] = useState<string | null>(null);
  const [engine, setEngine] = useState<PageEngine | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const canvas = useRef<CanvasHandle>(null);
  const debugOpen = useMew((s) => s.debugOpen);

  const report = useCallback((error: unknown) => {
    console.error("[notebook]", error);
    setNotice({ text: "Couldn't save your last change. Check available storage.", tone: "error" });
  }, []);

  // Open the most recent notebook (creating one on first use) and ask the browser not to evict it.
  useEffect(() => {
    let cancelled = false;
    void navigator.storage?.persist?.();
    void (async () => {
      const latest = await repo.openLatestNotebook();
      const all = await repo.listNotebooks();
      if (cancelled) return;
      setNotebooks(all);
      setNotebookId(latest.id);
    })().catch(report);
    return () => {
      cancelled = true;
    };
  }, [repo, report]);

  useEffect(() => {
    if (!notebookId) return;
    let cancelled = false;
    void repo
      .listPages(notebookId)
      .then((list) => {
        if (cancelled) return;
        setPages(list);
        setPageId(list[0]?.id ?? null);
      })
      .catch(report);
    return () => {
      cancelled = true;
    };
  }, [repo, notebookId, report]);

  useEffect(() => {
    if (!pageId) return;
    let cancelled = false;
    let opened: PageEngine | null = null;
    void PageEngine.open(repo, pageId, report)
      .then((next) => {
        if (cancelled) {
          next.dispose();
          return;
        }
        opened = next;
        setEngine(next);
      })
      .catch(report);
    return () => {
      cancelled = true;
      opened?.dispose(); // closes its cross-tab sync channel
    };
  }, [repo, pageId, report]);

  useEffect(() => {
    if (!engine) return;
    const sync = () =>
      useNotebookUi.getState().setView({ canUndo: engine.canUndo, canRedo: engine.canRedo });
    sync();
    return engine.subscribe(sync);
  }, [engine]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const actions = useMemo(
    () => ({
      undo: () => engine?.undo(),
      redo: () => engine?.redo(),
      zoom: (factor: number) => canvas.current?.zoomBy(factor),
      resetView: () => canvas.current?.resetView(),
    }),
    [engine],
  );
  useShortcuts(actions);
  const mew = useMewSession(engine);

  const createNotebook = async () => {
    const notebook = await repo.createNotebook(`Notebook ${notebooks.length + 1}`);
    setNotebooks(await repo.listNotebooks());
    setNotebookId(notebook.id);
  };

  const addPage = async () => {
    if (!notebookId) return;
    const page = await repo.addPage(notebookId);
    setPages((list) => [...list, page]);
    setPageId(page.id);
  };

  const exportLine = async () => {
    if (!engine) return;
    const crop = await cropCurrentLine(engine.doc);
    if (!crop) {
      setNotice({ text: "Write something first — there's no line to export.", tone: "info" });
      return;
    }
    downloadBlob(crop.blob, `mew-line-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    setNotice({ text: `Exported current line (${crop.width}×${crop.height} px).`, tone: "info" });
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <Sidebar
        notebooks={notebooks}
        currentId={notebookId}
        onSelect={setNotebookId}
        onCreate={() => void createNotebook().catch(report)}
      />
      <main className="relative min-w-0 flex-1">
        {engine && engine.pageId === pageId ? (
          <NotebookCanvas ref={canvas} engine={engine} onPenDown={mew.penDown} />
        ) : (
          <div className="grid h-full place-items-center text-sm text-ink-muted">
            Opening notebook…
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center px-4">
          <Toolbar
            onUndo={actions.undo}
            onRedo={actions.redo}
            onZoom={actions.zoom}
            onResetView={actions.resetView}
            onExportLine={() => void exportLine().catch(report)}
          />
        </div>

        {pageId && (
          <div className="pointer-events-none absolute bottom-4 left-4">
            <PageNav
              pages={pages}
              currentPageId={pageId}
              onSelect={setPageId}
              onAdd={() => void addPage().catch(report)}
            />
          </div>
        )}

        <div className="pointer-events-none absolute right-4 bottom-4">
          <MewDock
            onSummon={mew.summon}
            onStartListening={mew.startListening}
            onStopListening={mew.stopListening}
          />
        </div>

        {debugOpen && (
          <div className="pointer-events-none absolute top-20 right-4 bottom-24">
            <DebugPanel onSimulateUtterance={mew.say} onSummon={mew.summon} />
          </div>
        )}

        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-x-0 bottom-20 flex justify-center px-4"
        >
          {notice && (
            <p
              className={`rounded-full px-4 py-2 text-sm shadow-lg ${
                notice.tone === "error" ? "bg-error text-white" : "bg-ink text-paper"
              }`}
            >
              {notice.text}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
