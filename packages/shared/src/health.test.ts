import { describe, expect, it } from "vitest";
import { ApiHealth, WebHealth } from "./health";

describe("health schemas", () => {
  it("accepts a valid API health payload", () => {
    expect(ApiHealth.parse({ status: "ok", service: "api", version: "0.1.0" })).toBeTruthy();
  });

  it("rejects an API payload with an unexpected status", () => {
    expect(ApiHealth.safeParse({ status: "error", service: "api", version: "0.1.0" }).success).toBe(
      false,
    );
  });

  it("requires every service to be reported in the web payload", () => {
    expect(WebHealth.safeParse({ status: "ok", services: { web: "ok" } }).success).toBe(false);
  });
});
