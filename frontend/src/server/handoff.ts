import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { auth } from "@clerk/nextjs/server";
import {
  AskModelResponse,
  fallbackBrief,
  HANDOFF_ASK_PROMPT,
  HANDOFF_BRIEF_PROMPT,
  HANDOFF_MAGIC,
  HANDOFF_WALKTHROUGH_PROMPT,
  HandoffBrief,
  type HandoffBriefRequest,
  HandoffPlaintext,
  HandoffView,
  inLanguage,
  type NebLanguage,
  realCitations,
  renderBriefInput,
  renderPackageText,
  scriptSegments,
  spokenWords,
  unsafeReasons,
  WalkthroughModelResponse,
} from "@mew/shared";
import { z } from "zod";

import { ApiError, apiFetch, apiFetchBytes } from "./api-client";
import { isClerkConfigured } from "@/lib/auth-mode";
import { screenModel } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";
import { HttpError } from "./http-error";
import { learnerFacts } from "./learner-identity";
import { addTo, getJson, remove, setJson } from "./redis";

/**
 * Handoff on the web server (docs/HANDOFF_FEATURE.md, being built). The package's content key
 * arrives from the sender's desktop app over TLS and is stored only wrapped (AES-256-GCM under
 * HANDOFF_KEY_SECRET); it's unwrapped for signed-in members only, after the API service checked
 * the membership. Nothing here logs titles, briefs, questions, answers or addresses.
 */

// ─── The flag ─────────────────────────────────────────────────────────────────────────────────

/**
 * On only with HANDOFF_ENABLED=1, and for the beta: HANDOFF_BETA_USERS is "*" or a comma list of
 * user ids and emails. Off, every Handoff route answers 404.
 */
export async function requireHandoff(userId: string): Promise<void> {
  if (process.env.HANDOFF_ENABLED !== "1") throw new HttpError(404, "Not found");
  const beta = (process.env.HANDOFF_BETA_USERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (beta.includes("*") || beta.includes(userId.toLowerCase())) return;
  const email = (await learnerFacts(userId).catch(() => null))?.email ?? null;
  if (email && beta.includes(email)) return;
  throw new HttpError(404, "Not found");
}

// ─── Keys and packages ────────────────────────────────────────────────────────────────────────

function serverKey(): Buffer {
  const raw = process.env.HANDOFF_KEY_SECRET ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new HttpError(503, "Handoff isn't configured");
  return key;
}

/** The content key, wrapped by the server's key: base64(nonce | ciphertext | tag). */
export function wrapKey(contentKeyB64: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", serverKey(), nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.from(contentKeyB64, "base64")),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString("base64");
}

export function unwrapKey(wrapped: string): string {
  const bytes = Buffer.from(wrapped, "base64");
  if (bytes.length !== 12 + 32 + 16)
    throw new HttpError(410, "This handoff is no longer available");
  const decipher = createDecipheriv("aes-256-gcm", serverKey(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(44));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(12, 44)), decipher.final()]).toString(
      "base64",
    );
  } catch {
    throw new HttpError(500, "The handoff's key couldn't be read");
  }
}

/** Decrypts a package ("NEBH1" | nonce | ciphertext | tag) and checks its contents. */
export function openPackage(ciphertext: ArrayBuffer, contentKeyB64: string): HandoffPlaintext {
  const bytes = Buffer.from(ciphertext);
  const magic = Buffer.from(HANDOFF_MAGIC);
  if (bytes.length < magic.length + 12 + 16 || !bytes.subarray(0, magic.length).equals(magic)) {
    throw new HttpError(422, "That isn't a handoff package");
  }
  const nonce = bytes.subarray(magic.length, magic.length + 12);
  const body = bytes.subarray(magic.length + 12, bytes.length - 16);
  const tag = bytes.subarray(bytes.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(contentKeyB64, "base64"), nonce);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new HttpError(422, "The handoff package couldn't be opened");
  }
  const parsed = HandoffPlaintext.safeParse(JSON.parse(plain.toString("utf8")));
  if (!parsed.success) throw new HttpError(422, "The handoff package isn't valid");
  return parsed.data;
}

// ─── The API service ──────────────────────────────────────────────────────────────────────────

/** A member: their Clerk token (or local mode) and their verified email. */
export type Member = { userId: string; token: string | null; email: string | null };

export async function currentMember(userId: string): Promise<Member> {
  const facts = await learnerFacts(userId).catch(() => null);
  const email = facts?.verified ? facts.email : null;
  if (!isClerkConfigured) return { userId, token: null, email };
  const token = await (await auth()).getToken();
  if (!token) throw new HttpError(401, "Unauthorized");
  return { userId, token, email };
}

