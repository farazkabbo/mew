import { apiFetchBytes } from "@/server/api-client";
import { mapApi } from "@/server/handoff";
import { device, handoffId, type IdContext } from "@/server/handoff-routes";
import { handle } from "@/server/http";

/** The ciphertext, for the receiver's desktop app (members only). */
export const POST = handle(async (request: Request, context: IdContext) => {
  const who = await device(request);
  const id = await handoffId(context);
  const headers: Record<string, string> = { "X-Mew-Device-Token": who.token };
  if (who.email) headers["X-Mew-User-Email"] = who.email;
  const { bytes } = await apiFetchBytes(`/v1/handoffs/${id}/device/package`, {
    method: "POST",
    headers,
    timeoutMs: 30_000,
  }).catch(mapApi);
  return new Response(bytes, {
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
  });
});
