/**
 * Clerk is optional in local development only ("local mode"): without keys the app runs
 * signed-out with browser-local data. In production a missing key makes the proxy refuse to
 * serve (see src/proxy.ts), so local mode can never become an auth bypass.
 *
 * Referenced literally so Next.js inlines it in both server and client bundles.
 */
export const isClerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

/** The id local data is scoped to when nobody is signed in (local mode). */
export const LOCAL_USER_ID = "local";
