import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Next.js requires `config.matcher` to be a literal in proxy.ts, so it is checked from source:
// importing the proxy would pull in the Clerk runtime.
const source = readFileSync(path.join(import.meta.dirname, "proxy.ts"), "utf8");
const pageMatcher = /"\/\(\(\?!_next.*\)\.\*\)"/.exec(source)?.[0];

function compile(literal: string): RegExp {
  const pattern = JSON.parse(literal) as string;
  return new RegExp(`^${pattern}$`);
}

describe("proxy matcher", () => {
  it("is present", () => {
    expect(pageMatcher).toBeDefined();
  });

  const matcher = compile(pageMatcher ?? '""');

  it.each(["/", "/status", "/notebook/abc", "/xhtml", "/notebookcss", "/api/me"])(
    "runs the proxy (auth + CSP) for %s",
    (route) => {
      expect(matcher.test(route)).toBe(true);
    },
  );

  it.each([
    "/_next/static/chunk.js",
    "/favicon.ico",
    "/fonts/inter.woff2",
    "/api/health",
    "/workers/code-runner.mjs",
    "/pyodide/pyodide.asm.wasm",
  ])("skips static assets and the health probe: %s", (route) => {
    expect(matcher.test(route)).toBe(false);
  });
});

describe("public routes", () => {
  const publicList = /createRouteMatcher\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? "";

  // Signed out, the desktop app's Sign in must reach the page, which sends the visitor to
  // sign-up; protecting it in the proxy would send them to sign-in instead.
  it("lets /desktop/authorize through to the page", () => {
    expect(publicList).toContain('"/desktop/authorize"');
  });
});
