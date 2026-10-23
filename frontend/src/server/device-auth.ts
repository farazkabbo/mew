import "server-only";

import { VerifiedDevice } from "@mew/shared";

import { ApiError, apiFetch } from "./api-client";
import { HttpError } from "./http-error";

const BEARER_DEVICE_TOKEN = /^Bearer (mewdt_[A-Za-z0-9_-]{43})$/;
export const SCREEN_SCOPE = "screen";

/**
 * Authenticates a request from the desktop app by its device token (decision 8). The token is
 * checked against the database on every request (no cache), so revoking a device takes effect
 * at once. Only Screen Coach routes accept device tokens.
 */
export async function requireDevice(request: Request): Promise<VerifiedDevice> {
  const token = deviceToken(request);
  let device: VerifiedDevice;
  try {
    device = await apiFetch("/v1/devices/verify", VerifiedDevice, {
      method: "POST",
      body: { token },
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401) throw unauthorized();
    if (error.status === null) throw new HttpError(503, "The service is unavailable right now");
    throw new HttpError(502, "Couldn't check the device");
  }
  if (!device.scopes.includes(SCREEN_SCOPE)) throw new HttpError(403, "Not allowed");
  return device;
}

/** The device token from `Authorization: Bearer …`, or 401. */
export function deviceToken(request: Request): string {
  const token = BEARER_DEVICE_TOKEN.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) throw unauthorized();
  return token;
}

/**
 * The client's address for rate limiting requests that have no user yet (redeeming a link
 * code). Behind Render's proxy it's the first X-Forwarded-For entry; locally there is none.
 */
export function clientAddress(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function unauthorized(): HttpError {
  return new HttpError(401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
}
