import {
  type ImportPlan,
  type Notebook,
  type NotebookTree,
  PDF_LIMITS,
  type PdfCourseRequest,
  type PdfInfo,
} from "@mew/shared";

import type { NotebookRepository } from "../notebook/repository";

/**
 * Carrying out a PDF import (K4 §5.1) once the student pressed Import: chapters made for the
 * plan's chapters, the pages laid in, the first pages drawn at once (the rest as they're viewed),
 * and, with "Use as course material", the PDF handed to the course (a new course linked to the
 * notebook when it had none; concepts are found in the background, never waited for here).
 */

export type ImportChoice = {
  /** The node the PDF goes into. */
  nodeId: string;
  plan: ImportPlan;
  courseMaterial: boolean;
};

export type ImportResult = {
  /** The first page made (opened after the import). */
  firstPageId: string | null;
  chapters: Notebook[];
  /** The course it became material for, when asked. */
  courseId: string | null;
  /** "Use as course material" didn't go through (the pages are there anyway). */
  courseFailed: boolean;
};

type Deps = {
  repo: NotebookRepository;
  tree: NotebookTree<Notebook>;
  makeCourseMaterial: (pdfId: string, request: PdfCourseRequest) => Promise<string>;
};

export async function carryOutImport(
  info: PdfInfo,
  choice: ImportChoice,
  { repo, tree, makeCourseMaterial }: Deps,
): Promise<ImportResult> {
  const pdf = {
    pdfId: info.pdfId,
    fileName: info.fileName,
    pageCount: info.pageCount,
    sizes: info.pageSizes ?? [],
  };
  const sections: PdfCourseRequest["sections"] = [];
  let firstPageId: string | null = null;
  const note = (pages: readonly { id: string }[]) => {
    firstPageId ??= pages[0]?.id ?? null;
  };

  const { loose, chapters: planned } = choice.plan;
  if (loose) {
    note(await repo.addPdfPages(choice.nodeId, pdf, loose.firstPage, loose.lastPage));
    sections.push({ nodeId: choice.nodeId, firstPage: loose.firstPage, lastPage: loose.lastPage });
  }
  const chapters: Notebook[] = [];
  for (const chapter of planned) {
    const made = await repo.tree.addChild(choice.nodeId, chapter.title, { withPage: false });
    const nodeId = made?.id ?? choice.nodeId; // a section can't hold chapters: pages go in it
    if (made) chapters.push(made);
    note(await repo.addPdfPages(nodeId, pdf, chapter.firstPage, chapter.lastPage));
    sections.push({ nodeId, firstPage: chapter.firstPage, lastPage: chapter.lastPage });
  }

  // The first pages are drawn now, the rest as they're viewed (§5.2).
  const first = sections[0]?.firstPage ?? 1;
  const early = Array.from({ length: PDF_LIMITS.firstPages }, (_, i) => first - 1 + i).filter(
    (i) => i < info.pageCount,
  );
  void repo.pdfCache.keep(info.pdfId, early).catch(() => undefined);

  let courseId: string | null = null;
  let courseFailed = false;
  if (choice.courseMaterial && sections.length > 0) {
    const root = tree.path(choice.nodeId)[0] ?? tree.get(choice.nodeId);
    try {
      courseId = await makeCourseMaterial(info.pdfId, {
        courseId: root?.courseId ?? null,
        title: (root?.title ?? info.fileName.replace(/\.pdf$/i, "")).slice(0, 120) || "My course",
        sections,
      });
      if (root && !root.courseId) await repo.tree.setCourse(root.id, courseId);
    } catch {
      courseFailed = true;
    }
  }
  return { firstPageId, chapters, courseId, courseFailed };
}
