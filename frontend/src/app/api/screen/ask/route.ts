import { ScreenAskRequest } from "@mew/shared";

import { walkthroughContext } from "@/server/coach/run";
import { deviceWalkthroughs } from "@/server/coach/store";
import { deviceToken, requireDevice } from "@/server/device-auth";
import { geminiEnv } from "@/server/env";
import { handle, readJson } from "@/server/http";
import { assertJpeg } from "@/server/jpeg";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { screenCourseContext } from "@/server/screen-course";
import { LIMITS } from "@/server/limits";
import { askerOf, questionStream, startQuestion } from "@/server/question-gate";
import { runScreenTutor } from "@/server/screen-tutor";
import { studentNotes } from "@/server/student-notes";

/** The JSON body: a base64 JPEG (~1 MB at most) plus a short question. */
const MAX_BODY_BYTES = 1_500_000;

/**
 * Screen Coach: one question about the student's screen, from the desktop app (device token;
 * no browser session). Streams newline-delimited JSON events (`speech`, then `response`) so the
 * desktop app can start speaking before the ink actions finish generating.
 *
 * The screenshot was captured and redacted on the device; here it is checked, forwarded to the
 * model, and dropped with the request. It is never stored or logged. A question asked during a
 * walkthrough (coach mode) is answered in its context, and the student's own course passages
 * about the question come with it (S5), so the answer can name the connection.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    screen: RATE_RULES.screen,
    screenDaily: RATE_RULES.screenDaily,
    screenMonthly: RATE_RULES.screenMonthly,
  });
  const body = await readJson(request, ScreenAskRequest, MAX_BODY_BYTES);
  assertJpeg(body.image.jpeg);
  geminiEnv(); // fail fast with 503 (before streaming) when the model isn't configured
  // One of the learner's questions, or part of the walkthrough it's asked in (LAUNCH_LIMITS.md).
  const question = await startQuestion(
    askerOf(request, device.userId),
    body.walkthroughId
      ? { key: `q:walk:${body.walkthroughId}`, cap: LIMITS.walkthroughSteps }
      : undefined,
  );
  // Asked in the middle of a walkthrough: the tutor answers about its current step.
  const token = deviceToken(request);
  const [walkthrough, courseContext, notes] = await Promise.all([
    body.walkthroughId
      ? walkthroughContext(deviceWalkthroughs(token), body.walkthroughId)
      : undefined,
    screenCourseContext(token, body.transcript),
    // The student's own lines about it: the answer teaches from them (docs/PLAN.md).
    studentNotes(token, body.transcript),
  ]);

  return questionStream(
    question,
    () =>
      runScreenTutor(
        {
          ...body,
          ...(walkthrough && { walkthrough }),
          courseContext,
          language: device.language,
          studentNotes: notes,
        },
        request.signal,
      ),
    // Spoken words reached the learner (a safe fallback line is still an answer).
    (event) => event.type === "speech",
  );
});
