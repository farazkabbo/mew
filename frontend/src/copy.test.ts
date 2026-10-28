import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Writing for neb (docs/NEB_APP_UI.md §3.9): no sentence a student reads says "wrong",
 * "incorrect", "error", "fail" or "easy" ("not yet", "check this", "almost" instead). Checked over
 * every sentence in the app's JSX text and string literals: anything with a space in it that
 * reads like words. Code names ("failed", "rename-error") have no spaces and aren't sentences.
 */
const ROOT = path.resolve(import.meta.dirname);
const FOLDERS = ["app", "components", "features"];
const BANNED = /\b(wrong|incorrect|errors?|fail(s|ed|ure)?|easy)\b/i;
/** Labels the spec keeps on purpose: K9's "Not wrong" on a mark (NEB_APP_UI §4.2). */
const KEPT = new Set(["Not wrong", "not wrong"]);
/** Never shown to students: developer pages, server routes (logs and API errors), tests. */
const ALLOWED_FILES = [
  /features[\\/]mew[\\/]DebugPanel/,
  /app[\\/]\(site\)[\\/]status/,
  /app[\\/]api[\\/]/,
  /\.test\.tsx?$/,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

/** Sentences: JSX text, and quoted strings with at least two words. */
function sentences(source: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  const push = (text: string, index: number) => {
    const t = text.trim();
    if (/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(t)) out.push({ text: t, line: lineOf(index) });
  };
  // JSX text, not TypeScript arrows (=>) or generics.
  for (const m of source.matchAll(/(?<![=\w-])>([^<>{}=;]+)</g)) push(m[1] ?? "", m.index);
  for (const m of source.matchAll(/"([^"\n]{3,})"|`([^`\n]{3,})`/g)) {
    push(m[1] ?? m[2] ?? "", m.index);
  }
  return out;
}

/** Lines that are code, not copy: logs, thrown and built errors, comments. */
function isCode(source: string, line: number): boolean {
  const text = source.split("\n")[line - 1] ?? "";
  return /console\.|throw new|new Error\(|super\(|^\s*(\/\/|\*|\/\*)/.test(text);
}

describe("neb's wording (§3.9)", () => {
  it("never tells a student they're wrong, failed, or that it's easy", () => {
    const found: string[] = [];
    for (const folder of FOLDERS) {
      for (const file of files(path.join(ROOT, folder))) {
        if (ALLOWED_FILES.some((re) => re.test(file))) continue;
        const source = readFileSync(file, "utf8");
        for (const { text, line } of sentences(source)) {
          if (BANNED.test(text) && !KEPT.has(text) && !isCode(source, line)) {
            found.push(`${path.relative(ROOT, file)}:${line}  ${text}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});
