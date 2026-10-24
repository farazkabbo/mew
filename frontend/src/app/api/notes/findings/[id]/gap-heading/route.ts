import { NextResponse } from "next/server";

import { handle } from "@/server/http";
import { type FindingContext, findingAction } from "@/server/notes-check/finding-route";
import { gapHeading } from "@/server/notes-check/resolve";

/** "Add it": a heading for a gap, for the tutor to write in the margin (never the content). */
export const POST = handle(async (request: Request, context: FindingContext) => {
  const result = await findingAction(request, context, (id) => gapHeading(id));
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});
