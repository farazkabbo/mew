import "server-only";

import { z } from "zod";

import { HttpError } from "./http-error";
import type { UserApiMessages } from "./user-api";

/**
 * Notebook PDFs (K4, docs/NOTEBOOKS_K.md §5) between the browser and the API service, always as
 * the signed-in student (their files only: RLS and the bucket's folder policies). The file is
 * checked by its bytes here and parsed only in the service's sandbox.
 */

/** The largest import (the API service enforces its own PDF_MAX_MB too). */
export const MAX_PDF_BYTES = 100 * 1024 * 1024 + 1024;

export const PDF_MESSAGES: UserApiMessages = {
  unavailable: "Importing PDFs isn't available right now",
  notConfigured: "Importing PDFs isn't configured on the server",
  passThrough: new Map([
    [404, "Not found"],
    [413, "That PDF is too large to import"],
    [415, "That file isn't a PDF"],
  ]),
  failed: "Couldn't import that PDF",
  // "Neb can't import password-protected PDFs", "That PDF has too many pages to import"…
  ownDetail: new Set([422]),
};

export function pdfId(raw: string): string {
  const id = z.uuid().safeParse(raw);
  if (!id.success) throw new HttpError(404, "Not found");
  return id.data;
}

export function pageIndex(raw: string): number {
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0 || index > 999) throw new HttpError(404, "Not found");
  return index;
}

/** The file's name as shown (no folders, no control characters, at most 200 characters). */
export function fileName(raw: string | null): string {
  const name = (raw ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (name || "document.pdf").slice(0, 200);
}
