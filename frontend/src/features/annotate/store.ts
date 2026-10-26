import type { Annotation } from "@mew/shared";
import { create } from "zustand";

/** The open marks on the page on screen (K9), for their tap targets. */
type LiveMarksState = {
  pageId: string | null;
  marks: readonly Annotation[];
  set(pageId: string | null, marks: readonly Annotation[]): void;
};

export const useLiveMarks = create<LiveMarksState>()((set) => ({
  pageId: null,
  marks: [],
  set: (pageId, marks) => set({ pageId, marks }),
}));