function memberHeaders(member: Member): { token?: string; headers: Record<string, string> } {
  const headers: Record<string, string> = member.email ? { "X-Mew-User-Email": member.email } : {};
  if (member.token) return { token: member.token, headers };
  return { headers: { ...headers, "X-Mew-Local-User": "local" } };
}

/** Upstream refusals as the same statuses (403, 404, 410…), with safe words. */
export function mapApi(error: unknown): never {
  if (!(error instanceof ApiError)) throw error;
  const known: Record<number, string> = {
    401: "Unauthorized",
    403: "This handoff wasn't shared with you. Ask the sender to add you.",
    404: "Not found",
    409: "The package hasn't been uploaded yet",
    410: "This handoff has expired or was revoked",
    413: "The package is too large",
    422: "That request wasn't valid",
  };
  const words = error.status === null ? undefined : known[error.status];
  if (error.status !== null && words) throw new HttpError(error.status, words);
  throw new HttpError(503, "Handoff is unavailable right now");
}

export async function memberApi<T>(
  member: Member,
  path: `/${string}`,
  schema: z.ZodType<T>,
  options: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  try {
    return await apiFetch(path, schema, {
      ...options,
      ...memberHeaders(member),
      timeoutMs: 10_000,
    });
  } catch (error) {
    return mapApi(error);
  }
}

export async function deviceApi<T>(
  token: string,
  email: string | null,
  path: `/${string}`,
  schema: z.ZodType<T>,
  options: {
    method?: "GET" | "POST" | "PUT";
    body?: unknown;
    raw?: { data: ArrayBuffer; contentType: string };
  } = {},
): Promise<T> {
  const headers: Record<string, string> = { "X-Mew-Device-Token": token };
  if (email) headers["X-Mew-User-Email"] = email;
  try {
    return await apiFetch(path, schema, { ...options, headers, timeoutMs: 30_000 });
  } catch (error) {
    return mapApi(error);
  }
}

export async function memberPackage(member: Member, id: string): Promise<ArrayBuffer> {
  try {
    const { bytes } = await apiFetchBytes(`/v1/handoffs/${id}/package`, {
      ...memberHeaders(member),
      timeoutMs: 30_000,
    });
    return bytes;
  } catch (error) {
    return mapApi(error);
  }
}

/** What a member may see, with the content key unwrapped (members only, checked upstream). */
export async function viewFor(member: Member, id: string) {
  const view = await memberApi(member, `/v1/handoffs/${id}`, HandoffView);
  const { wrappedKey, ...rest } = view;
  return { ...rest, contentKey: unwrapKey(wrappedKey) };
}

/** The package's plaintext, for the walkthrough and Q&A (decrypted here, never kept). */
export async function packageFor(member: Member, id: string) {
  const view = await viewFor(member, id);
  const plain = openPackage(await memberPackage(member, id), view.contentKey);
  return { view, manifest: plain.manifest };
}

export const NoContent = z.unknown();

// ─── The model ────────────────────────────────────────────────────────────────────────────────

export type HandoffModelDeps = { generate: GenerateStructured };
export const handoffModelDeps: HandoffModelDeps = { generate: generateStructured };

/** The brief: one call; on a schema failure one retry with the error, then a minimal brief. */
export async function writeBrief(
  request: HandoffBriefRequest,
  language: NebLanguage,
  signal?: AbortSignal,
  deps: HandoffModelDeps = handoffModelDeps,
): Promise<{ brief: HandoffBrief; fallback: boolean }> {
  const input = [
    {
      type: "text" as const,
      text: renderBriefInput({ ...request, language }),
    },
    ...request.crops.map((c) => ({
      type: "image" as const,
      base64: c.jpeg,
      mimeType: "image/jpeg" as const,
    })),
  ];
  const ids = new Set(request.moments.map((m) => m.id));
  let note = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const made = await deps.generate({
        model: screenModel(),
        purpose: "handoff-brief",
        system: inLanguage(HANDOFF_BRIEF_PROMPT.system, language) + note,
        input,
        schema: HandoffBrief,
        thinkingLevel: "low" as const,
        maxOutputTokens: 2048,
        timeoutMs: 20_000,
        ...(signal && { signal }),
      });
      // Citations that aren't moments of this session are dropped, not trusted.
      const cite = (items: { text: string; momentId?: string | undefined }[]) =>
        items.map((i) => (i.momentId && !ids.has(i.momentId) ? { text: i.text } : i));
      const brief = { ...made, tried: cite(made.tried), blockers: cite(made.blockers) };
      const texts = [
        brief.title,
        brief.where,
        brief.goal,
        ...brief.tried.map((t) => t.text),
        ...brief.next.map((n) => n.text),
      ];
      if (texts.some((t) => unsafeReasons(t).length > 0)) break;
      return { brief, fallback: false };
    } catch (error) {
      if (signal?.aborted) throw error;
      note = `\n\nYour last answer didn't match the schema (${error instanceof Error ? error.name : "error"}). Answer again with valid JSON only.`;
    }
  }
  const last = request.snapshots.at(-1);
  return { brief: fallbackBrief(request.moments, last), fallback: true };
}

