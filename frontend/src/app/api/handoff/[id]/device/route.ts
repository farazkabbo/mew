import { HandoffView } from "@mew/shared";
import { NextResponse } from "next/server";

import { deviceApi, unwrapKey } from "@/server/handoff";
import { device, handoffId, type IdContext, NO_STORE } from "@/server/handoff-routes";
import { handle } from "@/server/http";

/** Pick up from here: the receiver's desktop app reads the handoff and its key (members only). */
export const POST = handle(async (request: Request, context: IdContext) => {
  const who = await device(request);
  const id = await handoffId(context);
  const view = await deviceApi(
    who.token,
    who.email,
    `/v1/handoffs/${id}/device/view`,
    HandoffView,
    {
      method: "POST",
    },
  );
  const { wrappedKey, ...rest } = view;
  return NextResponse.json({ ...rest, contentKey: unwrapKey(wrappedKey) }, { headers: NO_STORE });
});
