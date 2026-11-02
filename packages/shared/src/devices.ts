import { z } from "zod";

import { NebLanguage } from "./language";

/**
 * Desktop sign-in for Screen Coach (docs/SCREEN_COACH.md decision 8). Mirrors
 * backend/src/mew_api/devices/models.py.
 *
 * The desktop app makes a random verifier and gives the signed-in page only its hash (the
 * challenge); the page gets a one-time link code for it and passes the code back; the desktop
 * app redeems code + verifier for an opaque device token, kept in Windows Credential Manager.
 */

export const DEVICE_TOKEN_PATTERN = /^mewdt_[A-Za-z0-9_-]{43}$/;

/** base64url SHA-256 of the verifier, without padding (PKCE S256). */
export const DeviceChallenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const DeviceLinkRequest = z.object({ challenge: DeviceChallenge });
export type DeviceLinkRequest = z.infer<typeof DeviceLinkRequest>;

export const DeviceLinkCode = z.object({ code: z.string(), expiresInS: z.number().int() });
export type DeviceLinkCode = z.infer<typeof DeviceLinkCode>;

export const DeviceExchangeRequest = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  deviceName: z.string().trim().min(1).max(80),
});
export type DeviceExchangeRequest = z.infer<typeof DeviceExchangeRequest>;

export const IssuedDeviceToken = z.object({
  token: z.string().regex(DEVICE_TOKEN_PATTERN),
  deviceId: z.uuid(),
});
export type IssuedDeviceToken = z.infer<typeof IssuedDeviceToken>;

/**
 * A browser sign-in redeemed (SCREEN_COACH decision 8a): Screen Coach's token, and the one-minute
 * Clerk ticket that starts the desktop window's own session.
 */
export const DesktopSignIn = z.object({
  token: z.string().regex(DEVICE_TOKEN_PATTERN),
  ticket: z.string().min(1),
});
export type DesktopSignIn = z.infer<typeof DesktopSignIn>;

export const VerifiedDevice = z.object({
  userId: z.string().min(1),
  deviceId: z.uuid(),
  scopes: z.array(z.string()),
  /** The language its owner chose, so a screen answer comes back in it. */
  language: NebLanguage.default("en"),
});
export type VerifiedDevice = z.infer<typeof VerifiedDevice>;

/** A device as its owner sees it in Settings (never the token). */
export const DeviceInfo = z.object({
  id: z.uuid(),
  deviceName: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const DeviceList = z.object({ devices: z.array(DeviceInfo) });
export type DeviceList = z.infer<typeof DeviceList>;
