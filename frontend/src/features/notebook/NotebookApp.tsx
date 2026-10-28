"use client";

import {
  type ImageBlock,
  type Page,
  type PdfInfo,
  type LiveMarkKind,
  type SavedQuizFilter,
  type Stroke,
  unsortedNodeId,
} from "@mew/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MarkLayer } from "../annotate/MarkLayer";
import { ReadAsChip } from "../annotate/ReadAsChip";
import { MarksMenu } from "../annotate/MarksMenu";
import { useMarkPrefs } from "../annotate/prefs";
import { AnnotationRecords } from "../annotate/records";
import { AnnotationSync } from "../annotate/sync";
import { DebugPanel } from "../mew/DebugPanel";
import { MewDock } from "../mew/MewDock";
import { useMew } from "../mew/store";
import {
  type MascotState,
  type NotebookVoiceHandler,
  useMascotState,
  useMewSession,
} from "../mew/useMewSession";
import { MomentMoves } from "../moments/outbox";
import {
  circledWords,
  dueByNode,
  type Moment,
  momentsFrom,
  pdfFileName,
  subtreeIds,
} from "../moments/moments";
import { QuickCheck } from "../moments/QuickCheck";
import { useMomentChecks } from "../moments/store";
import { useNotesCheck } from "../notes/check-store";
import { checkClip, pageOfFinding, usePageMarks } from "../notes/notebook-check";
import { NotesCheckPanel } from "../notes/NotesCheckPanel";
import { NotesMarks } from "../notes/NotesMarks";
import { SolutionRecords } from "../solution/record";
import { SolutionLayer } from "../solution/SolutionLayer";
import { NotebookPointer } from "../tutor/NotebookPointer";
import { EntryNotes } from "./EntryNotes";
import { useNoteIndexing } from "../notes/useNoteIndexing";
import { Onboarding } from "../onboarding/Onboarding";
import { QuizCard } from "../quiz/QuizCard";
import { makeCourseMaterial, recognizePdfPage } from "../pdfs/api";
import { carryOutImport } from "../pdfs/import";
import type { ImportChoice } from "../pdfs/import";
import { ImportPdfDialog } from "../pdfs/ImportPdfDialog";
import { ShortcutsNotice } from "../shortcuts/ShortcutsNotice";
import { useHoldToTalk } from "../shortcuts/useHoldToTalk";
import { useShortcutKeys } from "../shortcuts/useShortcutKeys";
import { useVoice } from "../voice/store";
import { useQuiz } from "../quiz/store";
import { useSettings } from "../settings/store";
import { type CanvasHandle, NotebookCanvas } from "./canvas/NotebookCanvas";
import { ClipSource } from "./ClipSource";
import { NotebookDb } from "./db";
import { PageEngine } from "./engine";
import { cropCurrentLine, downloadBlob } from "./export-line";
import { HoldCircle } from "./HoldCircle";
import { PageNav } from "./PageNav";
import { NotebookRepository } from "./repository";
import { Sidebar } from "./Sidebar";
import { SourceHighlight } from "./SourceHighlight";
import { useNotebookUi } from "./store";
import { isShown } from "./visibility";
import { useAppServices } from "./useAppServices";
import { useClipImport } from "./useClipImport";
import { pullTree } from "./tree-api";
import { useShortcuts } from "./useShortcuts";
import { DestinationPicker } from "./tree/DestinationPicker";
import { NodeHome } from "./tree/NodeHome";
import { TreeDialogs } from "./tree/TreeDialogs";
import { TreeNav } from "./tree/TreeNav";
import { type TreeNoticeView, useTreeActions } from "./tree/useTreeActions";
import { useNotebookTree } from "./tree/useNotebookTree";
import { useNotebookVoice } from "./tree/useNotebookVoice";
import { useTreeShortcuts } from "./tree/useTreeShortcuts";
import { Desk } from "../desk/Desk";
import { ChapterTabs } from "../page/ChapterTabs";
import { LANE, NebLane } from "../page/NebLane";
import { PageHeader } from "../page/PageHeader";
import { PageTools } from "../page/PageTools";
import { PencilCase, readWritingHand, type WritingHand } from "../page/PencilCase";
import { ReplayBar } from "../page/ReplayBar";
import type { NebDotState } from "@/components/ui/NebDot";

type Notice = TreeNoticeView;

/**
 * What the main area shows: the desk (nothing open, NEB_APP_UI §5.1), a node's home (cards), or
 * one of its pages.
 */
type View = "desk" | "home" | "page";

