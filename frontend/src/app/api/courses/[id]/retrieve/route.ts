import { RetrieveRequest, RetrieveResponse } from "@mew/shared";
import { NextResponse } from "next/server";

import { coursesApi } from "@/server/courses";
import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

import { courseId } from "../route";

/** The course passages most relevant to a question (context for the tutor, with pages). */
export const POST = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);
    const userId = await requireUserId();
    enforceRateLimit(userId, { retrieve: RATE_RULES.retrieve });
    const body = await readJson(request, RetrieveRequest, 4_000);
    const result = await coursesApi(
      `/v1/courses/${await courseId(context)}/retrieve`,
      RetrieveResponse,
      { method: "POST", body, timeoutMs: 10_000 },
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  },
);
