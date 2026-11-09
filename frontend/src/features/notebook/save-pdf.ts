"use client";

import {
  buildMomentsPdf,
  collectMoments,
  type MomentSource,
  type TextRenderer,
} from "./export-pdf";

/**
 * "Save as PDF" in the app (docs/PLAN.md, Part 3): the browser draws the words (every script it
 * has a font for), the clip's picture comes from our own route, and the file is downloaded.
 */

const STYLES = {
  title: { font: "600 40px system-ui, sans-serif", line: 52, color: "#1b1a17" },
  heading: { font: "600 30px system-ui, sans-serif", line: 44, color: "#1b1a17" },
  body: { font: "28px system-ui, sans-serif", line: 40, color: "#33302a" },
} as const;

/** Words wrapped to `width` pixels and drawn on a white canvas, as a PNG. */
export const canvasText: TextRenderer = async (lines, width) => {
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("No canvas to draw the words on");
  const rows: { text: string; style: keyof typeof STYLES }[] = [];
  for (const line of lines) {
    measure.font = STYLES[line.style].font;
    let row = "";
    for (const word of line.text.split(/(\s+)/)) {
      if (row && measure.measureText(row + word).width > width) {
        rows.push({ text: row.trimEnd(), style: line.style });
        row = word.trimStart();
      } else {
        row += word;
      }
    }
    rows.push({ text: row, style: line.style });
  }
  const height = rows.reduce((sum, row) => sum + STYLES[row.style].line, 0) + 8;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width);
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No canvas to draw the words on");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textBaseline = "top";
  let y = 4;
  for (const row of rows) {
    const style = STYLES[row.style];
    context.font = style.font;
    context.fillStyle = style.color;
    context.fillText(row.text, 0, y);
    y += style.line;
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The words couldn't be drawn");
  return { png: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height };
};

/** A clip's picture from our own route (the student's session, RLS, the bucket policy). */
export async function fetchClipImage(clipId: string) {
  const response = await fetch(`/api/clips/${clipId}/image`, { cache: "no-store" });
  if (!response.ok) return null;
  const type = response.headers.get("content-type") ?? "";
  const mime = type.includes("png") ? ("image/png" as const) : ("image/jpeg" as const);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime, ...size };
}

export type SavePdfScope =
  | { kind: "moment"; pageId: string; imageId: string }
  | { kind: "page"; pageId: string }
  | { kind: "chapter"; nodeId: string };

/** Builds the PDF for `scope` and downloads it. False when there was no moment to put in it. */
export async function savePdf(
  repo: Omit<MomentSource, "clipImage">,
  scope: SavePdfScope,
  title: string,
): Promise<boolean> {
  const pageIds =
    scope.kind === "chapter"
      ? (await repo.listPages(scope.nodeId)).map((page) => page.id)
      : [scope.pageId];
  const moments = await collectMoments(
    {
      // Called on the repository itself: its methods live on its class, not in a spread copy.
      listPages: (id) => repo.listPages(id),
      loadStrokes: (id) => repo.loadStrokes(id),
      loadImages: (id) => repo.loadImages(id),
      clipImage: fetchClipImage,
    },
    pageIds,
    title,
    scope.kind === "moment" ? scope.imageId : undefined,
  );
  if (moments.length === 0) return false;
  const bytes = await buildMomentsPdf(moments, canvasText);
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Neb"}.pdf`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
