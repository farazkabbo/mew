import "server-only";

/**
 * An error that maps directly to an HTTP response with a safe, user-facing message. Kept apart
 * from `http.ts` (which loads Clerk and Next) so plain server modules and evals can throw it.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
    /**
     * A machine-readable reason the client turns into its own words (docs/DESKTOP_API.md):
     * RATE_LIMITED, QUOTA_EXCEEDED, AT_CAPACITY, EMAIL_UNVERIFIED.
     */
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
