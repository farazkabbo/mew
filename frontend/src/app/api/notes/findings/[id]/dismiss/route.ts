import { handle } from "@/server/http";
import { type FindingContext, findingAction } from "@/server/notes-check/finding-route";
import { dismissFinding } from "@/server/notes-check/resolve";

/** "Dismiss": set a finding aside. Nothing is recorded about the student's understanding. */
export const POST = handle(async (request: Request, context: FindingContext) => {
  await findingAction(request, context, (id) => dismissFinding(id), { model: false });
  return new Response(null, { status: 204 });
});