/** A node being written in is marked as edited at most this often. */
const TOUCH_EVERY_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Whether the Contents drawer stays open (this device). */
const CONTENTS_KEY = "neb:contents";
/** Marks tapped on the page itself (NEB_APP_UI §4.2); the rest are notes in the lane. */
const TICKS = new Set<LiveMarkKind>(["tick"]);
/** neb's state as its dot shows it (§3.8). */
const MASCOT_DOT: Record<MascotState, NebDotState> = {
  sleeping: "watching",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
  muted: "off",
};
/** Screen width the quiz card covers on the left (its width plus margins), kept free of ink. */
const QUIZ_CARD_INSET = 352;

export function NotebookApp({
  userId,
  start = "latest",
  name = null,
}: {
  userId: string;
  /** /desk starts on the desk; /notebook opens the latest notebook (and its page). */
  start?: "desk" | "latest";
  /** The student's first name, for the desk's greeting. */
  name?: string | null;
}) {
  const db = useMemo(() => new NotebookDb(userId), [userId]);
  const repo = useMemo(() => new NotebookRepository(db), [db]);
  /** The open node: a notebook, chapter or section (its pages are `pages`). */
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [view, setView] = useState<View>(start === "desk" ? "desk" : "page");
  /** The page to open once the node's pages are read (a jump, a new page). */
  const wantedPage = useRef<string | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageId, setPageId] = useState<string | null>(null);
  const [engine, setEngine] = useState<PageEngine | null>(null);
  /** Ctrl+Alt held on the page (K6 §6.3): its number keys a fresh circle layer per hold. */
  const [holding, setHolding] = useState<number | null>(null);
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
  /** Bumped when moments change on this device (K8: saved, filed, moved). */
  const [momentsVersion, setMomentsVersion] = useState(0);
  const reloadMoments = useCallback(() => setMomentsVersion((v) => v + 1), []);
  const now = useMinuteClock();
  // Known only in the browser (the server renders the web app's shortcuts).
  const keys = useShortcutKeys();

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
          // Unsorted (K8) is where moments wait: its home is where they're filed from.
          const home = current.children(id).length > 0 || id === unsortedNodeId(userId);
          setView(home ? "home" : "page");
        })
        .catch(report);
    },
    [repo, report, userId],
  );
  /** A node's home, chapters or not (the breadcrumb; K8: a chapter's Moments). */
  const openHome = useCallback((id: string) => {
    setNotebookId(id);
    setView("home");
  }, []);

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
      if (start === "desk" && !(course && UUID.test(course))) return;
      const latest =
        course && UUID.test(course)
          ? await repo.notebookForCourse(course, title)
          : await repo.openLatestNotebook();
      if (!cancelled) openNode(latest.id);
    })().catch(report);
    return () => {
      cancelled = true;
    };
  }, [repo, report, openNode, start]);

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
  // A Circle & Ask explanation is added to its node's "From screen" page quietly (or opened);
  // the notice says where (K3).
  const entryAdded = useCallback(
    (page: Page, missing: boolean) => {
      setPages((list) =>
        list.some((p) => p.id === page.id) || list[0]?.notebookId !== page.notebookId
          ? list
          : [...list, page],
      );
      if (page.id === pageId) setPageVersion((v) => v + 1);
      reloadMoments();
      const where = tree
        .path(page.notebookId)
        .map((n) => n.title)
        .join(" › ");
      setNotice({
        text: missing
          ? `That place isn't on this device, so it's saved in ${where}.`
          : `Saved to ${where || "your notebook"} · From screen.`,
        tone: "info",
        ...(page.id !== pageId && { action: { label: "Open", run: () => openPage(page) } }),
      });
    },
    [pageId, tree, openPage, reloadMoments],
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

  // K8: the moments on this device, and their checks (badges, Quick check, Review).
  const [entries, setEntries] = useState<{ images: ImageBlock[]; pages: Page[] }>({
    images: [],
    pages: [],
  });
  /** The PDFs imported on this device, by file name (K8: "Open in neb"). */
  const [pdfNames, setPdfNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    void repo
      .listEntries()
      .then((read) => live && setEntries(read))
      .catch(report);
    void repo
      .pdfFileNames()
      .then((names) => live && setPdfNames(names))
      .catch(report);
    return () => {
      live = false;
    };
  }, [repo, report, momentsVersion, view, notebookId]);
  const moments = useMemo(
    () => momentsFrom(entries.images, entries.pages).filter((m) => tree.isLive(m.nodeId)),
    [entries, tree],
  );
  const checks = useMomentChecks((s) => s.checks);
  const loadChecks = useMomentChecks((s) => s.load);
  // Read where they're shown (a home's badges and Quick check card), not on every page open.
  useEffect(() => {
    if (view !== "home" && view !== "desk") return;
    void loadChecks();
    const again = () => void loadChecks();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [loadChecks, momentsVersion, view]);
  const dueCounts = useMemo(() => dueByNode(checks ?? [], tree, now), [checks, tree, now]);
  /** Every check due now, anywhere (the desk's Tonight card). */
  const dueTotal = useMemo(
    () => (checks ?? []).filter((c) => Date.parse(c.dueAt) <= now).length,
    [checks, now],
  );
  const exam = useMomentChecks((s) => s.exam);
  const unsortedCount = useMemo(() => {
    const unsorted = unsortedNodeId(userId);
    return new Map([[unsorted, moments.filter((m) => m.nodeId === unsorted).length]]);
  }, [moments, userId]);
  const momentOf = useCallback(
    (clipId: string) => moments.find((m) => m.clipId === clipId),
    [moments],
  );
  /** Shows a moment on its page (from Moments, Ctrl+K or a Quick check), replaying if asked. */
  const openMoment = useCallback(
    (moment: Moment, replay = false) => {
      void repo
        .getPage(moment.pageId)
        .then((page) => {
          if (!page) return;
          useNotebookUi.getState().requestMoment({ imageId: moment.imageId, replay });
          openPage(page);
        })
        .catch(report);
    },
    [repo, report, openPage],
  );
  /**
   * Files a moment from the notebook (K8: "File these", or a place chosen for it): its entry
   * moves there whole, then the server's copy follows, and filing learns from it.
   */
  const momentMoves = useMemo(() => new MomentMoves(), []);
  useEffect(() => {
    void momentMoves.flush();
    const online = () => void momentMoves.flush();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [momentMoves]);
  const fileMoment = useCallback(
    async (moment: Moment, nodeId: string) => {
      // Moved on this device first (offline too); the server follows now or once it's reachable.
      const page = await repo.relocateEntry(moment.imageId, nodeId);
      if (!page) throw new Error("That moment isn't on this device any more.");
      void fetch(`/api/clips/${moment.clipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebookPageId: page.id }),
        keepalive: true,
      }).catch(() => undefined);
      void momentMoves.moved(moment.clipId, nodeId);
      reloadMoments();
      void loadChecks(true);
    },
    [repo, reloadMoments, loadChecks, momentMoves],
  );
  const [choosingFor, setChoosingFor] = useState<Moment | null>(null);
  /** K8 §4.7: a moment from a PDF that's imported here opens on its page in neb. */
  const inNeb = useCallback(
    (moment: Moment) => {
      const name = pdfFileName(moment.image);
      return name !== null && pdfNames.has(name);
    },
    [pdfNames],
  );
  const openInNeb = useCallback(
    (moment: Moment) => {
      const name = pdfFileName(moment.image);
      const pdfId = name ? pdfNames.get(name) : undefined;
      if (!pdfId) return;
      const words = circledWords(moment.image);
      void repo
        .pdfPageWith(pdfId, moment.image)
        .then((found) => {
          if (!found) {
            setNotice({ text: "That PDF's pages aren't on this device yet.", tone: "info" });
            return;
          }
          openPage(found.page);
          // The circled words, highlighted once the page is open (when they were found on it).
          useNotebookUi.getState().highlightSource({ imageId: found.imageId, boxes: found.boxes });
          setNotice({
            text: words ? `From your moment: “${words}…”` : "From your moment.",
            tone: "info",
          });
        })
        .catch(report);
    },
    [pdfNames, repo, openPage, report],
  );
  const openQuickCheck = useMomentChecks((s) => s.openQuickCheck);
  /** "Quiz me on what I saved today / this week / in Physics" (K8 §4.5). */
  const quizSaved = useCallback(
    (filter: SavedQuizFilter) => {
      const place = filter.place?.toLowerCase() ?? null;
      const match = place
        ? [...(nodes ?? [])].find((n) => tree.isLive(n.id) && n.title.toLowerCase() === place)
        : undefined;
      void loadChecks(true).then(() =>
        openQuickCheck({
          filter,
          nodeIds: match ? [...subtreeIds(tree, match.id)] : null,
        }),
      );
    },
    [nodes, tree, loadChecks, openQuickCheck],
  );

  // /notebook?moment=<clip id> (K8: Replay from the Review page's Quick check): shown and replayed
  // once this device's moments are read.
  const momentParam = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (momentParam.current === undefined) {
      const wanted = new URLSearchParams(window.location.search).get("moment");
      momentParam.current = wanted && UUID.test(wanted) ? wanted : null;
    }
    const wanted = momentParam.current;
    if (!wanted) return;
    const moment = moments.find((m) => m.clipId === wanted);
    if (!moment) return;
    momentParam.current = null;
    openMoment(moment, true);
  });
  // A chapter's course is its notebook's.
  const courseId = (notebookId && tree.path(notebookId)[0]?.courseId) || null;
  // Mew's notebook labels (K3) go to `useNotebookVoice`, made below with the tree's actions.
  const voice = useRef<NotebookVoiceHandler | null>(null);
  const onNotebookVoice = useCallback<NotebookVoiceHandler>(
    (...args) => voice.current?.(...args),
    [],
  );
  const mew = useMewSession(engine, courseId, onNotebookVoice, quizSaved);
  const solutionRecords = useMemo(() => new SolutionRecords(db), [db]);
  useEffect(() => {
    mew.setSolutionRecords(solutionRecords);
    return () => mew.setSolutionRecords(null);
  }, [mew, solutionRecords]);
  useShortcuts(
    {
      ...actions,
      checkWork: () => {
        mew.checkWork();
        // NEB_APP_UI §4.4: while the margin is folded, Alt+C checks and then unfolds it.
        const notebook = notebookId ? tree.path(notebookId)[0]?.id : null;
        if (notebook && useMarkPrefs.getState().prefsFor(notebook).hideUntilDone) {
          useMarkPrefs.getState().setHideUntilDone(notebook, false);
        }
      },
    },
    keys.platform,
    keys.own,
  );
  // Hold left Ctrl + left Alt to talk and circle your own writing, let go to ask (K2, K6).
  useHoldToTalk({
    start: () => {
      mew.hold.start();
      setHolding((n) => (n ?? 0) + 1);
      const { status } = useVoice.getState();
      if (status === "off" || status === "error") mew.startListening();
    },
    release: (heldAt) => {
      setHolding(null);
      mew.hold.release(heldAt);
    },
    cancel: () => {
      setHolding(null);
      mew.hold.cancel();
    },
  });
  const { quiz } = mew;
  // Notes Check: every line's text, kept with the page and (if allowed) on the server.
  useNoteIndexing({ db, repo, engine, notebookId, recognition: mew.recognition });
  const notebook = node;
  const marks = usePageMarks(db, engine);
  const focus = useNotesCheck((s) => s.focus);
  const checkResult = useNotesCheck((s) => s.result);
  const checking = useNotesCheck((s) => s.running);
  // K4 §5.2: a scanned page's text, read when the student asks ("Recognize text").
  const scannedPages = useNotebookUi((s) => s.scannedPages);
  const [readingPage, setReadingPage] = useState<string | null>(null);
  const recognizePage = (image: NonNullable<typeof clipImage>) => {
    const pdf = image.pdf;
    const page = engine;
    if (!pdf || !page) return;
    setReadingPage(image.id);
    void recognizePdfPage(pdf.pdfId, pdf.pageIndex)
      .then(async (text) => {
        if (!text) {
          setNotice({ text: "Neb couldn't find any text on this page.", tone: "info" });
          return;
        }
        page.noteImageText(image.id, text);
        useNotebookUi.getState().markScanned(image.id, false);
        await page.pdfCache.setText(pdf.pdfId, pdf.pageIndex, text);
        setNotice({ text: "Neb read this page: the tutor can use its text now.", tone: "info" });
      })
      .catch(report)
      .finally(() => setReadingPage(null));
  };

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
  // K4: importing a PDF (Ctrl+O, "Import PDF", or a PDF dropped on the sidebar or a page).
  const [importing, setImporting] = useState<{ nodeId: string | null; file: File | null } | null>(
    null,
  );
  const importPdf = async (info: PdfInfo, choice: ImportChoice) => {
    const result = await carryOutImport(info, choice, { repo, tree, makeCourseMaterial });
    setImporting(null);
    const first = result.firstPageId ? await repo.getPage(result.firstPageId) : null;
    if (first) openPage(first);
    else openNode(choice.nodeId);
    const pages =
      (choice.plan.loose ? choice.plan.loose.lastPage - choice.plan.loose.firstPage + 1 : 0) +
      choice.plan.chapters.reduce((n, c) => n + c.lastPage - c.firstPage + 1, 0);
    setNotice({
      text: result.courseFailed
        ? `Imported ${pages} pages. It couldn't become course material just now.`
        : result.chapters.length > 0
          ? `Imported ${pages} pages into ${result.chapters.length} chapters.`
          : `Imported ${pages} pages.`,
      tone: result.courseFailed ? "error" : "info",
    });
  };
  useEffect(() => {
    const isPdf = (event: DragEvent) =>
      [...(event.dataTransfer?.items ?? [])].some(
        (item) => item.kind === "file" && item.type === "application/pdf",
      );
    const over = (event: DragEvent) => {
      if (isPdf(event)) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      const file = [...(event.dataTransfer?.files ?? [])].find(
        (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
      );
      if (!file) return;
      event.preventDefault();
      // Dropped on a notebook or chapter in the sidebar: there; anywhere else: the open one.
      const row = (event.target as HTMLElement | null)?.closest?.("[data-node-id]");
      setImporting({ nodeId: row?.getAttribute("data-node-id") ?? notebookId, file });
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [notebookId]);
  const notebookVoice = useNotebookVoice({
    repo,
    tree,
    nodes: nodes ?? [],
    notebookId,
    pageId: view === "page" ? pageId : null,
    actions: treeActions,
    notify,
    report,
    openNode,
  });
  useEffect(() => {
    voice.current = notebookVoice;
  });
  const loadCounts = useCallback((ids: readonly string[]) => repo.countPages(ids), [repo]);
  /** Where Alt+N adds a chapter: the open notebook (a chapter's own notebook). */
  const rootId = notebookId ? (tree.path(notebookId)[0]?.id ?? null) : null;

  // Live annotations (K9): kept on this device, sent to the server, per notebook level.
  const annotationRecords = useMemo(() => new AnnotationRecords(db), [db]);
  const { setLiveAnnotations, setLiveNotebook } = mew;
  useEffect(() => {
    const sync = new AnnotationSync(
      annotationRecords,
      () => useSettings.getState().settings.notes_index,
    );
    setLiveAnnotations({ records: annotationRecords, sync });
    return () => {
      setLiveAnnotations(null);
      sync.dispose();
    };
  }, [setLiveAnnotations, annotationRecords]);
  useEffect(() => {
    setLiveNotebook(rootId);
  }, [setLiveNotebook, rootId]);
  // U2 (NEB_APP_UI §4): the page's parts.
  /** The Contents drawer (the K1 tree), kept open or closed on this device. */
  const [contentsOpen, setContentsOpen] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setContentsOpen(localStorage.getItem(CONTENTS_KEY) === "1");
    } catch {
      // Closed.
    }
  }, []);
  const toggleContents = useCallback(() => {
    setContentsOpen((open) => {
      try {
        localStorage.setItem(CONTENTS_KEY, open ? "0" : "1");
      } catch {
        // This session only.
      }
      return !open;
    });
  }, []);
  /** Back to the desk (§4.1 "‹"): nothing open. */
  const openDesk = useCallback(() => {
    setNotebookId(null);
    setPageId(null);
    setEngine(null);
    setView("desk");
  }, []);
  const [hand, setHand] = useState<WritingHand>("right");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHand(readWritingHand());
  }, []);
  /** When ink last went down (the pencil case tucks itself away during long writing). */
  const [writing, setWriting] = useState(0);
  useEffect(
    () =>
      engine?.subscribe((change) => {
        if (change === "draw") setWriting(Date.now());
      }),
    [engine],
  );
  /** The lane is 18 % of the sheet, 150–200 px (§4.2). */
  const sheet = useRef<HTMLDivElement>(null);
  const [laneWidth, setLaneWidth] = useState<number>(LANE.minWidth);
  useEffect(() => {
    const element = sheet.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      setLaneWidth(
        Math.round(Math.min(LANE.maxWidth, Math.max(LANE.minWidth, width * LANE.share))),
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [view]);
  const folded = useMarkPrefs((s) => (rootId ? s.prefsFor(rootId).hideUntilDone : false));
  const markLevel = useMarkPrefs((s) => s.levelFor(rootId));
  const mascot = useMascotState();
  const laneDot: NebDotState = markLevel === "off" ? "off" : MASCOT_DOT[mascot];
  /** Circle & ask from the pencil case: a hold, as if Ctrl+Alt were held; tapped again, it asks. */
  const toggleCircle = () => {
    if (holding === null) {
      mew.hold.start();
      setHolding((n) => (n ?? 0) + 1);
      return;
    }
    setHolding(null);
    mew.hold.release(Date.now());
  };
  // K10 §8.2: the lasso's selection, for "neb read:" on that line.
  const [lassoed, setLassoed] = useState<readonly Stroke[] | null>(null);
  // K10 §8.2: what helps read a line here (the notebook's subject, its chapter's words).
  const { setReadingContext } = mew;
  const readingPath = notebookId ? tree.path(notebookId) : [];
  const readingSubject = readingPath[0]?.subject ?? null;
  const readingTitles = readingPath.map((n) => n.title).join("\u0000");
  useEffect(() => {
    setReadingContext({
      subject: readingSubject,
      vocabulary: readingTitles ? readingTitles.split("\u0000") : [],
    });
  }, [setReadingContext, readingSubject, readingTitles]);
  // The day's budget for live marking spent (§7.5): Quiet until tomorrow, and the student is told.
  useEffect(
    () =>
      useMarkPrefs.subscribe((state, previous) => {
        if (state.quietUntil > previous.quietUntil) {
          setNotice({
            text: "Live marks are on Quiet for the rest of today: today's budget is used.",
            tone: "info",
          });
        }
      }),
    [],
  );
  useTreeShortcuts(
    {
      newNotebook: treeActions.startCreating,
      newChapter: () => rootId && treeActions.addChild(rootId),
      newPage: () => notebookId && treeActions.addPage(notebookId),
      rename: () => notebookId && treeActions.setRenamingId(notebookId),
      jump: () => treeActions.setPaletteOpen(true),
      importPdf: () => setImporting({ nodeId: notebookId, file: null }),
      reorder: (step) => notebookId && treeActions.reorder(notebookId, step),
    },
    keys.platform,
    keys.own,
  );

  const exportLine = async () => {
    if (!engine) return;
    const crop = await cropCurrentLine(engine.doc, { marks: isShown });
    if (!crop) {
      setNotice({ text: "Write something first — there's no line to export.", tone: "info" });
      return;
    }
    downloadBlob(crop.blob, `mew-line-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    setNotice({ text: `Exported current line (${crop.width}×${crop.height} px).`, tone: "info" });
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      {view !== "desk" && contentsOpen && (
        <Sidebar
          notebooks={
            <TreeNav
              tree={tree}
              currentId={notebookId}
              renamingId={treeActions.renamingId}
              draft={treeActions.draft}
              trashCount={tree.trash().length}
              counts={unsortedCount}
              newNotebookShortcut={keys.shown("new_notebook")}
              onOpen={openNode}
              onCreateNotebook={treeActions.startCreating}
              onAddChild={treeActions.addChild}
              onAddPage={treeActions.addPage}
              onStartRename={treeActions.setRenamingId}
              onRename={treeActions.rename}
              onMove={treeActions.move}
              onReorder={treeActions.reorder}
              onMoveTo={treeActions.setMovingId}
              onKeepOffline={treeActions.keepOffline}
              onDelete={treeActions.requestDelete}
              onOpenTrash={() => treeActions.setTrashOpen(true)}
            />
          }
          onQuiz={courseId ? () => void quiz.start(courseId) : null}
        />
      )}
      <main className="relative flex min-w-0 flex-1 flex-col bg-desk">
        {view !== "desk" && notebookId && (
          <PageHeader
            tree={tree}
            nodeId={notebookId}
            pageNumber={
              view === "page" ? (pages.find((p) => p.id === pageId)?.index ?? 0) + 1 : null
            }
            rootId={rootId}
            folded={folded}
            checkKeys={keys.shown("check_work")}
            page={view === "page"}
            onDesk={openDesk}
            onContents={toggleContents}
            onOpenHome={openHome}
            onFold={() => rootId && useMarkPrefs.getState().setHideUntilDone(rootId, !folded)}
          />
        )}
        <div className="relative flex min-h-0 flex-1">
          {view === "page" && (
            <div
              className={`flex w-[96px] shrink-0 items-center justify-center ${hand === "left" ? "order-last" : ""}`}
            >
              <PencilCase
                hand={hand}
                onHand={setHand}
                onUndo={actions.undo}
                onRedo={actions.redo}
                onCircle={toggleCircle}
                writing={writing}
              />
            </div>
          )}
          <div className={`flex min-w-0 flex-1 flex-col ${view === "page" ? "pb-1" : ""}`}>
            <div
              ref={sheet}
              data-testid={view === "page" ? "sheet" : undefined}
              className={
                view === "page"
                  ? "relative flex min-h-0 flex-1 rounded-[6px] bg-paper shadow-sh-3"
                  : "relative flex min-h-0 flex-1"
              }
            >
              {view === "page" && engine && (
                <NebLane
                  canvas={canvas}
                  live={mew.live}
                  width={laneWidth}
                  folded={folded}
                  dot={laneDot}
                  onWhy={(mark) => mew.askAboutLine(mark.lineStrokeIds)}
                  onUnfold={() => rootId && useMarkPrefs.getState().setHideUntilDone(rootId, false)}
                  onDot={mew.summon}
                />
              )}
              <div className="relative min-w-0 flex-1 overflow-hidden rounded-[6px]">
                {view === "desk" ? (
                  nodes ? (
                    <Desk
                      tree={tree}
                      unsortedId={unsortedNodeId(userId)}
                      now={now}
                      name={name}
                      moments={moments}
                      dueCounts={dueCounts}
                      dueTotal={dueTotal}
                      exam={exam ? { title: exam.title, days: exam.daysLeft } : null}
                      loadCounts={loadCounts}
                      keys={{ jump: keys.shown("jump"), newNotebook: keys.shown("new_notebook") }}
                      onOpen={openNode}
                      onOpenMoment={(moment) => openMoment(moment, true)}
                      onQuickCheck={() => openQuickCheck()}
                      onJump={() => treeActions.setPaletteOpen(true)}
                      onNewNotebook={treeActions.startCreating}
                      onDropPdf={(nodeId, file) => setImporting({ nodeId, file })}
                    />
                  ) : (
                    <div className="h-full bg-desk" aria-busy="true" />
                  )
                ) : view === "home" && node ? (
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
                    onImportPdf={() => setImporting({ nodeId: node.id, file: null })}
                    moments={moments.filter((m) => subtreeIds(tree, node.id).has(m.nodeId))}
                    dueCounts={dueCounts}
                    onOpenMoment={(moment) => openMoment(moment)}
                    inNeb={inNeb}
                    onOpenInNeb={openInNeb}
                    onQuickCheck={() => openQuickCheck({ nodeIds: [...subtreeIds(tree, node.id)] })}
                    onSetSubject={(subject) =>
                      void repo.tree.setSubject(node.id, subject).catch(report)
                    }
                    {...(node.id === unsortedNodeId(userId) && {
                      unsorted: { onFile: fileMoment, onChoose: setChoosingFor },
                    })}
                  />
                ) : engine && engine.pageId === pageId ? (
                  <NotebookCanvas
                    ref={canvas}
                    engine={engine}
                    onPenDown={mew.penDown}
                    tutorInk={mew.ink}
                    leftInset={quizActive ? QUIZ_CARD_INSET : 0}
                    onSelection={setLassoed}
                  />
                ) : (
                  <div className="grid h-full place-items-center text-sm text-muted">
                    Opening notebook…
                  </div>
                )}

                {/* Mounted with the page's canvas (keyed by page), so the notes subscribe to the camera
            of the canvas that's actually shown and scroll with the page, never over it. */}
                {engine && view === "page" && engine.pageId === pageId && (
                  <EntryNotes key={engine.pageId} canvas={canvas} images={engine.images} />
                )}

                {engine && view === "page" && (
                  <SourceHighlight canvas={canvas} images={engine.images} />
                )}

                {engine && view === "page" && <NotebookPointer canvas={canvas} ink={mew.ink} />}

                {engine && view === "page" && (
                  <MarkLayer
                    canvas={canvas}
                    live={mew.live}
                    onWhy={(mark) => mew.askAboutLine(mark.lineStrokeIds)}
                    kinds={TICKS}
                  />
                )}
                {engine && view === "page" && (
                  <ReadAsChip canvas={canvas} live={mew.live} selection={lassoed} />
                )}

                {engine && view === "page" && (
                  <SolutionLayer
                    canvas={canvas}
                    pageId={engine.pageId}
                    flow={mew.showThenYou}
                    records={solutionRecords}
                    checkShortcut={keys.shown("check_work")}
                  />
                )}

                {engine && (
                  <NotesMarks
                    canvas={canvas}
                    marks={marks}
                    focusId={focus?.findingId ?? null}
                    db={db}
                    ink={mew.ink}
                  />
                )}

                {engine && view === "page" && holding !== null && (
                  <HoldCircle key={holding} canvas={canvas} onLoop={mew.hold.circle} />
                )}

                {clipImage && !quizActive && (
                  <div className="pointer-events-none absolute inset-x-0 top-3 flex flex-col items-center gap-2 px-4">
                    <ClipSource
                      image={clipImage}
                      {...(clipImage.ocrText &&
                        !checking && { onCheck: () => checkAgainstNotes(clipImage) })}
                      {...(scannedPages.has(clipImage.id) && {
                        onRecognize: () => recognizePage(clipImage),
                        reading: readingPage === clipImage.id,
                      })}
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
                        <button
                          type="button"
                          className="opacity-80"
                          onClick={() => setCheckPrompt(null)}
                        >
                          Not now
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="pointer-events-none absolute top-4 left-4">
                  <QuizCard session={quiz} />
                </div>

                <div className="pointer-events-none absolute right-4 bottom-24">
                  <ShortcutsNotice hidden={app.showIntro || quizActive} />
                </div>

                {view !== "desk" && (
                  <div className="pointer-events-none absolute right-4 bottom-4">
                    <MewDock
                      onSummon={mew.summon}
                      onStartListening={mew.startListening}
                      onStopListening={mew.stopListening}
                    />
                  </div>
                )}

                {debugOpen && (
                  <div className="pointer-events-none absolute top-4 right-4 bottom-20">
                    <DebugPanel onSimulateUtterance={mew.say} onSummon={mew.summon} />
                  </div>
                )}

                <div
                  aria-live="polite"
                  className="pointer-events-none absolute inset-x-0 bottom-20 z-50 flex justify-center px-4"
                >
                  {notice && (
                    <p
                      className={`pointer-events-auto flex items-center gap-3 rounded-full px-4 py-2 text-sm shadow-lg ${"bg-ink text-paper"}`}
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
                      You&apos;re offline. Your notes are saved on this device; Neb needs a
                      connection.
                    </p>
                  )}
                </div>
              </div>
            </div>
            {view === "page" && engine && (
              <div className="flex items-center gap-4 px-1 pt-2">
                <ReplayBar
                  engine={engine}
                  moments={moments.filter((m) => m.pageId === pageId).map((m) => m.createdAt)}
                  onHide={(ids) => useNotebookUi.getState().setPageReplayHidden(ids)}
                />
                <PageTools
                  onZoom={actions.zoom}
                  onResetView={actions.resetView}
                  onExportLine={() => void exportLine().catch(report)}
                  marks={<MarksMenu notebookId={rootId} pageId={pageId} />}
                  pageNav={
                    pageId && (
                      <PageNav
                        pages={pages}
                        currentPageId={pageId}
                        onSelect={setPageId}
                        onAdd={() => notebookId && treeActions.addPage(notebookId)}
                      />
                    )
                  }
                />
              </div>
            )}
          </div>
          {view === "page" && rootId && (
            <div className="flex w-[150px] shrink-0 items-center">
              <ChapterTabs
                tree={tree}
                rootId={rootId}
                openId={notebookId}
                addKeys={keys.shown("new_chapter")}
                onOpen={openNode}
                onAdd={() => treeActions.addChild(rootId)}
              />
            </div>
          )}
        </div>
        <div className="pointer-events-none absolute top-20 right-2 bottom-20 z-40 flex flex-col items-end">
          <NotesCheckPanel />
        </div>
      </main>
      {importing && (
        <ImportPdfDialog
          open
          tree={tree}
          nodeId={importing.nodeId}
          file={importing.file}
          onImport={importPdf}
          onClose={() => setImporting(null)}
        />
      )}
      <QuickCheck
        onListen={mew.startListening}
        inNeb={inNeb}
        onOpenInNeb={openInNeb}
        findMoment={momentOf}
        onReplay={(clipId) => {
          const moment = momentOf(clipId);
          if (moment) openMoment(moment, true);
          else setNotice({ text: "That moment isn't on this device.", tone: "info" });
        }}
      />
      <DestinationPicker
        open={choosingFor !== null}
        title="File this moment in…"
        tree={tree}
        topLevel={false}
        refuse={(destination) =>
          destination === unsortedNodeId(userId)
            ? "it's here"
            : destination === choosingFor?.nodeId
              ? "already here"
              : null
        }
        onPick={(destination) => {
          const moment = choosingFor;
          setChoosingFor(null);
          if (moment && destination) {
            void fileMoment(moment, destination).catch(() =>
              setNotice({ text: "Couldn't file that just now. Try again.", tone: "error" }),
            );
          }
        }}
        onClose={() => setChoosingFor(null)}
      />
      <TreeDialogs
        moments={moments}
        onOpenMoment={(moment) => openMoment(moment)}
        onFromPdf={(input) => {
          treeActions.cancelCreating();
          void repo.tree
            .createNotebook({ ...input, chapters: [] })
            .then((made) => {
              openNode(made.id);
              setImporting({ nodeId: made.id, file: null });
            })
            .catch(report);
        }}
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

/** The time now, updated every minute ("edited 5 minutes ago" stays right). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
