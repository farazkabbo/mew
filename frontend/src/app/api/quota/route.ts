import { NextResponse } from "next/server";

import { handle, requireUserId } from "@/server/http";
import { quotaEnforced } from "@/server/limits";
import { allowanceOf } from "@/server/question-gate";

/**
 * The learner's free questions (docs/LAUNCH_LIMITS.md): how many are used and left, for the
 * quiet "5 of 8 questions left" in the app. Outside production (unless NEB_QUOTA=on) nothing is
 * counted, so it says so.
 */
export const GET = handle(async () => {
  const userId = await requireUserId();
  if (!quotaEnforced()) {
    return NextResponse.json({ enforced: false }, { headers: { "Cache-Control": "no-store" } });
  }
  const allowance = await allowanceOf(userId);
  return NextResponse.json(
    { enforced: true, ...allowance },
    { headers: { "Cache-Control": "no-store" } },
  );
});
