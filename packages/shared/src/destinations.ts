import { z } from "zod";

import { type ChildLabel } from "./notebook";

/**
 * "Save it to my Physics notebook, chapter 5" (K3, docs/NOTEBOOKS_K.md §4.3): from the words a
 * student says or types to a node of their own notebook tree. Deterministic first:
 *
 * 1. **Normalise**: lowercase; drop "my", "the", "notebook", "please"…; number words and ordinals
 *    after (or before) a level word become digits ("chapter five", "fifth chapter", "ch5",
 *    "chap. 5", "chapter iv"); chapter, unit, week, topic, module, section and lesson are all
 *    level words (a notebook calls its chapters what it likes).
 * 2. **Split into path segments** by the level words and "of / in / under": "physics chapter 5",
 *    "chapter 5 of physics" and "the kinematics chapter in physics" are all [physics] › [...].
 * 3. **Score every node** along its path: title similarity per segment (exact, words, prefix,
 *    Jaro–Winkler), the number (in the title, strongly; as the nth child, weakly), plus small
 *    boosts for the open notebook and recent destinations.
 * 4. **Decide**: ≥ 0.85 and ≥ 0.15 ahead of the next → that node; close candidates → up to three
 *    chips (never a guess); a clear parent without the asked-for child → "Create it and save";
 *    nothing ≥ 0.5 → none (the server may ask the gate model to pick an id, §4.3 step 5).
 *
 * Titles are the student's own data; nothing here logs them.
 */

export const DESTINATION_LIMITS = {
  phraseChars: 160,
  /** At most this many choices are offered when it's not clear (§4.3 step 4). */
  choices: 3,
  resolveAt: 0.85,
  marginAt: 0.15,
  candidateAt: 0.5,
  /** Entries on one "From screen" page before the next one starts (decision 7). */
  entriesPerFromScreenPage: 30,
  /** A destination stays the default for the same source this long (§4.3 step 7). */
  stickyMs: 2 * 60 * 60 * 1000,
} as const;

/** Which page of the node an entry goes to. */
export const DestinationPage = z.discriminatedUnion("kind", [
  /** The node's "From screen" page (one per node, decision 7). */
  z.object({ kind: z.literal("from_screen") }),
  z.object({ kind: z.literal("new") }),
  /** "On page 3": the node's third page (pages live on the device, so by number). */
  z.object({ kind: z.literal("number"), number: z.number().int().min(1).max(999) }),
]);
export type DestinationPage = z.infer<typeof DestinationPage>;

export const DestinationMethod = z.enum(["exact", "fuzzy", "model", "picker", "sticky", "default"]);
export type DestinationMethod = z.infer<typeof DestinationMethod>;

/** A destination the resolver (or the student) settled on. */
export const ResolvedDestination = z.object({
  nodeId: z.uuid(),
  /** Titles from the notebook down, for the chip and the toast ("Physics › Chapter 5"). */
  path: z.array(z.string().min(1).max(200)).min(1).max(3),
  page: DestinationPage,
  confidence: z.number().min(0).max(1),
  method: DestinationMethod,
});
export type ResolvedDestination = z.infer<typeof ResolvedDestination>;

/** What the words came to. */
export const DestinationResolution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resolved"), destination: ResolvedDestination }),
  /** Close candidates: the student picks (chips). */
  z.object({
    kind: z.literal("ambiguous"),
    choices: z.array(ResolvedDestination).min(1).max(DESTINATION_LIMITS.choices),
  }),
  /** The parent is clear but the child isn't there: "Create it and save · Pick another". */
  z.object({
    kind: z.literal("missing"),
    parentId: z.uuid(),
    parentPath: z.array(z.string().min(1).max(200)).min(1).max(3),
    title: z.string().min(1).max(80),
    page: DestinationPage,
  }),
  z.object({ kind: z.literal("none") }),
]);
export type DestinationResolution = z.infer<typeof DestinationResolution>;

/**
 * Where a saved entry goes, as stored with it (the device lays it out): a node and its page, or a
 * child to create first under `nodeId` (the student tapped "Create it and save").
 */
export const SavedDestination = z.object({
  nodeId: z.uuid(),
  page: DestinationPage,
  create: z.object({ title: z.string().trim().min(1).max(80) }).optional(),
  /** The titles it had when chosen ("Physics › Chapter 5"), for the toast and a sticky default. */
  path: z.array(z.string().min(1).max(200)).min(1).max(3).optional(),
});
export type SavedDestination = z.infer<typeof SavedDestination>;

