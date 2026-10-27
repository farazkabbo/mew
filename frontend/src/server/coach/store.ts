import "server-only";

import {
  AppName,
  FsrsCard,
  type SkillEvidence,
  Walkthrough,
  type WalkthroughCreate,
  type WalkthroughKind,
  type WalkthroughUpdate,
} from "@mew/shared";
import { z } from "zod";

import { ApiError, apiFetch } from "../api-client";
import { HttpError } from "../http-error";

/**
 * Walkthroughs kept by the API service for the desktop app (Screen Coach S4). Every call carries
 * the device token, which the API checks again itself: it never takes a user id from us.
 */
export type WalkthroughStore = {
  create(walkthrough: WalkthroughCreate): Promise<Walkthrough>;
  get(id: string): Promise<Walkthrough | null>;
  /** The walkthrough to continue (unfinished, touched in the last 7 days), if any. */
  latest(): Promise<Walkthrough | null>;
  /** Writes progress made from `update.revision`; null if the walkthrough moved on meanwhile. */
  update(id: string, update: WalkthroughUpdate): Promise<Walkthrough | null>;
  /** S5: the student's skills (to pick one to re-check, and its card). */
  skills(): Promise<DeviceSkill[]>;
  /** S5: a finished walkthrough's skill, evidence and next re-check. */
  recordSkill(record: SkillRecord): Promise<DeviceSkill>;
};

/** A skill as coach mode needs it (S5). */
export const DeviceSkill = z.object({
  id: z.uuid(),
  title: z.string(),
  app: AppName.nullable(),
  dueAt: z.iso.datetime({ offset: true }),
  fsrsState: FsrsCard,
  lastWalkthroughId: z.uuid().nullable(),
});
export type DeviceSkill = z.infer<typeof DeviceSkill>;

export type SkillRecord = {
  walkthroughId: string;
  title: string;
  app: string | null;
  kind: WalkthroughKind;
  evidence: SkillEvidence;
  hints: number;
  card: FsrsCard;
  dueAt: string;
};

export function deviceWalkthroughs(token: string): WalkthroughStore {
  const call = <T>(
    path: `/${string}`,
    schema: z.ZodType<T>,
    options: Parameters<typeof apiFetch>[2] = {},
  ): Promise<T> =>
    apiFetch(path, schema, {
      ...options,
      headers: { "X-Mew-Device-Token": token },
      timeoutMs: 8_000,
    });

  return {
    create: (walkthrough) =>
      guarded(call("/v1/walkthroughs/device", Walkthrough, { method: "POST", body: walkthrough })),
    get: (id) => orNull(call(`/v1/walkthroughs/device/${id}`, Walkthrough), [404]),
    latest: () => orNull(call("/v1/walkthroughs/device/latest", Walkthrough), [404]),
    update: (id, update) =>
      orNull(
        call(`/v1/walkthroughs/device/${id}`, Walkthrough, { method: "PUT", body: update }),
        [409],
      ),
    skills: () =>
      guarded(call("/v1/skills/device", z.object({ skills: z.array(DeviceSkill) }))).then(
        (r) => r.skills,
      ),
    recordSkill: (record) =>
      guarded(call("/v1/skills/device/record", DeviceSkill, { method: "POST", body: record })),
  };
}

/** The value, or null when the API answered one of `statuses`; other failures as `guarded`. */
async function orNull<T>(call: Promise<T>, statuses: readonly number[]): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && error.status !== null && statuses.includes(error.status)) {
      return null;
    }
    throw safe(error);
  }
}

async function guarded<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw safe(error);
  }
}

/** API failures as safe HTTP errors (no upstream details). */
function safe(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.status === 401) return new HttpError(401, "Unauthorized");
  if (error.status === null || error.status === 503) {
    return new HttpError(503, "Coach mode isn't available right now");
  }
  return new HttpError(502, "Coach mode failed");
}
