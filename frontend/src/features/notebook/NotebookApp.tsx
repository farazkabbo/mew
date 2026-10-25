"use client";

import type { Page } from "@mew/shared";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { isDesktop } from "../desktop/bridge";

import { DebugPanel } from "../mew/DebugPanel";
import { MewDock } from "../mew/MewDock";
import { useMew } from "../mew/store";
import { useMewSession } from "../mew/useMewSession";
import { useNotesCheck } from "../notes/check-store";
import { checkClip, pageOfFinding, usePageMarks } from "../notes/notebook-check";
import { NotesCheckPanel } from "../notes/NotesCheckPanel";
import { NotesMarks } from "../notes/NotesMarks";
import { EntryNotes } from "./EntryNotes";
import { useNoteIndexing } from "../notes/useNoteIndexing";
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
import { pullTree } from "./tree-api";
import { useShortcuts } from "./useShortcuts";
import { Breadcrumb } from "./tree/Breadcrumb";
import { NodeHome } from "./tree/NodeHome";
import { TreeDialogs } from "./tree/TreeDialogs";
import { TreeNav } from "./tree/TreeNav";
import { type TreeNoticeView, useTreeActions } from "./tree/useTreeActions";
import { useNotebookTree } from "./tree/useNotebookTree";
import { useTreeShortcuts } from "./tree/useTreeShortcuts";

type Notice = TreeNoticeView;

/** What the main area shows for the open node: its home (cards), or one of its pages. */
type View = "home" | "page";

/** A node being written in is marked as edited at most this often. */
const TOUCH_EVERY_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Screen width the quiz card covers on the left (its width plus margins), kept free of ink. */
const QUIZ_CARD_INSET = 352;

