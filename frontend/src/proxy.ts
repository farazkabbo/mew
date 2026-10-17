import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";

import { isClerkConfigured } from "@/lib/auth-mode";
import { cspDirectives, standaloneCsp } from "@/server/csp";
import { appEnv } from "@/server/env";

const isPublicRoute = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);
const production = process.env.NODE_ENV === "production";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

const withClerk = clerkMiddleware(
  async (auth, request) => {
    if (!isPublicRoute(request)) await auth.protect();
  },
  () => ({
    // Only accept session tokens minted for our own origin (CSRF / token-reuse protection).
    authorizedParties: [appEnv().APP_ORIGIN],
    contentSecurityPolicy: {
      strict: true,
      directives: cspDirectives({ supabaseUrl, production }),
    },
  }),
);

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (isClerkConfigured) return withClerk(request, event);
  if (production) {
    // Fail closed: never serve an unauthenticated production app.
    return new NextResponse("Authentication is not configured.", { status: 503 });
  }
  return localMode(request);
}

/** Development without Clerk: no auth, same nonce-based CSP. */
function localMode(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = standaloneCsp(nonce, { supabaseUrl, production });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

// /api/health is deliberately outside the proxy: it is public, sessionless JSON, and must keep
// answering even when the auth provider is misconfigured or down.
export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params.
    "/((?!_next|api/health$|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api(?!/health$)|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
