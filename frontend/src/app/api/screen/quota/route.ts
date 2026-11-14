import { NextResponse } from "next/server";

import { requireDevice } from "@/server/device-auth";
import { handle } from "@/server/http";
import { quotaEnforced } from "@/server/limits";
import { allowanceOf } from "@/server/question-gate";

/** The same as /api/quota, for the desktop app (device token). */
export const GET = handle(async (request: Request) => {
  const device = await requireDevice(request);
  if (!quotaEnforced()) {
    return NextResponse.json({ enforced: false }, { headers: { "Cache-Control": "no-store" } });
  }
  const allowance = await allowanceOf(device.userId);
  return NextResponse.json(
    { enforced: true, ...allowance },
    { headers: { "Cache-Control": "no-store" } },
  );
});