export function NotebookApp({ userId }: { userId: string }) {
  const db = useMemo(() => new NotebookDb(userId), [userId]);
  const repo = useMemo(() => new NotebookRepository(db), [db]);
  /** The open node: a notebook, chapter or section (its pages are `pages`). */
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [view, setView] = useState<View>("page");
  /** The page to open once the node's pages are read (a jump, a new page). */
  const wantedPage = useRef<string | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageId, setPageId] = useState<string | null>(null);
  const [engine, setEngine] = useState<PageEngine | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** The clip page just saved, offered a notes check once (brief §2.1). */
  const [checkPrompt, setCheckPrompt] = useState<string | null>(null);
  const canvas = useRef<CanvasHandle>(null);
  /** "Quiz me" from a course screen: /notebook?course=…&quiz=1 starts a quiz once open. */
  const quizRequested = useRef(false);
  const debugOpen = useMew((s) => s.debugOpen);
  const quizActive = useQuiz((s) => s.active);

  const report = useCallback((error: unknown) => {
    console.error("[notebook]", error);
    setNotice({ text: "Couldn't save your last change. Check available storage.", tone: "error" });
  }, []);
  const notify = useCallback((next: Notice) => setNotice(next), []);
  const treeNotice = useCallback((text: string) => setNotice({ text, tone: "info" }), []);

  const { nodes, tree } = useNotebookTree(repo, treeNotice, report);
  const now = useMinuteClock();
  // Known only in the browser (the server renders the web app's shortcuts).
  const desktop = useSyncExternalStore(noSubscription, isDesktop, () => false);

  /**
   * Opens a node: its home when it has chapters (or sections), else its first page. It becomes
   * the most recently used, so the app opens it again next time.
   */
  const openNode = useCallback(
    (id: string) => {
      void repo
        .touchNotebook(id)
        .then(() => repo.tree.tree())
        .then((current) => {
          setNotebookId(id);
          setView(current.children(id).length > 0 ? "home" : "page");
        })
        .catch(report);
    },
    [repo, report],
  );

  const openPage = useCallback((page: Page) => {
    wantedPage.current = page.id;
    setNotebookId(page.notebookId);
    setView("page");
    setPages((list) =>
      list.some((p) => p.id === page.id) || list[0]?.notebookId !== page.notebookId
        ? list
        : [...list, page],
    );
    setPageId(page.id);
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
      // A device with no notebooks yet (a new browser, a second computer) takes the account's
      // first, so it never makes a "My first notebook" of its own beside them.
      if (navigator.onLine && (await repo.listNotebooks()).length === 0) {
        const server = await pullTree();
        if (server) await repo.tree.applyServerTree(server);
      }
      const latest =
        course && UUID.test(course)
          ? await repo.notebookForCourse(course, title)
          : await repo.openLatestNotebook();
      if (!cancelled) openNode(latest.id);
    })().catch(report);
    return () => {
      cancelled = true;
    };
  }, [repo, report, openNode]);

  // The open node's pages; a page view always has one (a node from another device may have
  // none here yet).
  useEffect(() => {
    if (!notebookId) return;
    let cancelled = false;
    void (async () => {
      if (view === "page") await repo.firstPageOrNew(notebookId);
      const list = await repo.listPages(notebookId);
      if (cancelled) return;
      setPages(list);
      const wanted = list.find((p) => p.id === wantedPage.current);
      wantedPage.current = null;
      setPageId((wanted ?? list[0])?.id ?? null);
    })().catch(report);
    return () => {
      cancelled = true;
    };
  }, [repo, notebookId, view, report]);

  // The open node went to the trash (here, in another tab, or on another device): open the
  // nearest node above it that's still there, else the latest notebook.
  useEffect(() => {
    if (!nodes || !notebookId) return;
    const open = tree.get(notebookId);
    if (!open || tree.isLive(notebookId)) return;
    const above = tree.path(notebookId).slice(0, -1).reverse();
    const live = above.find((n) => tree.isLive(n.id));
    if (live) openNode(live.id);
    else void repo.openLatestNotebook().then((n) => openNode(n.id), report);
  }, [nodes, tree, notebookId, openNode, repo, report]);

  // Bumped when the open page changed in storage from outside the engine (a follow-up added to
  // a Circle & Ask entry on it): the page is opened again, pictures and all.
  const [pageVersion, setPageVersion] = useState(0);
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
  }, [repo, pageId, pageVersion, report]);

  useEffect(() => {
    if (!engine) return;
    const sync = () =>
      useNotebookUi.getState().setView({ canUndo: engine.canUndo, canRedo: engine.canRedo });
    sync();
    return engine.subscribe(sync);
  }, [engine]);

  useEffect(() => {
    if (!engine || !notebookId) return;
    let touched = 0;
    return engine.subscribe((change) => {
      if (change === "tutor" || Date.now() - touched < TOUCH_EVERY_MS) return;
      touched = Date.now();
      void repo.touchNotebook(notebookId).catch(report);
    });
  }, [engine, notebookId, repo, report]);

  useEffect(() => {
    if (!notice) return;
    // A notice with Undo stays long enough to reach for it.
    const timer = setTimeout(() => setNotice(null), notice.action ? 8000 : 4000);
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
  // Opened through openPage, so a node still loading its pages keeps this one open.
  const openClipPage = useCallback(
    (page: Page) => {
      openPage(page);
      setNotice({ text: "Saved from your screen. Work on it right here.", tone: "info" });
      setCheckPrompt(page.id); // "Check this against your notes?" (never runs on its own)
    },
    [openPage],
  );
  // A Circle & Ask explanation is added to today's "From screen" page quietly (or opened).
  const entryAdded = useCallback(
    (page: Page) => {
      setPages((list) => (list.some((p) => p.id === page.id) ? list : [...list, page]));
      if (page.id === pageId) setPageVersion((v) => v + 1);
      setNotice({ text: "Saved to your From screen page.", tone: "info" });
    },
    [pageId],
  );
  const clipFailed = useCallback((text: string) => setNotice({ text, tone: "error" }), []);
  useClipImport({
    repo,
    notebookId,
    onOpened: openClipPage,
    onAdded: entryAdded,
    onError: clipFailed,
  });
  const clipImage = engine?.images.at(-1);
  const node = notebookId ? (tree.get(notebookId) ?? null) : null;
  // A chapter's course is its notebook's.
  const courseId = (notebookId && tree.path(notebookId)[0]?.courseId) || null;
  const mew = useMewSession(engine, courseId);
  const { quiz } = mew;
  // Notes Check: every line's text, kept with the page and (if allowed) on the server.
  useNoteIndexing({ db, repo, engine, notebookId, recognition: mew.recognition });
  const notebook = node;
  const marks = usePageMarks(db, engine);
  const focus = useNotesCheck((s) => s.focus);
  const checkResult = useNotesCheck((s) => s.result);
  const checking = useNotesCheck((s) => s.running);
  const checkAgainstNotes = (image: NonNullable<typeof clipImage>) => {
    setCheckPrompt(null);
    if (notebook) void checkClip(image, notebook);
  };

  // "Show me" (here or in the desktop app's panel): open the page the finding is on.
  useEffect(() => {
    const finding = checkResult?.findings.find((f) => f.id === focus?.findingId);
    if (!finding) return;
    let cancelled = false;
    void (async () => {
      const target = await pageOfFinding(db, finding);
      const page = target ? await repo.getPage(target) : null;
      if (cancelled || !page) return;
      openPage(page);
    })().catch(report);
    return () => {
      cancelled = true;
    };
  }, [focus, checkResult, db, repo, report, openPage]);
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

  const treeActions = useTreeActions({ repo, tree, notify, report, openNode, openPage });
  const loadCounts = useCallback((ids: readonly string[]) => repo.countPages(ids), [repo]);
  /** Where Alt+N adds a chapter: the open notebook (a chapter's own notebook). */
  const rootId = notebookId ? (tree.path(notebookId)[0]?.id ?? null) : null;
  useTreeShortcuts(
    {
      newNotebook: treeActions.startCreating,
      newChapter: () => rootId && treeActions.addChild(rootId),
      newPage: () => notebookId && treeActions.addPage(notebookId),
      rename: () => notebookId && treeActions.setRenamingId(notebookId),
      jump: () => treeActions.setPaletteOpen(true),
      reorder: (step) => notebookId && treeActions.reorder(notebookId, step),
    },
    desktop,
  );

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
        notebooks={
          <TreeNav
            tree={tree}
            currentId={notebookId}
            renamingId={treeActions.renamingId}
            draft={treeActions.draft}
            trashCount={tree.trash().length}
            newNotebookShortcut={desktop ? "Ctrl+N" : "Alt+B"}
            onOpen={openNode}
            onCreateNotebook={treeActions.startCreating}
            onAddChild={treeActions.addChild}
            onAddPage={treeActions.addPage}
            onStartRename={treeActions.setRenamingId}
            onRename={treeActions.rename}
            onMove={treeActions.move}
            onReorder={treeActions.reorder}
            onMoveTo={treeActions.setMovingId}
            onDelete={treeActions.requestDelete}
            onOpenTrash={() => treeActions.setTrashOpen(true)}
          />
        }
        onQuiz={courseId ? () => void quiz.start(courseId) : null}
      />
      <main className="relative min-w-0 flex-1">
        {view === "home" && node ? (
          <NodeHome
            node={node}
            tree={tree}
            pages={pages.filter((p) => p.notebookId === node.id)}
            now={now}
            loadCounts={loadCounts}
            onOpen={openNode}
            onOpenPage={(id) => {
              const page = pages.find((p) => p.id === id);
              if (page) openPage(page);
            }}
            onAddChild={() => treeActions.addChild(node.id)}
            onAddPage={() => treeActions.addPage(node.id)}
          />
        ) : engine && engine.pageId === pageId ? (
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

        {view === "page" && notebookId && !quizActive && (
          <div className="pointer-events-auto absolute top-[4.25rem] left-4 hidden max-w-[45%] rounded-xl bg-paper-raised/90 px-1 py-1 backdrop-blur md:block">
            <Breadcrumb
              tree={tree}
              nodeId={notebookId}
              pageNumber={(pages.find((p) => p.id === pageId)?.index ?? 0) + 1}
              onOpen={openNode}
            />
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

        {engine && <EntryNotes canvas={canvas} images={engine.images} />}

        {engine && (
          <NotesMarks
            canvas={canvas}
            marks={marks}
            focusId={focus?.findingId ?? null}
            db={db}
            ink={mew.ink}
          />
        )}

        {clipImage && !quizActive && (
          <div className="pointer-events-none absolute inset-x-0 top-[4.5rem] flex flex-col items-center gap-2 px-4">
            <ClipSource
              image={clipImage}
              {...(clipImage.ocrText &&
                !checking && { onCheck: () => checkAgainstNotes(clipImage) })}
            />
            {checkPrompt === pageId && clipImage.ocrText && (
              <div
                role="status"
                data-testid="notes-check-prompt"
                className="pointer-events-auto flex items-center gap-3 rounded-full bg-ink px-4 py-2 text-sm text-paper shadow-lg"
              >
                Check this against your notes?
                <button
                  type="button"
                  className="font-semibold underline"
                  onClick={() => checkAgainstNotes(clipImage)}
                >
                  Check
                </button>
                <button type="button" className="opacity-80" onClick={() => setCheckPrompt(null)}>
                  Not now
                </button>
              </div>
            )}
          </div>
        )}

        <div className="pointer-events-none absolute top-20 right-4 bottom-24 flex flex-col items-end">
          <NotesCheckPanel />
        </div>

        <div className="pointer-events-none absolute top-20 left-4">
          <QuizCard session={quiz} />
        </div>

        {view === "page" && pageId && (
          <div className="pointer-events-none absolute bottom-4 left-4">
            <PageNav
              pages={pages}
              currentPageId={pageId}
              onSelect={setPageId}
              onAdd={() => notebookId && treeActions.addPage(notebookId)}
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
              className={`pointer-events-auto flex items-center gap-3 rounded-full px-4 py-2 text-sm shadow-lg ${
                notice.tone === "error" ? "bg-error text-white" : "bg-ink text-paper"
              }`}
            >
              {notice.text}
              {notice.action && (
                <button
                  type="button"
                  className="font-semibold underline"
                  onClick={() => {
                    notice.action?.run();
                    setNotice(null);
                  }}
                >
                  {notice.action.label}
                </button>
              )}
            </p>
          )}
          {!app.online && !notice && (
            <p
              data-testid="offline-notice"
              className="rounded-full bg-ink px-4 py-2 text-sm text-paper shadow-lg"
            >
              You&apos;re offline. Your notes are saved on this device; Neb needs a connection.
            </p>
          )}
        </div>
      </main>
      <TreeDialogs
        actions={treeActions}
        tree={tree}
        repo={repo}
        now={now}
        openNode={openNode}
        openPage={openPage}
      />
      {app.showIntro && (
        <Onboarding onDone={app.closeIntro} onStartListening={mew.startListening} />
      )}
    </div>
  );
}

function noSubscription(): () => void {
  return () => undefined;
}

/** The time now, updated every minute ("edited 5 minutes ago" stays right). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
