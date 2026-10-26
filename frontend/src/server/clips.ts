import "server-only";

import {
  CLIP_LIMITS,
  type ClipCreateRequest,
  ClipCreated,
  clipPointCount,
  type EntryAppendRequest,
  type SavedDestination,
} from "@mew/shared";
import { z } from "zod";

import { ApiError, apiFetch } from "./api-client";
import { HttpError } from "./http-error";
import { assertJpeg } from "./jpeg";

/** The JSON body of a clip: a base64 JPEG (~3 MB at most), strokes and a little text. */
export const MAX_CLIP_BODY_BYTES = 4_600_000;

/** How far a stroke may run past the image's edges (a circle drawn around the edge of a crop). */
const STROKE_MARGIN = 0.5;

/**
 * Checks a clip from the desktop app beyond its schema: the image really is a JPEG of the size
 * it claims (the page sizes it by that), the ink stays near the image, and the total amount of
 * ink is capped. A Circle & Ask entry's marks count as ink too, and every tutor stroke has its
 * explanation step. Anything else is 400.
 */
export function assertClip(clip: ClipCreateRequest): void {
  const size = assertJpeg(clip.image.jpeg, CLIP_LIMITS.longSide);
  if (size.width !== clip.image.width || size.height !== clip.image.height) {
    throw new HttpError(400, "The image's size doesn't match");
  }
  const marks = clip.entry?.studentStrokes ?? [];
  if (clipPointCount([...clip.strokes, ...marks]) > CLIP_LIMITS.points) {
    throw new HttpError(400, "Too much ink");
  }
  if (clip.entry && clip.entry.strokeSteps.length !== clip.strokes.length) {
    throw new HttpError(400, "Each stroke needs its step");
  }
  const { width, height } = clip.image;
  const inside = (v: number, size: number) =>
    v >= -size * STROKE_MARGIN && v <= size * (1 + STROKE_MARGIN);
  for (const stroke of [...clip.strokes, ...marks]) {
    for (const [x, y] of stroke.points) {
      if (!inside(x, width) || !inside(y, height))
        throw new HttpError(400, "Ink outside the image");
    }
  }
}

/**
 * Stores a clip for the device's user. The API checks the device token again itself (it never
 * takes a user id from us for this), uploads the image to the private bucket and adds the row.
 */
export async function createClip(
  deviceToken: string,
  clip: ClipCreateRequest,
): Promise<ClipCreated> {
  try {
    return await apiFetch("/v1/clips", ClipCreated, {
      method: "POST",
      body: clip,
      headers: { "X-Mew-Device-Token": deviceToken },
      timeoutMs: 20_000,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401) throw new HttpError(401, "Unauthorized");
    if (error.status === 413) throw new HttpError(413, "Clip too large");
    if (error.status === null || error.status === 503) {
      throw new HttpError(503, "Saving clips isn't available right now");
    }
    throw new HttpError(502, "Couldn't save the clip");
  }
}

/**
 * Adds a Circle & Ask follow-up to its session's entry (S3.2 §5). The API checks the device
 * token again and finds the entry by the session, for that device's owner only.
 */
export async function appendToEntry(
  deviceToken: string,
  append: EntryAppendRequest,
): Promise<ClipCreated> {
  if (clipPointCount(append.strokes) > CLIP_LIMITS.points) {
    throw new HttpError(400, "Too much ink");
  }
  try {
    return await apiFetch("/v1/clips/entries/append", ClipCreated, {
      method: "POST",
      body: append,
      headers: { "X-Mew-Device-Token": deviceToken },
      timeoutMs: 10_000,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401) throw new HttpError(401, "Unauthorized");
    if (error.status === 404) throw new HttpError(404, "Not found");
    if (error.status === 413) throw new HttpError(413, "The entry is full");
    if (error.status === null || error.status === 503) {
      throw new HttpError(503, "Saving isn't available right now");
    }
    throw new HttpError(502, "Couldn't add to the entry");
  }
}

/**
 * Moves a saved clip or entry to another place in the notebook (K3). The API checks the device
 * token again and changes only that device owner's clip; 404 if there's no such clip.
 */
export async function moveClip(
  deviceToken: string,
  clipId: string,
  destination: SavedDestination,
): Promise<void> {
  try {
    await apiFetch("/v1/clips/destination", z.undefined(), {
      method: "POST",
      body: { clipId, destination },
      headers: { "X-Mew-Device-Token": deviceToken },
      timeoutMs: 10_000,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401) throw new HttpError(401, "Unauthorized");
    if (error.status === 404) throw new HttpError(404, "Not found");
    if (error.status === null || error.status === 503) {
      throw new HttpError(503, "Saving isn't available right now");
    }
    throw new HttpError(502, "Couldn't move it");
  }
}
