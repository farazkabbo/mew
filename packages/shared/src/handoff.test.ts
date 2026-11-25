import { describe, expect, it } from "vitest";

import cases from "./handoff-redaction.cases.json";
import {
  fallbackBrief,
  HandoffBrief,
  HandoffCreateRequest,
  redactText,
  scriptSegments,
  spokenWords,
  stripSecretParams,
} from "./handoff";

describe("handoff redaction", () => {
  // Stored in fragments, so no scanner sees a whole fake token.
  it.each(cases.cases)("hides the $kind in %#", ({ text, hidden, kept }) => {
    const out = redactText(text.join("")).text;
    expect(out).not.toContain(hidden.join(""));
    if (kept) expect(out).toContain(kept);
  });

  it.each(cases.clean)("leaves ordinary work text alone: %s", (text) => {
    const { text: out, found } = redactText(text);
    expect(out).toBe(text);
    expect(found).toEqual([]);
  });

  it("reports kinds and counts, never the values", () => {
    const { found } = redactText(`a@b.com and c@d.org, key sk-${"abcdefghij".repeat(2)}`);
    expect(found).toEqual(
      expect.arrayContaining([
        { kind: "email", count: 2 },
        { kind: "secret", count: 1 },
      ]),
    );
    expect(JSON.stringify(found)).not.toContain("a@b.com");
  });

  it("strips secret query values but keeps the rest of the address", () => {
    expect(stripSecretParams("https://x.io/a?token=abc&page=2&sig=zz#top")).toBe(
      "https://x.io/a?token=hidden&page=2&sig=hidden#top",
    );
  });
});

describe("handoff shapes", () => {
  it("validates a brief and caps it", () => {
    const brief = {
      title: "Fix duplicate waitlist emails",
      where: "VS Code · signup.ts line 42",
      goal: "Stop the waitlist sending two emails",
      tried: [{ text: "Added a unique index", momentId: "m1" }],
      blockers: [{ text: "Migration fails on prod data", momentId: "m2" }],
      next: [{ text: "Run the dedupe script", kind: "command", target: "pnpm dedupe" }],
      openQuestions: [],
    };
    expect(HandoffBrief.safeParse(brief).success).toBe(true);
    expect(
      HandoffBrief.safeParse({
        ...brief,
        next: [...brief.next, ...brief.next, ...brief.next, ...brief.next],
      }).success,
    ).toBe(false);
    expect(
      HandoffBrief.safeParse({ ...brief, tried: [{ text: "x", momentId: "javascript:1" }] })
        .success,
    ).toBe(false);
  });

  it("only takes a 32-byte key and known expiries", () => {
    const ok = {
      title: "x",
      senderName: "F",
      recipients: [{ email: "bob@example.com" }],
      expiresInDays: 7,
      sizeBytes: 10,
      contentKey: `${"A".repeat(43)}=`,
    };
    expect(HandoffCreateRequest.safeParse(ok).success).toBe(true);
    expect(HandoffCreateRequest.safeParse({ ...ok, expiresInDays: 3 }).success).toBe(false);
    expect(HandoffCreateRequest.safeParse({ ...ok, contentKey: "short" }).success).toBe(false);
    expect(HandoffCreateRequest.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("splits a script at its moment markers, ignoring unknown ones", () => {
    const script =
      "Faraz was fixing emails. [moment:m1] He added an index. [moment:m9] Odd. [moment:m2] It failed.";
    expect(scriptSegments(script, ["m1", "m2"])).toEqual([
      { momentId: null, text: "Faraz was fixing emails." },
      { momentId: "m1", text: "He added an index." },
      { momentId: "m1", text: "Odd." },
      { momentId: "m2", text: "It failed." },
    ]);
    expect(spokenWords(script)).toBe(11);
  });

  it("falls back to a brief from the moments' own words", () => {
    const brief = fallbackBrief(
      [{ id: "m1", app: "code.exe", window: "signup.ts - mew", question: "why twice?" }],
      { app: "code.exe", window: "signup.ts - mew" },
    );
    expect(HandoffBrief.safeParse(brief).success).toBe(true);
    expect(brief.tried[0]).toEqual({ text: "why twice?", momentId: "m1" });
  });
});
