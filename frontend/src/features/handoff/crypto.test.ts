import { createCipheriv, randomBytes } from "node:crypto";

import { HANDOFF_MAGIC } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { openPackage } from "./crypto";

const MANIFEST = {
  version: 1,
  createdAt: "2026-11-24T10:00:00.000Z",
  sender: { name: "Faraz" },
  language: "en",
  window: { from: "2026-11-24T08:30:00.000Z", to: "2026-11-24T10:00:00.000Z" },
  brief: {
    title: "Fix duplicate waitlist emails",
    where: "",
    goal: "",
    tried: [],
    blockers: [],
    next: [],
    openQuestions: [],
  },
  moments: [],
  context: [],
  redactions: [],
};

function seal(plain: unknown, key: Buffer): ArrayBuffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(plain)), cipher.final()]);
  const out = Buffer.concat([Buffer.from(HANDOFF_MAGIC), nonce, body, cipher.getAuthTag()]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

describe("opening a package in the browser", () => {
  it("decrypts what the desktop app sealed, and refuses tampering", async () => {
    const key = randomBytes(32);
    const sealed = seal({ manifest: MANIFEST, files: {} }, key);
    const opened = await openPackage(sealed, key.toString("base64"));
    expect(opened.manifest.brief.title).toBe("Fix duplicate waitlist emails");
    const bad = new Uint8Array(sealed.slice(0));
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    await expect(openPackage(bad.buffer, key.toString("base64"))).rejects.toThrow();
    await expect(openPackage(sealed, randomBytes(32).toString("base64"))).rejects.toThrow();
  });
});
