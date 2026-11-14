import type { ImageBlock, Page, Stroke } from "@mew/shared";
import { PDFDocument, rgb } from "pdf-lib";

/**
 * Saved moments as a PDF (docs/PLAN.md, Part 3): "export to PDF" for a moment, a page or a
 * chapter. Laid out here, with no model call: each moment gets a page with its picture, the
 * tutor's and the student's ink drawn over it as vectors, the explanation as a numbered list, the
 * check question to practise with, and the date. The words are drawn by the browser (any
 * language, any script) and placed as a picture; the ink stays vector.
 */

/** One stroke over the picture: points and width as fractions of the picture's width/height. */
export type PdfStroke = { color: string; width: number; points: readonly [number, number][] };

export type PdfMoment = {
  title: string;
  date: Date;
  image: { bytes: Uint8Array; mime: "image/jpeg" | "image/png"; width: number; height: number };
  strokes: readonly PdfStroke[];
  turns: NonNullable<ImageBlock["entry"]>["turns"];
};

/** A block of words drawn as a PNG `width` pixels wide (the browser's canvas in the app). */
export type TextRenderer = (
  lines: readonly { text: string; style: "title" | "heading" | "body" }[],
  width: number,
) => Promise<{ png: Uint8Array; width: number; height: number }>;

const PAGE = { width: 595.28, height: 841.89, margin: 40 } as const;
/** The picture's most of the page's height, so the explanation fits under it. */
const MAX_PICTURE_HEIGHT = 380;
/** Text is drawn at twice the PDF's size, so it stays sharp when printed. */
const TEXT_SCALE = 2;

export async function buildMomentsPdf(
  moments: readonly PdfMoment[],
  renderText: TextRenderer,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(moments[0]?.title ?? "Neb moments");
  pdf.setProducer("Neb");
  const usable = PAGE.width - 2 * PAGE.margin;
  for (const moment of moments) {
    let page = pdf.addPage([PAGE.width, PAGE.height]);
    let top = PAGE.height - PAGE.margin;

    const header = await renderText(
      [
        { text: moment.title, style: "title" },
        { text: moment.date.toDateString(), style: "body" },
      ],
      usable * TEXT_SCALE,
    );
    top = await placePng(pdf, page, header, top);

    // The picture, fitted to the width (and to the picture's share of the height).
    const picture =
      moment.image.mime === "image/png"
        ? await pdf.embedPng(moment.image.bytes)
        : await pdf.embedJpg(moment.image.bytes);
    const scale = Math.min(usable / moment.image.width, MAX_PICTURE_HEIGHT / moment.image.height);
    const [w, h] = [moment.image.width * scale, moment.image.height * scale];
    const left = PAGE.margin;
    const bottom = top - 8 - h;
    page.drawImage(picture, { x: left, y: bottom, width: w, height: h });
    for (const stroke of moment.strokes) {
      const path = stroke.points
        .map(([x, y], i) => `${i === 0 ? "M" : "L"} ${(x * w).toFixed(2)} ${(y * h).toFixed(2)}`)
        .join(" ");
      if (!path) continue;
      // drawSvgPath reads the path top-down from (x, y): the picture's top-left corner.
      page.drawSvgPath(path, {
        x: left,
        y: bottom + h,
        borderColor: hexColor(stroke.color),
        borderWidth: Math.max(stroke.width * w, 0.6),
        borderOpacity: stroke.color.length === 9 ? 0.4 : 1,
      });
    }
    top = bottom - 14;

    // The explanation, then the check questions to practise with.
    const lines: { text: string; style: "title" | "heading" | "body" }[] = [];
    const practice: string[] = [];
    for (const turn of moment.turns) {
      if (turn.question) lines.push({ text: turn.question, style: "heading" });
      turn.steps.forEach((step, i) => lines.push({ text: `${i + 1}. ${step}`, style: "body" }));
      if (turn.summary) lines.push({ text: turn.summary, style: "body" });
      if (turn.followUpQuestion) practice.push(turn.followUpQuestion);
    }
    if (practice.length > 0) {
      lines.push({ text: "Practise", style: "heading" });
      practice.forEach((q, i) => lines.push({ text: `${i + 1}. ${q}`, style: "body" }));
    }
    if (lines.length === 0) continue;
    const note = await renderText(lines, usable * TEXT_SCALE);
    if (top - note.height / TEXT_SCALE < PAGE.margin) {
      page = pdf.addPage([PAGE.width, PAGE.height]);
      top = PAGE.height - PAGE.margin;
    }
    await placePng(pdf, page, note, top);
  }
  return pdf.save();
}

/** Places a rendered block of words at `top`, scaled down to the page; returns its bottom. */
async function placePng(
  pdf: PDFDocument,
  page: ReturnType<PDFDocument["addPage"]>,
  block: { png: Uint8Array; width: number; height: number },
  top: number,
): Promise<number> {
  const image = await pdf.embedPng(block.png);
  const [w, h] = [block.width / TEXT_SCALE, block.height / TEXT_SCALE];
  page.drawImage(image, { x: PAGE.margin, y: top - h, width: w, height: h });
  return top - h;
}

function hexColor(hex: string) {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

/** The ink drawn over an entry's picture, as fractions of it (strokes elsewhere are left out). */
export function strokesOver(image: ImageBlock, strokes: readonly Stroke[]): PdfStroke[] {
  const ids = image.entry?.strokeIds ? new Set(image.entry.strokeIds) : null;
  const over = (s: Stroke) =>
    ids
      ? ids.has(s.id)
      : s.bbox[0] >= image.x &&
        s.bbox[1] >= image.y &&
        s.bbox[0] + s.bbox[2] <= image.x + image.width &&
        s.bbox[1] + s.bbox[3] <= image.y + image.height;
  return strokes.filter(over).map((s) => ({
    color: s.color,
    width: s.width / image.width,
    points: s.points.map(
      ([x, y]) => [(x - image.x) / image.width, (y - image.y) / image.height] as [number, number],
    ),
  }));
}

/** What exporting needs from the notebook: its pages, ink and pictures. */
export type MomentSource = {
  listPages(notebookId: string): Promise<Page[]>;
  loadStrokes(pageId: string): Promise<Stroke[]>;
  loadImages(pageId: string): Promise<ImageBlock[]>;
  /** A clip's picture, as stored on the server. */
  clipImage(clipId: string): Promise<PdfMoment["image"] | null>;
};

/** The moments on these pages, in page order and top to bottom; `onlyImageId` keeps just one. */
export async function collectMoments(
  source: MomentSource,
  pageIds: readonly string[],
  title: string,
  onlyImageId?: string,
): Promise<PdfMoment[]> {
  const moments: PdfMoment[] = [];
  for (const pageId of pageIds) {
    const [images, strokes] = await Promise.all([
      source.loadImages(pageId),
      source.loadStrokes(pageId),
    ]);
    const entries = images
      .filter((image) => image.entry && image.clipId)
      .filter((image) => !onlyImageId || image.id === onlyImageId)
      .sort((a, b) => a.y - b.y);
    for (const image of entries) {
      const picture = image.clipId ? await source.clipImage(image.clipId) : null;
      if (!picture || !image.entry) continue;
      moments.push({
        title,
        date: new Date(image.createdAt),
        image: picture,
        strokes: strokesOver(image, strokes),
        turns: image.entry.turns,
      });
    }
  }
  return moments;
}
