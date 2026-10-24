import type { FindingStatus, NotesCheckResult, NotesFinding } from "@mew/shared";
import { create } from "zustand";

const MARKS_HIDDEN_KEY = "mew:notes-marks-hidden";

/** How the student's follow-up on one finding is going (N5). */
export type FindingProgress = {
  status: FindingStatus;
  /** What the tutor last said about it (a reply to their answer, or an explanation). */
  reply?: string | undefined;
  /** Waiting for the server. */
  busy: boolean;
  /** Answers that still differed: after two, the tutor explains instead of asking again. */
  misses: number;
  /** A gap's heading is written on the page; what the student writes under it gets checked. */
  headingWritten?: boolean;
  /** The line's text when last seen, to re-check a difference once each time it changes. */
  lineText?: string | undefined;
};

const NEW_PROGRESS: FindingProgress = { status: "open", busy: false, misses: 0 };

type NotesCheckState = {
  /** The latest check (from the desktop app, or run from the notebook). */
  result: NotesCheckResult | null;
  panelOpen: boolean;
  /** "Hide marks": the notebook's marks stay off until shown again (remembered). */
  marksHidden: boolean;
  /** Findings the student dismissed (no evidence recorded: brief §8). */
  dismissed: ReadonlySet<string>;
  /** A finding to bring into view; `at` makes a repeated request a new one. */
  focus: { findingId: string; at: number } | null;
  /** A check started in the notebook is running. */
  running: boolean;
  error: string | null;
  /** Follow-ups by finding id. */
  progress: Readonly<Record<string, FindingProgress>>;
  /** A page's findings still open on the server (its marks after a reload), by page id. */
  restored: Readonly<Record<string, readonly NotesFinding[]>>;
};

type Actions = {
  show(result: NotesCheckResult): void;
  start(): void;
  fail(message: string): void;
  openPanel(): void;
  closePanel(): void;
  toggleMarks(): void;
  dismiss(findingId: string): void;
  focusFinding(findingId: string): void;
  track(findingId: string, change: Partial<FindingProgress>): void;
  restore(pageId: string, findings: readonly NotesFinding[]): void;
};

/**
 * Notes Check's state in the web app (N4): the latest findings, which ones the student set
 * aside, and what the panel and the marks are showing. Marks are drawn from this, beside the
 * ink, never into it.
 */
export const useNotesCheck = create<NotesCheckState & Actions>()((set) => ({
  result: null,
  panelOpen: false,
  marksHidden: readHidden(),
  dismissed: new Set(),
  focus: null,
  running: false,
  error: null,
  progress: {},
  restored: {},
  show: (result) =>
    set({ result, panelOpen: true, dismissed: new Set(), running: false, error: null }),
  start: () => set({ running: true, error: null, panelOpen: true }),
  fail: (message) => set({ running: false, error: message, panelOpen: true }),
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false, error: null }),
  toggleMarks: () =>
    set((state) => {
      writeHidden(!state.marksHidden);
      return { marksHidden: !state.marksHidden };
    }),
  dismiss: (findingId) => set((state) => ({ dismissed: new Set([...state.dismissed, findingId]) })),
  focusFinding: (findingId) => set({ focus: { findingId, at: Date.now() }, panelOpen: true }),
  track: (findingId, change) =>
    set((state) => ({
      progress: {
        ...state.progress,
        [findingId]: { ...(state.progress[findingId] ?? NEW_PROGRESS), ...change },
      },
    })),
  restore: (pageId, findings) =>
    set((state) => ({ restored: { ...state.restored, [pageId]: findings } })),
}));

/** The finding's follow-up so far (a fresh one when nothing has happened yet). */
export function progressOf(
  state: Pick<NotesCheckState, "progress">,
  findingId: string,
): FindingProgress {
  return state.progress[findingId] ?? NEW_PROGRESS;
}

/**
 * Whether the server has the finding, so it can be followed up: the latest check was stored,
 * or it was restored from the server. (A check that couldn't be stored still shows its marks.)
 */
export function isStored(
  state: Pick<NotesCheckState, "result" | "restored">,
  findingId: string,
): boolean {
  if (state.result?.checkId && state.result.findings.some((f) => f.id === findingId)) return true;
  return Object.values(state.restored).some((list) => list.some((f) => f.id === findingId));
}

/** A finding by id, from the latest check or the restored ones. */
export function findingById(
  state: Pick<NotesCheckState, "result" | "restored">,
  findingId: string,
): NotesFinding | null {
  return (
    state.result?.findings.find((f) => f.id === findingId) ??
    Object.values(state.restored)
      .flat()
      .find((f) => f.id === findingId) ??
    null
  );
}

function readHidden(): boolean {
  try {
    return globalThis.localStorage?.getItem(MARKS_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean): void {
  try {
    localStorage.setItem(MARKS_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}
