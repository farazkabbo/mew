import { z } from "zod";

/** The only host the browser may open a speech-to-text socket to. */
export const SCRIBE_REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

/** Response of `POST /api/stt/token`: everything the browser needs to open one STT session. */
export const SttSession = z.object({
  /** Single-use token: consumed on connect, expires after 15 minutes. */
  token: z.string().min(1).max(512),
  modelId: z.string().min(1).max(64),
  url: z.literal(SCRIBE_REALTIME_URL),
});
export type SttSession = z.infer<typeof SttSession>;
