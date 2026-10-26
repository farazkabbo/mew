import type { BBox, YourTurn } from "@mew/shared";

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

export class SolutionRecords {
  constructor(private readonly db: NotebookDb) {}

  forPage(pageId: string): Promise<LocalSolution[]> {
    return this.db.solutions.where("pageId").equals(pageId).sortBy("createdAt");
  }

  async save(record: LocalSolution): Promise<void> {
    await this.db.solutions.put(record);
  }
}
