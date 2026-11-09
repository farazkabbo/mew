import { type TutorRequest, TutorStreamEvent } from "@mew/shared";

export class TutorRequestError extends Error {
  constructor(
    readonly status: number,
    /** The server's own words for a limit (out of questions, at capacity…), to say as is. */
    readonly spoken?: string,
  ) {
    super(`Tutor request failed (${status})`);
    this.name = "TutorRequestError";
  }
}

const LIMIT_CODES = new Set(["RATE_LIMITED", "QUOTA_EXCEEDED", "AT_CAPACITY", "EMAIL_UNVERIFIED"]);

/** Streams a tutor turn from `/api/tutor`, yielding validated events as they arrive. */
export async function* streamTutor(
  request: TutorRequest,
  signal: AbortSignal,
): AsyncGenerator<TutorStreamEvent> {
  const response = await fetch("/api/tutor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
    signal,
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
      code?: unknown;
    } | null;
    const limited =
      typeof body?.code === "string" && LIMIT_CODES.has(body.code) && typeof body.error === "string"
        ? body.error.slice(0, 300)
        : undefined;
    throw new TutorRequestError(response.status, limited);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = TutorStreamEvent.safeParse(JSON.parse(line));
        if (event.success) yield event.data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
