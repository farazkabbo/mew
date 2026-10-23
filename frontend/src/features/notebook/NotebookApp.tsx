"use client";

import type { Notebook, Page } from "@mew/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DebugPanel } from "../mew/DebugPanel";
import { MewDock } from "../mew/MewDock";
import { useMew } from "../mew/store";
import { useMewSession } from "../mew/useMewSession";
import { Onboarding } from "../onboarding/Onboarding";
import { QuizCard } from "../quiz/QuizCard";
import { useQuiz } from "../quiz/store";
import { type CanvasHandle, NotebookCanvas } from "./canvas/NotebookCanvas";
import { ClipSource } from "./ClipSource";
import { NotebookDb } from "./db";
import { PageEngine } from "./engine";
import { cropCurrentLine, downloadBlob } from "./export-line";
import { PageNav } from "./PageNav";
import { NotebookRepository } from "./repository";
import { Sidebar } from "./Sidebar";
import { useNotebookUi } from "./store";
import { Toolbar } from "./Toolbar";
import { useAppServices } from "./useAppServices";
import { useClipImport } from "./useClipImport";
import { useShortcuts } from "./useShortcuts";

type Notice = { text: string; tone: "info" | "error" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Screen width the quiz card covers on the left (its width plus margins), kept free of ink. */
const QUIZ_CARD_INSET = 352;

export function NotebookApp({ userId }: { userId: string }) {
  const repo = useMemo(() => new NotebookRepository(new NotebookDb(userId)), [userId]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageId, setPageId] = useState<string | null>(null);
  const [engine, setEngine] = useState<PageEngine | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const canvas = useRef<CanvasHandle>(null);
  /** "Quiz me" from a course screen: /notebook?course=…&quiz=1 starts a quiz once open. */
  const quizRequested = useRef(false);
  const debugOpen = useMew((s) => s.debugOpen);
  const quizActive = useQuiz((s) => s.active);

  const report = useCallback((error: unknown) => {
    console.error("[notebook]", error);
    setNotice({ text: "Couldn't save your last change. Check available storage.", tone: "error" });
  }, []);

  // Open the most recent notebook (creating one on first use) and ask the browser not to evict it.
  useEffect(() => {
    let cancelled = false;
    void navigator.storage?.persist?.();
    void (async () => {
      // /notebook?course=<id>&title=<course title> opens (or creates) that course's notebook.
      const params = new URLSearchParams(window.location.search);
      const course = params.get("course");
      quizRequested.current = params.get("quiz") === "1";
      const title = (params.get("title") ?? "").trim().slice(0, 200) || "Course notes";
      const latest =
        course && UUID.test(course)
          ? await repo.notebookForCourse(course, title)
          : await repo.openLatestNotebook();
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

  // A clip saved from the screen (Screen Coach) becomes a new page of this notebook.
  const openClipPage = useCallback((page: Page) => {
    setPages((list) => (list.some((p) => p.id === page.id) ? list : [...list, page]));
    setPageId(page.id);
    setNotice({ text: "Saved from your screen. Work on it right here.", tone: "info" });
  }, []);
  const clipFailed = useCallback((text: string) => setNotice({ text, tone: "error" }), []);
  useClipImport({ repo, notebookId, onOpened: openClipPage, onError: clipFailed });
  const clipImage = engine?.images.at(-1);
  const courseId = notebooks.find((n) => n.id === notebookId)?.courseId ?? null;
  const mew = useMewSession(engine, courseId);
  const { quiz } = mew;
  const app = useAppServices({
    ready: engine !== null,
    listen: mew.startListening,
    summon: mew.summon,
  });

  useEffect(() => {
    if (!courseId || !engine || !quizRequested.current) return;
    quizRequested.current = false;
    void quiz.start(courseId);
  }, [courseId, engine, quiz]);

  // A quiz belongs to its course's notebook: switching notebooks ends it.
  useEffect(() => {
    const running = useQuiz.getState();
    if (running.active && running.courseId !== courseId) void quiz.stop();
  }, [courseId, quiz]);

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
        onQuiz={courseId ? () => void quiz.start(courseId) : null}
      />
      <main className="relative min-w-0 flex-1">
        {engine && engine.pageId === pageId ? (
          <NotebookCanvas
            ref={canvas}
            engine={engine}
            onPenDown={mew.penDown}
            tutorInk={mew.ink}
            leftInset={quizActive ? QUIZ_CARD_INSET : 0}
          />
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

        {clipImage && !quizActive && (
          <div className="pointer-events-none absolute inset-x-0 top-[4.5rem] flex justify-center px-4">
            <ClipSource image={clipImage} />
          </div>
        )}

        <div className="pointer-events-none absolute top-20 left-4">
          <QuizCard session={quiz} />
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
          {!app.online && !notice && (
            <p
              data-testid="offline-notice"
              className="rounded-full bg-ink px-4 py-2 text-sm text-paper shadow-lg"
            >
              You&apos;re offline. Your notes are saved on this device; Mew needs a connection.
            </p>
          )}
        </div>
      </main>
      {app.showIntro && (
        <Onboarding onDone={app.closeIntro} onStartListening={mew.startListening} />
      )}
    </div>
  );
}
