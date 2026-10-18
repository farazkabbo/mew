import { QuizGradeRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { geminiEnv } from "@/server/env";
import { assertSameOrigin, handle, HttpError, readJson, requireUserId } from "@/server/http";
import { assertPng } from "@/server/png";
import { gradeAnswer } from "@/server/quiz";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

const MAX_BODY_BYTES = 1_700_000;

/** Grades the student's answer to a quiz question against the lesson's model answer. */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  enforceRateLimit(userId, {
    quizGrade: RATE_RULES.quizGrade,
    quizGradeDaily: RATE_RULES.quizGradeDaily,
  });
  const body = await readJson(request, QuizGradeRequest, MAX_BODY_BYTES);
  if (body.image) assertPng(body.image);
  geminiEnv(); // 503 without a model: the client falls back to self-grading

  try {
    const grade = await gradeAnswer(body);
    return NextResponse.json(grade, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.warn("[quiz] grading failed:", error instanceof Error ? error.message : error);
    throw new HttpError(502, "Grading failed");
  }
});
