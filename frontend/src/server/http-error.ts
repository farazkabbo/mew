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
  ) {
    super(message);
    this.name = "HttpError";
  }
}