/** Where a saved moment came from, as far as "the same source" goes (§4.3 step 7, §4.6). */
export const DestinationSource = z.object({
  app: z.string().max(64).nullable().optional(),
  title: z.string().max(300).optional(),
  url: z.string().max(2000).optional(),
});
export type DestinationSource = z.infer<typeof DestinationSource>;

/** `POST /api/screen/destinations/resolve` (device token): what the student said or typed. */
export const DestinationResolveRequest = z.object({
  phrase: z.string().trim().min(1).max(DESTINATION_LIMITS.phraseChars),
  source: DestinationSource.optional(),
});
export type DestinationResolveRequest = z.infer<typeof DestinationResolveRequest>;

export const DestinationResolveResponse = z.object({ resolution: DestinationResolution });

/** `GET /api/screen/destinations` (device token): the picker's places, titles only. */
export const DestinationTree = z.object({
  places: z
    .array(
      z.object({
        nodeId: z.uuid(),
        path: z.array(z.string().min(1).max(200)).min(1).max(3),
      }),
    )
    .max(500),
});
export type DestinationTree = z.infer<typeof DestinationTree>;

/**
 * What makes two moments "the same source": the same YouTube video, the same PDF (by file name,
 * in a browser or a reader), the same web page (site and path), or the same window of an app.
 * Null when there's nothing to go on.
 */
export function sourceKey(source: DestinationSource | undefined): string | null {
  if (!source) return null;
  const url = source.url ?? "";
  const video =
    /^https:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([\w-]{6,20})/.exec(url) ??
    /^https:\/\/youtu\.be\/([\w-]{6,20})/.exec(url);
  if (video?.[1]) return `youtube:${video[1]}`;
  const page = /^https:\/\/([^/?#]+)(\/[^?#]*)?/.exec(url);
  if (page?.[1]) {
    const path = page[2] ?? "/";
    const file = /([^/]+\.pdf)$/i.exec(path)?.[1];
    return file ? `pdf:${file.toLowerCase()}` : `web:${page[1].toLowerCase()}${path}`;
  }
  const title = source.title?.trim().toLowerCase();
  const pdf = title ? /([^\\/:*?"<>|]+\.pdf)\b/.exec(title)?.[1] : undefined;
  if (pdf) return `pdf:${pdf.trim()}`;
  if (source.app && title) return `app:${source.app}:${title.slice(0, 120)}`;
  return null;
}

/** A node as the resolver sees it (a device's `Notebook` or the server's `NotebookNodeSync`). */
export type DestinationNode = {
  id: string;
  parentId: string | null;
  title: string;
  position: string;
  childLabel?: ChildLabel;
  deletedAt?: number | null | undefined;
};

export type ResolveContext = {
  /** The node open in the notebook, if any (its notebook gets a small boost). */
  currentNodeId?: string | null;
  /** Recent destinations, newest first (a small boost each). */
  recentNodeIds?: readonly string[];
};

// ─── Normalising ─────────────────────────────────────────────────────────────────────────────

const LEVEL_WORDS: Record<string, string> = {
  chapter: "chapter",
  chapters: "chapter",
  chap: "chapter",
  ch: "chapter",
  unit: "unit",
  units: "unit",
  week: "week",
  weeks: "week",
  wk: "week",
  topic: "topic",
  topics: "topic",
  module: "module",
  modules: "module",
  mod: "module",
  section: "section",
  sections: "section",
  sec: "section",
  lesson: "lesson",
  lessons: "lesson",
  lecture: "lesson",
  lec: "lesson",
  part: "part",
};

const FILLER = new Set([
  "my",
  "the",
  "a",
  "an",
  "notebook",
  "notebooks",
  "notes",
  "folder",
  "please",
  "pls",
  "called",
  "named",
  "number",
  "no",
  "num",
  "our",
  "this",
]);

const SMALL_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
};
const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  last: -1,
};
const ROMAN = /^(?=[ivxl]+$)(x{0,3})(ix|iv|v?i{0,3})$|^(xl|l)(x{0,3})(ix|iv|v?i{0,3})$/;

function romanValue(text: string): number | null {
  if (!ROMAN.test(text)) return null;
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50 };
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const value = values[text[i] ?? ""] ?? 0;
    const next = values[text[i + 1] ?? ""] ?? 0;
    total += value < next ? -value : value;
  }
  return total > 0 ? total : null;
}

/** A number written as digits ("5", "5th", "1.2"), or null. */
function digits(token: string): string | null {
  const match = /^(\d{1,3}(?:\.\d{1,2})?)(?:st|nd|rd|th)?$/.exec(token);
  return match?.[1] ?? null;
}

