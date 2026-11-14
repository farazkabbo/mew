import { NextResponse } from "next/server";

import { updateManifestUrl } from "@/server/desktop-updates";

/** Installed desktop apps checking for a new version: a redirect to the release files. */
export function GET(): NextResponse {
  return NextResponse.redirect(updateManifestUrl(), {
    status: 302,
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
