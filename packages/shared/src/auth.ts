import { z } from "zod";

/** Response of the FastAPI `GET /v1/me` endpoint: the identity the API verified from the Clerk token. */
export const ApiWhoAmI = z.object({
  user_id: z.string().min(1),
});
export type ApiWhoAmI = z.infer<typeof ApiWhoAmI>;