const WALK_TTL_S = 30 * 24 * 3600;
const LOCK_TTL_S = 30;

/**
 * The walkthrough script for (handoff, language), made once: concurrent first opens wait for the
 * one generation (a Redis single-flight lock), and later opens read the cache.
 */
export async function walkthroughFor(
  id: string,
  language: NebLanguage,
  make: () => Promise<string>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  const key = `handoff:walk:${id}:${language}`;
  const cached = await getJson<string>(key);
  if (cached) return cached;
  const lock = `handoff:walk:lock:${id}:${language}`;
  if ((await addTo(lock, 1, LOCK_TTL_S)) === 1) {
    try {
      const script = await make();
      await setJson(key, script, WALK_TTL_S);
      return script;
    } finally {
      await remove(lock);
    }
  }
  for (let i = 0; i < 60; i++) {
    await wait(250);
    const ready = await getJson<string>(key);
    if (ready) return ready;
    if ((await getJson<number>(lock)) === null) break;
  }
  throw new HttpError(503, "The walkthrough is still being written. Try again in a moment.");
}

export async function writeWalkthrough(
  manifest: HandoffPlaintext["manifest"],
  language: NebLanguage,
  signal?: AbortSignal,
  deps: HandoffModelDeps = handoffModelDeps,
): Promise<string> {
  try {
    const made = await deps.generate({
      model: screenModel(),
      purpose: "handoff-walkthrough",
      system: inLanguage(HANDOFF_WALKTHROUGH_PROMPT.system, language),
      input: [{ type: "text" as const, text: renderPackageText(manifest) }],
      schema: WalkthroughModelResponse,
      thinkingLevel: "low" as const,
      maxOutputTokens: 1024,
      timeoutMs: 20_000,
      ...(signal && { signal }),
    });
    const words = spokenWords(made.script);
    if (words > 260 || unsafeReasons(made.script).length > 0) throw new Error("unusable script");
    return made.script;
  } catch {
    // The brief itself, read out plainly: still grounded, never invented.
    const b = manifest.brief;
    return [
      `${manifest.sender.name} was working on ${b.title}.`,
      b.where && `Where: ${b.where}.`,
      b.goal && `The goal: ${b.goal}.`,
      ...b.tried.map((t) => `${t.momentId ? `[moment:${t.momentId}] ` : ""}Tried: ${t.text}.`),
      ...b.blockers.map(
        (t) => `${t.momentId ? `[moment:${t.momentId}] ` : ""}Blocked by: ${t.text}.`,
      ),
      ...b.next.map((n) => `Next: ${n.text}.`),
    ]
      .filter(Boolean)
      .join(" ");
  }
}

export function segmentsOf(script: string, manifest: HandoffPlaintext["manifest"]) {
  return scriptSegments(
    script,
    manifest.moments.map((m) => m.id),
  );
}

export async function answerQuestion(
  manifest: HandoffPlaintext["manifest"],
  question: string,
  language: NebLanguage,
  signal?: AbortSignal,
  deps: HandoffModelDeps = handoffModelDeps,
): Promise<AskModelResponse> {
  const made = await deps.generate({
    model: screenModel(),
    purpose: "handoff-ask",
    system: inLanguage(HANDOFF_ASK_PROMPT.system, language),
    input: [
      { type: "text" as const, text: `Handoff (data): ${renderPackageText(manifest)}` },
      {
        type: "text" as const,
        text: `The teammate's question (data): ${JSON.stringify(question)}`,
      },
    ],
    schema: AskModelResponse,
    thinkingLevel: "low" as const,
    maxOutputTokens: 768,
    timeoutMs: 20_000,
    ...(signal && { signal }),
  });
  const notCovered = `${manifest.sender.name} didn't cover that. Want to ask them?`;
  if (!made.covered || unsafeReasons(made.answer).length > 0) {
    return { answer: notCovered, citations: [], covered: false };
  }
  return { ...made, citations: realCitations(made.citations, manifest) };
}
