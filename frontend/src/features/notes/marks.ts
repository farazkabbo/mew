import { unionBBox } from "@mew/ink";
import type { BBox, CheckedSource, NotesFinding } from "@mew/shared";

import { clock, safeLink } from "../notebook/clip-page";
import type { LocalNoteLine } from "./local-lines";

/**
 * Notes Check's marks on a notebook page (N4, brief §8), worked out from the findings and the
 * page's line records (pure). They're annotations beside the student's ink, never strokes:
 *
 * - a difference or an unclear line: an amber dotted underline with a "?" that opens the question;
 * - a gap: a "+" in the margin under the line it would follow;
 * - a match: a thin violet bracket beside the line, with a chip linking to the source.
 *
 * A difference or gap the student has settled (N5) stays as a faint check, so the page shows
 * what they worked through.
 */
export type PageMark =
  | {
      kind: "question";
      findingId: string;
      /** The lines' box, in page units. */
      box: BBox;
      question: string;
      unclear: boolean;
      settled: boolean;
    }
  | { kind: "gap"; findingId: string; box: BBox; question: string; settled: boolean }
  | { kind: "match"; findingId: string; box: BBox; link: SourceLink | null };

/** Where a match came from, as a link chip. */
export type SourceLink = { href: string | null; label: string };

export function pageMarks(
  findings: readonly NotesFinding[],
  lines: readonly LocalNoteLine[],
  {
    dismissed = new Set<string>(),
    settled = new Set<string>(),
    source,
  }: {
    dismissed?: ReadonlySet<string>;
    settled?: ReadonlySet<string>;
    source?: CheckedSource;
  } = {},
): PageMark[] {
  const live = lines.filter((line) => !line.removed);
  const boxOf = (ids: readonly string[]): BBox | null => {
    const boxes = live.filter((line) => ids.includes(line.id)).map((line) => line.bbox);
    return boxes.length > 0 ? boxes.reduce(unionBBox) : null;
  };
  const link = sourceLink(source);

  const marks: PageMark[] = [];
  for (const finding of findings) {
    if (dismissed.has(finding.id)) continue;
    switch (finding.type) {
      case "difference":
      case "unclear": {
        const box = boxOf(finding.lineIds);
        if (box) {
          marks.push({
            kind: "question",
            findingId: finding.id,
            box,
            question: finding.question ?? "Look at this line again?",
            unclear: finding.type === "unclear",
            settled: settled.has(finding.id),
          });
        }
        break;
      }
      case "gap": {
        const box = finding.insertAfterLineId ? boxOf([finding.insertAfterLineId]) : null;
        if (box) {
          marks.push({
            kind: "gap",
            findingId: finding.id,
            box,
            question: finding.question ?? "This isn't in your notes yet. Want to add it?",
            settled: settled.has(finding.id),
          });
        }
        break;
      }
      case "match": {
        const box = boxOf(finding.lineIds);
        if (box) marks.push({ kind: "match", findingId: finding.id, box, link });
        break;
      }
    }
  }
  return marks;
}

/** The chip of a match: the video at its moment, the page, or the saved clip. */
function sourceLink(source: CheckedSource | undefined): SourceLink | null {
  if (!source) return null;
  if (source.clipId) return { href: null, label: "From your clip" };
  const href = safeLink(source.url);
  if (!href) return null;
  const at = source.timestampSec === undefined ? "" : ` · ${clock(source.timestampSec)}`;
  return { href, label: `${source.title ?? "Source"}${at}` };
}
