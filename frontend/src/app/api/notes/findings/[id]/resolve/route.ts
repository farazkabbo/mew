import { ResolveRequest } from "@mew/shared";
import { NextResponse } from "next/server";

import { handle, readJson } from "@/server/http";
import { type FindingContext, findingAction } from "@/server/notes-check/finding-route";
import { resolveFinding } from "@/server/notes-check/resolve";

/** What the student said about a finding, or how they changed the line: how it turned out. */
export const POST = handle(async (request: Request, context: FindingContext) => {
  const result = await findingAction(request, context, async (id) => {
    const body = await readJson(request, ResolveRequest, 4_000);
    return resolveFinding(id, body);
  });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});