/** Reads a spoken number at tokens[i] (one or two words); its value and how many words it used. */
function spokenNumber(
  tokens: readonly string[],
  i: number,
): { value: number; used: number } | null {
  const word = tokens[i] ?? "";
  const tens = TENS[word];
  if (tens !== undefined) {
    const unit = SMALL_NUMBERS[tokens[i + 1] ?? ""];
    return unit !== undefined && unit > 0 && unit < 10
      ? { value: tens + unit, used: 2 }
      : { value: tens, used: 1 };
  }
  const small = SMALL_NUMBERS[word];
  return small === undefined ? null : { value: small, used: 1 };
}

/** The words of a phrase, lowercase, without punctuation (keeping "1.2"), "ch5" split. */
export function phraseTokens(text: string): string[] {
  const out: string[] = [];
  const cleaned = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/(\d)\.(\d)/g, "$1\u0000$2")
    .replace(/[^\p{L}\p{N}\u0000']+/gu, " ")
    .replace(/\u0000/g, ".");
  for (const raw of cleaned.split(/\s+/)) {
    const word = raw.replace(/^'+|'+$/g, "").replace(/'s$/, "");
    if (!word) continue;
    const glued = /^([a-z]+?)(\d{1,3}(?:\.\d{1,2})?)$/.exec(word);
    if (glued && glued[1] && LEVEL_WORDS[glued[1]] && glued[2]) out.push(glued[1], glued[2]);
    else out.push(word);
  }
  return out;
}

type Token =
  | { kind: "word"; text: string }
  | { kind: "level"; level: string }
  | { kind: "number"; value: string }
  /** "of", "in", "under"…: may split two levels ("chapter 5 of physics"), or be in a title. */
  | { kind: "split"; text: string };

const SPLITTERS = new Set(["of", "in", "under", "inside", "within", "from"]);

/** The phrase's tokens: words, level words, numbers (normalised), and "of/in/under" splits. */
function lex(tokens: readonly string[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i] ?? "";
    const level = LEVEL_WORDS[word];
    const previous = out.at(-1);
    const afterLevel = previous?.kind === "level";
    if (level) {
      // An ordinal before a level word: "the fifth chapter".
      if (previous?.kind === "word" && ORDINALS[previous.text] !== undefined) {
        const value = ORDINALS[previous.text] ?? 0;
        out.pop();
        out.push({ kind: "level", level }, { kind: "number", value: String(value) });
        continue;
      }
      out.push({ kind: "level", level });
      continue;
    }
    if (SPLITTERS.has(word)) {
      out.push({ kind: "split", text: word });
      continue;
    }
    if (FILLER.has(word)) continue;
    const number = digits(word);
    if (number !== null) {
      out.push({ kind: "number", value: number });
      continue;
    }
    if (afterLevel) {
      const spoken = spokenNumber(tokens, i);
      if (spoken) {
        out.push({ kind: "number", value: String(spoken.value) });
        i += spoken.used - 1;
        continue;
      }
      const ordinal = ORDINALS[word];
      if (ordinal !== undefined) {
        out.push({ kind: "number", value: String(ordinal) });
        continue;
      }
      const roman = romanValue(word);
      if (roman !== null) {
        out.push({ kind: "number", value: String(roman) });
        continue;
      }
    }
    out.push({ kind: "word", text: word });
  }
  return out;
}

/** One level of the path the student named: a name, a number, or both. */
export type Segment = { name: string | null; number: string | null; level: string | null };

/** Tokens as segments, outermost (the notebook) first; `splits` says which splitters split. */
function segmentsOf(tokens: readonly Token[], splits: readonly boolean[]): Segment[] {
  // "A of B": B holds A. Groups are read innermost first, then reversed.
  const groups: Token[][] = [[]];
  let at = 0;
  for (const token of tokens) {
    if (token.kind === "split") {
      if (splits[at++]) groups.push([]);
      else groups.at(-1)?.push({ kind: "word", text: token.text });
    } else groups.at(-1)?.push(token);
  }
  const segments: Segment[] = [];
  for (const group of groups.reverse()) {
    let current: Segment = { name: null, number: null, level: null };
    const words: string[] = [];
    const flush = () => {
      if (words.length > 0) current.name = words.splice(0).join(" ");
      // "physics ii": a numeral at the end of a name is its number.
      const roman = current.number === null && current.name?.split(" ");
      if (roman && roman.length >= 2) {
        const value = romanValue(roman.at(-1) ?? "");
        if (value !== null) {
          current.number = String(value);
          current.name = roman.slice(0, -1).join(" ");
        }
      }
      if (current.name !== null || current.number !== null) segments.push(current);
      current = { name: null, number: null, level: null };
    };
    group.forEach((token, i) => {
      if (token.kind === "level") {
        // "physics chapter 5": the words before a level word are the level above, unless they
        // name this one ("the kinematics chapter").
        const namesThisOne = i === group.length - 1;
        if (words.length > 0 && !namesThisOne) flush();
        else if (current.level !== null || current.number !== null) flush();
        current.level = token.level;
      } else if (token.kind === "number") {
        if (current.number !== null) flush();
        current.number = token.value;
      } else if (token.kind === "word") {
        words.push(token.text);
      }
    });
    flush();
  }
  return segments.slice(-3);
}

/**
 * Every way to read the phrase: each "of / in / under" either splits two levels or belongs to a
 * title ("history of science"); and a name of several words may also be two levels ("math
 * calculus"). Most splits first.
 */
function phraseReadings(phrase: string): Segment[][] {
  const tokens = lex(phraseTokens(phrase));
  const splitters = tokens.filter((t) => t.kind === "split").length;
  const readings: Segment[][] = [];
  const count = Math.min(splitters, 4);
  for (let mask = (1 << count) - 1; mask >= 0; mask--) {
    const splits = Array.from(
      { length: splitters },
      (_, i) => i < count && (mask & (1 << i)) !== 0,
    );
    const segments = segmentsOf(tokens, splits);
    if (segments.length > 0) readings.push(segments);
  }
  // "math calculus" as [math] › [calculus].
  for (const segments of [...readings]) {
    const only = segments.length === 1 ? segments[0] : undefined;
    const words = only?.name?.split(" ") ?? [];
    if (!only || only.number !== null || words.length < 2 || words.length > 4) continue;
    for (let cut = 1; cut < words.length; cut++) {
      readings.push([
        { name: words.slice(0, cut).join(" "), number: null, level: null },
        { name: words.slice(cut).join(" "), number: null, level: only.level },
      ]);
    }
  }
  return readings;
}

/** The phrase as path segments, outermost (the notebook) first (its first reading). */
export function phraseSegments(phrase: string): Segment[] {
  return phraseReadings(phrase)[0] ?? [];
}

/** Where the entry goes in the node: "on page 3", "on a new page" (default: "From screen"). */
export function phrasePage(phrase: string): { page: DestinationPage; rest: string } {
  const lower = phrase.toLowerCase();
  const cut = (index: number, length: number) =>
    (lower.slice(0, index) + lower.slice(index + length)).replace(/\s+/g, " ").trim();
  const numbered = /\b(?:on|to|onto)?\s*page\s+(\d{1,3}|[a-z]+)\b/.exec(lower);
  if (numbered?.[1]) {
    const value = digits(numbered[1]) ?? SMALL_NUMBERS[numbered[1]]?.toString();
    const number = value ? Math.trunc(Number(value)) : NaN;
    if (Number.isInteger(number) && number >= 1 && number <= 999) {
      return { page: { kind: "number", number }, rest: cut(numbered.index, numbered[0].length) };
    }
  }
  const fresh = /\b(?:on|to|onto|in)?\s*(?:a\s+)?new\s+page\b/.exec(lower);
  if (fresh) return { page: { kind: "new" }, rest: cut(fresh.index, fresh[0].length) };
  return { page: { kind: "from_screen" }, rest: phrase };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────────────────────

/** Jaro–Winkler similarity of two strings (0–1). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  for (let i = 0, j = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[j]) j++;
    if (a[i] !== b[j]) transpositions++;
    j++;
  }
  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Small words that don't tell titles apart. */
const STOP = new Set(["and", "of", "the", "a", "an", "in", "on", "to", "for", "with", "at"]);

type TitleInfo = {
  /** The title's words that tell it apart (no numbers, level words or small words). */
  words: string[];
  numbers: string[];
  levels: string[];
};

function titleInfo(title: string): TitleInfo {
  const tokens = lex(phraseTokens(title));
  const words = tokens.flatMap((t) =>
    t.kind === "word" ? [t.text] : t.kind === "split" ? [t.text] : [],
  );
  const numbers = tokens.flatMap((t) => (t.kind === "number" ? [t.value] : []));
  // "Physics II": a numeral at the end of a title is its number.
  const last = words.at(-1);
  const roman = words.length >= 2 && last ? romanValue(last) : null;
  if (roman !== null) {
    words.pop();
    numbers.push(String(roman));
  }
  return {
    words: words.filter((w) => !STOP.has(w)),
    numbers,
    levels: tokens.flatMap((t) => (t.kind === "level" ? [t.level] : [])),
  };
}

/** Chapter, unit, week, topic, module and lesson mean the same; a section or part is below. */
const levelKind = (level: string) => (level === "section" || level === "part" ? level : "chapter");

/**
 * How well a named segment fits a title (0–1): every word → 1; some of a longer title's words →
 * a little over 0.8 (so "Physics" beats "Physics II" by a clear margin); the start of a one-word
 * title ("phys", "chem", "bio") → 0.95; a near spelling → its Jaro–Winkler similarity, only when
 * close (≥ 0.9, so "cells" never looks like "calculus").
 */
function nameScore(name: string, title: TitleInfo, numbered: boolean): number {
  const said = name.split(" ").filter((w) => w && !STOP.has(w));
  const words = title.words;
  if (said.length === 0 || words.length === 0) return 0;
  // A number in a title without a level word is part of its name ("Physics II"), unless the
  // student said a number too (it's scored on its own).
  const extra = !numbered && title.levels.length === 0 ? title.numbers.length : 0;
  const size = words.length + extra;
  if (said.every((w) => words.includes(w))) {
    return said.length === size ? 1 : 0.78 + (0.04 * said.length) / size;
  }
  if (said.length === 1 && (said[0]?.length ?? 0) >= 3) {
    const start = said[0] ?? "";
    if (size === 1 && words[0]?.startsWith(start)) return 0.95;
    if (words.some((w) => w.startsWith(start))) return 0.78 + 0.04 / size;
  }
  const whole = jaroWinkler(said.join(" "), words.join(" "));
  const single = said.length === 1 && size === 1 ? jaroWinkler(said[0] ?? "", words[0] ?? "") : 0;
  const near = Math.max(whole, single);
  return near >= 0.9 ? near * 0.95 : 0;
}

/** How well a numbered segment fits a node: in its title, or (weakly) as the nth child. */
function numberScore(number: string, title: TitleInfo, nth: number): number {
  if (title.numbers.length > 0) return title.numbers.includes(number) ? 1 : 0;
  return String(nth) === number ? 0.7 : 0;
}

function segmentScore(segment: Segment, title: TitleInfo, nth: number): number {
  const scores: number[] = [];
  if (segment.name !== null) scores.push(nameScore(segment.name, title, segment.number !== null));
  if (segment.number !== null) scores.push(numberScore(segment.number, title, nth));
  if (scores.length === 0) return 0;
  const score = scores.reduce((a, b) => a + b, 0) / scores.length;
  // "Chapter 5" isn't "Section 5".
  const said = segment.level === null ? null : levelKind(segment.level);
  const named = title.levels.map(levelKind);
  return said !== null && named.length > 0 && !named.includes(said) ? score * 0.6 : score;
}

/** The live tree, with what scoring needs per node. */
class ScoringTree {
  readonly live: DestinationNode[];
  private readonly byId = new Map<string, DestinationNode>();
  private readonly infos = new Map<string, TitleInfo>();
  private readonly nths = new Map<string, number>();

  constructor(nodes: readonly DestinationNode[]) {
    for (const node of nodes) this.byId.set(node.id, node);
    const isLive = (node: DestinationNode): boolean => {
      for (let at: DestinationNode | undefined = node, n = 0; at && n < 5; n++) {
        if (at.deletedAt !== undefined && at.deletedAt !== null) return false;
        at = at.parentId === null ? undefined : this.byId.get(at.parentId);
      }
      return true;
    };
    this.live = nodes.filter(isLive);
    const siblings = new Map<string | null, DestinationNode[]>();
    for (const node of this.live) {
      const parent = node.parentId !== null && this.byId.has(node.parentId) ? node.parentId : null;
      siblings.set(parent, [...(siblings.get(parent) ?? []), node]);
    }
    for (const list of siblings.values()) {
      list
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
        .forEach((node, i) => this.nths.set(node.id, i + 1));
    }
    for (const node of this.live) this.infos.set(node.id, titleInfo(node.title));
  }

  get(id: string): DestinationNode | undefined {
    return this.byId.get(id);
  }

  path(id: string): DestinationNode[] {
    const path: DestinationNode[] = [];
    for (let at = this.byId.get(id); at && path.length < 4;) {
      path.unshift(at);
      at = at.parentId === null ? undefined : this.byId.get(at.parentId);
    }
    return path;
  }

  children(id: string): DestinationNode[] {
    return this.live.filter((n) => n.parentId === id);
  }

  score(segment: Segment, node: DestinationNode): number {
    const info = this.infos.get(node.id);
    return info ? segmentScore(segment, info, this.nths.get(node.id) ?? 0) : 0;
  }
}

/** The best alignment of segments (outermost first) to a path ending at its last node. */
function pathScore(
  tree: ScoringTree,
  segments: readonly Segment[],
  path: readonly DestinationNode[],
): number {
  const last = path.length - 1;
  const inner = segments.at(-1);
  const target = path[last];
  if (!inner || !target || segments.length > path.length) return 0;
  const innerScore = tree.score(inner, target);
  const outer = segments.slice(0, -1);
  if (outer.length === 0) return innerScore;
  // The outer segments go, in order, to the ancestors (some may be skipped).
  const ancestors = path.slice(0, last);
  let best = 0;
  const choose = (from: number, at: number, total: number, first: number) => {
    if (at === outer.length) {
      // Levels nobody named between the first named one and the target ("physics chapter 5"
      // reaching a section) cost a little.
      const between = last - first - outer.length;
      best = Math.max(best, total - between * 0.05 * segments.length);
      return;
    }
    for (let i = from; i <= ancestors.length - (outer.length - at); i++) {
      const segment = outer[at];
      const ancestor = ancestors[i];
      if (segment && ancestor) {
        choose(i + 1, at + 1, total + tree.score(segment, ancestor), at === 0 ? i : first);
      }
    }
  };
  choose(0, 0, 0, 0);
  return Math.max(0, (best + innerScore) / segments.length);
}

function destinationOf(
  tree: ScoringTree,
  node: DestinationNode,
  page: DestinationPage,
  confidence: number,
  method: DestinationMethod,
): ResolvedDestination {
  return {
    nodeId: node.id,
    path: tree.path(node.id).map((n) => n.title.slice(0, 200)),
    page,
    confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100,
    method,
  };
}

const capitalise = (text: string) =>
  text.replace(/(^|\s)\p{L}/gu, (letter) => letter.toUpperCase()).slice(0, 80);

function singularOf(label: ChildLabel | undefined): string {
  return (label ?? "Chapters").slice(0, -1);
}

/** A name the student gave alone ("cells") that only one node has: enough to go on. */
const UNIQUE_AT = 0.78;

/** Resolves what the student said to a node of `nodes` (K3 §4.3, steps 1–4 and 6). */
export function resolveDestination(
  phrase: string,
  nodes: readonly DestinationNode[],
  context: ResolveContext = {},
): DestinationResolution {
  const { page, rest } = phrasePage(phrase.slice(0, DESTINATION_LIMITS.phraseChars));
  const readings = phraseReadings(rest);
  if (readings.length === 0) return { kind: "none" };
  const tree = new ScoringTree(nodes);
  const current = context.currentNodeId ? tree.get(context.currentNodeId) : undefined;
  const currentRoot = current ? tree.path(current.id)[0]?.id : undefined;
  const recent = context.recentNodeIds ?? [];

  const scoreFor = (segments: readonly Segment[], node: DestinationNode) => {
    const path = tree.path(node.id);
    let score = pathScore(tree, segments, path);
    if (score <= 0) return 0;
    // A number with nothing else ("chapter 5"): in the open notebook, when there is one.
    if (segments.length === 1 && segments[0]?.name === null) {
      if (path.length < 2) return 0; // a notebook isn't "chapter 5"
      if (currentRoot && path[0]?.id !== currentRoot) score -= 0.2;
    }
    return score;
  };
  const scored = tree.live
    .map((node) => {
      let score = Math.max(...readings.map((segments) => scoreFor(segments, node)));
      if (score <= 0) return { node, score: 0, exact: false };
      const exact = readings.some((segments) => {
        const path = tree.path(node.id);
        return (
          segments.length === path.length &&
          segments.every((s, i) => {
            const at = path[i];
            return at !== undefined && tree.score(s, at) >= 0.999;
          })
        );
      });
      if (currentRoot && tree.path(node.id)[0]?.id === currentRoot) score += 0.05;
      const recency = recent.indexOf(node.id);
      if (recency >= 0) score += Math.max(0.01, 0.04 - recency * 0.01);
      return { node, score: Math.min(1, score), exact };
    })
    .filter((s) => s.score >= DESTINATION_LIMITS.candidateAt)
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const next = scored[1];
  const resolve = (s: NonNullable<typeof top>) => ({
    kind: "resolved" as const,
    destination: destinationOf(tree, s.node, page, s.score, s.exact ? "exact" : "fuzzy"),
  });
  if (top && top.score >= DESTINATION_LIMITS.resolveAt) {
    const clear = !next || top.score - next.score >= DESTINATION_LIMITS.marginAt - 1e-9;
    if (clear) return resolve(top);
  }
  for (const segments of readings) {
    const missing = missingChild(tree, segments, page);
    if (missing && (!top || top.score < DESTINATION_LIMITS.resolveAt)) return missing;
  }
  if (!top) return { kind: "none" };
  if (!next && top.score >= UNIQUE_AT) return resolve(top);
  const close = scored
    .filter((s) => s.score >= top.score - DESTINATION_LIMITS.marginAt)
    .slice(0, DESTINATION_LIMITS.choices)
    .map((s) => destinationOf(tree, s.node, page, s.score, "fuzzy"));
  return { kind: "ambiguous", choices: close };
}

/**
 * "There's no Chapter 5 in Physics yet": the outer segments name one node clearly, and none of
 * its children fits the innermost segment.
 */
function missingChild(
  tree: ScoringTree,
  segments: readonly Segment[],
  page: DestinationPage,
): DestinationResolution | null {
  const inner = segments.at(-1);
  const outer = segments.slice(0, -1);
  if (!inner || outer.length === 0) return null;
  const parents = tree.live
    .filter((node) => tree.path(node.id).length <= 2) // a child must fit under it (3 levels)
    .map((node) => ({ node, score: pathScore(tree, outer, tree.path(node.id)) }))
    .filter((s) => s.score >= DESTINATION_LIMITS.resolveAt)
    .sort((a, b) => b.score - a.score);
  const [parent, other] = parents;
  if (!parent) return null;
  if (other && parent.score - other.score < DESTINATION_LIMITS.marginAt - 1e-9) return null;
  const fits = tree.children(parent.node.id).some((child) => tree.score(inner, child) >= 0.85);
  if (fits) return null;
  const level = singularOf(parent.node.childLabel);
  const name = inner.name === null ? "" : capitalise(inner.name);
  const title =
    inner.number !== null ? `${level} ${inner.number}${name ? ` · ${name}` : ""}` : name;
  if (!title) return null;
  return {
    kind: "missing",
    parentId: parent.node.id,
    parentPath: tree.path(parent.node.id).map((n) => n.title.slice(0, 200)),
    title: title.slice(0, 80),
    page,
  };
}

/** Words that describe instead of naming ("the one about forces"): the model may help. */
export function looksDescriptive(phrase: string): boolean {
  return (
    /\b(about|on|with|where|that|which|for)\b/i.test(phrase) && phraseTokens(phrase).length >= 3
  );
}

// ─── Finding the destination in what was said ─────────────────────────────────────────────────

const SAVE_VERBS = "save|put|add|file|keep|store|stick|send|move";
const SAVE_OBJECTS = "it|this|that|these|those|them|the explanation|this one|that one";
const INTO = "to|in|into|under|on|onto|inside";

/** A save clause from its verb to the end: "save it to physics chapter 5". */
const SAVE_CLAUSE = new RegExp(
  `^(?:${SAVE_VERBS})(?:\\s+(?:${SAVE_OBJECTS}))?\\s+(?:${INTO})\\s+(.+?)\\s*[.!?]*$`,
  "i",
);
const SAVE_VERB = new RegExp(`\\b(?:${SAVE_VERBS})\\b`, "gi");
/** "save this to physics chapter 5 and explain it": a destination first, then the question. */
const LEADING = new RegExp(
  `^(?:please\\s+)?(?:${SAVE_VERBS})(?:\\s+(?:${SAVE_OBJECTS}))?\\s+(?:${INTO})\\s+(.+?)\\s*(?:,|\\band\\b)\\s+((?:explain|tell|show|why|what|how)\\b.+)$`,
  "i",
);
/** A destination phrase needs one of these, or a title the resolver finds. */
const NOTEBOOK_CUES = new RegExp(
  `\\b(?:my|notebook|notes|folder|${Object.keys(LEVEL_WORDS).join("|")})\\b|\\b(?:ch|chap|unit|wk|sec|lec)\\d`,
  "i",
);
/** What joins a question to its save clause ("…, and then", "… please"); a "?" stays. */
const JOINERS = /(?:\s*(?:[,;:&]|\band\b|\bthen\b|\balso\b|\bplease\b))+\s*$/i;
/** A word that makes the next one a noun ("this file", "the store"). */
const DETERMINER_BEFORE = /\b(?:this|that|the|a|an|my|your|its|our|their)\s+$/i;
/** A question about saving itself ("how do I save this to PDF?"), not a place to save. */
const ABOUT_SAVING = /^(?:how|can|could|should|where|why|what|do|does)\b/i;

export type DestinationSplit = {
  /** What's left to ask the tutor ("" when the words were only the save). */
  question: string;
  phrase: string;
  /** The phrase names a notebook-ish place on its face ("my …", a level word…). */
  cued: boolean;
};

/**
 * Takes the destination out of a question (§4.2: it isn't sent to the model as part of it):
 * "Explain this and save it to Physics chapter 5" → "Explain this" + "Physics chapter 5". Null
 * when there's none. A phrase without a cue ("how do I save this to PDF?") should only count if
 * the resolver finds it in the student's tree: check `cued`.
 */
export function splitDestination(text: string): DestinationSplit | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const leading = LEADING.exec(trimmed);
  if (leading?.[1] && leading[2]) {
    return {
      question: leading[2].trim(),
      phrase: leading[1].trim(),
      cued: NOTEBOOK_CUES.test(leading[1]),
    };
  }
  // The last save clause counts ("put it in context and save it to physics").
  const starts = [...trimmed.matchAll(SAVE_VERB)].map((m) => m.index).reverse();
  let found: { at: number; phrase: string } | null = null;
  for (const at of starts) {
    // "this file", "the store": after a determiner the "verb" is a noun.
    if (DETERMINER_BEFORE.test(trimmed.slice(0, at))) continue;
    const clause = SAVE_CLAUSE.exec(trimmed.slice(at));
    if (clause?.[1]) {
      found = { at, phrase: clause[1].trim() };
      break;
    }
  }
  if (!found) return null;
  const question = trimmed.slice(0, found.at).replace(JOINERS, "").trim();
  if (ABOUT_SAVING.test(question) && question.split(/\s+/).length <= 3) return null;
  return { question, phrase: found.phrase, cued: NOTEBOOK_CUES.test(found.phrase) };
}

// ─── Notebook commands by voice ──────────────────────────────────────────────────────────────

/** Create, rename or move by voice (§4.5): always confirmed with an undo toast; never delete. */
export type NotebookCommand =
  | { kind: "rename"; title: string }
  | { kind: "create"; level: "notebook" | "child"; title: string; parentPhrase: string | null }
  | { kind: "move"; phrase: string }
  /** Voice never deletes: the student is told to use the menu. */
  | { kind: "delete_refused" };

const LEVEL_PATTERN = `(?:notebook|${Object.keys(LEVEL_WORDS).join("|")}|page)`;

export function parseNotebookCommand(text: string): NotebookCommand | null {
  const words = text
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/^(?:hey\s+)?(?:neb|mew)[,\s]+/i, "")
    .replace(/^(?:please|can you|could you)\s+/i, "")
    .trim();
  if (new RegExp(`^(?:delete|remove|trash|erase)\\b`, "i").test(words)) {
    return { kind: "delete_refused" };
  }
  const rename = new RegExp(
    `^(?:rename|call)\\s+(?:this|the|my)?\\s*(?:current\\s+)?${LEVEL_PATTERN}?\\s*(?:to|as)?\\s+(.+)$`,
    "i",
  ).exec(words);
  if (rename?.[1]) {
    const title = rename[1].replace(/^(?:to|as)\s+/i, "").trim();
    return title ? { kind: "rename", title: title.slice(0, 80) } : null;
  }
  const create = new RegExp(
    `^(?:create|make|add|start|new)\\s+(?:a\\s+)?(?:new\\s+)?(${LEVEL_PATTERN})\\s+(?:called|named|for|titled)?\\s*(.+?)(?:\\s+(?:in|under|inside|to)\\s+(.+))?$`,
    "i",
  ).exec(words);
  if (create?.[1] && create[2]) {
    const level = create[1].toLowerCase() === "notebook" ? "notebook" : "child";
    if (create[1].toLowerCase() === "page") return null;
    return {
      kind: "create",
      level,
      title: create[2].trim().slice(0, 80),
      parentPhrase: level === "child" ? (create[3]?.trim() ?? null) : null,
    };
  }
  const move = new RegExp(
    `^move\\s+(?:this|it|the)?\\s*(?:current\\s+)?${LEVEL_PATTERN}?\\s*(?:to|into|under|in)\\s+(.+)$`,
    "i",
  ).exec(words);
  if (move?.[1]) return { kind: "move", phrase: move[1].trim() };
  return null;
}
