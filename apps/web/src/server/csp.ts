import type { ClerkMiddlewareOptions } from "@clerk/nextjs/server";
import { SCRIBE_REALTIME_URL } from "@mew/shared";

/** Realtime speech-to-text socket host (scheme + host only, as CSP expects). */
const SPEECH_TO_TEXT_ORIGIN = new URL(SCRIBE_REALTIME_URL).origin;

type Directives = NonNullable<
  NonNullable<ClerkMiddlewareOptions["contentSecurityPolicy"]>["directives"]
>;

/**
 * Directives merged into Clerk's strict (nonce + 'strict-dynamic') CSP. Clerk supplies its own
 * hosts; we lock down what it leaves open and allow only the backends the browser talks to.
 */
export function cspDirectives(env: {
  supabaseUrl: string | undefined;
  production: boolean;
}): Directives {
  const connect = ["self", SPEECH_TO_TEXT_ORIGIN];
  if (env.supabaseUrl) {
    const origin = new URL(env.supabaseUrl).origin;
    connect.push(origin, origin.replace(/^http/, "ws"));
  }

  const directives: Directives = {
    "connect-src": connect,
    "object-src": ["none"],
    "base-uri": ["self"],
    "frame-ancestors": ["none"],
    "form-action": ["self"],
    "media-src": ["self", "blob:"],
  };
  if (env.production) directives["upgrade-insecure-requests"] = [];
  return directives;
}

const KEYWORDS = new Set(["self", "none", "unsafe-eval", "unsafe-inline", "strict-dynamic"]);

function formatSource(source: string): string {
  return KEYWORDS.has(source) || source.startsWith("nonce-") ? `'${source}'` : source;
}

/**
 * The complete policy used when Clerk is not configured (local development only). It mirrors
 * Clerk's strict mode: per-request nonce + 'strict-dynamic', no host allowlists for scripts.
 */
export function standaloneCsp(
  nonce: string,
  env: { supabaseUrl: string | undefined; production: boolean },
): string {
  const directives: Directives = {
    "default-src": ["self"],
    "script-src": [
      "self",
      `nonce-${nonce}`,
      "strict-dynamic",
      // React needs eval in development for debugging; never in production.
      ...(env.production ? [] : ["unsafe-eval"]),
    ],
    "style-src": ["self", "unsafe-inline"],
    "img-src": ["self", "blob:", "data:"],
    "font-src": ["self"],
    "worker-src": ["self", "blob:"],
    ...cspDirectives(env),
  };
  return Object.entries(directives)
    .map(([name, sources]) => [name, ...sources.map(formatSource)].join(" "))
    .join("; ");
}
