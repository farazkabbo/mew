import { ApiHealth, type ServiceStatus, type WebHealth } from "@mew/shared";
import { NextResponse } from "next/server";

import { apiFetch } from "@/server/api-client";

export async function GET(): Promise<NextResponse<WebHealth>> {
  const api = await probeApi();
  const body: WebHealth = {
    status: api === "ok" ? "ok" : "degraded",
    services: { web: "ok", api },
  };
  return NextResponse.json(body, {
    status: api === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}

async function probeApi(): Promise<ServiceStatus> {
  try {
    await apiFetch("/health", ApiHealth, { timeoutMs: 2_000 });
    return "ok";
  } catch (error) {
    console.warn("[health] API probe failed:", error instanceof Error ? error.message : error);
    return "down";
  }
}
