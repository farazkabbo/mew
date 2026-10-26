import { asksForAnswer, CircleAskRequest, questionText, type Subject } from "@mew/shared";

import { verifiedCheckQuestion } from "@/server/check-question";
import { runCircleAsk } from "@/server/circle-ask";
import { placeLabel, runCircleSolution } from "@/server/circle-solution";
import { circleDestination } from "@/server/destinations";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { keepForEntry } from "@/server/entry-extras";
import { geminiEnv } from "@/server/env";
import { fileMoment, filingEvent } from "@/server/filing";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

/** Two base64 JPEGs (~1 MB each at most), the marks and a little text. */
const MAX_BODY_BYTES = 3_000_000;

/**
 * Circle & Ask (S3.2): the student marked something on screen and asked about it, from the desktop
 * app (device token). Streams newline-delimited JSON events: each `step` as soon as it's written
 * and checked, then `done` (or `abort` when a step fails the safety check). The two images were
 * captured and redacted on the device; they're forwarded to the model and dropped with the
 * request, never stored or logged.
 *
 * "…and save it to Physics chapter 5" (K3) is taken out of the question first, resolved against
 * the student's own notebooks, and sent as a `destination` event before any step.
 *
 * "Just tell me the answer" (K7) is solved and verified first (Show-then-You), then shown in the
 * same steps; the verified solution waits for the entry to be saved.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    circleAsk: RATE_RULES.circleAsk,
    circleAskDaily: RATE_RULES.circleAskDaily,
    circleAskMonthly: RATE_RULES.circleAskMonthly,
  });
  const body = await readJson(request, CircleAskRequest, MAX_BODY_BYTES);
  assertJpeg(body.focus.image.jpeg);
  assertJpeg(body.context.jpeg);
  geminiEnv(); // 503 before streaming when the model isn't configured
  const placed = await circleDestination(body, device.userId, deviceToken(request));
  const question = questionText(placed.request.question);
  const direct = question !== null && asksForAnswer(question);
  if (direct) {
    enforceRateLimit(device.userId, {
      solution: RATE_RULES.solution,
      solutionDaily: RATE_RULES.solutionDaily,
    });
  }
  // Said where it goes ("…save it to Physics chapter 5"): no filing. Otherwise it's filed by what
  // the answer says it's about (K8), and the card hears where before the answer ends.
  const spoken = placed.event?.type === "destination" && placed.event.phrase !== null;
  const token = deviceToken(request);
  const source = { app: body.app, ...body.source };
  const file = async (subject: Subject | null, hints: readonly string[]) => {
    if (spoken) return [];
    const filed = await fileMoment(token, { userId: device.userId, source, subject, hints });
    return filed ? [filingEvent(filed)] : [];
  };
  const events = direct
    ? runCircleSolution(
        placed.request,
        {
          userId: device.userId,
          place: placeLabel(placed.event?.type === "destination" ? placed.event.resolution : null),
          file: (subject) => file(subject, []),
        },
        request.signal,
      )
    : runCircleAsk(placed.request, request.signal, undefined, async (answer) => {
        // The moment's subject and its verified check question wait for the entry (K8).
        const checkQuestion = await verifiedCheckQuestion(answer.checkQuestion);
        keepForEntry(device.userId, body.sessionId, {
          moment: { subject: answer.subject, checkQuestion },
        });
        return file(answer.subject, answer.conceptHints);
      });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (placed.event) controller.enqueue(encoder.encode(`${JSON.stringify(placed.event)}\n`));
      for await (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
});
