import type {
  ImageBlock,
  ImageSource,
  MomentCheckView,
  Notebook,
  NotebookTree,
  Page,
  PdfWord,
} from "@mew/shared";

import { safeLink } from "../notebook/clip-page";

/**
 * Moments (K8, docs/NOTEBOOKS_K.md §4.7): every saved screen entry on this device, as the Moments
 * tab, Ctrl+K and the Quick check show it. Read from the pages the entries are on, so a moment is
 * wherever its entry is (moved by "Change" or "File these", it moves with it).
 */

export type SourceKind = "video" | "web" | "pdf" | "app";

export type Moment = {
  imageId: string;
  clipId: string;
  pageId: string;
  /** The node its entry is on. */
  nodeId: string;
  /** The first question asked about it. */
  question: string;
  createdAt: number;
  kind: SourceKind;
  /** "Lecture 5", "notes.pdf", the app's name. */
  sourceName: string;
  image: ImageBlock;
};

/** What a moment came from: a video, a web page, a PDF, or another app. */
export function sourceKind(source: ImageSource | undefined): SourceKind {
  const url = source?.url ?? "";
  if (/^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/watch|youtu\.be\/)/.test(url)) return "video";
  if (/^https:\/\/[^?#]+\.pdf(?:[?#]|$)/i.test(url)) return "pdf";
  if (/\.pdf\b/i.test(source?.title ?? "")) return "pdf";
  if (url.startsWith("https://")) return "web";
  return "app";
}

/** The entries among `images` (on `pages`), newest first. */
export function momentsFrom(images: readonly ImageBlock[], pages: readonly Page[]): Moment[] {
  const nodeOf = new Map(pages.map((p) => [p.id, p.notebookId]));
  const moments: Moment[] = [];
  for (const image of images) {
    const nodeId = nodeOf.get(image.pageId);
    const question = image.entry?.turns[0]?.question;
    if (!image.clipId || !image.entry || !nodeId || !question) continue;
    moments.push({
      imageId: image.id,
      clipId: image.clipId,
      pageId: image.pageId,
      nodeId,
      question,
      createdAt: image.createdAt,
      kind: sourceKind(image.source),
      sourceName: image.source?.title ?? image.source?.app.replace(/\.exe$/i, "") ?? "Your screen",
      image,
    });
  }
  return moments.sort((a, b) => b.createdAt - a.createdAt);
}

/** A node and everything under it (a notebook's Moments tab shows its chapters' too). */
export function subtreeIds(tree: NotebookTree<Notebook>, rootId: string): Set<string> {
  const ids = new Set([rootId]);
  const walk = (id: string) => {
    for (const child of tree.children(id)) {
      ids.add(child.id);
      walk(child.id);
    }
  };
  walk(rootId);
  return ids;
}

export type MomentFilter = { nodeIds?: ReadonlySet<string>; query?: string; kind?: SourceKind };

/** The Moments tab's search and source filter: every word must be in its question or source. */
export function filterMoments(moments: readonly Moment[], filter: MomentFilter): Moment[] {
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return moments.filter((m) => {
    if (filter.nodeIds && !filter.nodeIds.has(m.nodeId)) return false;
    if (filter.kind && m.kind !== filter.kind) return false;
    const text = [
      m.question,
      m.sourceName,
      ...(m.image.entry?.turns.flatMap((t) => [t.question, t.summary]) ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Words for a text fragment: the first line of the circled text with a few words on it. */
function fragmentWords(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const words = line
      .replace(/[^\p{L}\p{N}'’ -]+/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0 && w !== "-");
    if (words.length >= 3) return words.slice(0, 6).join(" ");
  }
  return null;
}

/** `#:~:text=` encodes "-", "," and "&" too: they're the directive's own syntax. */
function encodeFragment(words: string): string {
  return encodeURIComponent(words).replace(/-/g, "%2D").replace(/,/g, "%2C");
}

/**
 * "Open source" (§4.7): back to the exact spot. A video keeps its second (the desktop app put it
 * in the link); a web page gets a text fragment that scrolls to the circled words; a PDF on the
 * web opens as it was. Null when there's no safe link (another app: its name is shown instead).
 */
export function openSourceLink(image: ImageBlock): string | null {
  const link = safeLink(image.source?.url);
  if (!link) return null;
  if (sourceKind(image.source) !== "web" || link.includes(":~:")) return link;
  const words = image.ocrText ? fragmentWords(image.ocrText) : null;
  if (!words) return link;
  const hash = link.includes("#") ? "" : "#";
  return `${link}${hash}:~:text=${encodeFragment(words)}`;
}

/** Due checks now (K8 §4.7: "2 checks due"), counted on their node and every node above it. */
export function dueByNode(
  checks: readonly MomentCheckView[],
  tree: NotebookTree<Notebook>,
  now: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const check of checks) {
    if (!check.nodeId || Date.parse(check.dueAt) > now) continue;
    for (const node of tree.path(check.nodeId)) counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
  }
  return counts;
}

/** "Tue", or "Tue 14 Oct" past a week: "From your moment on Tue". */
export function momentDay(createdAt: number, now: number): string {
  const date = new Date(createdAt);
  const recent = now - createdAt < 6 * 86_400_000;
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    ...(!recent && { day: "numeric", month: "short" }),
  });
}

/**
 * The PDF file a moment was circled in ("week3.pdf"), from its link or its window title, or null
 * (K8 §4.7: an external PDF later imported into neb opens there, at the right page).
 */
export function pdfFileName(image: ImageBlock): string | null {
  const url = image.source?.url ?? "";
  const fromUrl = /\/([^/?#]+\.pdf)(?:[?#]|$)/i.exec(url)?.[1];
  const fromTitle = /([^\\/:*?"<>|]+\.pdf)\b/i.exec(image.source?.title ?? "")?.[1];
  const name = fromUrl ? safeDecode(fromUrl) : fromTitle;
  return name?.trim().toLowerCase() || null;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Words for matching: lower case, letters and digits only. */
function tokens(text: string): string[] {
  return text
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

/** How many of the circled words find their place on a PDF page (at least 3). */
const ANCHOR_WORDS = 6;
/** Misread words in a row let through while following the circled text along the page. */
const MISREADS = 2;

/** A few words of the circled text to find on a PDF's pages (normalised for matching). */
export function circledWords(image: ImageBlock): string | null {
  const words = tokens(image.ocrText ?? "").slice(0, ANCHOR_WORDS);
  return words.length >= 3 ? words.join(" ") : null;
}

/** [left, top, right, bottom], 0-1 of a PDF page from its top left (its words' boxes). */
export type PageBox = PdfWord["box"];

/**
 * Where a moment's circled text is on a PDF page in neb (K8 §4.7: "that page, with the circled
 * area highlighted"): its first words found among the page's words, then followed along the page
 * for as long as the rest keeps matching (a word or two the screen's OCR misread are let
 * through). One box per line of the page; none when the words aren't there.
 */
export function circledBoxes(words: readonly PdfWord[], ocrText: string): PageBox[] {
  const circled = tokens(ocrText);
  const anchor = circled.slice(0, ANCHOR_WORDS);
  if (anchor.length < 3) return [];
  // The page as tokens, each knowing its word ("ball," is "ball"; "x-ray" is "x" "ray").
  const page = words.flatMap((word, index) => tokens(word.text).map((token) => ({ token, index })));
  const start = page.findIndex((_, i) => anchor.every((token, k) => page[i + k]?.token === token));
  if (start === -1) return [];

  let end = start + anchor.length - 1;
  let p = end + 1;
  let misread = 0;
  for (let c = anchor.length; c < circled.length && p < page.length && misread <= MISREADS;) {
    if (page[p]?.token === circled[c]) {
      end = p;
      misread = 0;
      c++;
    } else {
      misread++;
      // A word missing on one side, or one misread on both.
      if (page[p + 1]?.token === circled[c]) p++;
      else if (page[p]?.token === circled[c + 1]) {
        c++;
        continue;
      } else c++;
    }
    p++;
  }

  const lines: PageBox[] = [];
  const first = page[start]?.index ?? 0;
  const last = page[end]?.index ?? first;
  for (const { box } of words.slice(first, last + 1)) {
    const line = lines.at(-1);
    const height = box[3] - box[1];
    if (line && Math.abs(box[1] - line[1]) < height / 2) {
      lines[lines.length - 1] = [
        Math.min(line[0], box[0]),
        Math.min(line[1], box[1]),
        Math.max(line[2], box[2]),
        Math.max(line[3], box[3]),
      ];
    } else lines.push([...box]);
  }
  return lines;
}

/** Whether a PDF page's text has these words in order (spacing and punctuation aside). */
export function pageHasWords(pageText: string, words: string): boolean {
  return ` ${tokens(pageText).join(" ")} `.includes(` ${words} `);
}
