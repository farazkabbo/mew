import { z } from "zod";

export const ServiceStatus = z.enum(["ok", "down"]);
export type ServiceStatus = z.infer<typeof ServiceStatus>;

/** Liveness payload returned by the FastAPI service at `GET /health`. */
export const ApiHealth = z.object({
  status: z.literal("ok"),
  service: z.literal("api"),
  version: z.string(),
});
export type ApiHealth = z.infer<typeof ApiHealth>;

/** Aggregate payload returned by the web app at `GET /api/health`. */
export const WebHealth = z.object({
  status: z.enum(["ok", "degraded"]),
  services: z.object({
    web: ServiceStatus,
    api: ServiceStatus,
  }),
});
export type WebHealth = z.infer<typeof WebHealth>;
