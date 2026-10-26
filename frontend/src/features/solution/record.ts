import type { BBox, Stroke, YourTurn } from "@mew/shared";

import type { NotebookDb } from "../notebook/db";

/**
 * A worked solution on a page (K6 §6.1), kept on the device: its ink group (folded into a tab
 * after it's shown) and its Your Turn, with what the student did on it.
 */
export type LocalSolution = {
  id: string;
  pageId: string;
  createdAt: number;
  /** The solution's stroke group, and where it is on the page (the tab sits at its top). */
  groupId: string;
  bbox: BBox;
  folded: boolean;
  problem: string;
  courseId: string | null;
  /** Concepts the solution and its Your Turn practise (from the course). */
  conceptIds: string[];
  yourTurn: LocalYourTurn | null;
};

export type YourTurnStatus = "open" | "done" | "skipped";

export type LocalYourTurn = Pick<YourTurn, "problem" | "latex" | "answerKey" | "skill"> & {
  /**
   * A program to write (absent on older records): the answer key is what it prints, and this
   * reference program, run before the Your Turn was shown, printed it.
   */
  program?: string | null;
  groupId: string;
  /** Where the student writes the answer: inside the box, under the problem. */
  region: BBox;
  /** Peeked at the solution, or took a hint step: the answer counts `with_hint` (§6.5). */
  peeked: boolean;
  hinted: boolean;
  /** Wrong checks per line (by line id): after two, a hint step is offered. */
  misses: Record<string, number>;
  /** Lines already ticked, so a check doesn't tick them again. */
  ticked: string[];
  status: YourTurnStatus;
};

/** The solution written for a Circle & Ask entry (K7), by its image block's id. */
export function entrySolutionId(imageId: string): string {
  return `entry:${imageId}`;
}

/**
 * A worked solution's strokes on its page, to move it with its entry: its ink (folded or not), its
 * Your Turn box, and what's inside the box (the student's attempt and the marks on it).
 */
export function solutionStrokeIds(record: LocalSolution, strokes: readonly Stroke[]): string[] {
  const groups = new Set([record.groupId, record.yourTurn?.groupId].filter(Boolean));
  const box = record.yourTurn?.region;
  const inBox = ({ bbox: [x, y, w, h] }: Stroke) => {
    if (!box) return false;
    const [bx, by, bw, bh] = box;
    const cx = x + w / 2;
    const cy = y + h / 2;
    return cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh;
  };
  return strokes
    .filter((s) => (s.groupId !== undefined && groups.has(s.groupId)) || inBox(s))
    .map((s) => s.id);
}

/** The record once its strokes moved by (dx, dy) to another page, as the solution of `imageId`. */
export function movedSolution(
  record: LocalSolution,
  to: { pageId: string; imageId: string; dx: number; dy: number },
): LocalSolution {
  const shift = ([x, y, w, h]: BBox): BBox => [x + to.dx, y + to.dy, w, h];
  return {
    ...record,
    id: entrySolutionId(to.imageId),
    pageId: to.pageId,
    bbox: shift(record.bbox),
    yourTurn: record.yourTurn && { ...record.yourTurn, region: shift(record.yourTurn.region) },
  };
}

export class SolutionRecords {
  constructor(private readonly db: NotebookDb) {}

  forPage(pageId: string): Promise<LocalSolution[]> {
    return this.db.solutions.where("pageId").equals(pageId).sortBy("createdAt");
  }

  async save(record: LocalSolution): Promise<void> {
    await this.db.solutions.put(record);
  }
}
