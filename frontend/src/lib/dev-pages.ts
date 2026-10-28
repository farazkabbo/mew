/**
 * Pages for the team only (the handwriting capture, the UI previews): served in development, or
 * in a build made with NEXT_PUBLIC_DEV_PAGES=1. Production builds answer 404.
 */
export const devPagesEnabled =
  process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DEV_PAGES === "1";
