import { describe, expect, it } from "vitest";

import { cspDirectives, standaloneCsp } from "./csp";

describe("cspDirectives", () => {
  it("allows the Supabase origin over https and wss, without path", () => {
    const d = cspDirectives({ supabaseUrl: "https://abc.supabase.co/rest/v1/", production: false });
    expect(d["connect-src"]).toEqual(["self", "https://abc.supabase.co", "wss://abc.supabase.co"]);
  });

  it("locks down plugins, base URI and framing", () => {
    const d = cspDirectives({ supabaseUrl: undefined, production: false });
    expect(d["object-src"]).toEqual(["none"]);
    expect(d["base-uri"]).toEqual(["self"]);
    expect(d["frame-ancestors"]).toEqual(["none"]);
    expect(d["connect-src"]).toEqual(["self"]);
  });

  it("upgrades insecure requests only in production", () => {
    expect(cspDirectives({ supabaseUrl: undefined, production: true })).toHaveProperty(
      "upgrade-insecure-requests",
    );
    expect(cspDirectives({ supabaseUrl: undefined, production: false })).not.toHaveProperty(
      "upgrade-insecure-requests",
    );
  });
});

describe("standaloneCsp", () => {
  it("is nonce-based with strict-dynamic and quoted keywords", () => {
    const csp = standaloneCsp("abc123", { supabaseUrl: undefined, production: true });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("allows eval only in development", () => {
    expect(standaloneCsp("n", { supabaseUrl: undefined, production: false })).toContain(
      "'unsafe-eval'",
    );
  });
});
