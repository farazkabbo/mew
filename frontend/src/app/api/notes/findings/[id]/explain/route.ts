import { NextResponse } from "next/server";

import { handle } from "@/server/http";
import { type FindingContext, findingAction } from "@/server/notes-check/finding-route";
import { explainFinding } from "@/server/notes-check/resolve";

/** "Tell me": a short explanation grounded in the material (the finding becomes "explained"). */
export const POST = handle(async (request: Request, context: FindingContext) => {
  const result = await findingAction(request, context, (id) => explainFinding(id));
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});
