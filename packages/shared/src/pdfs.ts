import { z } from "zod";

/**
 * PDFs into notebooks and chapters (K4, docs/NOTEBOOKS_K.md §5). Mirrors
 * backend/src/mew_api/pdfs/models.py. A PDF is imported once (kept privately for its owner); each
 * of its pages becomes a notebook page with the PDF page as a locked picture under the student's
 * ink, drawn as it's viewed and kept for offline use.
 */

export const PDF_LIMITS = {
  /** Defaults; the server's own (PDF_MAX_MB, PDF_MAX_PAGES) are the ones enforced. */
  bytes: 100 * 1024 * 1024,
  pages: 400,
  fileNameChars: 200,
  outline: 200,
  /** Pages drawn right after the import; the rest as they're viewed (§5.2). */
  firstPages: 10,
} as const;

export const PdfOutlineItem = z.object({
  title: z.string().min(1).max(200),
  /** 0-based. */
  pageIndex: z.number().int().nonnegative(),
});
export type PdfOutlineItem = z.infer<typeof PdfOutlineItem>;

export const PdfInfo = z.object({
  pdfId: z.uuid(),
  fileName: z.string().min(1).max(PDF_LIMITS.fileNameChars),
  pageCount: z.number().int().min(1).max(1000),
  outline: z.array(PdfOutlineItem).max(PDF_LIMITS.outline),
  courseId: z.uuid().nullable().default(null),
  /** Each page's [width, height] in points (only right after the import). */
  pageSizes: z
    .array(z.tuple([z.number().positive(), z.number().positive()]))
    .max(1000)
    .optional(),
});
export type PdfInfo = z.infer<typeof PdfInfo>;

export const PdfWord = z.object({
  text: z.string().max(100),
  /** [left, top, right, bottom], 0-1 of the page, from its top left. */
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
export type PdfWord = z.infer<typeof PdfWord>;

export const PdfPageText = z.object({
  text: z.string().max(20_000),
  words: z.array(PdfWord).max(5_000),
});
export type PdfPageText = z.infer<typeof PdfPageText>;

/** "Recognize text" on a scanned page (K4 §5.2): what the model read (no word boxes). */
export const PdfPageOcr = z.object({ text: z.string().max(20_000) });
export type PdfPageOcr = z.infer<typeof PdfPageOcr>;

/** Pages (1-based, inclusive) that went to one notebook node. */
export const PdfSection = z
  .object({
    nodeId: z.uuid(),
    firstPage: z.number().int().min(1),
    lastPage: z.number().int().min(1),
  })
  .refine((s) => s.lastPage >= s.firstPage, "a section ends after it starts");

/** `POST /api/pdfs/[id]/course`: "Use as course material". */
export const PdfCourseRequest = z.object({
  courseId: z.uuid().nullable(),
  title: z.string().trim().min(1).max(120),
  sections: z.array(PdfSection).min(1).max(200),
});
export type PdfCourseRequest = z.infer<typeof PdfCourseRequest>;

export const PdfCourseStarted = z.object({ courseId: z.uuid() });

/** Where a notebook page's picture comes from: page `pageIndex` (0-based) of an imported PDF. */
export const PdfPageRef = z.object({
  pdfId: z.uuid(),
  pageIndex: z.number().int().min(0).max(999),
});
export type PdfPageRef = z.infer<typeof PdfPageRef>;

// ─── Planning an import ──────────────────────────────────────────────────────────────────────

/** "40–62", "40-62", "7", "" (all): 1-based pages, inclusive; null when it isn't a range. */
export function parsePageRange(
  text: string,
  pageCount: number,
): { first: number; last: number } | null {
  const trimmed = text.trim();
  if (!trimmed) return { first: 1, last: pageCount };
  const match = /^(\d{1,4})\s*(?:[-–—]|to)\s*(\d{1,4})$|^(\d{1,4})$/.exec(trimmed);
  if (!match) return null;
  const first = Number(match[1] ?? match[3]);
  const last = Number(match[2] ?? match[3]);
  if (first < 1 || last < first || last > pageCount) return null;
  return { first, last };
}

/** A chapter the import will make: its title and pages (1-based, inclusive). */
export type PlannedChapter = { title: string; firstPage: number; lastPage: number };

export type ImportPlan = {
  /** Pages that go into the destination itself (no chapter: before the first chapter, or all). */
  loose: { firstPage: number; lastPage: number } | null;
  chapters: PlannedChapter[];
};

/**
 * Which pages go where (§5.1): with "Split into chapters", each top-level outline entry inside
 * the range becomes a chapter holding its pages up to the next entry, and pages before the first
 * entry stay in the destination; `skip` leaves out chapters the student unchecked (and their
 * pages), `titles` renames them. Without splitting, every page in the range goes into the
 * destination.
 */
export function planImport(
  info: Pick<PdfInfo, "pageCount" | "outline">,
  range: { first: number; last: number },
  split: boolean,
  { titles = new Map<number, string>(), skip = new Set<number>() } = {},
): ImportPlan {
  const starts = split
    ? info.outline
        .map((item, index) => ({ ...item, index, page: item.pageIndex + 1 }))
        .filter((item) => item.page >= range.first && item.page <= range.last)
        .filter((item, i, all) => i === 0 || item.page > (all[i - 1]?.page ?? 0))
    : [];
  if (starts.length === 0) {
    return { loose: { firstPage: range.first, lastPage: range.last }, chapters: [] };
  }
  const first = starts[0]?.page ?? range.first;
  const chapters = starts
    .map((start, i) => ({
      index: start.index,
      title:
        (titles.get(start.index) ?? start.title).trim().slice(0, 80) || start.title.slice(0, 80),
      firstPage: start.page,
      lastPage: (starts[i + 1]?.page ?? range.last + 1) - 1,
    }))
    .filter((chapter) => !skip.has(chapter.index))
    .map(({ title, firstPage, lastPage }) => ({ title, firstPage, lastPage }));
  return {
    loose: first > range.first ? { firstPage: range.first, lastPage: first - 1 } : null,
    chapters,
  };
}
