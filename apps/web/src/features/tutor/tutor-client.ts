import { type TutorRequest, TutorStreamEvent } from "@mew/shared";

export class TutorRequestError extends Error {
  constructor(readonly status: number) {
    super(`Tutor request failed (${status})`);
    this.name = "TutorRequestError";
  }
}

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
  if (!response.ok || !response.body) throw new TutorRequestError(response.status);

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
