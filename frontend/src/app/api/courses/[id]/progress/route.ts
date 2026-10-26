import { ConceptNodes, type CourseProgress, LearnerData } from "@mew/shared";
import { NextResponse } from "next/server";

import { coursesApi } from "@/server/courses";
import { assertNotCrossSite, handle, requireUserId } from "@/server/http";
import { progressOf } from "@/server/learner";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

import { courseId } from "../route";

/**
 * The student's progress on each concept they've started (status and next review), and the
 * notebook chapters each concept belongs to (K1 §2.2: chapter cards show their progress).
 */
export const GET = handle(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    assertNotCrossSite(request);
    const userId = await requireUserId();
    enforceRateLimit(userId, { courseRead: RATE_RULES.courseRead });
    const id = await courseId(context);
    const [data, nodes] = await Promise.all([
      coursesApi(`/v1/courses/${id}/learner`, LearnerData),
      coursesApi(`/v1/courses/${id}/concept-nodes`, ConceptNodes),
    ]);
    const progress: CourseProgress = {
      concepts: progressOf(data, new Date()),
      conceptNodes: nodes.nodes.map((n) => ({
        conceptId: n.concept_id,
        nodeId: n.notebook_node_id,
      })),
    };
    return NextResponse.json(progress, { headers: { "Cache-Control": "no-store" } });
  },
);
