import { NextResponse } from "next/server";
import { z } from "zod";

import { memberApi } from "@/server/handoff";
import { member, NO_STORE } from "@/server/handoff-routes";
import { assertNotCrossSite, handle } from "@/server/http";

/** The recipient picker's suggestions: people the user handed off to before. */
export const GET = handle(async (request: Request) => {
  assertNotCrossSite(request);
  const who = await member();
  const people = await memberApi(
    who,
    "/v1/handoffs/people/recent",
    z.object({ emails: z.array(z.string()) }),
  );
  return NextResponse.json(people, { headers: NO_STORE });
});
