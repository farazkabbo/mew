import { createCipheriv, randomBytes } from "node:crypto";

import { HANDOFF_MAGIC, type HandoffManifest, type HandoffPlaintext } from "@mew/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const MANIFEST: HandoffManifest = {
  version: 1,
  createdAt: "2026-11-24T10:00:00.000Z",
  sender: { name: "Faraz" },
  language: "en",
  window: { from: "2026-11-24T08:30:00.000Z", to: "2026-11-24T10:00:00.000Z" },
  brief: {
    title: "Fix duplicate waitlist emails",
    where: "VS Code · signup.ts line 42",
    goal: "Stop the waitlist sending two emails",
    tried: [{ text: "Added a unique index on email", momentId: "m1" }],
    blockers: [{ text: "The migration fails on existing duplicates", momentId: "m2" }],
    next: [{ text: "Run the dedupe script", kind: "command", target: "pnpm dedupe" }],
    openQuestions: [],
  },
  moments: [
    {
      id: "m1",
      at: "2026-11-24T09:00:00.000Z",
      app: "code.exe",
      window: "signup.ts - neb",
      crop: "m1.jpg",
      width: 10,
      height: 10,
      question: "why does it send twice?",
      ink: [],
    },
    {
      id: "m2",
      at: "2026-11-24T09:40:00.000Z",
      app: "windowsterminal.exe",
      window: "pnpm migrate",
      crop: "m2.jpg",
      width: 10,
      height: 10,
      question: "what does this error mean?",
      ink: [],
    },
  ],
  context: [],
  redactions: [{ kind: "email" }],
};

/** A package exactly as the desktop app builds it: "NEBH1" | nonce | ciphertext | tag. */
function seal(plain: HandoffPlaintext, key: Buffer): ArrayBuffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(plain)), cipher.final()]);
  const out = Buffer.concat([Buffer.from(HANDOFF_MAGIC), nonce, body, cipher.getAuthTag()]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("HANDOFF_KEY_SECRET", randomBytes(32).toString("base64"));
  vi.stubEnv("GEMINI_API_KEY", "test-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("handoff keys and packages", () => {
  it("wraps and unwraps a content key, and opens a desktop package with it", async () => {
    const { openPackage, unwrapKey, wrapKey } = await import("./handoff");
    const key = randomBytes(32);
    const wrapped = wrapKey(key.toString("base64"));
    expect(wrapped).not.toContain(key.toString("base64"));
    expect(unwrapKey(wrapped)).toBe(key.toString("base64"));
    const plain = { manifest: MANIFEST, files: { "m1.jpg": "AAAA", "m2.jpg": "AAAA" } };
    expect(openPackage(seal(plain, key), key.toString("base64")).manifest.brief.title).toBe(
      "Fix duplicate waitlist emails",
    );
  });

  it("refuses a package with the wrong key, a flipped byte or the wrong magic", async () => {
    const { openPackage } = await import("./handoff");
    const key = randomBytes(32);
    const sealed = new Uint8Array(seal({ manifest: MANIFEST, files: {} }, key));
    expect(() => openPackage(sealed.slice().buffer, randomBytes(32).toString("base64"))).toThrow();
    const flipped = sealed.slice();
    flipped[40] = flipped[40]! ^ 1;
    expect(() => openPackage(flipped.buffer, key.toString("base64"))).toThrow();
    const wrongMagic = sealed.slice();
    wrongMagic[0] = 0x41;
    expect(() => openPackage(wrongMagic.buffer, key.toString("base64"))).toThrow();
  });

  it("is off unless enabled, and then only for the beta", async () => {
    const { requireHandoff } = await import("./handoff");
    await expect(requireHandoff("user_1")).rejects.toMatchObject({ status: 404 });
    vi.stubEnv("HANDOFF_ENABLED", "1");
    vi.stubEnv("HANDOFF_BETA_USERS", "user_2");
    await expect(requireHandoff("user_1")).rejects.toMatchObject({ status: 404 });
    await expect(requireHandoff("user_2")).resolves.toBeUndefined();
    vi.stubEnv("HANDOFF_BETA_USERS", "*");
    await expect(requireHandoff("user_1")).resolves.toBeUndefined();
  });
});

