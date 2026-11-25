import { HandoffCreateRequest } from "@mew/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { deviceApi, wrapKey } from "@/server/handoff";
import { device, NO_STORE } from "@/server/handoff-routes";
import { handle, readJson } from "@/server/http";

/**
 * Handoff: a draft from the sender's desktop app (device token). The content key is wrapped here
 * and stored only wrapped; the ciphertext follows with PUT …/package, then …/finalize sends it.
 */
export const POST = handle(async (request: Request) => {
  const who = await device(request);
  const body = await readJson(request, HandoffCreateRequest, 8_000);
  const created = await deviceApi(who.token, null, "/v1/handoffs", z.object({ id: z.uuid() }), {
    method: "POST",
    body: {
      title: body.title,
      senderName: body.senderName,
      recipients: body.recipients,
      expiresInDays: body.expiresInDays,
      sizeBytes: body.sizeBytes,
      wrappedKey: wrapKey(body.contentKey),
    },
  });
  const link = new URL(`/h/${created.id}`, request.url).toString();
  return NextResponse.json({ id: created.id, link }, { status: 201, headers: NO_STORE });
});