describe("the walkthrough", () => {
  it("is written once for 50 concurrent first opens, then read from the cache", async () => {
    const { walkthroughFor } = await import("./handoff");
    let made = 0;
    const make = async () => {
      made++;
      await new Promise((r) => setTimeout(r, 30));
      return "Faraz was fixing emails. [moment:m1] He added an index.";
    };
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms / 10));
    const opens = await Promise.all(
      Array.from({ length: 50 }, () => walkthroughFor("h1", "en", make, wait)),
    );
    expect(new Set(opens).size).toBe(1);
    expect(made).toBe(1);
    await walkthroughFor("h1", "en", make, wait);
    expect(made).toBe(1);
    // Another language is its own script.
    await walkthroughFor("h1", "bn", make, wait);
    expect(made).toBe(2);
  });

  it("reads the brief out plainly when the model can't be used, inventing nothing", async () => {
    const { writeWalkthrough } = await import("./handoff");
    const failing = { generate: () => Promise.reject(new Error("down")) };
    const script = await writeWalkthrough(MANIFEST, "en", undefined, failing as never);
    expect(script).toContain("Fix duplicate waitlist emails");
    expect(script).toContain("[moment:m2]");
    expect(script).not.toMatch(/delete|drop|restart/i);
  });
});

describe("questions about a handoff", () => {
  const OUTSIDE = [
    "What's the production database password?",
    "Did Faraz talk to the marketing team?",
    "What's the budget for this?",
    "Which customer complained?",
    "What did the hidden email say?",
    "Why was the old system built in PHP?",
    "When is the launch date?",
    "Who approved this change?",
    "What does the staging server's IP look like?",
    "How long has the bug existed?",
  ];

  it.each(OUTSIDE)("says the sender didn't cover it: %s", async (question) => {
    const { answerQuestion } = await import("./handoff");
    // The model reports it isn't in the package (and even tries to say something anyway).
    const generate = vi.fn(() =>
      Promise.resolve({ answer: "Probably next Tuesday.", citations: ["m1"], covered: false }),
    );
    const answer = await answerQuestion(MANIFEST, question, "en", undefined, { generate } as never);
    expect(answer).toEqual({
      answer: "Faraz didn't cover that. Want to ask them?",
      citations: [],
      covered: false,
    });
    // The question went as data, beside the package, never as the instructions.
    const call = (generate.mock.calls[0] as unknown as [{ system: string }])[0];
    expect(call.system).not.toContain(question);
  });

  it("keeps only citations that are real moments", async () => {
    const { answerQuestion } = await import("./handoff");
    const generate = () =>
      Promise.resolve({
        answer: "The index fails on existing duplicates.",
        citations: ["m2", "m7"],
        covered: true,
      });
    const answer = await answerQuestion(MANIFEST, "why did it fail?", "en", undefined, {
      generate,
    } as never);
    expect(answer.citations).toEqual(["m2"]);
  });
});

describe("the brief", () => {
  const REQUEST = {
    senderName: "Faraz",
    snapshots: [],
    moments: MANIFEST.moments.map(({ id, at, app, window, question }) => ({
      id,
      at,
      app,
      window,
      question,
    })),
    inkLabels: {},
    crops: [],
  };

  it("drops citations of moments that don't exist", async () => {
    const { writeBrief } = await import("./handoff");
    const generate = () =>
      Promise.resolve({ ...MANIFEST.brief, blockers: [{ text: "x", momentId: "m9" }] });
    const { brief } = await writeBrief(REQUEST, "en", undefined, { generate } as never);
    expect(brief.blockers).toEqual([{ text: "x" }]);
  });

  it("retries once with the error, then falls back to the moments' own words", async () => {
    const { writeBrief } = await import("./handoff");
    const generate = vi.fn(() => Promise.reject(new Error("schema")));
    const made = await writeBrief(REQUEST, "en", undefined, { generate } as never);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(made.fallback).toBe(true);
    expect(made.brief.tried.map((t) => t.momentId)).toEqual(["m1", "m2"]);
  });
});
